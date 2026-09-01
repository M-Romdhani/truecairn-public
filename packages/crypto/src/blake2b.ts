import { sodium, assertReady } from './init.js';

// BLAKE2b hash. Used internally by the keys package to extend a 16-byte
// salt to the 32-byte key length required by crypto_kdf_derive_from_key,
// and may grow other uses later. Not a primary primitive in Phase 2 — only
// exposed because we need it for that extension step.
//
// Output length [16, 64]. Optional key [0, 64] bytes (keyed mode acts as a
// PRF / MAC; unkeyed mode is a plain hash).

export const BLAKE2B_256_OUTPUT_BYTES = 32;
export const BLAKE2B_MIN_OUTPUT_BYTES = 16;
export const BLAKE2B_MAX_OUTPUT_BYTES = 64;
export const BLAKE2B_MAX_KEY_BYTES = 64;

export interface Blake2bHashInput {
  message: Uint8Array;
  outputLength: number;
  key?: Uint8Array;
}

export function blake2bHash(input: Blake2bHashInput): Uint8Array {
  assertReady();
  if (
    input.outputLength < BLAKE2B_MIN_OUTPUT_BYTES ||
    input.outputLength > BLAKE2B_MAX_OUTPUT_BYTES
  ) {
    throw new Error(
      `blake2b outputLength must be in [${BLAKE2B_MIN_OUTPUT_BYTES}, ${BLAKE2B_MAX_OUTPUT_BYTES}], got ${input.outputLength}`,
    );
  }
  if (input.key !== undefined && input.key.length > BLAKE2B_MAX_KEY_BYTES) {
    throw new Error(`blake2b key must be <= ${BLAKE2B_MAX_KEY_BYTES} bytes`);
  }
  return sodium.crypto_generichash(
    input.outputLength,
    input.message,
    input.key ?? null,
  );
}

// Convenience: 32-byte BLAKE2b hash. Common output size. Always unkeyed.
export function blake2b256(message: Uint8Array): Uint8Array {
  return blake2bHash({ message, outputLength: BLAKE2B_256_OUTPUT_BYTES });
}
