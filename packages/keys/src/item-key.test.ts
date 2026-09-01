import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, initCrypto, randomBytes } from '@truecairn/crypto';
import { generateItemKey, unwrapItemKey, wrapItemKey } from './item-key.js';
import { ITEM_AAD_VERSION_CURRENT } from './aad.js';
import { generateTierKey } from './tier-key.js';
import { ITEM_KEY_BYTES, type ItemKeyWrappedByTier } from './types.js';

// Every wrap/unwrap is bound to a specific item id since 2026-08-09 (F3).
const ITEM_ID = '3f2a1c44-0b7e-4c19-9a2d-5e6f70819abc';
const BOUND = { version: ITEM_AAD_VERSION_CURRENT, itemId: ITEM_ID } as const;

beforeAll(async () => {
  await initCrypto();
});

describe('generateItemKey', () => {
  it('returns 32 bytes', () => {
    expect(generateItemKey().length).toBe(ITEM_KEY_BYTES);
  });

  it('two calls return different keys', () => {
    expect(bytesToHex(generateItemKey())).not.toBe(bytesToHex(generateItemKey()));
  });
});

describe('wrapItemKey / unwrapItemKey — round-trip', () => {
  for (const tier of ['s1', 's2', 's3'] as const) {
    it(`${tier}: unwrap(wrap(itemKey, tierKey), tierKey) === itemKey`, () => {
      const tierKey = generateTierKey(tier);
      const itemKey = generateItemKey();
      const wrapped = wrapItemKey(itemKey, tierKey, ITEM_ID);
      expect(wrapped.tier).toBe(tier);
      const recovered = unwrapItemKey(wrapped, tierKey, BOUND);
      expect(bytesToHex(recovered)).toBe(bytesToHex(itemKey));
    });
  }
});

describe('wrapItemKey / unwrapItemKey — failures', () => {
  it('wrong tier key (same tier) throws on unwrap', () => {
    const tierKey = generateTierKey('s2');
    const otherTierKey = generateTierKey('s2'); // same tier, different bytes
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, tierKey, ITEM_ID);
    expect(() => unwrapItemKey(wrapped, otherTierKey, BOUND)).toThrow();
  });

  it('tier-mismatched tier key throws with a clear message', () => {
    const s2Key = generateTierKey('s2');
    const s3Key = generateTierKey('s3');
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, s2Key, ITEM_ID);
    expect(() => unwrapItemKey(wrapped, s3Key, BOUND)).toThrow(/wrapped for tier s2/);
  });

  it('relabeling the wrapped tier breaks AAD authentication', () => {
    const s2Key = generateTierKey('s2');
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, s2Key, ITEM_ID);
    // Force the tier field to s2's value on an s3 key context — but here we
    // simulate an attacker swapping the label to s3 and presenting an s3 key.
    const relabeled = { ...wrapped, tier: 's3' } as ItemKeyWrappedByTier;
    const s3Key = generateTierKey('s3');
    // The explicit tier check passes now (both s3), but the AAD was computed
    // for s2 at wrap time, so decryption fails.
    expect(() => unwrapItemKey(relabeled, s3Key, BOUND)).toThrow();
  });

  it('tampered ciphertext throws', () => {
    const tierKey = generateTierKey('s2');
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, tierKey, ITEM_ID);
    const ct = new Uint8Array(wrapped.ciphertext);
    ct[0] = ct[0]! ^ 0x01;
    const tampered = { ...wrapped, ciphertext: ct } as ItemKeyWrappedByTier;
    expect(() => unwrapItemKey(tampered, tierKey, BOUND)).toThrow();
  });

  it('rejects item key of wrong length on wrap', () => {
    const tierKey = generateTierKey('s2');
    const tooShort = randomBytes(16) as ReturnType<typeof generateItemKey>;
    expect(() => wrapItemKey(tooShort, tierKey, ITEM_ID)).toThrow(/itemKey must be 32/);
  });
});

// ── F3: the item-identity binding ────────────────────────────────────────────
//
// Permanent negative tests. Before v2 the wrapped item key was bound to its
// TIER only, so a server with write access could move one item's wrapped key
// (and the content that travels with it) onto another same-tier item of the
// same owner, and both decrypted perfectly under the wrong title. A "fix" that
// flips one of these back is a bug.
describe('wrapItemKey — item-identity binding (F3)', () => {
  const ITEM_A = '11111111-1111-4111-8111-111111111111';
  const ITEM_B = '22222222-2222-4222-8222-222222222222';

  it('REFUSES to unwrap under a different item id, same tier and same tier key', () => {
    const tierKey = generateTierKey('s2');
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, tierKey, ITEM_A);
    // The exact attack: same owner, same tier, same key — only the item differs.
    expect(() =>
      unwrapItemKey(wrapped, tierKey, { version: 2, itemId: ITEM_B }),
    ).toThrow();
  });

  it('binds so tightly that a one-character id change fails', () => {
    const tierKey = generateTierKey('s3');
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, tierKey, ITEM_A);
    const nearlyA = ITEM_A.slice(0, -1) + '2';
    expect(() =>
      unwrapItemKey(wrapped, tierKey, { version: 2, itemId: nearlyA }),
    ).toThrow();
  });

  // There is exactly one AAD construction, so a version this client does not
  // know is refused BY NAME rather than being handed to some other builder and
  // surfacing as a generic decryption failure. This is also what a v1 row looks
  // like after the compatibility path was removed: a clear, diagnosable refusal.
  it('REFUSES an unsupported AAD version, and says so', () => {
    const tierKey = generateTierKey('s1');
    const itemKey = generateItemKey();
    const wrapped = wrapItemKey(itemKey, tierKey, ITEM_A);
    expect(() => unwrapItemKey(wrapped, tierKey, { version: 1, itemId: ITEM_A })).toThrow(
      /unsupported item AAD version 1/,
    );
    expect(() => unwrapItemKey(wrapped, tierKey, { version: 3, itemId: ITEM_A })).toThrow(
      /unsupported item AAD version 3/,
    );
  });

  it('rejects an empty item id at wrap rather than binding to nothing', () => {
    const tierKey = generateTierKey('s2');
    expect(() => wrapItemKey(generateItemKey(), tierKey, '')).toThrow(/non-empty item id/);
  });
});
