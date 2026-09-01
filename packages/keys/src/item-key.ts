// Level 4 — per-item keys.
//
// docs/18 §"Key hierarchy" item 4: "Per-item keys. Random 256-bit keys
// generated per vault item. Wrapped under the appropriate per-tier key."
//
// The wrapped form carries the tier so it cannot be unwrapped with a tier
// key from a different tier. The tier is also AAD-bound, so relabeling the
// wrapped form breaks authentication.

import { randomBytes } from '@truecairn/crypto';
import {
  assertSupportedItemAadVersion,
  buildItemKeyAad,
  type ItemAadVersion,
} from './aad.js';
import { unwrapBytes, wrapBytes } from './internals/xchacha20.js';
import {
  ITEM_KEY_BYTES,
  type ItemKeyWrappedByTier,
  type UnwrappedItemKey,
  type UnwrappedTierKey,
} from './types.js';

export function generateItemKey(): UnwrappedItemKey {
  return randomBytes(ITEM_KEY_BYTES) as UnwrappedItemKey;
}

// Wrapping ALWAYS emits v2. There is deliberately no way to write a v1 wrap:
// the id is a required argument rather than an option, so a caller who has not
// decided what item this key belongs to cannot get past the type checker. v1
// exists on the read side only, for rows written before 2026-08-09.
export function wrapItemKey(
  itemKey: UnwrappedItemKey,
  tierKey: UnwrappedTierKey,
  itemId: string,
): ItemKeyWrappedByTier {
  if (itemKey.length !== ITEM_KEY_BYTES) {
    throw new Error(`itemKey must be ${ITEM_KEY_BYTES} bytes, got ${itemKey.length}`);
  }
  const aad = buildItemKeyAad({ tier: tierKey.tier, itemId });
  const w = wrapBytes(itemKey, tierKey, aad);
  return { ciphertext: w.ciphertext, nonce: w.nonce, tier: tierKey.tier } as ItemKeyWrappedByTier;
}

export interface ItemKeyUnwrapBinding {
  // Read from the row and asserted, not assumed: a version this client does not
  // understand should say so, rather than silently reaching for the wrong AAD
  // builder and failing as "decryption failed".
  version: ItemAadVersion;
  // Not optional: a caller reading a row without knowing which item it is has
  // already lost the binding.
  itemId: string;
}

export function unwrapItemKey(
  wrapped: ItemKeyWrappedByTier,
  tierKey: UnwrappedTierKey,
  binding: ItemKeyUnwrapBinding,
): UnwrappedItemKey {
  // Explicit tier check first — gives a clear error before the AEAD attempt.
  // (The AAD binding would also reject a tier mismatch, but with a generic
  // "decryption failed" rather than this specific message.)
  if (wrapped.tier !== tierKey.tier) {
    throw new Error(
      `item key was wrapped for tier ${wrapped.tier} but the supplied tier key is ${tierKey.tier}`,
    );
  }
  // A version the server got wrong is a denial, never a bypass: there is one
  // AAD construction, and the tag was computed over it.
  assertSupportedItemAadVersion(binding.version);
  const aad = buildItemKeyAad({ tier: wrapped.tier, itemId: binding.itemId });
  const plaintext = unwrapBytes(wrapped, tierKey, aad);
  if (plaintext.length !== ITEM_KEY_BYTES) {
    throw new Error(`unwrapped item key has unexpected length ${plaintext.length}`);
  }
  return plaintext as UnwrappedItemKey;
}
