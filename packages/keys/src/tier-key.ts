// Level 3 — per-tier keys (S1, S2, S3).
//
// docs/18 §"Key hierarchy" item 3: "Per-tier keys (S1, S2, S3). Random
// 256-bit keys generated at enrollment. Wrapped under the user master key
// for normal user access. The S2 and S3 keys are also split via Shamir into
// the contact/passphrase/hardware-key shares for release ceremonies."
//
// This module covers: generation, wrap/unwrap under the TierWrappingKey
// (derived from the master key in subkeys.ts), and the Shamir split/combine
// for S2 and S3 wired through @truecairn/crypto's constrained split so the
// release-passphrase share occupies a fixed index.

import { randomBytes, shamirCombine, shamirSplit, shamirSplitWithConstraint } from '@truecairn/crypto';
import type { VaultTier } from '@truecairn/shared';
import { unwrapBytes, wrapBytes } from './internals/xchacha20.js';
import {
  RELEASE_SHARE_INDEX_S2,
  RELEASE_SHARE_INDEX_S3,
  S2_SHARES,
  S2_THRESHOLD,
  S3_NESTED_CONTACT_SHARES,
  S3_NESTED_CONTACT_THRESHOLD,
  S3_SHARES,
  S3_THRESHOLD,
  TIER_KEY_BYTES,
  type ReleasePassphraseShare,
  type TierKeyShare,
  type TierKeyWrappedByMaster,
  type TierWrappingKey,
  type UnwrappedTierKey,
} from './types.js';

const TIER_INDEX: Record<VaultTier, number> = { s1: 1, s2: 2, s3: 3 };

// Attach the tier to a raw 32-byte key as an immutable property, producing
// the branded UnwrappedTierKey. The byte content is unchanged; crypto
// functions that read it as a Uint8Array ignore the property.
function brandTierKey(bytes: Uint8Array, tier: VaultTier): UnwrappedTierKey {
  Object.defineProperty(bytes, 'tier', { value: tier, writable: false, enumerable: true });
  return bytes as UnwrappedTierKey;
}

