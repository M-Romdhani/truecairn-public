import type { Locale } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';
import { requestWithStepUp, type StepUpDeps } from '../api/stepup.js';
import type { AccountInfo } from './keyMaterial.js';

// Update the display profile (name + honorific) shown in the account menu.
// A plain preference write — NOT sensitive (no key material / release / auth
// path), so no step-up. Returns the normalized values the server stored (an
// empty name or "None" honorific comes back as null).
export async function updateProfile(
  input: { displayName: string | null; title: string | null },
  fetchImpl?: typeof fetch,
): Promise<Pick<AccountInfo, 'displayName' | 'title'>> {
  return apiJson(
    await api('/v1/account/profile', {
      method: 'POST',
      body: input,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Store the language preference on the ACCOUNT rather than only in this browser
// (docs/40 Phase 1). Two things need that: the preference then follows the owner
// to another device, and the worker can render the 13 transactional templates in
// the right language — it has no browser to ask.
//
// Its own route, not a field on /v1/account/profile: that one requires
// displayName and title in every body, so routing language through it would let
// a language switch in one tab overwrite a name edit in another.
export async function setAccountLocale(
  locale: Locale,
  fetchImpl?: typeof fetch,
): Promise<{ locale: Locale }> {
  return apiJson(
    await api('/v1/account/locale', {
      method: 'POST',
      body: { locale },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Account-lifecycle mutations (QA Pass 3 Finding C). Deleting the account is a
// SENSITIVE action: step-up (fresh second factor + passphrase signature) and a
// 7-day delay during which it stays cancellable from the Engine page — the same
// lane as every other destructive change, no shortcut.
export async function requestAccountDeletion(
  deps: StepUpDeps,
): Promise<{ sensitiveActionId: string; effectiveAt: string }> {
  const res = await requestWithStepUp({ url: '/v1/account/delete', method: 'POST', body: {} }, deps);
  return apiJson(res);
}
