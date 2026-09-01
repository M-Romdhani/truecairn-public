import { schema, type Database } from '@truecairn/db';
import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  type NotificationChannelType,
  type NotificationPurpose,
} from '@truecairn/shared';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { renderTemplate } from './templates.js';
import { ProviderError, type NotificationProvider } from './types.js';

export interface DeliveryContext {
  db: Database;
  // Registry by channel type. A type with no provider dead-letters honestly
  // (no_provider_configured) — never a silent no-op success (PHASE3_5 §a).
  providers: Map<NotificationChannelType, NotificationProvider>;
  now: Date;
}

export interface DeliveryResult {
  processed: number;
  sent: number;
  retried: number;
  deadLettered: number;
}

const STUCK_SENDING_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const FAILING_THRESHOLD = 3;
// Backoff per failed attempt (1-indexed): attempt 1 failed -> wait BACKOFF[0]...
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];

// One delivery-worker pass: claim due + stuck rows, send each via its channel's
// provider, record the outcome + the channel health. Same FOR UPDATE SKIP LOCKED
// pattern as the sensitive-action processor. The external send happens OUTSIDE any
// transaction; a crash between send and record leaves the row 'sending', which the
// next pass reclaims and re-sends with the same idempotency key (provider dedups).
export async function tickDeliveries(ctx: DeliveryContext, limit: number): Promise<DeliveryResult> {
  const result: DeliveryResult = { processed: 0, sent: 0, retried: 0, deadLettered: 0 };

  // Phase 1: claim — mark 'sending', commit, before any external call.
  const claimed: string[] = [];
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const stuckBefore = new Date(ctx.now.getTime() - STUCK_SENDING_MS);
    const rows = await tx
      .select({ id: schema.notificationDeliveries.id })
      .from(schema.notificationDeliveries)
      .where(
        or(
          and(
            eq(schema.notificationDeliveries.status, 'queued'),
            or(
              isNull(schema.notificationDeliveries.nextAttemptAt),
              lte(schema.notificationDeliveries.nextAttemptAt, ctx.now),
            ),
          ),
          and(
            eq(schema.notificationDeliveries.status, 'sending'),
            lte(schema.notificationDeliveries.updatedAt, stuckBefore),
          ),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(limit);
    for (const r of rows) {
      await tx
        .update(schema.notificationDeliveries)
        .set({
          status: 'sending',
          attemptCount: sql`${schema.notificationDeliveries.attemptCount} + 1`,
          updatedAt: ctx.now,
        })
        .where(eq(schema.notificationDeliveries.id, r.id));
      claimed.push(r.id);
    }
  });

  // Phase 2: process each claimed row (own tx for the record).
  for (const id of claimed) {
    const tag = await deliverOne(id, ctx);
    result.processed += 1;
    if (tag === 'sent') result.sent += 1;
    else if (tag === 'retried') result.retried += 1;
    else result.deadLettered += 1;
  }
  return result;
}

// ── Which language a notice is written in (docs/40 Phase 3) ─────────────────
//
// THE OWNER'S LANGUAGE, ALWAYS — including the notices a trusted contact
// receives. That is the owner's decision, and it is the one that survives
// contact with the product: the owner chose these people, knows what they read,
// and is the only party who has ever expressed a language preference to us. A
// contact who has an account may have set their own language for their own
// screens, and that is a different question from what language the owner's
// release ceremony speaks in.
//
// So the default is the recipient's own account — correct for every owner-facing
// notice, where recipient and owner are the same person — and the three
// CONTACT-FACING ceremony purposes resolve the owner from the ceremony instead.
// They are the only purposes where the two differ, because they are the only
// ones delivered to somebody else's channel.
//
// A NULL locale means "never chose" and is not the same as choosing English
// (migration 0067). Both render in the source language today; keeping them
// distinct is what lets a future default change apply only to people who never
// expressed a preference.
const CONTACT_FACING_PURPOSES: ReadonlySet<NotificationPurpose> = new Set([
  'ceremony_initiation',
  'ceremony_affirmation_request',
  'ceremony_revocation_window',
]);

async function localeOf(db: Database, userId: string): Promise<Locale> {
  const [u] = await db
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return isLocale(u?.locale) ? u.locale : DEFAULT_LOCALE;
}

async function localeForDelivery(
  db: Database,
  d: { userId: string; purpose: NotificationPurpose; relatedEntityType: string | null; relatedEntityId: string | null },
): Promise<Locale> {
  if (
    CONTACT_FACING_PURPOSES.has(d.purpose) &&
    d.relatedEntityType === 'release_ceremony' &&
    d.relatedEntityId !== null
  ) {
    const [c] = await db
      .select({ userId: schema.releaseCeremonies.userId })
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.id, d.relatedEntityId));
    // A ceremony that has since been deleted falls back to the recipient's own
    // language rather than failing the send. A notice in the wrong language is
    // recoverable; a trusted contact who is never told to open the app is not.
    if (c !== undefined) return localeOf(db, c.userId);
  }
  return localeOf(db, d.userId);
}

