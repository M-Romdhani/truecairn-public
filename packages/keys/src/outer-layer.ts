// Level 5 — outer-layer keys (server-side temporal gate).
//
// docs/18 §"Key hierarchy" item 5 + Q2 (option A, confirmed): the outer-layer
// key wraps the inner per-item ciphertext + wrapped-per-item-key bundle at
// server-storage time. During ACTIVE operation the server removes the wrap
// on fetch so the client receives the inner form (which still requires the
// user's master-derived keys to decrypt). During a release ceremony the same
// unwrap is gated by engine state. The outer-layer key is NOT a confidentiality
// key — it only removes one wrap layer; the inner wraps still require
// user-held secrets. It is temporal access control.
//
// The outer-layer key itself is wrapped under a platform KEK (HSM in Phase 5;
// an in-memory placeholder here) with AAD binding (user_id, tier, kek_id,
// generation) via buildOuterLayerAad.

import { constantTimeEqual, randomBytes } from '@truecairn/crypto';
import { unwrapBytes, wrapBytes } from './internals/xchacha20.js';
import {
  OUTER_LAYER_KEK_BYTES,
  OUTER_LAYER_KEY_BYTES,
  type InnerVaultBundle,
  type ItemContentCiphertext,
  type ItemKeyWrappedByTier,
  type OuterLayerKek,
  type OuterLayerKeyWrappedByKek,
  type OuterWrappedVaultBundle,
  type UnwrappedOuterLayerKey,
} from './types.js';

const SECRETBOX_NONCE_BYTES = 24;

// ---------------------------------------------------------------------------
// Outer-layer key generation + KEK wrap/unwrap
// ---------------------------------------------------------------------------

export function generateOuterLayerKey(): UnwrappedOuterLayerKey {
  return randomBytes(OUTER_LAYER_KEY_BYTES) as UnwrappedOuterLayerKey;
}

// Placeholder for the HSM-held platform KEK (Phase 5 replaces this with an
// actual HSM reference). For Phase 2 it is a plain 32-byte key so the
// wrap/unwrap path can be exercised without an HSM dependency.
export function generateOuterLayerKek(): OuterLayerKek {
  return randomBytes(OUTER_LAYER_KEK_BYTES) as OuterLayerKek;
}

export function wrapOuterLayerKey(
  key: UnwrappedOuterLayerKey,
  kek: OuterLayerKek,
  aad: Uint8Array,
): OuterLayerKeyWrappedByKek {
  if (key.length !== OUTER_LAYER_KEY_BYTES) {
    throw new Error(`outer-layer key must be ${OUTER_LAYER_KEY_BYTES} bytes, got ${key.length}`);
  }
  const w = wrapBytes(key, kek, aad);
  return { ciphertext: w.ciphertext, nonce: w.nonce, aad } as OuterLayerKeyWrappedByKek;
}

// expectedAad: callers SHOULD pass the AAD reconstructed from authoritative
// sources (the user_id / tier / kek_id / generation columns) via
// buildOuterLayerAad. When provided, it is constant-time-compared against the
// stored aad before decryption, so tampering with the stored aad cannot
// substitute a different binding. If omitted, the stored aad is used (less
// safe; intended only for contexts where the components are not yet loaded).
export function unwrapOuterLayerKey(
  wrapped: OuterLayerKeyWrappedByKek,
  kek: OuterLayerKek,
  expectedAad?: Uint8Array,
): UnwrappedOuterLayerKey {
  if (expectedAad !== undefined && !constantTimeEqual(expectedAad, wrapped.aad)) {
    throw new Error('outer-layer key AAD does not match the expected binding');
  }
  const plaintext = unwrapBytes(wrapped, kek, wrapped.aad);
  if (plaintext.length !== OUTER_LAYER_KEY_BYTES) {
    throw new Error(`unwrapped outer-layer key has unexpected length ${plaintext.length}`);
  }
  return plaintext as UnwrappedOuterLayerKey;
}

// ---------------------------------------------------------------------------
// Inner vault bundle + the outer-layer storage wrap
// ---------------------------------------------------------------------------

