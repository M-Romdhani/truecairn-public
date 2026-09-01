import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, initCrypto } from '@truecairn/crypto';
import {
  createTierKeyCheck,
  generateTierKey,
  splitTierKeyForS3,
  S2_SHARES,
  S2_THRESHOLD,
  S3_NESTED_CONTACT_SHARES,
  S3_NESTED_CONTACT_THRESHOLD,
  S3_SHARES,
  S3_THRESHOLD,
  type ReleasePassphraseShare,
  type TierKeyShare,
} from '@truecairn/keys';
import { DEFAULT_MAX_SUBSETS, reconstructTierKey } from './reconstruct.js';

beforeAll(async () => {
  await initCrypto();
});

function syntheticReleaseShare(shareIndex: number): ReleasePassphraseShare {
  const bytes = new Uint8Array(1 + 32);
  bytes[0] = shareIndex;
  for (let i = 1; i <= 32; i++) bytes[i] = (i * 5 + shareIndex) & 0xff;
  return { bytes, tier: 's3' } as ReleasePassphraseShare;
}

// A set of distinct-index, same-tier shares that are NOT a valid split — used
// to exercise the "no subset validates" path.
function garbageShares(count: number): TierKeyShare[] {
  const out: TierKeyShare[] = [];
  for (let i = 1; i <= count; i++) {
    const bytes = new Uint8Array(1 + 32);
    bytes[0] = i; // distinct index
    for (let j = 1; j <= 32; j++) bytes[j] = (i * 31 + j) & 0xff;
    out.push({ bytes, tier: 's3' } as TierKeyShare);
  }
  return out;
}

describe('reconstructTierKey — happy path', () => {
  it('reconstructs the original tier key from a valid threshold subset', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const shares = splitTierKeyForS3(tk, syntheticReleaseShare(4));
    const result = reconstructTierKey({
      shares: [shares[0]!, shares[1]!, shares[2]!],
      threshold: 3,
      tierKeyCheck: check,
      generation: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(bytesToHex(result.tierKey)).toBe(bytesToHex(tk));
      expect(result.subsetsTried).toBe(1);
    }
  });

  it('recovers when one of n shares is corrupt by trying another subset (S3: 4 shares, 1 bad)', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const shares = splitTierKeyForS3(tk, syntheticReleaseShare(4));
    // Corrupt share index 0's evaluation bytes (keep its share index byte).
    const corrupt: TierKeyShare = { bytes: new Uint8Array(shares[0]!.bytes), tier: 's3' } as TierKeyShare;
    corrupt.bytes[1] = corrupt.bytes[1]! ^ 0xff;
    const result = reconstructTierKey({
      shares: [corrupt, shares[1]!, shares[2]!, shares[3]!],
      threshold: 3,
      tierKeyCheck: check,
      generation: 1,
    });
    // Some 3-subset excludes the corrupt share and validates.
    expect(result.ok).toBe(true);
    if (result.ok) expect(bytesToHex(result.tierKey)).toBe(bytesToHex(tk));
  });
});

describe('reconstructTierKey — failure modes', () => {
  it('returns insufficient_shares when fewer than threshold shares', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const shares = splitTierKeyForS3(tk, syntheticReleaseShare(4));
    const result = reconstructTierKey({
      shares: [shares[0]!, shares[1]!],
      threshold: 3,
      tierKeyCheck: check,
      generation: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_shares', subsetsTried: 0 });
  });

  it('returns shares_unverifiable when no subset reconstructs the key', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const result = reconstructTierKey({
      shares: garbageShares(4),
      threshold: 3,
      tierKeyCheck: check,
      generation: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shares_unverifiable');
  });

  it('mismatched generation makes a valid split unverifiable (sentinel AAD binding)', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const shares = splitTierKeyForS3(tk, syntheticReleaseShare(4));
    const result = reconstructTierKey({
      shares: [shares[0]!, shares[1]!, shares[2]!],
      threshold: 3,
      tierKeyCheck: check,
      generation: 2, // wrong generation
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shares_unverifiable');
  });
});

describe('reconstructTierKey — bounded retry (the degenerate-input guard)', () => {
  it('caps the subset search: C(10,3)=120 but it stops at the cap and fails cleanly', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    // 10 distinct garbage shares; C(10,3) = 120 possible subsets, none valid.
    const result = reconstructTierKey({
      shares: garbageShares(10),
      threshold: 3,
      tierKeyCheck: check,
      generation: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('shares_unverifiable');
      // It tried exactly the cap, NOT all 120 subsets.
      expect(result.subsetsTried).toBe(DEFAULT_MAX_SUBSETS);
    }
  });

  it('honours a custom maxSubsets cap', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const result = reconstructTierKey({
      shares: garbageShares(8),
      threshold: 3,
      tierKeyCheck: check,
      generation: 1,
      maxSubsets: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subsetsTried).toBe(3);
  });

  it('throws for threshold < 2 (S1 must use the envelope path)', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    expect(() =>
      reconstructTierKey({ shares: garbageShares(2), threshold: 1, tierKeyCheck: check, generation: 1 }),
    ).toThrow(/threshold >= 2/);
  });
});

// ── The subset-budget guard (2026-07-25 RC audit) ─────────────────────────────
//
// DEFAULT_MAX_SUBSETS is a silent cap: if it ever falls below C(n, k) for a
// shipped tier, a legitimate recovery can exhaust the budget before reaching the
// correct subset and fail as 'shares_unverifiable'. That failure is
// indistinguishable, from the recipient's side, from contacts having sabotaged
// the ceremony — at the exact moment the product is supposed to work.
//
// It is correct today by a comfortable margin. This pins the arithmetic so
// raising a tier's share count without revisiting the cap fails the build.
describe('DEFAULT_MAX_SUBSETS covers every shipped tier', () => {
  const choose = (n: number, k: number): number => {
    if (k > n) return 0;
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  };

  it.each([
    ['S2 flat (2-of-3)', S2_SHARES, S2_THRESHOLD],
    ['S3 flat (3-of-4)', S3_SHARES, S3_THRESHOLD],
    ['S3 nested contacts (2-of-3)', S3_NESTED_CONTACT_SHARES, S3_NESTED_CONTACT_THRESHOLD],
  ])('%s: C(n,k) fits in the retry budget', (_label, n, k) => {
    const combinations = choose(n, k);
    expect(combinations).toBeGreaterThan(0);
    expect(
      DEFAULT_MAX_SUBSETS,
      `C(${n},${k}) = ${combinations} exceeds DEFAULT_MAX_SUBSETS (${DEFAULT_MAX_SUBSETS}): a ` +
        `legitimate recovery could run out of retries and fail as 'shares_unverifiable'. ` +
        `Raise the cap alongside the share count.`,
    ).toBeGreaterThanOrEqual(combinations);
  });

  it('the budget still tolerates the full number of wrong shares a tier allows', () => {
    // Shamir tolerates up to (n - k) bad shares; reaching a good subset requires
    // trying at most C(n, k). Both shipped tiers must clear that bar, which is
    // the property that lets a sabotaging contact be routed around.
    expect(DEFAULT_MAX_SUBSETS).toBeGreaterThanOrEqual(choose(S3_SHARES, S3_THRESHOLD));
    expect(S3_SHARES - S3_THRESHOLD).toBeGreaterThanOrEqual(1);
  });
});
