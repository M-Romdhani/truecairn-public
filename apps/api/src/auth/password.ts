import { constantTimeEqual, deriveKey, randomKdfSalt } from '@truecairn/crypto';

// The LOGIN password is a fallback factor verified server-side. It is NOT the
// master passphrase and unlocks no keys. We reuse @truecairn/crypto's Argon2id
// KDF (deriveKey) — no separate password-hashing path — but with libsodium's
// INTERACTIVE cost (2 ops / 64 MiB), the documented preset for online login,
// NOT the master passphrase's 256 MiB/4 (which is client-side and infrequent;
// running it on every server login would be a memory-exhaustion DoS). Flagged
// for review.
const LOGIN_OPSLIMIT = 2;
const LOGIN_MEMLIMIT = 64 * 1024 * 1024;
const HASH_BYTES = 32;

const enc = new TextEncoder();

// Stored in password_credentials.argon2_phc as:
//   v1$<ops>$<mem>$<saltB64url>$<hashB64url>
// We encode the params so a future cost change is a per-row decision, verifiable
// without a schema migration.
export function hashPassword(password: string): string {
  const salt = randomKdfSalt();
  const hash = deriveKey({
    password: enc.encode(password),
    salt,
    outputLength: HASH_BYTES,
    params: { opslimit: LOGIN_OPSLIMIT, memlimit: LOGIN_MEMLIMIT },
  });
  return encode(LOGIN_OPSLIMIT, LOGIN_MEMLIMIT, salt, hash);
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parsed = decode(encoded);
  if (parsed === null) return false;
  const candidate = deriveKey({
    password: enc.encode(password),
    salt: parsed.salt,
    outputLength: parsed.hash.length,
    params: { opslimit: parsed.opslimit, memlimit: parsed.memlimit },
  });
  return constantTimeEqual(candidate, parsed.hash);
}

// True if the stored hash was produced with parameters other than the current
// login cost (or is unparseable) — the login flow rehashes on the next verify.
export function needsRehash(encoded: string): boolean {
  const parsed = decode(encoded);
  if (parsed === null) return true;
  return parsed.opslimit !== LOGIN_OPSLIMIT || parsed.memlimit !== LOGIN_MEMLIMIT;
}

function encode(ops: number, mem: number, salt: Uint8Array, hash: Uint8Array): string {
  return `v1$${ops}$${mem}$${b64url(salt)}$${b64url(hash)}`;
}

function decode(
  s: string,
): { opslimit: number; memlimit: number; salt: Uint8Array; hash: Uint8Array } | null {
  const parts = s.split('$');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const opslimit = Number.parseInt(parts[1] ?? '', 10);
  const memlimit = Number.parseInt(parts[2] ?? '', 10);
  if (!Number.isInteger(opslimit) || !Number.isInteger(memlimit)) return null;
  const salt = new Uint8Array(Buffer.from(parts[3] ?? '', 'base64url'));
  const hash = new Uint8Array(Buffer.from(parts[4] ?? '', 'base64url'));
  if (salt.length !== 16 || hash.length < 16) return null;
  return { opslimit, memlimit, salt, hash };
}

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

// The constant-time enumeration defense (reviewer requirement). On unknown email
// (or an account with no password) the login flow runs the FULL Argon2id verify
// against THIS sentinel — held in memory, never fetched from the DB — so the
// only timing cost is the constant derive, with no fast path and no DB-roundtrip
// variance. The hash corresponds to no real password: any verify fails after
// doing the full work.
export const SENTINEL_PASSWORD_HASH = encode(
  LOGIN_OPSLIMIT,
  LOGIN_MEMLIMIT,
  new Uint8Array(16).fill(0x5a),
  new Uint8Array(HASH_BYTES).fill(0xa5),
);
