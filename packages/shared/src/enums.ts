// TypeScript mirrors of the Postgres ENUM types declared in
// packages/db/migrations/0001_enums.sql. Keep these two files in lockstep —
// they are the canonical list of valid values for every closed-set column.

export const ACCOUNT_STATUSES = [
  'pending',
  'active',
  'locked',
  'recovery',
  'terminated',
  // PHASE3_4: user-requested account deletion (tombstoned, not row-deleted —
  // the audit log survives). Distinct from 'terminated' (platform action).
  'deleted',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const CONTACT_ROLES = ['personal', 'professional', 'recovery'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

// The five recipient types docs/03's matrix is written in terms of, in the order
// its columns appear.
//
// READ THIS BEFORE ADDING ONE. This is a SECOND axis layered over CONTACT_ROLES,
// never a replacement for it. `role` is not a label: `diverseRoleSatisfied` is a
// release gate in packages/ceremony/src/transitions.ts, and docs/14 explains what
// it buys — a conspiracy must span "both personal and professional life", which is
// a materially higher coordination bar than two people who already work together.
//
// If these five ever became the role enum, that bar would silently drop:
// `lawyer_accountant` + `cofounder_business_partner` would read as two different
// roles and satisfy diversity, while in reality both sit in the same professional
// sphere — possibly the same firm, possibly introduced to the owner by each other.
// The rule would keep its letter and lose the thing it protects.
//
// So every type maps down to exactly one existing role, the mapping is total, and
// two types sharing a role can never satisfy diversity between them. Both
// properties are pinned by recipient-type.test.ts.
export const RECIPIENT_TYPES = [
  'spouse_family_executor',
  'cofounder_business_partner',
  'lawyer_accountant',
  'recovery_contact',
  'designated_heir',
] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

// The mapping down to the security role. Total by construction — a Record over
// RecipientType, so adding a type without deciding its role is a compile error
// rather than a runtime surprise at ceremony time.
export const RECIPIENT_TYPE_ROLE: Readonly<Record<RecipientType, ContactRole>> = {
  spouse_family_executor: 'personal',
  // The heir may be the spouse or someone else entirely, but the trust is the
  // same KIND of trust — personal, not institutional. docs/03: "Often the same
  // person as the spouse."
  designated_heir: 'personal',
  // Both professional, deliberately. A cofounder and an accountant are different
  // relationships to the owner and different rows in the matrix, but they are the
  // same sphere of life for collusion purposes, which is the only question `role`
  // answers.
  cofounder_business_partner: 'professional',
  lawyer_accountant: 'professional',
  recovery_contact: 'recovery',
};

// The inverse, for the two places that must infer a TYPE from a ROLE:
//
//   * migration 0066's backfill, for contacts that predate the type axis;
//   * change_contact_role, which moves a contact between roles and would
//     otherwise leave a type behind that contradicts the new role — a state the
//     database refuses (contacts_recipient_type_matches_role), so the sensitive
//     action would fail at APPLY time, in the worker, seven days after the owner
//     asked for it and with no obvious cause.
//
// The inverse is not a function — two types share `personal` and two share
// `professional` — so this picks a REPRESENTATIVE, and the choice is the
// narrowest column in docs/03's matrix for that role. Inferring is a guess, and a
// guess about who receives someone's estate should err toward reaching fewer
// people, never more. The owner can change it; they cannot un-send a release.
export const REPRESENTATIVE_TYPE_FOR_ROLE: Readonly<Record<ContactRole, RecipientType>> = {
  // spouse_family_executor and designated_heir differ in exactly one cell:
  // asset_inventory is S1 for the spouse and S2 for the heir. Neither is
  // uniformly narrower, and the spouse column never grants access LATER than the
  // heir's, so the spouse is the safe default for a row we are guessing about.
  personal: 'spouse_family_executor',
  // cofounder receives three categories; lawyer_accountant receives four.
  professional: 'cofounder_business_partner',
  recovery: 'recovery_contact',
};

// Algorithm of a contact's affirmation key. V1 is Ed25519-only; a future
// hardware-key path adds a value here (PHASE3_2 §d).
export const CONTACT_KEY_TYPES = ['ed25519'] as const;
export type ContactKeyType = (typeof CONTACT_KEY_TYPES)[number];

export const CONTACT_STATUSES = [
  'invited',
  'pending_keygen',
  'enrolled',
  'active',
  'rotating',
  'removed',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const VAULT_TIERS = ['s1', 's2', 's3'] as const;
export type VaultTier = (typeof VAULT_TIERS)[number];

// The eight categories docs/03's release-policy matrix is written in terms of.
// `vault_items.category` shipped as free `text` and only ever held values in test
// fixtures, so the matrix — decided in July 2026, never implemented — had no row
// axis to key off and an owner picked a release tier with no guidance at all. The
// quiet failure that allows is the wrong material reaching the wrong person at
// release, discovered when nobody is left to correct it.
//
// NOT a crypto format change. `category` appears in neither `buildOuterLayerAad`
// (user_id, tier, kek_id, generation) nor the item-identity AAD of migration 0062,
// so this does not interact with `aadVersion` and carries none of that risk.
//
// Enforced by CHECK rather than a Postgres enum on purpose: adding a ninth
// category later is then an ALTER of one constraint, not a type migration.
export const VAULT_CATEGORIES = [
  'recovery_instructions',
  'operational_playbooks',
  'asset_inventory',
  'identity_documents',
  'financial_accounts',
  'legal_documents',
  'crypto_wallets',
  'personal_archive',
] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

export const ENGINE_STATES = [
  'pre_active',
  'active',
  'check_in_pending',
  'notification_stalled',
  'escalation_pending',
  'release_review',
  'limited_release',
  'staged_release',
  'full_release',
  'returning',
  'review_required',
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

export const CEREMONY_STATUSES = [
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
  'released',
  'cancelled',
  'failed',
] as const;
export type CeremonyStatus = (typeof CEREMONY_STATUSES)[number];

export const AFFIRMATION_STATUSES = ['pending', 'tentative', 'committed', 'revoked'] as const;
export type AffirmationStatus = (typeof AFFIRMATION_STATUSES)[number];

export const RECIPIENT_RECONSTRUCTION_STATUSES = [
  'pending',
  'reconstructing',
  'released',
  'failed',
] as const;
export type RecipientReconstructionStatus = (typeof RECIPIENT_RECONSTRUCTION_STATUSES)[number];

export const SENSITIVE_ACTION_TYPES = [
  'rotate_master_passphrase',
  'rotate_release_passphrase',
  'rotate_recovery_code',
  'add_contact',
  'remove_contact',
  'change_contact_role',
  'rotate_contact',
  // Designated beneficiary (backlog #2): a contact who RECEIVES an S2/S3 release
  // without holding a share or affirming. Designating/removing who inherits the
  // vault is at least as sensitive as assigning a share → step-up + 7-day delay.
  'designate_beneficiary',
  'remove_beneficiary',
  // PHASE3_4: renamed from change_release_threshold (migration 0027). The s2/s3
  // Shamir thresholds are locked (user_tier_keys CHECK); this action changes which
  // factor fills a release-share slot — a release_shares composition change.
  'change_share_composition',
  'change_tier_configuration',
  'change_inactivity_threshold',
  'change_cooldown_window',
  'register_hardware_key',
  'remove_hardware_key',
  'change_email',
  'arm_engine',
  'delete_account',
  // Vault domain (PHASE3_3 Checkpoint B/C). Per-item tier moves + deletion are
  // sensitive: a tier demotion drops an item's release threshold/stage, and a
  // delete destroys data — both get the step-up + 7-day-delay treatment.
  'set_vault_item_tier',
  'delete_vault_item',
  'purge_attachment',
  // Removing a VERIFIED notification channel (docs/26 §4 follow-on): a stolen
  // session must not be able to silence the owner's check-in reminders, so the
  // removal gets step-up + the delay — during which the channel being removed
  // still receives the notice (docs/10-threat-5.2). Unverified channels are
  // never selected for notices, so their removal stays immediate.
  'remove_channel',
] as const;
export type SensitiveActionType = (typeof SENSITIVE_ACTION_TYPES)[number];

export const SENSITIVE_ACTION_STATUSES = [
  'pending',
  'applied',
  'cancelled',
  'expired',
] as const;
export type SensitiveActionStatus = (typeof SENSITIVE_ACTION_STATUSES)[number];

// 'whatsapp' added by migration 0046 (CV-3): same Twilio transport as sms,
// whatsapp:-prefixed addressing; its read receipts are deliberately ignored
// (docs/26 D2 — delivered/bounced only, never read).
export const NOTIFICATION_CHANNEL_TYPES = ['email', 'sms', 'push', 'webhook', 'whatsapp'] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export const NOTIFICATION_CHANNEL_HEALTHS = ['healthy', 'degraded', 'failing'] as const;
export type NotificationChannelHealth = (typeof NOTIFICATION_CHANNEL_HEALTHS)[number];

export const NOTIFICATION_PURPOSES = [
  'check_in_request',
  'escalation_request',
  'sensitive_action_notice',
  'ceremony_initiation',
  'ceremony_affirmation_request',
  'ceremony_revocation_window',
  'engine_state_change',
  'contact_invitation',
  'health_probe',
  // PHASE3_5: the user-facing 3.1 account-lock anomaly notice.
  'security_alert',
  // Continuity Verification CV-0.0 (docs/26): the channel-enrolment code
  // round-trip. The ONE purpose whose body carries a per-delivery value (the
  // server-generated code, random noise tied to no content) — injected by
  // renderTemplate from payload_params, never by an enqueuer-written body.
  'channel_verification',
  // Onboarding welcome (CV-brand pass): a one-time, fully-branded email sent
  // when a user verifies their FIRST email channel — the first moment we have a
  // confirmed reachable address. Transactional, not marketing; the only notice
  // whose body is rich rather than bare (it carries no vault content either).
  'welcome',
  // Billing (docs/28): a one-time notice when a subscription lapses while paid
  // channels (SMS/WhatsApp) are still enrolled. Those channels keep delivering —
  // money never silences a channel that already guards a vault — and this
  // notice says so. Fired on the entitled→not-entitled webhook edge only, so
  // replays never re-send.
  'plan_downgraded',
] as const;
export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];

export const DELIVERY_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'confirmed',
  'bounced',
  'failed',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const SHARE_TYPES = [
  'contact',
  'release_passphrase',
  'hardware_key',
  'second_professional_contact',
] as const;
export type ShareType = (typeof SHARE_TYPES)[number];

// Billing plans (LemonSqueezy). 'free' is the default (no subscription row);
// 'pro' is any entitled LemonSqueezy subscription. One paid plan today — the
// monthly/annual split is a price/variant difference in LS, not a distinct
// entitlement, so it does not appear here.
export const BILLING_PLANS = ['free', 'pro'] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

// Optional honorific shown before the display name in the account menu. Pure
// display metadata — never used for auth, crypto, or release. The UI offers a
// "None" choice (no honorific) alongside these; "None" is stored as NULL.
export const HONORIFIC_TITLES = ['Mr.', 'Mrs.', 'Ms.', 'Mx.', 'Dr.', 'Prof.'] as const;
export type HonorificTitle = (typeof HONORIFIC_TITLES)[number];

// Continuity Verification (docs/26). The channel matrix's purpose classes: an
// owner opts a channel in/out of a class, and absent preference = enabled
// (today's behaviour). owner_verification is the check-in/escalation blitz;
// owner_notices are routine state/sensitive-action notices; contact_notices
// are ceremony requests on the contact's own account.
export const CV_PURPOSE_CLASSES = [
  'owner_verification',
  'owner_notices',
  'contact_notices',
] as const;
export type CvPurposeClass = (typeof CV_PURPOSE_CLASSES)[number];

// Which matrix class governs a purpose AT CHANNEL-SELECTION TIME (docs/26 §4
// "Matrix enforcement for owner_notices/contact_notices"). Purposes mapped here
// are skipped on channels the owner opted out; unmapped purposes are EXEMPT —
// always delivered — and each exemption is a deliberate safety decision:
//   - check_in_request / escalation_request: the engine's primary continuity
//     notices are the safety floor. The owner_verification class narrows only
//     the CV cadence's extra fanout waves (eligibleChannels enforces it there);
//     a matrix row must never be able to fully silence "are you alive?".
//   - security_alert: the anomaly lane. A session that can quietly opt the
//     owner out of compromise alerts defeats the alert's purpose.
//   - channel_verification / welcome / health_probe: operational — the
//     round-trip must reach the very channel being proven.
// The matrix can only ever narrow selection; verified-and-live filtering
// happens before it everywhere.
export const ROUTINE_NOTICE_CLASSES: Readonly<
  Partial<Record<NotificationPurpose, CvPurposeClass>>
> = {
  engine_state_change: 'owner_notices',
  sensitive_action_notice: 'owner_notices',
  plan_downgraded: 'owner_notices',
  ceremony_initiation: 'contact_notices',
  ceremony_affirmation_request: 'contact_notices',
  ceremony_revocation_window: 'contact_notices',
  // No auto-producer today (invite tokens travel out of band) — classified for
  // the day one exists.
  contact_invitation: 'contact_notices',
};

export function routineNoticeClass(purpose: NotificationPurpose): CvPurposeClass | null {
  return ROUTINE_NOTICE_CLASSES[purpose] ?? null;
}

// The Continuity Report's deterministic outcome — computed BY RULE from
// provider-proven facts, never scored (docs/26 D3). Definitions:
//   channels_unconfigured        — no verified channel existed to attempt.
//   unreachable_all_channels     — every attempted channel provably failed
//                                  (each attempt bounced or dead-lettered).
//   delivered_no_checkin         — at least one provider-proven delivery, no
//                                  channel provably unreachable — and still
//                                  no authenticated check-in followed.
//   partial_delivery_no_checkin  — the honest middle: a mix of delivered /
//                                  unconfirmed ('sent', no webhook proof) /
//                                  unreachable channels, and no check-in.
export const CONTINUITY_OUTCOMES = [
  'channels_unconfigured',
  'unreachable_all_channels',
  'partial_delivery_no_checkin',
  'delivered_no_checkin',
] as const;
export type ContinuityOutcome = (typeof CONTINUITY_OUTCOMES)[number];

// Who caused an audit_log entry (AI Guardian, plan docs/25 §3.4). A forensic
// discriminator: it lets the chain prove that no `ai` actor ever emitted a
// forward engine event. It is NOT part of the signed canonical entry (adding a
// field there would invalidate every existing entry's hash) — it is defence-in-
// depth metadata written in the SAME transaction as the entry it labels, and the
// asymmetry invariant test asserts an `ai` row only ever carries an allowlisted
// AI event type. Existing appends default to 'owner'; the worker/engine may label
// 'worker'; only the ai-authority chokepoint ever writes 'ai'.
export const AUDIT_ACTORS = ['owner', 'worker', 'ai'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];
