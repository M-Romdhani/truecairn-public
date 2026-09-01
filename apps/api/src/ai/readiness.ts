import { schema, type Database } from '@truecairn/db';
import {
  RELEASE_SHARE_INDEX_S2,
  S2_THRESHOLD,
  S3_NESTED_CONTACT_THRESHOLD,
} from '@truecairn/keys';
import {
  VAULT_TIERS,
  type EngineState,
  type UserId,
  type VaultTier,
} from '@truecairn/shared';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

// ── Deterministic continuity-readiness scorer (plan docs/25 §5 / D2) ──────────
//
// A pure function over server-visible METADATA that decides whether a user's
// digital-continuity setup can actually work — expressed as a score plus a list of
// TYPED gaps (closed enums + numbers, never free text). The LLM never runs this
// logic; at most it renders the explanation prose for a gap. This is the technical
// anchor for the readiness proposals: the AI can only surface a gap this
// deterministic check found — it cannot invent one.
//
// The headline gap is the S3 role-diversity case from the audit: a release
// consensus must span >= 2 distinct contact roles (packages/ceremony diverseRole
// rule), so contacts assigned to a tier all sharing one role can NEVER reconstruct.

// Days after which an untouched vault item is flagged stale (a warning, not a
// blocker). A constant for now; lift to config if a tier ever needs its own.
const STALE_ITEM_DAYS = 180;

// Flat, tier-prefixed gap codes — matches the plan's `flag_readiness_gap` payload
// (`{ gap: 's3_role_diversity_unsatisfiable' }`). Adding a code is a conscious,
// reviewable change (the proposal schema + docs/AI.md list must track it).
export const READINESS_GAP_CODES = [
  'no_vault_items',
  'no_enrolled_contacts',
  's1_beneficiary_unset',
  's2_coverage_insufficient',
  's3_coverage_insufficient',
  's2_role_diversity_unsatisfiable',
  's3_role_diversity_unsatisfiable',
  's2_passphrase_slot_unset',
  'engine_not_armed',
  'checkin_overdue',
  'stale_items',
  'no_verified_channel',
  'contact_key_unconfirmed',
] as const;
export type ReadinessGapCode = (typeof READINESS_GAP_CODES)[number];

export type GapSeverity = 'blocker' | 'warning';

export interface ReadinessGap {
  code: ReadinessGapCode;
  severity: GapSeverity;
  tier?: VaultTier;
  // Numeric/enum context only — never free text (keeps the gap safe to send to the
  // LLM for prose and safe to store in a proposal payload).
  detail?: Record<string, number>;
}

export interface ReadinessReport {
  score: number; // 0..100
  gaps: ReadinessGap[];
}

export interface TierShareInfo {
  // Active contact-type release_shares assigned for the tier.
  contactShareCount: number;
  // Distinct contact ROLES among those share-holders (diversity satisfiability).
  distinctRoles: number;
}

export interface ReadinessInputs {
  now: Date;
  engineState: EngineState | null;
  nextScheduledCheckInAt: Date | null;
  itemsByTier: Record<VaultTier, number>;
  enrolledContactCount: number;
  shares: Record<VaultTier, TierShareInfo>;
  s2PassphraseSlotSet: boolean;
  beneficiariesByTier: Record<VaultTier, number>;
  staleItemCount: number;
  // Verified, non-removed notification channels. A count, like everything else
  // here — never a destination, and never a channel type.
  verifiedChannelCount: number;
  // Enrolled contacts that HAVE a published key but whose safety number the owner
  // has never confirmed. A count — never an identity.
  unconfirmedKeyPinCount: number;
}

const SEVERITY_DEDUCTION: Record<GapSeverity, number> = { blocker: 20, warning: 8 };
// Engine states in which a check-in is expected (so "overdue" is meaningful).
const CHECKIN_STATES: ReadonlySet<EngineState> = new Set([
  'active',
  'check_in_pending',
  'escalation_pending',
]);

