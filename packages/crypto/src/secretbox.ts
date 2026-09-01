import { sodium, assertReady } from './init.js';
import { assertLength } from './util.js';

// XChaCha20-Poly1305 IETF AEAD. The choice is locked in
// docs/18-crypto-architecture.md §"Symmetric encryption".
//
// Why this specific cipher mode:
// - Authenticated (Poly1305 tag bound to ciphertext + AAD)
// - 192-bit nonce: safe to randomly generate without nonce-reuse coordination
// - Standardized in draft-irtf-cfrg-xchacha-03

export const SECRETBOX_KEY_BYTES = 32;
export const SECRETBOX_NONCE_BYTES = 24;
export const SECRETBOX_TAG_BYTES = 16;

// Output of secretboxEncrypt is ciphertext || tag (Poly1305 tag appended).
// Length is plaintext.length + 16.

export function randomSecretboxKey(): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(SECRETBOX_KEY_BYTES);
}

export function randomSecretboxNonce(): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(SECRETBOX_NONCE_BYTES);
}

export interface SecretboxEncryptInput {
  key: Uint8Array;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  additionalData?: Uint8Array;
}

export interface SecretboxDecryptInput {
  key: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  additionalData?: Uint8Array;
}

export function secretboxEncrypt(input: SecretboxEncryptInput): Uint8Array {
  assertReady();
  assertLength('secretbox key', input.key, SECRETBOX_KEY_BYTES);
  assertLength('secretbox nonce', input.nonce, SECRETBOX_NONCE_BYTES);
  // null secret nonce + additionalData (or null if absent).
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    input.plaintext,
    input.additionalData ?? null,
    null,
    input.nonce,
    input.key,
  );
}

// Throws on authentication failure. Catch downstream if you need a boolean.
export function secretboxDecrypt(input: SecretboxDecryptInput): Uint8Array {
  assertReady();
  assertLength('secretbox key', input.key, SECRETBOX_KEY_BYTES);
  assertLength('secretbox nonce', input.nonce, SECRETBOX_NONCE_BYTES);
  if (input.ciphertext.length < SECRETBOX_TAG_BYTES) {
    throw new Error('ciphertext shorter than authentication tag');
  }
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    input.ciphertext,
    input.additionalData ?? null,
    input.nonce,
    input.key,
  );
}