// Construct an UnwrappedTierKey from raw bytes + a tier. Used by callers that
// obtain tier-key bytes outside generate/unwrap (e.g. the S1 envelope open,
// where the bytes come from a sealed box). Validates length.
export function tierKeyFromBytes(bytes: Uint8Array, tier: VaultTier): UnwrappedTierKey {
  if (bytes.length !== TIER_KEY_BYTES) {
    throw new Error(`tier key must be ${TIER_KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return brandTierKey(bytes, tier);
}

// AAD binding the wrapped form's plaintext metadata (tier + generation) so an
// attacker cannot relabel an S2-wrapped key as S3, or replay an old
// generation, without breaking authentication.
//   aad = 'T' 'K' || tier_byte || u32_be(generation)
function tierKeyAad(tier: VaultTier, generation: number): Uint8Array {
  const buf = new Uint8Array(2 + 1 + 4);
  buf[0] = 0x54; // 'T'
  buf[1] = 0x4b; // 'K'
  buf[2] = TIER_INDEX[tier];
  new DataView(buf.buffer).setUint32(3, generation, false);
  return buf;
}

export function generateTierKey(tier: VaultTier): UnwrappedTierKey {
  return brandTierKey(randomBytes(TIER_KEY_BYTES), tier);
}

export function wrapTierKey(
  tierKey: UnwrappedTierKey,
  wrappingKey: TierWrappingKey,
  generation: number,
): TierKeyWrappedByMaster {
  if (tierKey.length !== TIER_KEY_BYTES) {
    throw new Error(`tierKey must be ${TIER_KEY_BYTES} bytes, got ${tierKey.length}`);
  }
  if (!Number.isInteger(generation) || generation < 1 || generation > 0xffffffff) {
    throw new Error(`generation must be a uint32 >= 1, got ${generation}`);
  }
  const aad = tierKeyAad(tierKey.tier, generation);
  const w = wrapBytes(tierKey, wrappingKey, aad);
  return {
    ciphertext: w.ciphertext,
    nonce: w.nonce,
    tier: tierKey.tier,
    generation,
  } as TierKeyWrappedByMaster;
}

export function unwrapTierKey(
  wrapped: TierKeyWrappedByMaster,
  wrappingKey: TierWrappingKey,
): UnwrappedTierKey {
  const aad = tierKeyAad(wrapped.tier, wrapped.generation);
  const plaintext = unwrapBytes(wrapped, wrappingKey, aad);
  if (plaintext.length !== TIER_KEY_BYTES) {
    throw new Error(`unwrapped tier key has unexpected length ${plaintext.length}`);
  }
  return brandTierKey(plaintext, wrapped.tier);
}

// ---------------------------------------------------------------------------
// Shamir split — S2 (2-of-3) and S3 (3-of-4).
//
// The release-passphrase share occupies the fixed last index
// (RELEASE_SHARE_INDEX_*). Its value is supplied by the caller (computed via
// deriveReleasePassphraseShare). The constrained split builds the polynomial
// so the share at that index equals the supplied value; the remaining
// indices (1..totalShares-1) are the contact shares, which the caller wraps
// to contact X25519 pubkeys in deliverable 3.
// ---------------------------------------------------------------------------

function splitTierKey(
  tierKey: UnwrappedTierKey,
  expectedTier: 's2' | 's3',
  threshold: number,
  totalShares: number,
  releaseShareIndex: number,
  releaseShare: ReleasePassphraseShare,
): TierKeyShare[] {
  if (tierKey.tier !== expectedTier) {
    throw new Error(`tierKey tier ${tierKey.tier} does not match expected ${expectedTier}`);
  }
  if (releaseShare.tier !== expectedTier) {
    throw new Error(
      `releaseShare tier ${releaseShare.tier} does not match expected ${expectedTier}`,
    );
  }
  if (releaseShare.bytes.length !== 1 + TIER_KEY_BYTES) {
    throw new Error(`releaseShare must be ${1 + TIER_KEY_BYTES} bytes, got ${releaseShare.bytes.length}`);
  }
  if (releaseShare.bytes[0] !== releaseShareIndex) {
    throw new Error(
      `releaseShare index ${releaseShare.bytes[0]} does not match the fixed index ${releaseShareIndex} for ${expectedTier}`,
    );
  }
  const constraintValue = releaseShare.bytes.slice(1);
  const rawShares = shamirSplitWithConstraint({
    secret: tierKey,
    threshold,
    totalShares,
    constraint: { shareIndex: releaseShareIndex, value: constraintValue },
  });
  return rawShares.map((bytes) => ({ bytes, tier: expectedTier }) as TierKeyShare);
}

export function splitTierKeyForS2(
  tierKey: UnwrappedTierKey,
  releaseShare: ReleasePassphraseShare,
): TierKeyShare[] {
  return splitTierKey(tierKey, 's2', S2_THRESHOLD, S2_SHARES, RELEASE_SHARE_INDEX_S2, releaseShare);
}

export function splitTierKeyForS3(
  tierKey: UnwrappedTierKey,
  releaseShare: ReleasePassphraseShare,
): TierKeyShare[] {
  return splitTierKey(tierKey, 's3', S3_THRESHOLD, S3_SHARES, RELEASE_SHARE_INDEX_S3, releaseShare);
}

// Convert a release-passphrase share into a TierKeyShare for reconstruction.
// Same bytes, same tier; explicit brand conversion so the provenance change
// is auditable at call sites.
export function releaseShareAsTierShare(release: ReleasePassphraseShare): TierKeyShare {
  return { bytes: release.bytes, tier: release.tier } as TierKeyShare;
}

// ---------------------------------------------------------------------------
// S3 nested scheme — release passphrase MANDATORY + any 2-of-3 contacts.
//
// docs/24: under the flat 3-of-4, three colluding diverse-role contacts
// reconstruct S3 WITHOUT the passphrase. The nested scheme forecloses that:
//
//   mask  = the passphrase's Argon2id evaluation (the 32 bytes of a
//           ReleasePassphraseShare, index byte dropped) — a one-time-pad layer.
//   C     = tierKey XOR mask
//   shares = Shamir 2-of-3 over C, one per contact (NO passphrase share).
//
// Reconstruction needs the passphrase (for `mask`) AND any 2 of 3 contacts (for
// C); contacts alone recover only C, which is independent of the tier key without
// the mask. Keeps S3's "lose any one contact" resilience while making collusion
// cryptographically short. S2 stays flat (splitTierKeyForS2) with the passphrase
// as an optional fallback share.
// ---------------------------------------------------------------------------

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error('xorBytes: length mismatch');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

// The 32-byte XOR mask carried by an S3 ReleasePassphraseShare (its evaluation;
// the leading index byte is not part of the mask).
function s3Mask(releaseShare: ReleasePassphraseShare): Uint8Array {
  if (releaseShare.tier !== 's3') {
    throw new Error(`S3 nested scheme requires an s3 release share, got ${releaseShare.tier}`);
  }
  if (releaseShare.bytes.length !== 1 + TIER_KEY_BYTES) {
    throw new Error(`releaseShare must be ${1 + TIER_KEY_BYTES} bytes, got ${releaseShare.bytes.length}`);
  }
  return releaseShare.bytes.slice(1);
}

export function splitTierKeyForS3Nested(
  tierKey: UnwrappedTierKey,
  releaseShare: ReleasePassphraseShare,
): TierKeyShare[] {
  if (tierKey.tier !== 's3') {
    throw new Error(`tierKey tier ${tierKey.tier} does not match expected s3`);
  }
  const masked = xorBytes(tierKey, s3Mask(releaseShare)); // C = K XOR mask
  const rawShares = shamirSplit({
    secret: masked,
    threshold: S3_NESTED_CONTACT_THRESHOLD,
    totalShares: S3_NESTED_CONTACT_SHARES,
  });
  return rawShares.map((bytes) => ({ bytes, tier: 's3' }) as TierKeyShare);
}

export function combineTierKeyForS3Nested(
  contactShares: TierKeyShare[],
  releaseShare: ReleasePassphraseShare,
): UnwrappedTierKey {
  if (contactShares.length < S3_NESTED_CONTACT_THRESHOLD) {
    throw new Error(
      `combineTierKeyForS3Nested needs >= ${S3_NESTED_CONTACT_THRESHOLD} contact shares, got ${contactShares.length}`,
    );
  }
  for (const s of contactShares) {
    if (s.tier !== 's3') throw new Error('combineTierKeyForS3Nested: all shares must be s3');
  }
  const masked = shamirCombine(contactShares.map((s) => s.bytes)); // C
  if (masked.length !== TIER_KEY_BYTES) {
    throw new Error(`reconstructed masked secret has unexpected length ${masked.length}`);
  }
  return brandTierKey(xorBytes(masked, s3Mask(releaseShare)), 's3'); // K = C XOR mask
}

export function combineTierKey(shares: TierKeyShare[]): UnwrappedTierKey {
  if (shares.length < 2) {
    throw new Error('combineTierKey needs at least 2 shares');
  }
  // Tier-mismatch check FIRST — early-return before any Lagrange interpolation
  // work. Cheap defense against an attacker probing for timing differences
  // between "rejected immediately" and "did the math, then rejected".
  const tier = shares[0]!.tier;
  for (let i = 1; i < shares.length; i++) {
    if (shares[i]!.tier !== tier) {
      throw new Error('combineTierKey: all shares must share the same tier');
    }
  }
  const rawShares = shares.map((s) => s.bytes);
  const secret = shamirCombine(rawShares);
  if (secret.length !== TIER_KEY_BYTES) {
    throw new Error(`reconstructed tier key has unexpected length ${secret.length}`);
  }
  return brandTierKey(secret, tier);
}
