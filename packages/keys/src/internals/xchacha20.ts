// Thin internal helper. Every wrap/unwrap in this package goes through here
// so the (key, nonce, ciphertext, AAD) plumbing has one implementation.
//
// Not exported from the package barrel — consumers use the typed wrap/unwrap
// functions in master-key.ts / tier-key.ts / item-key.ts / outer-layer.ts.

import {
  randomSecretboxNonce,
  secretboxDecrypt,
  secretboxEncrypt,
} from '@truecairn/crypto';

export interface WrappedBytes {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
}

export function wrapBytes(
  plaintext: Uint8Array,
  kek: Uint8Array,
  aad?: Uint8Array,
): WrappedBytes {
  const nonce = randomSecretboxNonce();
  const ciphertext = secretboxEncrypt({
    key: kek,
    nonce,
    plaintext,
    ...(aad !== undefined ? { additionalData: aad } : {}),
  });
  return { ciphertext, nonce };
}

export function unwrapBytes(
  wrapped: WrappedBytes,
  kek: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  return secretboxDecrypt({
    key: kek,
    nonce: wrapped.nonce,
    ciphertext: wrapped.ciphertext,
    ...(aad !== undefined ? { additionalData: aad } : {}),
  });
}
