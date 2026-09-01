import { schema, type Database } from '@truecairn/db';
import { eligibleChannels } from '@truecairn/notifications';
import type { UserId } from '@truecairn/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isEntitled, PRO_CHANNEL_TYPES } from './entitlement.js';

// Apply a LemonSqueezy subscription webhook (signature already verified by the
// route). We trust the STATUS carried on every subscription event rather than
// inferring from the event name, so any of created/updated/cancelled/resumed/
// expired/paused converges the row to LS's current truth. Idempotent: replays
// re-upsert the same values. Invoice events (payment_success/failed) carry a
// different object type and are a no-op here — the accompanying
// subscription_updated carries the status that matters.
//
// Mapping to our user is via meta.custom_data.user_id, which we set on the
// checkout URL. If a later event omits it, we fall back to the existing row
// keyed by the LS subscription id.
//
// custom_data.user_id IS BUYER-CONTROLLABLE and is treated that way (2026-08-08
// re-audit, N-6). The signature proves the event came from LemonSqueezy; it says
// nothing about whether the buyer edited that query parameter on the hosted
// checkout URL before paying, and they can. Because the upsert is keyed on
// user_id, an unguarded accept meant a buyer substituting someone else's UUID
// OVERWROTE that person's subscription row with their own ls_subscription_id —
// then cancelled, and a paying customer silently lost their plan. A UUID matching
// no user, or a reused ls_subscription_id, violated a constraint instead: the
// transaction threw, the webhook 5xx'd, and LS retried that event forever.
//
// So the LS SUBSCRIPTION ID is the authority here, not custom_data. It is minted
// by LemonSqueezy and no buyer can choose it. The three guards below all fail to
// 'unmapped' and never throw, and each records a security event — a mismatch is
// either an attack or a genuine billing bug, and both need to be visible.
//
// Downgrade notice (docs/28): when this event crosses the entitled→not-entitled
// EDGE and the owner still has live verified paid channels (SMS/WhatsApp), one
// plan_downgraded notice is enqueued in the SAME transaction as the row update.
// The channels themselves keep delivering — money can block adding a resource,
// never silence a channel that already guards a vault — the notice just says
// so. Edge detection makes replays safe: a replayed event finds the row already
// not-entitled and never re-sends.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookOutcome = 'applied' | 'ignored' | 'unmapped';

