import type { BillingPlan, VaultTier } from './enums.js';

// Per-plan hard limits (docs/28). These are ENFORCED server-side at creation
// time, and the SAME numbers drive the pricing/upgrade copy — so what the site
// advertises can never drift from what the code actually gates. `null` means
// unlimited. Storage is the total attachment budget in bytes.
//
// The one paid plan is 'pro' (shown as "Personal" in the UI). Free is the
// deliberately small tier — enough to prove it works for you, not to live in.

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface PlanLimits {
  /** Max trusted contacts (owner-side rows). null = unlimited. */
  maxContacts: number | null;
  /** Max live (non-deleted) vault items. null = unlimited. */
  maxVaultItems: number | null;
  /** Total encrypted-attachment storage budget, in bytes. */
  maxStorageBytes: number;
  /**
   * This plan's share of AI capacity, as a MULTIPLIER of the configured
   * `AI_USER_DAILY_TOKEN_BUDGET`. 1 = exactly that budget, 3 = three times it.
   * Inert when the variable is unset (no per-user breaker at all, as before).
   */
  aiTokenBudgetMultiplier: number;
  /**
   * Whether this plan's accounts are gated by the DEPLOYMENT-WIDE daily budget
   * (`AI_DAILY_TOKEN_BUDGET`) in addition to their own.
   *
   * This is the two-pool split. The shared ceiling is first-come with no
   * reservation, so before this a single heavy account could exhaust it and every
   * other account's AI surfaces read `unavailable` for the rest of the UTC day,
   * having spent nothing themselves (proven in guard.test.ts §"the GLOBAL budget
   * is a shared pool"). A paying customer losing a feature they bought because a
   * stranger was busy is the failure worth designing out.
   *
   * So: paid capacity is GUARANTEED (bounded by the per-account cap alone, which
   * scales with revenue), free capacity is OPPORTUNISTIC (bounded by the cap AND
   * whatever the deployment has left). Total exposure stays predictable:
   * (paid accounts x paid cap) + (free traffic, capped by the global ceiling).
   */
  aiGatedByGlobalBudget: boolean;
}

export const PLAN_LIMITS: Record<BillingPlan, PlanLimits> = {
  free: {
    maxContacts: 2,
    maxVaultItems: 5,
    maxStorageBytes: 10 * MB,
    aiTokenBudgetMultiplier: 1,
    aiGatedByGlobalBudget: true,
  },
  pro: {
    maxContacts: null,
    maxVaultItems: null,
    maxStorageBytes: 5 * GB,
    aiTokenBudgetMultiplier: 3,
    aiGatedByGlobalBudget: false,
  },
};

export function planLimits(plan: BillingPlan): PlanLimits {
  return PLAN_LIMITS[plan];
}

// How many trusted contacts each tier's share split requires. S1 seals an
// envelope to one contact; S2 is a flat 2-of-3 where the release passphrase is
// the third share; S3 is the nested scheme — a 2-of-3 across THREE contacts
// under a mandatory passphrase mask (docs/24). The owner-side split enforces
// these exactly (`chosen.length !== need` in the Contacts assign form).
//
// They live here, beside PLAN_LIMITS, because the two TOGETHER decide which
// tiers a plan can actually complete — and the pricing copy makes that claim.
// Keeping them in the web screen meant nothing could compare them: Free caps
// contacts at 2, so S3 has never been reachable on it, while the landing page,
// the upgrade page and the docs/28 table all listed "All release tiers (S1–S3)"
// as a Free feature (found QA 2026-08-10). Deriving the copy from these numbers
// is what stops that being re-asserted by hand.
export const TIER_CONTACT_COUNT: Record<VaultTier, number> = { s1: 1, s2: 2, s3: 3 };

// The release tiers a plan's contact cap can actually COMPLETE, in ladder order.
//
// Note what this is not: it is not a gate. Nothing stops a free owner filing an
// item into S3 — the tier is an attribute of the item, and gating it would
// strand items that existing accounts have already put there. What the cap
// stops is the SHARE SPLIT, so an S3 item on a 2-contact plan is stored, sealed
// and unreleasable. That is precisely why the copy must not promise the tier:
// the failure is silent, and it lands on the most sensitive rung.
export function releaseTiersFor(plan: BillingPlan): VaultTier[] {
  const cap = PLAN_LIMITS[plan].maxContacts;
  const tiers: VaultTier[] = ['s1', 's2', 's3'];
  if (cap === null) return tiers;
  return tiers.filter((t) => TIER_CONTACT_COUNT[t] <= cap);
}
