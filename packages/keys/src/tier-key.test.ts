import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, initCrypto, randomBytes, shamirCombine } from '@truecairn/crypto';
import {
  combineTierKey,
  combineTierKeyForS3Nested,
  generateTierKey,
  releaseShareAsTierShare,
  splitTierKeyForS2,
  splitTierKeyForS3,
  splitTierKeyForS3Nested,
  unwrapTierKey,
  wrapTierKey,
} from './tier-key.js';
import {
  RELEASE_SHARE_INDEX_S2,
  RELEASE_SHARE_INDEX_S3,
  TIER_KEY_BYTES,
  type ReleasePassphraseShare,
  type TierKeyWrappedByMaster,
  type TierWrappingKey,
} from './types.js';

beforeAll(async () => {
  await initCrypto();
});

// A TierWrappingKey is just 32 bytes to this module; the KDF derivation is
// tested in subkeys.test.ts. Use a fixed one here for determinism.
function wrappingKey(): TierWrappingKey {
  return hexToBytes('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100') as TierWrappingKey;
}

// Synthetic release-passphrase share. tier-key split/combine cares only about
// the bytes + tier, not how they were derived; deriveReleasePassphraseShare's
// own KAT lives in kek.test.ts. This keeps tier-key tests fast (no Argon2id).
function syntheticReleaseShare(tier: 's2' | 's3', shareIndex: number): ReleasePassphraseShare {
  const bytes = new Uint8Array(1 + TIER_KEY_BYTES);
  bytes[0] = shareIndex;
  for (let i = 1; i <= TIER_KEY_BYTES; i++) bytes[i] = (i * 7 + shareIndex) & 0xff;
  return { bytes, tier } as ReleasePassphraseShare;
}

describe('generateTierKey', () => {
  it('returns 32 bytes carrying the requested tier', () => {
    for (const tier of ['s1', 's2', 's3'] as const) {
      const k = generateTierKey(tier);
      expect(k.length).toBe(TIER_KEY_BYTES);
      expect(k.tier).toBe(tier);
    }
  });

  it('two calls return different keys', () => {
    expect(bytesToHex(generateTierKey('s2'))).not.toBe(bytesToHex(generateTierKey('s2')));
  });
});

describe('wrapTierKey / unwrapTierKey — round-trip per tier', () => {
  for (const tier of ['s1', 's2', 's3'] as const) {
    it(`${tier}: unwrap(wrap(k)) === k, tier preserved`, () => {
      const wk = wrappingKey();
      const k = generateTierKey(tier);
      const wrapped = wrapTierKey(k, wk, 1);
      expect(wrapped.tier).toBe(tier);
      expect(wrapped.generation).toBe(1);
      const recovered = unwrapTierKey(wrapped, wk);
      expect(bytesToHex(recovered)).toBe(bytesToHex(k));
      expect(recovered.tier).toBe(tier);
    });
  }

  it('generation round-trips through wrap/unwrap', () => {
    const wk = wrappingKey();
    const k = generateTierKey('s3');
    const wrapped = wrapTierKey(k, wk, 7);
    expect(wrapped.generation).toBe(7);
    expect(bytesToHex(unwrapTierKey(wrapped, wk))).toBe(bytesToHex(k));
  });
});

describe('wrapTierKey / unwrapTierKey — authentication + metadata binding', () => {
  it('wrong wrapping key throws', () => {
    const k = generateTierKey('s2');
    const wrapped = wrapTierKey(k, wrappingKey(), 1);
    const wrongKey = randomBytes(32) as TierWrappingKey;
    expect(() => unwrapTierKey(wrapped, wrongKey)).toThrow();
  });

  it('tampered ciphertext throws', () => {
    const k = generateTierKey('s2');
    const wrapped = wrapTierKey(k, wrappingKey(), 1);
    const ct = new Uint8Array(wrapped.ciphertext);
    ct[0] = ct[0]! ^ 0x01;
    const tampered = { ...wrapped, ciphertext: ct } as TierKeyWrappedByMaster;
    expect(() => unwrapTierKey(tampered, wrappingKey())).toThrow();
  });

  it('relabeling the tier field breaks AAD authentication', () => {
    // An attacker swaps the wrapped form's tier from s2 to s3 hoping to make
    // the key usable in the wrong tier context. The AAD binds the tier, so
    // unwrap fails rather than silently returning a mislabeled key.
    const k = generateTierKey('s2');
    const wrapped = wrapTierKey(k, wrappingKey(), 1);
    const relabeled = { ...wrapped, tier: 's3' } as TierKeyWrappedByMaster;
    expect(() => unwrapTierKey(relabeled, wrappingKey())).toThrow();
  });

  it('replaying a different generation breaks AAD authentication', () => {
    const k = generateTierKey('s3');
    const wrapped = wrapTierKey(k, wrappingKey(), 5);
    const replayed = { ...wrapped, generation: 6 } as TierKeyWrappedByMaster;
    expect(() => unwrapTierKey(replayed, wrappingKey())).toThrow();
  });

  it('rejects generation < 1', () => {
    const k = generateTierKey('s2');
    expect(() => wrapTierKey(k, wrappingKey(), 0)).toThrow(/generation/);
  });
});

