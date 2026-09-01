import { sodium, assertReady } from './init.js';
import { assertLength } from './util.js';

// Argon2id, per docs/18-crypto-architecture.md §"Key derivation".
//
// Production parameters from docs/01-decisions-locked.md:
//   memory      = 256 MiB
//   operations  = 4
//   parallelism = 1 (libsodium fixes this internally)
//   salt        = 16 bytes, generated at user enrollment
//
// These map to libsodium's crypto_pwhash as:
//   opslimit = 4
//   memlimit = 268_435_456 (bytes)
//   alg      = crypto_pwhash_ALG_ARGON2ID13

export const KDF_SALT_BYTES = 16;
export const KDF_MIN_OUTPUT_BYTES = 16;
export const KDF_MAX_OUTPUT_BYTES = 4_294_967_295;

// Production parameter constants. Centralised so a parameter change is a
// single-line edit + a single-test-vector regeneration.
export const ARGON2ID_PRODUCTION_OPSLIMIT = 4;
export const ARGON2ID_PRODUCTION_MEMLIMIT = 256 * 1024 * 1024;

export interface KdfParams {
  opslimit: number;
  memlimit: number;
}

export interface DeriveKeyInput {
  password: Uint8Array;
  salt: Uint8Array;
  outputLength: number;
  params?: KdfParams;
}

export function randomKdfSalt(): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(KDF_SALT_BYTES);
}

export function deriveKey(input: DeriveKeyInput): Uint8Array {
  assertReady();
  assertLength('kdf salt', input.salt, KDF_SALT_BYTES);
  if (
    input.outputLength < KDF_MIN_OUTPUT_BYTES ||
    input.outputLength > KDF_MAX_OUTPUT_BYTES
  ) {
    throw new Error(
      `kdf outputLength must be in [${KDF_MIN_OUTPUT_BYTES}, ${KDF_MAX_OUTPUT_BYTES}], got ${input.outputLength}`,
    );
  }
  const params = input.params ?? {
    opslimit: ARGON2ID_PRODUCTION_OPSLIMIT,
    memlimit: ARGON2ID_PRODUCTION_MEMLIMIT,
  };
  return sodium.crypto_pwhash(
    input.outputLength,
    input.password,
    input.salt,
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}
