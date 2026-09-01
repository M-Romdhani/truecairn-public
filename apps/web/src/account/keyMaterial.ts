import { decodeKeyMaterial, type KeyMaterial } from '@truecairn/client-crypto';
import type { Locale } from '@truecairn/shared';
import { ApiError, api, apiJson } from '../api/client.js';

// Login bootstrap (PHASE4 R0.4): fetch the wrapped key material + the user's own
// id so the client can derive the passphrase KEK and unlock. requireSession only
// — a logged-in-but-locked user needs exactly this TO unlock.
export interface FetchedKeyMaterial {
  material: KeyMaterial;
  userId: string;
}

// Returns null when the account has no key material yet (404) — i.e. the user
// has registered but not run the enrollment ceremony.
export async function fetchKeyMaterial(fetchImpl?: typeof fetch): Promise<FetchedKeyMaterial | null> {
  const res = await api('/v1/account/key-material', {
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  if (res.status === 404) return null;
  const dto = await apiJson<{ userId: string } & Record<string, unknown>>(res);
  return { material: decodeKeyMaterial(dto as never), userId: dto.userId };
}

// The authenticated account's own email (audit M17) plus the optional display
// name/honorific shown in Settings and the account menu. displayName/title are
// null when the owner has not set them.
export interface AccountInfo {
  email: string;
  displayName: string | null;
  title: string | null;
  // The stored language preference (migration 0067). null ⇒ the owner has never
  // chosen one, which is NOT the same as choosing English — see useLocaleSync in
  // ../i18n/useLocaleSync.ts for what each case does.
  locale: Locale | null;
}

export async function fetchAccount(fetchImpl?: typeof fetch): Promise<AccountInfo> {
  return apiJson(await api('/v1/account/me', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

export { ApiError };