type DeliveryTag = 'sent' | 'retried' | 'dead';

async function deliverOne(id: string, ctx: DeliveryContext): Promise<DeliveryTag> {
  const [d] = await ctx.db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, id));
  if (!d || d.status !== 'sending') return 'dead';
  const [ch] = await ctx.db.select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, d.channelId));
  if (!ch || ch.removedAt !== null) {
    await markFailed(ctx.db, id, 'channel_unavailable', ctx.now);
    return 'dead';
  }
  const provider = ctx.providers.get(ch.channelType);
  if (!provider) {
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await markFailed(tx, id, 'no_provider_configured', ctx.now);
      await recordChannelFailure(tx, ch.id, ctx.now);
    });
    return 'dead';
  }

  const locale = await localeForDelivery(ctx.db, d);
  const tmpl = renderTemplate(d.purpose, d.payloadParams ?? undefined, locale);
  // The external send — OUTSIDE any transaction.
  try {
    const r = await provider.send({
      destination: ch.destination,
      subject: tmpl.subject,
      body: tmpl.body,
      ...(tmpl.html !== undefined ? { html: tmpl.html } : {}),
      // The purpose lets a template-based transport (WhatsApp) pick the
      // Meta-approved template this notice was approved as; `variables` is that
      // same body decomposed positionally. Both come from renderTemplate, so
      // the adapter still never composes content.
      purpose: d.purpose,
      templateVariables: tmpl.variables,
      idempotencyKey: id,
    });
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await tx
        .update(schema.notificationDeliveries)
        // payloadParams is cleared on success: the plaintext verification code
        // leaves the DB the moment the provider accepts the send. A retryable
        // failure keeps it (the retry must render the same code).
        .set({ status: 'sent', sentAt: ctx.now, provider: provider.name, providerMessageId: r.providerMessageId, payloadParams: null, updatedAt: ctx.now })
        .where(eq(schema.notificationDeliveries.id, id));
      await recordChannelSuccess(tx, ch.id, ctx.now);
    });
    return 'sent';
  } catch (err) {
    const retryable = err instanceof ProviderError ? err.retryable : true;
    const msg = err instanceof Error ? err.message : String(err);
    return ctx.db.transaction(async (txRaw): Promise<DeliveryTag> => {
      const tx = txRaw as unknown as Database;
      await recordChannelFailure(tx, ch.id, ctx.now);
      if (retryable && d.attemptCount < MAX_ATTEMPTS) {
        const backoff = BACKOFF_MS[Math.min(d.attemptCount - 1, BACKOFF_MS.length - 1)]!;
        await tx
          .update(schema.notificationDeliveries)
          .set({ status: 'queued', nextAttemptAt: new Date(ctx.now.getTime() + backoff), lastError: msg, updatedAt: ctx.now })
          .where(eq(schema.notificationDeliveries.id, id));
        return 'retried';
      }
      await markFailed(tx, id, msg, ctx.now);
      return 'dead';
    });
  }
}

async function markFailed(db: Database, id: string, reason: string, now: Date): Promise<void> {
  await db
    .update(schema.notificationDeliveries)
    .set({ status: 'failed', lastError: reason, updatedAt: now })
    .where(eq(schema.notificationDeliveries.id, id));
}

// Exported so the async-delivery webhook (webhook.ts) credits/debits channel
// health on a provider's delivered/bounced callback with the SAME rules the
// synchronous send path uses — one definition, no drift.
export async function recordChannelSuccess(
  db: Database,
  channelId: string,
  now: Date,
): Promise<void> {
  await db
    .update(schema.notificationChannels)
    .set({ consecutiveFailures: 0, health: 'healthy', lastSuccessAt: now })
    .where(eq(schema.notificationChannels.id, channelId));
}

export async function recordChannelFailure(
  db: Database,
  channelId: string,
  now: Date,
): Promise<void> {
  const [ch] = await db
    .select({ cf: schema.notificationChannels.consecutiveFailures })
    .from(schema.notificationChannels)
    .where(eq(schema.notificationChannels.id, channelId))
    .for('update');
  const cf = (ch?.cf ?? 0) + 1;
  await db
    .update(schema.notificationChannels)
    .set({ consecutiveFailures: cf, health: cf >= FAILING_THRESHOLD ? 'failing' : 'degraded', lastFailureAt: now })
    .where(eq(schema.notificationChannels.id, channelId));
}
