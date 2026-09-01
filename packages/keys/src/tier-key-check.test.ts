import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createTierKeyCheck, validateTierKeyCheck } from './tier-key-check.js';
import { generateTierKey } from './tier-key.js';
import type { TierKeyCheck } from './tier-key-check.js';

beforeAll(async () => {
  await initCrypto();
});

describe('tier-key check sentinel', () => {
  it('validates with the same tier key + generation', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    expect(validateTierKeyCheck(tk, check, 1)).toBe(true);
  });

  it('plaintext is 16 random bytes; two checks differ', () => {
    const tk = generateTierKey('s2');
    const a = createTierKeyCheck(tk, 1);
    const b = createTierKeyCheck(tk, 1);
    expect(a.plaintext.length).toBe(16);
    expect(Buffer.from(a.plaintext).equals(Buffer.from(b.plaintext))).toBe(false);
  });

  it('rejects a different (wrong) tier key', () => {
    const tk = generateTierKey('s3');
    const wrong = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    expect(validateTierKeyCheck(wrong, check, 1)).toBe(false);
  });

  it('rejects a mismatched generation (AAD binding)', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    expect(validateTierKeyCheck(tk, check, 2)).toBe(false);
  });

  it('rejects a mismatched tier (AAD binding) — same bytes, relabeled tier', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    // Forge an s2-tagged key with the same bytes; AAD tier differs → fail.
    const relabeled = generateTierKey('s2');
    // Overwrite relabeled's bytes with tk's bytes to isolate the tier-in-AAD effect.
    relabeled.set(tk);
    expect(validateTierKeyCheck(relabeled, check, 1)).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const ct = new Uint8Array(check.ciphertext);
    ct[0] = ct[0]! ^ 0x01;
    const tampered: TierKeyCheck = { plaintext: check.plaintext, ciphertext: ct, nonce: check.nonce };
    expect(validateTierKeyCheck(tk, tampered, 1)).toBe(false);
  });

  it('rejects a tampered stored plaintext (so a swapped sentinel cannot pass)', () => {
    const tk = generateTierKey('s3');
    const check = createTierKeyCheck(tk, 1);
    const pt = new Uint8Array(check.plaintext);
    pt[0] = pt[0]! ^ 0x01;
    const tampered: TierKeyCheck = { plaintext: pt, ciphertext: check.ciphertext, nonce: check.nonce };
    expect(validateTierKeyCheck(tk, tampered, 1)).toBe(false);
  });

  it('rejects generation < 1 on create', () => {
    const tk = generateTierKey('s3');
    expect(() => createTierKeyCheck(tk, 0)).toThrow(/generation/);
  });
});
