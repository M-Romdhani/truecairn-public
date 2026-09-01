import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/x25519.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  X25519_PUBLIC_KEY_BYTES,
  X25519_SECRET_KEY_BYTES,
  X25519_SHARED_SECRET_BYTES,
  generateX25519Keypair,
  x25519PublicFromSecret,
  x25519ScalarMult,
} from './x25519.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

describe('X25519 (KAT from RFC 7748 §5.2 — Alice/Bob)', () => {
  const alicePub = hexToBytes(vectorFile.alice.publicKey);
  const aliceSec = hexToBytes(vectorFile.alice.secretKey);
  const bobPub = hexToBytes(vectorFile.bob.publicKey);
  const bobSec = hexToBytes(vectorFile.bob.secretKey);
  const expectedShared = hexToBytes(vectorFile.sharedSecret);

  it('public-from-secret matches RFC 7748 Alice', () => {
    expect(bytesToHex(x25519PublicFromSecret(aliceSec))).toBe(vectorFile.alice.publicKey);
  });

  it('public-from-secret matches RFC 7748 Bob', () => {
    expect(bytesToHex(x25519PublicFromSecret(bobSec))).toBe(vectorFile.bob.publicKey);
  });

  it('Alice·Bob shared secret matches RFC 7748', () => {
    const k = x25519ScalarMult(aliceSec, bobPub);
    expect(bytesToHex(k)).toBe(vectorFile.sharedSecret);
  });

  it('Bob·Alice shared secret matches RFC 7748 (symmetry)', () => {
    const k = x25519ScalarMult(bobSec, alicePub);
    expect(bytesToHex(k)).toBe(vectorFile.sharedSecret);
  });

  it('shared secret length matches the constant', () => {
    expect(expectedShared.length).toBe(X25519_SHARED_SECRET_BYTES);
  });
});

describe('X25519 keypair generator', () => {
  it('produces key sizes matching the constants', () => {
    const kp = generateX25519Keypair();
    expect(kp.publicKey.length).toBe(X25519_PUBLIC_KEY_BYTES);
    expect(kp.secretKey.length).toBe(X25519_SECRET_KEY_BYTES);
  });

  it('two consecutive generations return different keys', () => {
    const a = generateX25519Keypair();
    const b = generateX25519Keypair();
    expect(bytesToHex(a.secretKey)).not.toBe(bytesToHex(b.secretKey));
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it("generated keypair's public part matches its scalarmult of base", () => {
    const kp = generateX25519Keypair();
    expect(bytesToHex(x25519PublicFromSecret(kp.secretKey))).toBe(bytesToHex(kp.publicKey));
  });
});

describe('X25519 input validation', () => {
  it('rejects secret key of wrong length', () => {
    expect(() => x25519PublicFromSecret(new Uint8Array(16))).toThrow(/secretKey must be 32/);
  });

  it('rejects public key of wrong length on scalarmult', () => {
    expect(() => x25519ScalarMult(new Uint8Array(32), new Uint8Array(16))).toThrow(
      /publicKey must be 32/,
    );
  });
});