// The pure scorer — golden-testable without a DB. Deterministic: same inputs,
// same gaps, same score.
export function scoreReadiness(i: ReadinessInputs): ReadinessReport {
  const gaps: ReadinessGap[] = [];
  const totalItems = VAULT_TIERS.reduce((n, t) => n + i.itemsByTier[t], 0);

  if (totalItems === 0) {
    gaps.push({ code: 'no_vault_items', severity: 'blocker' });
    // Suppressing every other gap is right: with nothing to protect they are all
    // moot, and listing them would nag a new owner about S2 shares for items that
    // do not exist. Scoring uniformly is NOT right, and was F-04. An empty vault
    // is the one state where a release can never do anything at all — it is 0%
    // ready, not the 80% that "100 minus one blocker" produced. That phantom 80
    // outranked every account that had started filling a vault, so the owner's
    // first correct action cost them 20 points and the ring taught them to
    // distrust it exactly when it was meant to be guiding them.
    //
    // Scored explicitly instead of through finalize() because the deduction model
    // measures gaps against an applicable baseline, and here there is no
    // applicable baseline yet — every other check is undefined rather than passed.
    return { score: 0, gaps };
  }
  if (i.enrolledContactCount === 0) {
    gaps.push({ code: 'no_enrolled_contacts', severity: 'blocker' });
  }

  // S1 — a sealed-envelope tier: readiness = a designated beneficiary exists.
  if (i.itemsByTier.s1 > 0 && i.beneficiariesByTier.s1 === 0) {
    gaps.push({ code: 's1_beneficiary_unset', severity: 'blocker', tier: 's1' });
  }

  // S2 / S3 — Shamir tiers. Coverage first (can a quorum form at all?), then
  // role-diversity (can a quorum be DIVERSE?), then the S2 passphrase fallback.
  assessShamirTier(gaps, 's2', S2_THRESHOLD, i, {
    coverage: 's2_coverage_insufficient',
    diversity: 's2_role_diversity_unsatisfiable',
  });
  assessShamirTier(gaps, 's3', S3_NESTED_CONTACT_THRESHOLD, i, {
    coverage: 's3_coverage_insufficient',
    diversity: 's3_role_diversity_unsatisfiable',
  });
  if (i.itemsByTier.s2 > 0 && !i.s2PassphraseSlotSet) {
    gaps.push({ code: 's2_passphrase_slot_unset', severity: 'warning', tier: 's2' });
  }

  // Engine lifecycle.
  const hasContacts = i.enrolledContactCount > 0;
  if (hasContacts && (i.engineState === null || i.engineState === 'pre_active')) {
    gaps.push({ code: 'engine_not_armed', severity: 'warning' });
  }
  if (
    i.engineState !== null &&
    CHECKIN_STATES.has(i.engineState) &&
    i.nextScheduledCheckInAt !== null &&
    i.nextScheduledCheckInAt.getTime() < i.now.getTime()
  ) {
    gaps.push({ code: 'checkin_overdue', severity: 'warning' });
  }
  if (i.staleItemCount > 0) {
    gaps.push({ code: 'stale_items', severity: 'warning', detail: { count: i.staleItemCount } });
  }

  // F-07 (docs/38): the engine is running and the owner has no verified way to be
  // reached. `eligibleChannels` returns [] with no verified channel, so the
  // check-in request is not failed — it is never created. The owner is asked
  // nothing, answers nothing, and the ladder reads that silence exactly as it
  // reads real inactivity: escalation, then release. That is docs/13's false-
  // inactivity threat arriving through an empty table rather than an attacker.
  //
  // A BLOCKER, and scoped to the states where the engine actually sends check-ins
  // (the same gate `checkin_overdue` uses). Before arming there is no request to
  // miss, and `engine_not_armed` already covers "you have not started" — firing
  // here too would put two gaps on the same new-owner screen for one situation.
  if (i.engineState !== null && CHECKIN_STATES.has(i.engineState) && i.verifiedChannelCount === 0) {
    gaps.push({ code: 'no_verified_channel', severity: 'blocker' });
  }

  // An enrolled contact whose safety number was never confirmed cannot hold a
  // release share: the browser pins the key the owner confirmed out of band and
  // refuses to seal to any other, so the assign control only exists once a
  // contact reads 'verified' (migration 0061, the C-1 key-substitution fix).
  //
  // That gate is right, and it fails SILENTLY from the owner's side: they enrol
  // three people, believe they are covered, and the coverage blockers above say
  // only that too few shares are assigned — never that the reason is three
  // unconfirmed keys. This gap is the missing WHY, which is also why it is a
  // warning: the coverage gap is the blocker, this explains it.
  //
  // What it CANNOT do, and the UI must never imply otherwise (docs/38 §5): detect
  // an owner who clicked confirm without making the call. Nothing can. It makes
  // SKIPPING the step visible, not the step itself verifiable.
  if (i.unconfirmedKeyPinCount > 0) {
    gaps.push({
      code: 'contact_key_unconfirmed',
      severity: 'warning',
      detail: { count: i.unconfirmedKeyPinCount },
    });
  }

  return finalize(gaps);
}

