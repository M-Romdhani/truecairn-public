// DISPLAY pricing for the one paid plan — "Truecairn Personal" (internally the
// 'pro' entitlement). The AUTHORITATIVE charge always comes from the LemonSqueezy
// hosted checkout; these are the marketing figures shown on the landing + upgrade
// pages and MUST track the LemonSqueezy variant prices (docs/28):
//   • Monthly — $8 / month, billed monthly.
//   • Annual  — $80 / year, billed annually (~2 months free vs monthly).
// Pure constants + math — NO api/crypto imports, so this is safe to pull into the
// crypto-free public landing chunk (main.tsx boundary).

import { PLAN_LIMITS, releaseTiersFor, type BillingPlan } from '@truecairn/shared';

export type BillingPeriod = 'monthly' | 'yearly';

// The enforced per-plan limits (docs/28), re-exported so the marketing/upgrade
// copy renders the SAME numbers the server gates on — the two can never drift.
export const FREE_LIMITS = PLAN_LIMITS.free;
export const PERSONAL_LIMITS = PLAN_LIMITS.pro;

// How a plan's USABLE release tiers read in pricing copy — "S1–S3" when the
// whole ladder is reachable, "S1 & S2" when the contact cap stops short of S3.
// Derived from releaseTiersFor rather than written out, because writing it out
// is exactly how the Free card came to advertise a tier its own contact cap
// makes impossible to assign (QA 2026-08-10, docs/28).
export function releaseTiersLabel(plan: BillingPlan): string {
  const tiers = releaseTiersFor(plan).map((t) => t.toUpperCase());
  const first = tiers[0];
  const last = tiers[tiers.length - 1];
  if (first === undefined || last === undefined) return 'none';
  if (tiers.length === 1) return first;
  if (tiers.length === 2) return `${first} & ${last}`;
  return `${first}–${last}`;
}

// Human byte size for storage limits/usage. Whole numbers stay clean ("10 MB",
// "5 GB"); otherwise one decimal ("4.2 MB").
export function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const KB = 1024;
  if (bytes >= GB) return `${trim(bytes / GB)} GB`;
  if (bytes >= MB) return `${trim(bytes / MB)} MB`;
  if (bytes >= KB) return `${trim(bytes / KB)} KB`;
  return `${bytes} B`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export const PERSONAL_PRICE = {
  /** Billed monthly: US dollars per month. */
  monthlyPerMonth: 8,
  /** Billed annually: US dollars per year (~2 months free vs monthly). */
  annualPerYear: 80,
} as const;

/** Effective $/month when billed annually (annual total ÷ 12). */
export const personalAnnualPerMonth = PERSONAL_PRICE.annualPerYear / 12;

/** Whole-dollar savings per year from choosing annual over monthly. */
export const personalAnnualSavings = PERSONAL_PRICE.monthlyPerMonth * 12 - PERSONAL_PRICE.annualPerYear;

/** Rounded percent saved from choosing annual over monthly. */
export const personalAnnualSavingsPct = Math.round(
  (personalAnnualSavings / (PERSONAL_PRICE.monthlyPerMonth * 12)) * 100,
);

/** The $/month figure to headline for a period: the monthly rate, or the annual
 *  plan's effective monthly. */
export function personalPerMonth(period: BillingPeriod): number {
  return period === 'yearly' ? personalAnnualPerMonth : PERSONAL_PRICE.monthlyPerMonth;
}

/** Map a UI period to the checkout plan slug the billing API expects. */
export function checkoutPlanFor(period: BillingPeriod): 'pro_monthly' | 'pro_annual' {
  return period === 'yearly' ? 'pro_annual' : 'pro_monthly';
}

/** Split a dollar amount into whole dollars + two-digit cents for the big
 *  "$6" + ".67" price display. */
export function splitPrice(amount: number): { dollars: string; cents: string } {
  const cents = Math.round(amount * 100);
  return {
    dollars: String(Math.floor(cents / 100)),
    cents: String(cents % 100).padStart(2, '0'),
  };
}
