import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, initCrypto, randomBytes } from '@truecairn/crypto';
import { buildOuterLayerAad } from './aad.js';
import { encryptItemContent } from './item-content.js';
import { generateItemKey, wrapItemKey } from './item-key.js';
import {
  applyOuterLayerWrap,
  generateOuterLayerKek,
  generateOuterLayerKey,
  makeInnerVaultBundle,
  removeOuterLayerWrap,
  unwrapOuterLayerKey,
  wrapOuterLayerKey,
} from './outer-layer.js';
import { generateTierKey } from './tier-key.js';
import {
  OUTER_LAYER_KEY_BYTES,
  type InnerVaultBundle,
  type OuterLayerKek,
  type OuterLayerKeyWrappedByKek,
  type OuterWrappedVaultBundle,
  type UnwrappedOuterLayerKey,
} from './types.js';

// These tests exercise the OUTER layer; the inner wrap just needs to be well
// formed, so one fixed item id serves throughout.
const BUNDLE_ITEM_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

beforeAll(async () => {
  await initCrypto();
});

function sampleInnerBundle(tier: 's1' | 's2' | 's3' = 's3'): InnerVaultBundle {
  const tierKey = generateTierKey(tier);
  const itemKey = generateItemKey();
  const wrappedItemKey = wrapItemKey(itemKey, tierKey, BUNDLE_ITEM_ID);
  const contentCiphertext = encryptItemContent(
    new TextEncoder().encode('inner vault content'),
    itemKey,
  );
  return makeInnerVaultBundle(contentCiphertext, wrappedItemKey);
}

describe('outer-layer key generation + KEK wrap/unwrap', () => {
  it('generators return 32 bytes', () => {
    expect(generateOuterLayerKey().length).toBe(OUTER_LAYER_KEY_BYTES);
    expect(generateOuterLayerKek().length).toBe(32);
  });

  it('round-trips a key wrap/unwrap with AAD', () => {
    const key = generateOuterLayerKey();
    const kek = generateOuterLayerKek();
    const aad = buildOuterLayerAad({
      userId: '11111111-2222-3333-4444-555555555555',
      tier: 's3',
      kekId: 'kek-prod',
      generation: 1,
    });
    const wrapped = wrapOuterLayerKey(key, kek, aad);
    const recovered = unwrapOuterLayerKey(wrapped, kek);
    expect(bytesToHex(recovered)).toBe(bytesToHex(key));
  });

  it('unwrap with matching expectedAad succeeds', () => {
    const key = generateOuterLayerKey();
    const kek = generateOuterLayerKek();
    const aad = buildOuterLayerAad({ userId: 'u', tier: 's2', kekId: 'k', generation: 3 });
    const wrapped = wrapOuterLayerKey(key, kek, aad);
    const expected = buildOuterLayerAad({ userId: 'u', tier: 's2', kekId: 'k', generation: 3 });
    expect(bytesToHex(unwrapOuterLayerKey(wrapped, kek, expected))).toBe(bytesToHex(key));
  });

  it('unwrap with mismatched expectedAad throws before decryption', () => {
    const key = generateOuterLayerKey();
    const kek = generateOuterLayerKek();
    const aad = buildOuterLayerAad({ userId: 'u', tier: 's2', kekId: 'k', generation: 3 });
    const wrapped = wrapOuterLayerKey(key, kek, aad);
    const wrongExpected = buildOuterLayerAad({ userId: 'u', tier: 's2', kekId: 'k', generation: 4 });
    expect(() => unwrapOuterLayerKey(wrapped, kek, wrongExpected)).toThrow(/AAD does not match/);
  });

  it('wrong KEK throws on unwrap', () => {
    const key = generateOuterLayerKey();
    const kek = generateOuterLayerKek();
    const aad = buildOuterLayerAad({ userId: 'u', tier: 's1', kekId: 'k', generation: 1 });
    const wrapped = wrapOuterLayerKey(key, kek, aad);
    const wrongKek = randomBytes(32) as OuterLayerKek;
    expect(() => unwrapOuterLayerKey(wrapped, wrongKek)).toThrow();
  });

  it('tampering with the stored aad breaks decryption (aad is authenticated)', () => {
    const key = generateOuterLayerKey();
    const kek = generateOuterLayerKek();
    const aad = buildOuterLayerAad({ userId: 'u', tier: 's3', kekId: 'k', generation: 1 });
    const wrapped = wrapOuterLayerKey(key, kek, aad);
    const tamperedAad = new Uint8Array(wrapped.aad);
    tamperedAad[0] = tamperedAad[0]! ^ 0x01;
    const tampered = { ...wrapped, aad: tamperedAad } as OuterLayerKeyWrappedByKek;
    // No expectedAad supplied → unwrap uses the (tampered) stored aad, which
    // no longer matches what the ciphertext was authenticated with.
    expect(() => unwrapOuterLayerKey(tampered, kek)).toThrow();
  });

  it('rejects outer-layer key of wrong length on wrap', () => {
    const kek = generateOuterLayerKek();
    const aad = buildOuterLayerAad({ userId: 'u', tier: 's1', kekId: 'k', generation: 1 });
    const tooShort = randomBytes(16) as UnwrappedOuterLayerKey;
    expect(() => wrapOuterLayerKey(tooShort, kek, aad)).toThrow(/must be 32 bytes/);
  });
});

