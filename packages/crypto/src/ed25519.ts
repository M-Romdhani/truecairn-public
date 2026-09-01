import { sodium, assertReady } from './init.js';
import { assertLength } from './util.js';

// Ed25519, per docs/18 §"Signatures". Used for audit log signatures
// (server + user-signed sensitive events) and contact affirmation
// signatures in the release ceremony.
//
// libsodium uses the standard Ed25519 secret-key format: 64 bytes =
// 32-byte seed || 32-byte public key. Treat the secret key as opaque
// outside this module.

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SECRET_KEY_BYTES = 64;
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_SEED_BYTES = 32;

export interface Ed25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateEd25519Keypair(): Ed25519Keypair {
  assertReady();
  const kp = sodium.crypto_sign_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function ed25519KeypairFromSeed(seed: Uint8Array): Ed25519Keypair {
  assertReady();
  assertLength('ed25519 seed', seed, ED25519_SEED_BYTES);
  const kp = sodium.crypto_sign_seed_keypair(seed);
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function ed25519Sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  assertReady();
  assertLength('ed25519 secretKey', secretKey, ED25519_SECRET_KEY_BYTES);
  return sodium.crypto_sign_detached(message, secretKey);
}

export function ed25519Verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  assertReady();
  assertLength('ed25519 signature', signature, ED25519_SIGNATURE_BYTES);
  assertLength('ed25519 publicKey', publicKey, ED25519_PUBLIC_KEY_BYTES);
  return sodium.crypto_sign_verify_detached(signature, message, publicKey);
}