export async function applyLemonSqueezyWebhook(
  db: Database,
  body: unknown,
  now: Date,
  options: { allowTestMode?: boolean } = {},
): Promise<WebhookOutcome> {
  if (typeof body !== 'object' || body === null) return 'ignored';
  const b = body as {
    meta?: { custom_data?: { user_id?: unknown }; test_mode?: unknown };
    data?: { type?: unknown; id?: unknown; attributes?: Record<string, unknown> };
  };

  // TEST-MODE GUARD. Every LemonSqueezy webhook carries meta.test_mode, and until
  // now nothing read it. That was harmless only because the store had never left
  // test mode; the moment it goes live, a stray test-mode event — a replay, a
  // sandbox left connected to the production endpoint, a mis-pointed webhook URL
  // in a dashboard — would entitle a real account to a plan nobody paid for.
  //
  // The asymmetry is deliberate and is the whole design:
  //
  //   test_mode true, LEMONSQUEEZY_TEST_MODE unset  → ignored + security event
  //   test_mode true, LEMONSQUEEZY_TEST_MODE set    → processed
  //   test_mode false or absent                     → ALWAYS processed
  //
  // Failing closed on live events would be the worse bug in the other direction:
  // a flag left set after the switchover would silently stop entitling paying
  // customers, and a silent entitlement failure after a real charge is a refund
  // and an apology. Real money always entitles; only the pretend kind needs
  // permission. (Which means the pre-launch test purchase docs/28 calls for has
  // to set the flag — the ordering matters, so it is stated in .env.example.)
  //
  // 'ignored' with a 200, never a throw: LemonSqueezy retries a 5xx, and this
  // particular refusal would never resolve — the poison-pill shape the mapping
  // guards below were written to remove.
  if (b.meta?.test_mode === true && options.allowTestMode !== true) {
    try {
      await db.insert(schema.securityEvents).values({
        eventType: 'billing_test_mode_event_ignored',
        payload: {
          reason: 'test_mode_not_permitted',
          lsSubscriptionId: typeof b.data?.id === 'string' ? b.data.id : null,
        },
      });
    } catch {
      // Same reasoning as the mapping event below: visibility must not cost a
      // 5xx that puts LemonSqueezy back into its retry loop.
    }
    return 'ignored';
  }

  const data = b.data;
  if (data === undefined || data.type !== 'subscriptions') return 'ignored';
  const lsSubscriptionId = typeof data.id === 'string' ? data.id : String(data.id ?? '');
  if (lsSubscriptionId === '') return 'ignored';
  const attrs = data.attributes ?? {};
  const status = typeof attrs['status'] === 'string' ? (attrs['status'] as string) : undefined;
  if (status === undefined) return 'ignored';

  const patch = {
    lsSubscriptionId,
    lsCustomerId: strOrNull(attrs['customer_id']),
    lsVariantId: strOrNull(attrs['variant_id']),
    status,
    renewsAt: dateOrNull(attrs['renews_at']),
    endsAt: dateOrNull(attrs['ends_at']),
    updatedAt: now,
  };

  const rawUserId = b.meta?.custom_data?.user_id;
  const claimedUserId =
    typeof rawUserId === 'string' && UUID_RE.test(rawUserId) ? rawUserId : null;

  // Captured inside the transaction, written AFTER it. A security event is
  // observability, not part of the billing decision, and an insert that failed
  // inside the transaction would abort it — swallowing the JS error does not
  // un-abort Postgres, it just makes every later statement fail confusingly.
  // Recording it outside also means a rejected mapping is logged whether or not
  // the row update commits, which is the honest ordering.
  let mappingEvent: Record<string, unknown> | undefined;

  const outcome = await db.transaction(async (txRaw): Promise<WebhookOutcome> => {
    const tx = txRaw as unknown as Database;
    // Serialise every event for this subscription. The FOR UPDATE below cannot do
    // it alone: a row lock on a SELECT that returns nothing locks NOTHING, so two
    // concurrent `subscription_created` deliveries both saw no prior row and both
    // inserted, and one lost to the unique index — the same 5xx-then-retry-forever
    // shape the guards exist to remove. Transaction-scoped, so no path leaks it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ls:sub:${lsSubscriptionId}`}, 0))`,
    );

    // The mapping we can actually trust: LemonSqueezy mints subscription ids and
    // no buyer can choose one.
    const [bound] = await tx
      .select({
        userId: schema.billingSubscriptions.userId,
        status: schema.billingSubscriptions.status,
        endsAt: schema.billingSubscriptions.endsAt,
        lsCustomerId: schema.billingSubscriptions.lsCustomerId,
      })
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.lsSubscriptionId, lsSubscriptionId))
      .for('update');

    const decision = await vetClaimedUser(tx, claimedUserId, lsSubscriptionId, bound, patch, now);
    const userId = decision.userId;
    mappingEvent = decision.event;

    // Edge detection reads the row we are about to overwrite — which is the user's
    // row when we have a trusted mapping, and the subscription's otherwise.
    const [prior] =
      userId !== null
        ? await tx
            .select({
              userId: schema.billingSubscriptions.userId,
              status: schema.billingSubscriptions.status,
              endsAt: schema.billingSubscriptions.endsAt,
            })
            .from(schema.billingSubscriptions)
            .where(eq(schema.billingSubscriptions.userId, userId))
            .for('update')
        : [bound];

    let noticeUserId: string | null;
    if (userId !== null) {
      // Upsert keyed on the user — a user has at most one subscription, so a
      // resubscribe (new LS subscription id) replaces the prior row cleanly.
      await tx
        .insert(schema.billingSubscriptions)
        .values({ userId, createdAt: now, ...patch })
        .onConflictDoUpdate({
          target: schema.billingSubscriptions.userId,
          set: patch,
        });
      noticeUserId = userId;
    } else {
      // No user mapping on this event — update the existing row by LS id if we
      // have one; otherwise we can't attribute it (a created event always
      // carries the custom_data, so this only happens for an orphaned later
      // event).
      if (prior === undefined) return 'unmapped';
      await tx
        .update(schema.billingSubscriptions)
        .set(patch)
        .where(eq(schema.billingSubscriptions.lsSubscriptionId, lsSubscriptionId));
      noticeUserId = prior.userId;
    }

    const wasEntitled = prior !== undefined && isEntitled(prior, now);
    const nowEntitled = isEntitled({ status: patch.status, endsAt: patch.endsAt }, now);
    if (wasEntitled && !nowEntitled) {
      await enqueueDowngradeNotice(tx, noticeUserId as UserId, now);
    }
    return 'applied';
  });

  if (mappingEvent !== undefined) {
    try {
      await db
        .insert(schema.securityEvents)
        .values({ eventType: 'billing_user_mapping_rejected', payload: mappingEvent });
    } catch {
      // A mismatch is either an attack or a genuine billing bug and both need to
      // be visible — but not at the cost of a 5xx that puts LemonSqueezy back into
      // its retry loop, which is one of the failure modes this whole change removes.
    }
  }
  return outcome;
}

