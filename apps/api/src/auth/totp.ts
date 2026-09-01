import { createHmac } from 'node:crypto';
import {
  randomBytes,
  randomSecretboxNonce,
  secretboxDecrypt,
  secretboxEncrypt,
} from '@truecairn/crypto';

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160-bit, the standard size for TOTP over SHA-1

export function generateTotpSecret(): Uint8Array {
  return randomBytes(SECRET_BYTES);
}

// RFC 4226 HOTP over SHA-1, truncated to 6 digits. (RFC 6238 TOTP is HOTP with
// the counter = floor(unixtime / period).)
export function hotp(secret: Uint8Array, counter: number): string {
  const block = Buffer.alloc(8);
  block.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  block.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', Buffer.from(secret)).update(block).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function totpCounter(now: Date): number {
  return Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
}

export function totpCode(secret: Uint8Array, now: Date): string {
  return hotp(secret, totpCounter(now));
}

// Verify a presented code against the current AND previous window (30s drift
// tolerance, per the design). Both windows are always computed (no early return)
// and compared in constant time.
export function verifyTotp(secret: Uint8Array, code: string, now: Date): boolean {
  const counter = totpCounter(now);
  const matchesCurrent = constantTimeStringEqual(hotp(secret, counter), code);
  const matchesPrevious = constantTimeStringEqual(hotp(secret, counter - 1), code);
  return matchesCurrent || matchesPrevious;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface EncryptedTotpSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

// The TOTP secret is encrypted at rest under a server KEK (XChaCha20-Poly1305).
// Not zero-knowledge — the server must verify codes — and acceptable because
// TOTP gates session auth only, never vault keys.
export function encryptTotpSecret(kek: Uint8Array, secret: Uint8Array): EncryptedTotpSecret {
  const nonce = randomSecretboxNonce();
  return { ciphertext: secretboxEncrypt({ key: kek, nonce, plaintext: secret }), nonce };
}

export function decryptTotpSecret(kek: Uint8Array, e: EncryptedTotpSecret): Uint8Array {
  return secretboxDecrypt({ key: kek, nonce: e.nonce, ciphertext: e.ciphertext });
}

// RFC 4648 base32 (no padding) — the encoding authenticator apps expect for the
// otpauth URI secret.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// The otpauth:// URI an authenticator app imports (typically via QR).
export function buildOtpauthUri(issuer: string, account: string, secret: Uint8Array): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
