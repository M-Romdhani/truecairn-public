import { createHash, randomBytes } from 'node:crypto';

// A session token is 256 bits of CSPRNG randomness. The raw token lives only in
// the client cookie; the server stores SHA-256(token). A 256-bit token's input
// space defeats rainbow tables, so a fast hash is the correct choice here
// (PHASE3_1_AUTH_PROPOSAL §1) — no salt or slow KDF. Lookup is an indexed
// equality on the hash, so there is no secret-dependent comparison to time.
const TOKEN_BYTES = 32;

export interface GeneratedToken {
  // base64url, no padding — the value placed in the client cookie.
  token: string;
  // SHA-256(token bytes) — stored in sessions.token_hash.
  tokenHash: Uint8Array;
}

export function generateSessionToken(): GeneratedToken {
  const raw = randomBytes(TOKEN_BYTES);
  return { token: raw.toString('base64url'), tokenHash: sha256(raw) };
}

// Recompute the stored hash from a presented cookie token. Returns null if the
// token is not well-formed base64url of the expected length, so a malformed
// cookie is a clean miss rather than an exception.
export function hashPresentedToken(token: string): Uint8Array | null {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES) return null;
  return sha256(raw);
}

function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}