// Decide whether the buyer-supplied user_id may be trusted for THIS event, or
// whether we fall back to the ls_subscription_id mapping (2026-08-08 re-audit,
// N-6). Never throws: every refusal returns a null userId, which the caller reads
// as "no trusted mapping on this event" — exactly as it reads an event that
// carries no custom_data at all, a case that already had to work.
//
// Order is deliberate: cheapest and strongest signal first.
interface MappingDecision {
  userId: string | null;
  event?: Record<string, unknown>;
}

async function vetClaimedUser(
  db: Database,
  claimed: string | null,
  lsSubscriptionId: string,
  bound: { userId: string; lsCustomerId: string | null } | undefined,
  patch: { lsCustomerId: string | null },
  now: Date,
): Promise<MappingDecision> {
  if (claimed === null) return { userId: null };

  // GUARD 1 — the ls_subscription_id → user_id binding is IMMUTABLE. Once LS has
  // bound a subscription to one of our users, no later event may move it, whatever
  // its custom_data claims. This is also what stops a re-checkout reusing a bound
  // subscription id from hitting billing_subscriptions_ls_sub_uniq and 5xx'ing.
  if (bound !== undefined) {
    if (bound.userId === claimed) return { userId: claimed };
    return {
      userId: null,
      event: {
        reason: 'subscription_bound_to_another_user',
        lsSubscriptionId,
        claimedUserId: claimed,
        boundUserId: bound.userId,
      },
    };
  }

  // GUARD 2 — the user must exist. An unknown UUID used to violate the FK to
  // users.id, throw out of the transaction, and leave LS retrying that event
  // indefinitely against a failure that would never resolve.
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, claimed))
    .limit(1);
  if (user === undefined) {
    return {
      userId: null,
      event: { reason: 'unknown_user', lsSubscriptionId, claimedUserId: claimed },
    };
  }

  // GUARD 3 — a LIVE subscription is not evictable by a stranger. The upsert is
  // keyed on user_id, so accepting this claim would replace the user's existing
  // row with a different subscription; cancel that one and a paying customer
  // silently loses their plan.
  //
  // The discriminator is the LemonSqueezy CUSTOMER. The documented legitimate
  // flows — an upgrade, or a cancel-then-resubscribe inside the grace window —
  // are the same person and therefore the same customer id, so they still apply.
  // A different customer paying into someone else's account is the attack.
  const [existing] = await db
    .select({
      lsSubscriptionId: schema.billingSubscriptions.lsSubscriptionId,
      lsCustomerId: schema.billingSubscriptions.lsCustomerId,
      status: schema.billingSubscriptions.status,
      endsAt: schema.billingSubscriptions.endsAt,
    })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.userId, claimed))
    .limit(1);
  if (
    existing !== undefined &&
    existing.lsSubscriptionId !== lsSubscriptionId &&
    isEntitled(existing, now)
  ) {
    if (existing.lsCustomerId === null || patch.lsCustomerId === null) {
      // Cannot discriminate. ALLOW — refusing over a missing field would break a
      // legitimate resubscribe — but record it, because replacing a live
      // subscription is rare enough to be worth a look either way.
      return {
        userId: claimed,
        event: {
          reason: 'replaced_live_subscription_unverified_customer',
          lsSubscriptionId,
          claimedUserId: claimed,
          allowed: true,
        },
      };
    }
    if (existing.lsCustomerId !== patch.lsCustomerId) {
      return {
        userId: null,
        event: {
          reason: 'would_evict_live_subscription',
          lsSubscriptionId,
          claimedUserId: claimed,
          evictedSubscriptionId: existing.lsSubscriptionId,
        },
      };
    }
  }
  return { userId: claimed };
}

// One notice, only when there is something to say: live VERIFIED paid channels
// that keep working past the lapse. Delivered through the owner's matrix-
// eligible channels (owner_notices class), preferring email — the channel type
// that stays free.
async function enqueueDowngradeNotice(db: Database, userId: UserId, now: Date): Promise<void> {
  const paid = await db
    .select({ id: schema.notificationChannels.id })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
        inArray(schema.notificationChannels.channelType, [...PRO_CHANNEL_TYPES]),
      ),
    )
    .limit(1);
  if (paid.length === 0) return;

  const eligible = await eligibleChannels(db, userId, 'owner_notices');
  const target = eligible.find((c) => c.channelType === 'email') ?? eligible[0];
  if (target === undefined) return;
  await db.insert(schema.notificationDeliveries).values({
    channelId: target.id,
    userId,
    purpose: 'plan_downgraded',
    status: 'queued',
    nextAttemptAt: now,
    payloadSummary: 'plan lapsed — enrolled channels keep delivering',
  });
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

function dateOrNull(v: unknown): Date | null {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