describe('outer-layer bundle wrap/unwrap (server-transparent storage layer)', () => {
  it('round-trips an inner bundle through apply/remove', () => {
    const inner = sampleInnerBundle('s3');
    const olk = generateOuterLayerKey();
    const outer = applyOuterLayerWrap(inner, olk);
    const recovered = removeOuterLayerWrap(outer, olk);
    expect(bytesToHex(recovered.contentCiphertext.ciphertext)).toBe(
      bytesToHex(inner.contentCiphertext.ciphertext),
    );
    expect(bytesToHex(recovered.contentCiphertext.nonce)).toBe(
      bytesToHex(inner.contentCiphertext.nonce),
    );
    expect(bytesToHex(recovered.wrappedItemKey.ciphertext)).toBe(
      bytesToHex(inner.wrappedItemKey.ciphertext),
    );
    expect(bytesToHex(recovered.wrappedItemKey.nonce)).toBe(
      bytesToHex(inner.wrappedItemKey.nonce),
    );
    expect(recovered.wrappedItemKey.tier).toBe(inner.wrappedItemKey.tier);
  });

  it('preserves tier through the round-trip for every tier', () => {
    for (const tier of ['s1', 's2', 's3'] as const) {
      const inner = sampleInnerBundle(tier);
      const olk = generateOuterLayerKey();
      const recovered = removeOuterLayerWrap(applyOuterLayerWrap(inner, olk), olk);
      expect(recovered.wrappedItemKey.tier).toBe(tier);
    }
  });

  it('wrong outer-layer key throws on remove', () => {
    const inner = sampleInnerBundle('s2');
    const olk = generateOuterLayerKey();
    const wrong = generateOuterLayerKey();
    const outer = applyOuterLayerWrap(inner, olk);
    expect(() => removeOuterLayerWrap(outer, wrong)).toThrow();
  });

  it('tampered outer ciphertext throws on remove', () => {
    const inner = sampleInnerBundle('s2');
    const olk = generateOuterLayerKey();
    const outer = applyOuterLayerWrap(inner, olk);
    const ct = new Uint8Array(outer.ciphertext);
    ct[0] = ct[0]! ^ 0x01;
    const tampered = { ciphertext: ct, nonce: outer.nonce } as OuterWrappedVaultBundle;
    expect(() => removeOuterLayerWrap(tampered, olk)).toThrow();
  });

  it('two wraps of the same bundle differ (nonce randomness)', () => {
    const inner = sampleInnerBundle('s3');
    const olk = generateOuterLayerKey();
    const a = applyOuterLayerWrap(inner, olk);
    const b = applyOuterLayerWrap(inner, olk);
    expect(bytesToHex(a.ciphertext)).not.toBe(bytesToHex(b.ciphertext));
  });

  it('zero-knowledge property: the outer-layer key alone does not reveal content', () => {
    // Removing the outer wrap yields the INNER form — still per-item-key
    // encrypted. The recovered content ciphertext is NOT the plaintext.
    const tierKey = generateTierKey('s3');
    const itemKey = generateItemKey();
    const wrappedItemKey = wrapItemKey(itemKey, tierKey, BUNDLE_ITEM_ID);
    const plaintext = new TextEncoder().encode('crypto seed phrase');
    const contentCiphertext = encryptItemContent(plaintext, itemKey);
    const inner = makeInnerVaultBundle(contentCiphertext, wrappedItemKey);

    const olk = generateOuterLayerKey();
    const outer = applyOuterLayerWrap(inner, olk);
    const recovered = removeOuterLayerWrap(outer, olk);

    // The recovered content ciphertext must NOT equal the plaintext — the
    // outer-layer key removed only the temporal-gate wrap, not confidentiality.
    expect(bytesToHex(recovered.contentCiphertext.ciphertext)).not.toBe(bytesToHex(plaintext));
  });
});
