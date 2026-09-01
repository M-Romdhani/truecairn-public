import { schema, type Database } from '@truecairn/db';
import type { BillingPlan, NotificationChannelType, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';

// Entitlement is DERIVED, never a stored flag: a user is 'pro' exactly when
// they have a LemonSqueezy subscription row whose status still grants access.
// Absence of a row = 'free'. The billing webhook is the sole writer of the
// row; this module is the sole reader for gating.

// LemonSqueezy statuses that grant access. 'cancelled' is special — LS keeps
// the subscription usable until ends_at, then flips it to 'expired'.
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'on_trial', 'past_due']);

// Channel types that cost money per message — gated to pro (docs/28). Email +
// push are free and always available. 'webhook' is not owner-enrollable.
//
// 'whatsapp' STAYS in this set even though it is withdrawn from enrolment below.
// This set carries BILLING semantics, not availability: the downgrade sweep reads
// it to find residual paid channels a lapsed account still holds, so that the
// plan_downgraded notice fires (billing/webhook.ts). Dropping the entry would
// silently change what happens to an existing WhatsApp row on downgrade — a
// different behaviour from the one intended, on the accounts least able to notice.
export const PRO_CHANNEL_TYPES: ReadonlySet<NotificationChannelType> = new Set([
  'sms',
  'whatsapp',
]);

// Channel types withdrawn from NEW enrolment pending an external unblock. Distinct
// from the paid gate above: a pro plan does not buy these, because nobody can have
// them at any price right now.
//
// whatsapp (2026-08-01): Meta refuses to let this WhatsApp Business account create
// `truecairn_channel_verification` — "Ce compte WhatsApp Business n'a pas
// l'autorisation de créer un modèle de message". That template is the one that
// gates enrolment ITSELF: the verification code round-trip is how a channel becomes
// verified, so without it a WhatsApp channel cannot be created at all. The other
// eight truecairn_* templates are approved and Active, which buys nothing on its
// own — every WhatsApp notice depends on a channel that can never be verified.
// Offering it would send a paying user into a flow that cannot complete.
//
// Deliberately NOT env-derived. A repo constant cannot be switched on by a stray
// production variable, and it makes re-enabling a reviewed commit rather than a
// dashboard edit. Template identity is already repo-owned config for the same
// reason (whatsapp-templates.ts). To re-enable: approve the template at Meta, set
// WHATSAPP_CLOUD_*, then delete the entry here.
//
// The adapter, template map and their tests are retained and untouched — this
// withdraws the OFFER, not the capability. Existing verified rows are grandfathered
// (never re-gated, docs/28); only new enrolment is refused.
export const WITHDRAWN_CHANNEL_TYPES: ReadonlySet<NotificationChannelType> = new Set([
  'whatsapp',
]);

export function isEntitled(
  sub: { status: string; endsAt: Date | null } | undefined,
  now: Date,
): boolean {
  if (sub === undefined) return false;
  if (LIVE_STATUSES.has(sub.status)) return true;
  // A cancelled subscription keeps access until the paid period ends.
  if (sub.status === 'cancelled' && sub.endsAt !== null && sub.endsAt > now) return true;
  return false;
}

export interface Entitlement {
  plan: BillingPlan;
  status: string | null;
  renewsAt: string | null;
  endsAt: string | null;
}

export async function getEntitlement(
  db: Database,
  userId: UserId,
  now: Date,
): Promise<Entitlement> {
  const [sub] = await db
    .select({
      status: schema.billingSubscriptions.status,
      renewsAt: schema.billingSubscriptions.renewsAt,
      endsAt: schema.billingSubscriptions.endsAt,
    })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.userId, userId));
  const pro = isEntitled(sub, now);
  return {
    plan: pro ? 'pro' : 'free',
    status: sub?.status ?? null,
    renewsAt: sub?.renewsAt?.toISOString() ?? null,
    endsAt: sub?.endsAt?.toISOString() ?? null,
  };
}

// The channel types this user may enrol, given their plan. Free = email+push;
// pro = + the paid channels. The Settings picker renders from this, and the
// enrolment route enforces it (defense in depth).
//
// `configured` is what the DEPLOYMENT can actually deliver — the provider
// credentials that are present. Entitlement alone was the input until
// 2026-08-31, and that was the WhatsApp bug wearing different clothes: a pro
// plan on a deployment with no TWILIO_* would offer `sms`, the verification code
// would dead-letter, and the channel could NEVER become verified — because in
// this design the code round-trip IS how a channel becomes verified. The comment
// on WITHDRAWN_CHANNEL_TYPES says that set exists so nobody is sent "into a flow
// that cannot complete"; an unconfigured provider is exactly that flow, arrived
// at from the other direction.
//
// Subtraction order is load-bearing. Unconfigured first, withdrawn LAST, so a
// withdrawn type disappears for every plan rather than reading as something a
// paid plan would unlock — and an unconfigured one never reads as an upsell.
//
// This changes what is OFFERED, never what already exists: verified rows are
// grandfathered and are never re-gated (docs/28), same shape as the WhatsApp
// withdrawal.
export function enrollableChannelTypes(
  plan: BillingPlan,
  configured: ReadonlySet<NotificationChannelType>,
): NotificationChannelType[] {
  const free: NotificationChannelType[] = ['email', 'push'];
  const all = plan === 'pro' ? [...free, ...PRO_CHANNEL_TYPES] : free;
  return all.filter((t) => configured.has(t) && !WITHDRAWN_CHANNEL_TYPES.has(t));
}
