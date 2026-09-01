// Tier-key check sentinel (CEREMONY_PROPOSAL.md Q3, as amended: per-user
// RANDOM sentinel rather than a fixed known plaintext).
//
// At enrollment, createTierKeyCheck generates 16 random bytes and encrypts
// them under the tier key (AAD-bound: 'tckchk' || tier || generation). Both
// the random plaintext and the ciphertext+nonce are stored on the
// user_tier_keys row. At reconstruction (client-side), validateTierKeyCheck
// decrypts the ciphertext with a candidate (reconstructed) tier key and
// constant-time-compares to the plaintext: a match proves the candidate key
// is correct. This makes k-subset retry cheap and works even when the user
// has zero vault items.

import { constantTimeEqual, randomBytes, secretboxDecrypt, secretboxEncrypt } from '@truecairn/crypto';
import type { VaultTier } from '@truecairn/shared';
import { TIER_KEY_BYTES, type UnwrappedTierKey } from './types.js';

const TIER_INDEX: Record<VaultTier, number> = { s1: 1, s2: 2, s3: 3 };
const SENTINEL_PLAINTEXT_BYTES = 16;

export interface TierKeyCheck {
  plaintext: Uint8Array;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

// AAD: 'tckchk' (6 bytes) || tier_byte || u32_be(generation). Distinct domain
// tag from the tier-key wrap ('TK') so a check ciphertext can never be
// confused with a wrapped tier key.
function tierKeyCheckAad(tier: VaultTier, generation: number): Uint8Array {
  const tag = new TextEncoder().encode('tckchk'); // 6 bytes
  const buf = new Uint8Array(tag.length + 1 + 4);
  buf.set(tag, 0);
  buf[tag.length] = TIER_INDEX[tier];
  new DataView(buf.buffer).setUint32(tag.length + 1, generation, false);
  return buf;
}

export function createTierKeyCheck(tierKey: UnwrappedTierKey, generation: number): TierKeyCheck {
  if (!Number.isInteger(generation) || generation < 1 || generation > 0xffffffff) {
    throw new Error(`generation must be a uint32 >= 1, got ${generation}`);
  }
  const plaintext = randomBytes(SENTINEL_PLAINTEXT_BYTES);
  const nonce = randomBytesNonce();
  const aad = tierKeyCheckAad(tierKey.tier, generation);
  const ciphertext = secretboxEncrypt({ key: tierKey, nonce, plaintext, additionalData: aad });
  return { plaintext, ciphertext, nonce };
}

// Returns true iff decrypting `check.ciphertext` under `tierKey` yields
// `check.plaintext`. Any AEAD failure (wrong key) is caught and returns false
// rather than throwing — reconstruction wants a boolean to drive k-subset retry.
export function validateTierKeyCheck(
  tierKey: UnwrappedTierKey,
  check: TierKeyCheck,
  generation: number,
): boolean {
  if (tierKey.length !== TIER_KEY_BYTES) return false;
  const aad = tierKeyCheckAad(tierKey.tier, generation);
  let recovered: Uint8Array;
  try {
    recovered = secretboxDecrypt({
      key: tierKey,
      nonce: check.nonce,
      ciphertext: check.ciphertext,
      additionalData: aad,
    });
  } catch {
    return false;
  }
  return constantTimeEqual(recovered, check.plaintext);
}

// secretbox nonce is 24 bytes; randomBytes from crypto gives the CSPRNG bytes.
function randomBytesNonce(): Uint8Array {
  return randomBytes(24);
}