describe('splitTierKeyForS2 (2-of-3) + combineTierKey', () => {
  it('release share lands at the fixed index 3 with the supplied bytes', () => {
    const k = generateTierKey('s2');
    const release = syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2);
    const shares = splitTierKeyForS2(k, release);
    expect(shares).toHaveLength(3);
    const atIndex3 = shares.find((s) => s.bytes[0] === RELEASE_SHARE_INDEX_S2)!;
    expect(bytesToHex(atIndex3.bytes)).toBe(bytesToHex(release.bytes));
  });

  it('every 2-of-3 subset reconstructs the original tier key', () => {
    const k = generateTierKey('s2');
    const release = syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2);
    const shares = splitTierKeyForS2(k, release);
    const subsets = [
      [0, 1], // two contacts
      [0, 2], // contact + release
      [1, 2], // contact + release
    ];
    for (const subset of subsets) {
      const recovered = combineTierKey(subset.map((i) => shares[i]!));
      expect(bytesToHex(recovered)).toBe(bytesToHex(k));
      expect(recovered.tier).toBe('s2');
    }
  });

  it('reconstruction using the recomputed release share (via releaseShareAsTierShare) works', () => {
    const k = generateTierKey('s2');
    const release = syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2);
    const shares = splitTierKeyForS2(k, release);
    // Simulate a ceremony: contact share #1 + the release share recomputed
    // from the passphrase (here, the synthetic one converted to a tier share).
    const recovered = combineTierKey([shares[0]!, releaseShareAsTierShare(release)]);
    expect(bytesToHex(recovered)).toBe(bytesToHex(k));
  });
});

describe('splitTierKeyForS3 (3-of-4) + combineTierKey', () => {
  it('release share lands at the fixed index 4 with the supplied bytes', () => {
    const k = generateTierKey('s3');
    const release = syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3);
    const shares = splitTierKeyForS3(k, release);
    expect(shares).toHaveLength(4);
    const atIndex4 = shares.find((s) => s.bytes[0] === RELEASE_SHARE_INDEX_S3)!;
    expect(bytesToHex(atIndex4.bytes)).toBe(bytesToHex(release.bytes));
  });

  it('every 3-of-4 subset reconstructs the original tier key', () => {
    const k = generateTierKey('s3');
    const release = syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3);
    const shares = splitTierKeyForS3(k, release);
    const subsets = [
      [0, 1, 2], // three contacts
      [0, 1, 3], // two contacts + release
      [0, 2, 3],
      [1, 2, 3],
    ];
    for (const subset of subsets) {
      const recovered = combineTierKey(subset.map((i) => shares[i]!));
      expect(bytesToHex(recovered)).toBe(bytesToHex(k));
      expect(recovered.tier).toBe('s3');
    }
  });

  it('any 2 of 4 shares do NOT reconstruct the secret (threshold 3)', () => {
    const k = generateTierKey('s3');
    const release = syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3);
    const shares = splitTierKeyForS3(k, release);
    const sub = combineTierKey([shares[0]!, shares[1]!]);
    expect(bytesToHex(sub)).not.toBe(bytesToHex(k));
  });

  it('reconstructed tier key wraps/unwraps cleanly (level-3 integration)', () => {
    const wk = wrappingKey();
    const k = generateTierKey('s3');
    const release = syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3);
    const shares = splitTierKeyForS3(k, release);
    const reconstructed = combineTierKey([shares[0]!, shares[1]!, shares[2]!]);
    const wrapped = wrapTierKey(reconstructed, wk, 1);
    expect(bytesToHex(unwrapTierKey(wrapped, wk))).toBe(bytesToHex(k));
  });
});

