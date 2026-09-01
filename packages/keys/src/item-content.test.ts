import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, initCrypto, randomBytes } from '@truecairn/crypto';
import { decryptItemContent, encryptItemContent } from './item-content.js';
import { generateItemKey } from './item-key.js';
import type { ItemContentCiphertext, UnwrappedItemKey } from './types.js';

beforeAll(async () => {
  await initCrypto();
});

describe('encryptItemContent / decryptItemContent — round-trip', () => {
  it('recovers small plaintext', () => {
    const itemKey = generateItemKey();
    const content = new TextEncoder().encode('the launch codes are in the safe');
    const ct = encryptItemContent(content, itemKey);
    const recovered = decryptItemContent(ct, itemKey);
    expect(new TextDecoder().decode(recovered)).toBe('the launch codes are in the safe');
  });

  it('recovers empty plaintext', () => {
    const itemKey = generateItemKey();
    const ct = encryptItemContent(new Uint8Array(0), itemKey);
    expect(decryptItemContent(ct, itemKey).length).toBe(0);
  });

  it('recovers 1 MiB plaintext', () => {
    const itemKey = generateItemKey();
    const big = randomBytes(1024 * 1024);
    const ct = encryptItemContent(big, itemKey);
    expect(bytesToHex(decryptItemContent(ct, itemKey))).toBe(bytesToHex(big));
  });

  it('ciphertext length = plaintext + 16 (AEAD tag)', () => {
    const itemKey = generateItemKey();
    const content = randomBytes(100);
    const ct = encryptItemContent(content, itemKey);
    expect(ct.ciphertext.length).toBe(100 + 16);
    expect(ct.nonce.length).toBe(24);
  });

  it('two encryptions of the same content differ (nonce randomness)', () => {
    const itemKey = generateItemKey();
    const content = new TextEncoder().encode('same');
    const a = encryptItemContent(content, itemKey);
    const b = encryptItemContent(content, itemKey);
    expect(bytesToHex(a.ciphertext)).not.toBe(bytesToHex(b.ciphertext));
  });
});

describe('item content — failures', () => {
  it('wrong item key throws on decrypt', () => {
    const itemKey = generateItemKey();
    const wrong = generateItemKey();
    const ct = encryptItemContent(new TextEncoder().encode('secret'), itemKey);
    expect(() => decryptItemContent(ct, wrong)).toThrow();
  });

  it('tampered ciphertext throws', () => {
    const itemKey = generateItemKey();
    const ct = encryptItemContent(new TextEncoder().encode('secret'), itemKey);
    const tampered = new Uint8Array(ct.ciphertext);
    tampered[0] = tampered[0]! ^ 0x01;
    const bad = { ciphertext: tampered, nonce: ct.nonce } as ItemContentCiphertext;
    expect(() => decryptItemContent(bad, itemKey)).toThrow();
  });

  it('rejects item key of wrong length', () => {
    const tooShort = randomBytes(16) as UnwrappedItemKey;
    expect(() => encryptItemContent(new Uint8Array(0), tooShort)).toThrow(/itemKey must be 32/);
  });
});