export function makeInnerVaultBundle(
  contentCiphertext: ItemContentCiphertext,
  wrappedItemKey: ItemKeyWrappedByTier,
): InnerVaultBundle {
  return { contentCiphertext, wrappedItemKey } as InnerVaultBundle;
}

export function applyOuterLayerWrap(
  inner: InnerVaultBundle,
  outerLayerKey: UnwrappedOuterLayerKey,
): OuterWrappedVaultBundle {
  const serialized = serializeInnerBundle(inner);
  const w = wrapBytes(serialized, outerLayerKey);
  return { ciphertext: w.ciphertext, nonce: w.nonce } as OuterWrappedVaultBundle;
}

export function removeOuterLayerWrap(
  outer: OuterWrappedVaultBundle,
  outerLayerKey: UnwrappedOuterLayerKey,
): InnerVaultBundle {
  const serialized = unwrapBytes(outer, outerLayerKey);
  return deserializeInnerBundle(serialized);
}

// ---------------------------------------------------------------------------
// Bundle (de)serialization. Length-prefixed so the boundary between the two
// wrapped structs is unambiguous. Layout:
//   u32_be(len(content.ciphertext)) || content.ciphertext
//   u32_be(len(content.nonce))      || content.nonce
//   u32_be(len(itemKey.ciphertext)) || itemKey.ciphertext
//   u32_be(len(itemKey.nonce))      || itemKey.nonce
//   tier_byte
// ---------------------------------------------------------------------------

const TIER_FROM_BYTE: Record<number, 's1' | 's2' | 's3'> = { 1: 's1', 2: 's2', 3: 's3' };
const BYTE_FROM_TIER: Record<'s1' | 's2' | 's3', number> = { s1: 1, s2: 2, s3: 3 };

function serializeInnerBundle(bundle: InnerVaultBundle): Uint8Array {
  const cc = bundle.contentCiphertext;
  const wik = bundle.wrappedItemKey;
  const parts: Uint8Array[] = [
    lengthPrefixed(cc.ciphertext),
    lengthPrefixed(cc.nonce),
    lengthPrefixed(wik.ciphertext),
    lengthPrefixed(wik.nonce),
    Uint8Array.of(BYTE_FROM_TIER[wik.tier]),
  ];
  return concat(parts);
}

function deserializeInnerBundle(bytes: Uint8Array): InnerVaultBundle {
  const reader = new ByteReader(bytes);
  const contentCiphertext = reader.readLengthPrefixed();
  const contentNonce = reader.readLengthPrefixed();
  const itemKeyCiphertext = reader.readLengthPrefixed();
  const itemKeyNonce = reader.readLengthPrefixed();
  const tierByte = reader.readByte();
  reader.assertExhausted();

  if (contentNonce.length !== SECRETBOX_NONCE_BYTES || itemKeyNonce.length !== SECRETBOX_NONCE_BYTES) {
    throw new Error('deserialized bundle has a malformed nonce length');
  }
  const tier = TIER_FROM_BYTE[tierByte];
  if (tier === undefined) {
    throw new Error(`deserialized bundle has invalid tier byte ${tierByte}`);
  }

  return {
    contentCiphertext: {
      ciphertext: contentCiphertext,
      nonce: contentNonce,
    } as ItemContentCiphertext,
    wrappedItemKey: {
      ciphertext: itemKeyCiphertext,
      nonce: itemKeyNonce,
      tier,
    } as ItemKeyWrappedByTier,
  } as InnerVaultBundle;
}

// --- byte helpers ---

function lengthPrefixed(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readLengthPrefixed(): Uint8Array {
    if (this.offset + 4 > this.bytes.length) {
      throw new Error('truncated length prefix while deserializing bundle');
    }
    const len = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    ).getUint32(0, false);
    this.offset += 4;
    if (this.offset + len > this.bytes.length) {
      throw new Error('truncated payload while deserializing bundle');
    }
    const slice = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  readByte(): number {
    if (this.offset + 1 > this.bytes.length) {
      throw new Error('truncated trailing byte while deserializing bundle');
    }
    const b = this.bytes[this.offset]!;
    this.offset += 1;
    return b;
  }

  assertExhausted(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error(
        `trailing bytes after deserializing bundle: ${this.bytes.length - this.offset} left`,
      );
    }
  }
}