describe('combineTierKey — tier-mismatch rejection (early-return)', () => {
  it('rejects mixed-tier shares', () => {
    const s2 = generateTierKey('s2');
    const s3 = generateTierKey('s3');
    const s2Shares = splitTierKeyForS2(s2, syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2));
    const s3Shares = splitTierKeyForS3(s3, syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3));
    expect(() => combineTierKey([s2Shares[0]!, s3Shares[0]!])).toThrow(/same tier/);
  });

  it('rejects fewer than 2 shares', () => {
    const k = generateTierKey('s2');
    const shares = splitTierKeyForS2(k, syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2));
    expect(() => combineTierKey([shares[0]!])).toThrow(/at least 2/);
  });
});

describe('S3 nested scheme (passphrase mandatory + any 2-of-3 contacts) — docs/24', () => {
  // The mask carried by an S3 release share (synthetic; fast — no Argon2id).
  const mask = (): ReleasePassphraseShare => syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3);

  it('any 2 of 3 contacts + the passphrase reconstruct the exact tier key', () => {
    const k = generateTierKey('s3');
    const shares = splitTierKeyForS3Nested(k, mask());
    expect(shares).toHaveLength(3);
    const subsets: Array<[number, number]> = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    for (const [a, b] of subsets) {
      const recovered = combineTierKeyForS3Nested([shares[a]!, shares[b]!], mask());
      expect(bytesToHex(recovered)).toBe(bytesToHex(k));
      expect(recovered.tier).toBe('s3');
    }
    // All three together also reconstruct.
    expect(bytesToHex(combineTierKeyForS3Nested(shares, mask()))).toBe(bytesToHex(k));
  });

  it('is passphrase-MANDATORY: contacts alone recover only the masked secret, not the key', () => {
    const k = generateTierKey('s3');
    const shares = splitTierKeyForS3Nested(k, mask());
    // The value the contacts can reconstruct on their own (C) is NOT the tier key.
    const maskedSecret = shamirCombine([shares[0]!.bytes, shares[1]!.bytes]);
    expect(bytesToHex(maskedSecret)).not.toBe(bytesToHex(k));
    // A wrong passphrase (different mask) yields a different key, never k.
    const wrong = syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S3);
    wrong.bytes[1] = (wrong.bytes[1]! ^ 0xff) & 0xff; // perturb one mask byte
    const viaWrong = combineTierKeyForS3Nested([shares[0]!, shares[1]!], wrong);
    expect(bytesToHex(viaWrong)).not.toBe(bytesToHex(k));
  });

  it('rejects fewer than 2 contact shares and a non-s3 release share', () => {
    const k = generateTierKey('s3');
    const shares = splitTierKeyForS3Nested(k, mask());
    expect(() => combineTierKeyForS3Nested([shares[0]!], mask())).toThrow(/>= 2/);
    expect(() => splitTierKeyForS3Nested(generateTierKey('s2') as never, mask())).toThrow(
      /does not match expected s3/,
    );
    expect(() =>
      combineTierKeyForS3Nested(shares, syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2)),
    ).toThrow(/requires an s3 release share/);
  });
});

describe('splitTierKey — input validation', () => {
  it('rejects tier-key/expected-tier mismatch (S2 fn with S3 key)', () => {
    const k = generateTierKey('s3');
    expect(() => splitTierKeyForS2(k, syntheticReleaseShare('s2', RELEASE_SHARE_INDEX_S2))).toThrow(
      /does not match/,
    );
  });

  it('rejects release-share tier mismatch', () => {
    const k = generateTierKey('s2');
    expect(() => splitTierKeyForS2(k, syntheticReleaseShare('s3', RELEASE_SHARE_INDEX_S2))).toThrow(
      /does not match/,
    );
  });

  it('rejects release share at the wrong index', () => {
    const k = generateTierKey('s2');
    // Index 2 instead of the fixed index 3 for S2.
    expect(() => splitTierKeyForS2(k, syntheticReleaseShare('s2', 2))).toThrow(/fixed index/);
  });
});
