import { createHash } from 'node:crypto';
import { canonicalBytes, type CanonicalEntry } from './canonical.js';

export function entryHash(entry: CanonicalEntry): Uint8Array {
  const h = createHash('sha256');
  h.update(canonicalBytes(entry));
  return new Uint8Array(h.digest());
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
