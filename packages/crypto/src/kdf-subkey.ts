import { sodium, assertReady } from './init.js';
import { assertLength } from './util.js';

// BLAKE2b-based subkey derivation, per docs/18-crypto-architecture.md
// §"Key hierarchy":
//   "the audit log signing key, the wrapping key for per-tier keys, and the
//    verification key for the audit log" are derived from the master key.
//
// libsodium's crypto_kdf_derive_from_key uses BLAKE2b internally with:
//   - master key (32 bytes) as the BLAKE2b key
//   - subkey id (64-bit unsigned) and context (8 bytes) for domain separation
//   - output length in [16, 64] bytes
//
// Use distinct (context, subkey_id) pairs for each subkey purpose so that
// independent subkeys cannot be conflated.

export const KDF_KEY_BYTES = 32;
export const KDF_CONTEXT_BYTES = 8;
export const KDF_MIN_SUBKEY_BYTES = 16;
export const KDF_MAX_SUBKEY_BYTES = 64;

export interface DeriveSubkeyInput {
  masterKey: Uint8Array;
  // 8-character ASCII context string. Domain separator for a class of subkeys
  // (e.g. "tc-audit", "tc-twrap"). libsodium-wrappers requires a string here
  // (not Uint8Array); it validates the UTF-8 byte length internally.
  context: string;
  // 64-bit unsigned identifier within the context.
  subkeyId: number | bigint;
  // Length of the derived subkey, in bytes. Must be in [16, 64].
  subkeyLength: number;
}

export function deriveSubkey(input: DeriveSubkeyInput): Uint8Array {
  assertReady();
  assertLength('subkey masterKey', input.masterKey, KDF_KEY_BYTES);

  // The libsodium binding requires the context as a string. We validate the
  // UTF-8 byte length matches the libsodium constant here so misuse fails
  // at our boundary with a clear message rather than deep inside libsodium.
  const contextByteLength = new TextEncoder().encode(input.context).length;
  if (contextByteLength !== KDF_CONTEXT_BYTES) {
    throw new Error(
      `subkey context must encode to exactly ${KDF_CONTEXT_BYTES} bytes, got ${contextByteLength}`,
    );
  }

  if (
    input.subkeyLength < KDF_MIN_SUBKEY_BYTES ||
    input.subkeyLength > KDF_MAX_SUBKEY_BYTES
  ) {
    throw new Error(
      `subkeyLength must be in [${KDF_MIN_SUBKEY_BYTES}, ${KDF_MAX_SUBKEY_BYTES}], got ${input.subkeyLength}`,
    );
  }

  const idBigInt = typeof input.subkeyId === 'bigint' ? input.subkeyId : BigInt(input.subkeyId);
  if (idBigInt < 0n || idBigInt > 0xffffffffffffffffn) {
    throw new Error('subkeyId must fit in a 64-bit unsigned integer');
  }

  // libsodium-wrappers crypto_kdf_derive_from_key signature:
  //   crypto_kdf_derive_from_key(subkey_len, subkey_id, ctx, key)
  //
  // The @types/libsodium-wrappers-sumo declaration types subkey_id as `number`,
  // but the underlying JS runtime accepts both `number` and `BigInt` (and
  // requires BigInt for ids > Number.MAX_SAFE_INTEGER). We pass BigInt and
  // cast through `unknown` because the declaration is wrong, not the runtime.
  return sodium.crypto_kdf_derive_from_key(
    input.subkeyLength,
    idBigInt as unknown as number,
    input.context,
    input.masterKey,
  );
}
