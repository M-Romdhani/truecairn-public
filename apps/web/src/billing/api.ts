// Billing client (LemonSqueezy). Status is a plain read; checkout returns a
// hosted LemonSqueezy URL the browser redirects to — no card data ever touches
// our origin. Prices live in LemonSqueezy, not here.

import type { BillingPlan } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';

export interface BillingStatus {
  plan: BillingPlan;
  status: string | null;
  renewsAt: string | null;
  endsAt: string | null;
  /**
   * The store's billing page, where the subscriber cancels or updates a card —
   * null for a user with no subscription, or when the deployment has not
   * configured one. Rendered as "Manage subscription"; never synthesised
   * client-side, so an unconfigured deployment shows no link rather than a
   * broken one.
   */
  customerPortalUrl: string | null;
}

export type CheckoutPlan = 'pro_monthly' | 'pro_annual';

export async function fetchBillingStatus(fetchImpl?: typeof fetch): Promise<BillingStatus> {
  const res = await api('/v1/billing/status', fetchImpl !== undefined ? { fetchImpl } : {});
  return apiJson(res);
}

// Current usage of the capped resources vs the plan's limits (limit null =
// unlimited). Drives the "3 / 5 used" display on the Plans page.
export interface ResourceUsage {
  used: number;
  limit: number | null;
}
export interface PlanUsage {
  plan: BillingPlan;
  contacts: ResourceUsage;
  vaultItems: ResourceUsage;
  storageBytes: ResourceUsage;
}

export async function fetchUsage(fetchImpl?: typeof fetch): Promise<PlanUsage> {
  const res = await api('/v1/account/usage', fetchImpl !== undefined ? { fetchImpl } : {});
  return apiJson(res);
}

// Fetch the hosted checkout URL for a plan. The caller redirects to it.
export async function getCheckoutUrl(
  plan: CheckoutPlan,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const res = await api(`/v1/billing/checkout/${plan}`, fetchImpl !== undefined ? { fetchImpl } : {});
  const { url } = await apiJson<{ url: string }>(res);
  return url;
}
