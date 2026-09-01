import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/xchacha20poly1305.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  SECRETBOX_KEY_BYTES,
  SECRETBOX_NONCE_BYTES,
  SECRETBOX_TAG_BYTES,
  randomSecretboxKey,
  randomSecretboxNonce,
  secretboxDecrypt,
  secretboxEncrypt,
} from './secretbox.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

describe('XChaCha20-Poly1305 IETF (KAT from draft-irtf-cfrg-xchacha-03 §A.3.1)', () => {
  // The IETF draft publishes ciphertext and tag separately; libsodium's
  // crypto_aead_xchacha20poly1305_ietf_encrypt emits ciphertext || tag in a
  // single buffer. The expected combined value is ciphertext + tag.
  const v = vectorFile.vector;
  const key = hexToBytes(v.key);
  const nonce = hexToBytes(v.nonce);
  const aad = hexToBytes(v.additionalData);
  const plaintext = new TextEncoder().encode(v.plaintextAscii);
  const expectedCiphertext = hexToBytes(v.expectedCiphertext);
  const expectedTag = hexToBytes(v.expectedTag);
  const expectedCombined = new Uint8Array(expectedCiphertext.length + expectedTag.length);
  expectedCombined.set(expectedCiphertext, 0);
  expectedCombined.set(expectedTag, expectedCiphertext.length);

  it('input sizes match constants', () => {
    expect(key.length).toBe(SECRETBOX_KEY_BYTES);
    expect(nonce.length).toBe(SECRETBOX_NONCE_BYTES);
    expect(expectedTag.length).toBe(SECRETBOX_TAG_BYTES);
  });

  it('encrypt produces the exact KAT ciphertext + tag bytes', () => {
    const out = secretboxEncrypt({
      key,
      nonce,
      plaintext,
      additionalData: aad,
    });
    expect(bytesToHex(out)).toBe(bytesToHex(expectedCombined));
  });

  it('decrypt of the KAT ciphertext recovers the plaintext', () => {
    const recovered = secretboxDecrypt({
      key,
      nonce,
      ciphertext: expectedCombined,
      additionalData: aad,
    });
    expect(new TextDecoder().decode(recovered)).toBe(v.plaintextAscii);
  });
});

describe('XChaCha20-Poly1305 authentication failures', () => {
  const key = hexToBytes(vectorFile.vector.key);
  const nonce = hexToBytes(vectorFile.vector.nonce);
  const aad = hexToBytes(vectorFile.vector.additionalData);
  const plaintext = new TextEncoder().encode(vectorFile.vector.plaintextAscii);

  it('flipped ciphertext bit throws on decrypt', () => {
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    ct[0] = ct[0]! ^ 0x01;
    expect(() =>
      secretboxDecrypt({ key, nonce, ciphertext: ct, additionalData: aad }),
    ).toThrow();
  });

  it('flipped tag bit throws on decrypt', () => {
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    ct[ct.length - 1] = ct[ct.length - 1]! ^ 0x01;
    expect(() =>
      secretboxDecrypt({ key, nonce, ciphertext: ct, additionalData: aad }),
    ).toThrow();
  });

  it('changed AAD throws on decrypt (AAD is authenticated)', () => {
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    const tamperedAad = new Uint8Array(aad);
    tamperedAad[0] = tamperedAad[0]! ^ 0x01;
    expect(() =>
      secretboxDecrypt({ key, nonce, ciphertext: ct, additionalData: tamperedAad }),
    ).toThrow();
  });

  it('absent AAD on decrypt of AAD-bound ciphertext throws', () => {
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    expect(() => secretboxDecrypt({ key, nonce, ciphertext: ct })).toThrow();
  });

  it('different nonce throws on decrypt', () => {
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    const otherNonce = new Uint8Array(nonce);
    otherNonce[0] = otherNonce[0]! ^ 0x01;
    expect(() =>
      secretboxDecrypt({ key, nonce: otherNonce, ciphertext: ct, additionalData: aad }),
    ).toThrow();
  });

  it('different key throws on decrypt', () => {
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    const otherKey = new Uint8Array(key);
    otherKey[0] = otherKey[0]! ^ 0x01;
    expect(() =>
      secretboxDecrypt({ key: otherKey, nonce, ciphertext: ct, additionalData: aad }),
    ).toThrow();
  });
});

describe('XChaCha20-Poly1305 input validation', () => {
  it('rejects key of wrong length', () => {
    expect(() =>
      secretboxEncrypt({
        key: new Uint8Array(16),
        nonce: new Uint8Array(SECRETBOX_NONCE_BYTES),
        plaintext: new Uint8Array(0),
      }),
    ).toThrow(/key must be 32 bytes/);
  });

  it('rejects nonce of wrong length', () => {
    expect(() =>
      secretboxEncrypt({
        key: new Uint8Array(SECRETBOX_KEY_BYTES),
        nonce: new Uint8Array(12),
        plaintext: new Uint8Array(0),
      }),
    ).toThrow(/nonce must be 24 bytes/);
  });

  it('rejects ciphertext shorter than tag length on decrypt', () => {
    expect(() =>
      secretboxDecrypt({
        key: new Uint8Array(SECRETBOX_KEY_BYTES),
        nonce: new Uint8Array(SECRETBOX_NONCE_BYTES),
        ciphertext: new Uint8Array(8),
      }),
    ).toThrow(/shorter than/);
  });
});

describe('XChaCha20-Poly1305 random key + nonce generators', () => {
  it('produces values of the correct length', () => {
    expect(randomSecretboxKey().length).toBe(SECRETBOX_KEY_BYTES);
    expect(randomSecretboxNonce().length).toBe(SECRETBOX_NONCE_BYTES);
  });

  it('two consecutive calls return different values (CSPRNG smoke test)', () => {
    const a = randomSecretboxNonce();
    const b = randomSecretboxNonce();
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});
