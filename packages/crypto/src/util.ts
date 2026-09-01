import { sodium, assertReady } from './init.js';

// Constant-time byte comparison via libsodium's memcmp. Use this for any
// comparison of secrets, tags, MACs, or anything an attacker could influence
// the timing of.
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  assertReady();
  if (a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

// Unambiguous framing for a list of byte strings:
//   u32_be(len(a)) || a || u32_be(len(b)) || b || …
//
// Use this anywhere distinct logical inputs are concatenated before hashing or
// before being passed as AEAD additional data. Raw concatenation lets two
// different input lists serialise to identical bytes as soon as any field is
// variable-length, which turns a domain separator into a suggestion. The
// outer-layer AAD (packages/keys aad.ts) predates this helper and hand-rolls
// the same format for its fixed field list.
export function lengthPrefixedConcat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    if (p.length > 0xffffffff) throw new Error('lengthPrefixedConcat: part too long');
    total += 4 + p.length;
  }
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;
  for (const p of parts) {
    view.setUint32(off, p.length, false);
    off += 4;
    buf.set(p, off);
    off += p.length;
  }
  if (off !== total) {
    throw new Error(`internal framing bug: wrote ${off} of ${total} bytes`);
  }
  return buf;
}

// Split bytes produced by lengthPrefixedConcat. Rejects trailing bytes and
// truncated prefixes rather than returning what it managed to read — a partial
// parse of an authenticated blob is a decode bug that reads like valid data.
export function lengthPrefixedSplit(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + 4 > bytes.length) throw new Error('lengthPrefixedSplit: truncated length prefix');
    const len = view.getUint32(off, false);
    off += 4;
    if (off + len > bytes.length) throw new Error('lengthPrefixedSplit: truncated part');
    out.push(bytes.slice(off, off + len));
    off += len;
  }
  return out;
}

// Hex helpers for KAT vectors. Test-time only — production code passes
// Uint8Arrays everywhere.
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error(`hex string has odd length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// Standard base64 (RFC 4648, with padding) via libsodium — browser- and
// Node-safe, no Buffer dependency. The wire encoding for binary fields the
// client exchanges with the API (PHASE4). Node's Buffer.from(s, 'base64')
// decodes the same string, so client (sodium) and server (Buffer) interoperate.
export function toBase64(bytes: Uint8Array): string {
  assertReady();
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(b64: string): Uint8Array {
  assertReady();
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

// URL-safe base64, no padding — the encoding the auth layer uses on the wire for
// the step-up challenge and signature headers (server side: Buffer base64url).
export function toBase64Url(bytes: Uint8Array): string {
  assertReady();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromBase64Url(b64: string): Uint8Array {
  assertReady();
  return sodium.from_base64(b64, sodium.base64_variants.URLSAFE_NO_PADDING);
}

// Wrapper-internal assertion. Throws on misuse with a clear message; this is
// not user input validation (consumers are trusted internal modules) but
// catches programmer errors early.
export function assertLength(name: string, bytes: Uint8Array, expected: number): void {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${bytes.length}`);
  }
}

// Cryptographically-secure random bytes via libsodium's CSPRNG. Public so
// modules outside @truecairn/crypto (the keys package, the audit package)
// don't have to reach into sodium directly.
export function randomBytes(length: number): Uint8Array {
  assertReady();
  if (length < 0 || !Number.isInteger(length)) {
    throw new Error(`randomBytes length must be a non-negative integer, got ${length}`);
  }
  return sodium.randombytes_buf(length);
}

// Zeroize a secret buffer via libsodium's sodium_memzero (a real write the
// engine won't optimise away, unlike a plain loop). Use it to destroy a
// passphrase, a derived KEK, or any unwrapped key the moment it is no longer
// needed — the client's plaintext-lifetime discipline (PHASE4 §a) depends on it.
// No-op-safe on an empty array. Note: JS strings can't be wiped (immutable) —
// secrets must be held as Uint8Array to be wipeable.
export function wipe(bytes: Uint8Array): void {
  assertReady();
  sodium.memzero(bytes);
}
