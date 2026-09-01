import { api } from '../api/client.js';

// End THIS session server-side: revokes the session row and clears the cookie
// (POST /v1/auth/logout). The in-memory master key is wiped separately by the
// session lock(); a full sign-out does both. Distinct from "Lock vault", which
// only wipes the key but leaves the authenticated session intact (audit M1).
export async function logout(fetchImpl?: typeof fetch): Promise<void> {
  await api('/v1/auth/logout', {
    method: 'POST',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