function assessShamirTier(
  gaps: ReadinessGap[],
  tier: 's2' | 's3',
  contactThreshold: number,
  i: ReadinessInputs,
  codes: { coverage: ReadinessGapCode; diversity: ReadinessGapCode },
): void {
  if (i.itemsByTier[tier] === 0) return; // no items in this tier — not applicable
  const share = i.shares[tier];
  if (share.contactShareCount < contactThreshold) {
    gaps.push({
      code: codes.coverage,
      severity: 'blocker',
      tier,
      detail: { assigned: share.contactShareCount, needed: contactThreshold },
    });
    return; // coverage first; diversity is only meaningful once a quorum can form
  }
  if (share.distinctRoles < 2) {
    gaps.push({
      code: codes.diversity,
      severity: 'blocker',
      tier,
      detail: { distinctRoles: share.distinctRoles, needed: 2 },
    });
  }
}

function finalize(gaps: ReadinessGap[]): ReadinessReport {
  const deduction = gaps.reduce((sum, g) => sum + SEVERITY_DEDUCTION[g.severity], 0);
  return { score: Math.max(0, 100 - deduction), gaps };
}

// Gather the deterministic inputs from server-side metadata. Reads only what the
// server already holds (item counts, contact roles/statuses, share assignments,
// beneficiary configs, engine cadence) — no ciphertext, no secret. The RESULT
// (score + typed gaps) is what may reach the LLM, never these raw reads.
export async function gatherReadinessInputs(db: Database, userId: UserId): Promise<ReadinessInputs> {
  const now = new Date();

  const [es] = await db
    .select({
      state: schema.engineStates.state,
      nextScheduledCheckInAt: schema.engineStates.nextScheduledCheckInAt,
    })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);

  const itemRows = await db
    .select({ tier: schema.vaultItems.tier, n: sql<number>`count(*)::int` })
    .from(schema.vaultItems)
    .where(and(eq(schema.vaultItems.userId, userId), isNull(schema.vaultItems.deletedAt)))
    .groupBy(schema.vaultItems.tier);

  const staleBefore = new Date(now.getTime() - STALE_ITEM_DAYS * 24 * 60 * 60 * 1000);
  const [staleRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.vaultItems)
    .where(
      and(
        eq(schema.vaultItems.userId, userId),
        isNull(schema.vaultItems.deletedAt),
        lt(schema.vaultItems.updatedAt, staleBefore),
      ),
    );

  const enrolledRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.ownerUserId, userId),
        isNull(schema.contacts.removedAt),
        inArray(schema.contacts.status, ['enrolled', 'active']),
      ),
    );

  // Active contact-type shares per tier, with the distinct role count of the
  // contacts that hold them (the diversity-satisfiability basis).
  const shareRows = await db
    .select({
      tier: schema.releaseShares.tier,
      count: sql<number>`count(*)::int`,
      distinctRoles: sql<number>`count(distinct ${schema.contacts.role})::int`,
    })
    .from(schema.releaseShares)
    .innerJoin(schema.contacts, eq(schema.releaseShares.contactId, schema.contacts.id))
    .where(
      and(
        eq(schema.releaseShares.userId, userId),
        eq(schema.releaseShares.shareType, 'contact'),
        isNull(schema.releaseShares.revokedAt),
      ),
    )
    .groupBy(schema.releaseShares.tier);

  const [s2Passphrase] = await db
    .select({ id: schema.releaseShares.id })
    .from(schema.releaseShares)
    .where(
      and(
        eq(schema.releaseShares.userId, userId),
        eq(schema.releaseShares.tier, 's2'),
        eq(schema.releaseShares.shareIndex, RELEASE_SHARE_INDEX_S2),
        eq(schema.releaseShares.shareType, 'release_passphrase'),
        isNull(schema.releaseShares.revokedAt),
      ),
    )
    .limit(1);

  // Verified + live channels only — the exact predicate `eligibleChannels` uses
  // to decide what a notice can be sent to (packages/notifications/channel-matrix).
  // An unverified or removed row cannot receive anything, so counting it here
  // would report reachability the engine does not have.
  const [channelRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
      ),
    );

  // Enrolled contacts holding a published X25519 key with no confirmation recorded.
  // The key check matters: a contact still mid-enrolment has nothing to confirm
  // yet, so counting them would nag the owner about a step they cannot take.
  const [unconfirmedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.ownerUserId, userId),
        isNull(schema.contacts.removedAt),
        inArray(schema.contacts.status, ['enrolled', 'active']),
        isNotNull(schema.contacts.contactX25519Pubkey),
        isNull(schema.contacts.keyPinConfirmedAt),
      ),
    );

  const beneRows = await db
    .select({ tier: schema.releaseBeneficiaries.tier, n: sql<number>`count(*)::int` })
    .from(schema.releaseBeneficiaries)
    .where(
      and(
        eq(schema.releaseBeneficiaries.userId, userId),
        isNull(schema.releaseBeneficiaries.revokedAt),
      ),
    )
    .groupBy(schema.releaseBeneficiaries.tier);

  const itemsByTier = zeroTiers();
  for (const r of itemRows) itemsByTier[r.tier as VaultTier] = r.n;
  const shares = emptyShares();
  for (const r of shareRows) {
    shares[r.tier as VaultTier] = { contactShareCount: r.count, distinctRoles: r.distinctRoles };
  }
  const beneficiariesByTier = zeroTiers();
  for (const r of beneRows) beneficiariesByTier[r.tier as VaultTier] = r.n;

  return {
    now,
    engineState: es?.state ?? null,
    nextScheduledCheckInAt: es?.nextScheduledCheckInAt ?? null,
    itemsByTier,
    enrolledContactCount: enrolledRows[0]?.n ?? 0,
    shares,
    s2PassphraseSlotSet: s2Passphrase !== undefined,
    beneficiariesByTier,
    staleItemCount: staleRow?.n ?? 0,
    verifiedChannelCount: channelRow?.n ?? 0,
    unconfirmedKeyPinCount: unconfirmedRow?.n ?? 0,
  };
}

function zeroTiers(): Record<VaultTier, number> {
  return Object.fromEntries(VAULT_TIERS.map((t) => [t, 0])) as Record<VaultTier, number>;
}

function emptyShares(): Record<VaultTier, TierShareInfo> {
  return Object.fromEntries(
    VAULT_TIERS.map((t) => [t, { contactShareCount: 0, distinctRoles: 0 }]),
  ) as Record<VaultTier, TierShareInfo>;
}
