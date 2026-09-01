// Level 4 — vault item content encryption.
//
// The per-item key encrypts the raw vault content. The ciphertext form is
// what lives in vault_items.content_ciphertext. No AAD: the per-item key is
// unique per item, and there is no item-level metadata to bind at this layer
// (category lives in a plaintext DB column and is policy data, not content).

import { unwrapBytes, wrapBytes } from './internals/xchacha20.js';
import { ITEM_KEY_BYTES, type ItemContentCiphertext, type UnwrappedItemKey } from './types.js';

export function encryptItemContent(
  content: Uint8Array,
  itemKey: UnwrappedItemKey,
): ItemContentCiphertext {
  if (itemKey.length !== ITEM_KEY_BYTES) {
    throw new Error(`itemKey must be ${ITEM_KEY_BYTES} bytes, got ${itemKey.length}`);
  }
  const w = wrapBytes(content, itemKey);
  return { ciphertext: w.ciphertext, nonce: w.nonce } as ItemContentCiphertext;
}

export function decryptItemContent(
  ciphertext: ItemContentCiphertext,
  itemKey: UnwrappedItemKey,
): Uint8Array {
  if (itemKey.length !== ITEM_KEY_BYTES) {
    throw new Error(`itemKey must be ${ITEM_KEY_BYTES} bytes, got ${itemKey.length}`);
  }
  return unwrapBytes(ciphertext, itemKey);
}
