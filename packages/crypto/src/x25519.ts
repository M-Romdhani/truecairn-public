import { sodium, assertReady } from './init.js';
import { assertLength } from './util.js';

// X25519, per docs/18-crypto-architecture.md §"Asymmetric encryption for
// contact share wrapping". Used to wrap a contact's release share to their
// public key (via sealed boxes — see sealed-box.ts) and for Diffie-Hellman
// shared-secret derivation if any consumer needs it.

export const X25519_PUBLIC_KEY_BYTES = 32;
export const X25519_SECRET_KEY_BYTES = 32;
export const X25519_SHARED_SECRET_BYTES = 32;
export const X25519_SEED_BYTES = 32;

export interface X25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateX25519Keypair(): X25519Keypair {
  assertReady();
  // crypto_box_keypair generates an X25519 keypair from CSPRNG.
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// Deterministic keypair from a 32-byte seed. Used for KAT tests and any
// flow that needs reproducible keys (e.g. derived from a seed in the key
// hierarchy). Production "new keypair" calls use generateX25519Keypair.
export function x25519KeypairFromSeed(seed: Uint8Array): X25519Keypair {
  assertReady();
  assertLength('x25519 seed', seed, X25519_SEED_BYTES);
  const kp = sodium.crypto_box_seed_keypair(seed);
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// Compute the X25519 scalar multiplication of the given secret key over the
// given public key. Returns the 32-byte shared secret.
export function x25519ScalarMult(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertReady();
  assertLength('x25519 secretKey', secretKey, X25519_SECRET_KEY_BYTES);
  assertLength('x25519 publicKey', publicKey, X25519_PUBLIC_KEY_BYTES);
  return sodium.crypto_scalarmult(secretKey, publicKey);
}

// Public key from secret key via scalar multiplication of the base point.
export function x25519PublicFromSecret(secretKey: Uint8Array): Uint8Array {
  assertReady();
  assertLength('x25519 secretKey', secretKey, X25519_SECRET_KEY_BYTES);
  return sodium.crypto_scalarmult_base(secretKey);
}
