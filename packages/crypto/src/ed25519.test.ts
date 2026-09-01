import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/ed25519.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SECRET_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  ed25519KeypairFromSeed,
  ed25519Sign,
  ed25519Verify,
  generateEd25519Keypair,
} from './ed25519.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

describe('Ed25519 (KAT from RFC 8032 §7.1)', () => {
  for (const v of vectorFile.vectors) {
    describe(v.name, () => {
      const seed = hexToBytes(v.seed);
      const msg = hexToBytes(v.messageHex);
      const expectedSig = v.expectedSignature;

      it('public key derived from seed matches RFC 8032', () => {
        const kp = ed25519KeypairFromSeed(seed);
        expect(bytesToHex(kp.publicKey)).toBe(v.publicKey);
      });

      it('signature over message matches RFC 8032', () => {
        const kp = ed25519KeypairFromSeed(seed);
        const sig = ed25519Sign(msg, kp.secretKey);
        expect(bytesToHex(sig)).toBe(expectedSig);
      });

      it('signature verifies under the public key', () => {
        const kp = ed25519KeypairFromSeed(seed);
        const sig = hexToBytes(expectedSig);
        expect(ed25519Verify(sig, msg, kp.publicKey)).toBe(true);
      });
    });
  }
});

describe('Ed25519 — signature failures', () => {
  const seed = hexToBytes(vectorFile.vectors[1]!.seed);
  const msg = hexToBytes(vectorFile.vectors[1]!.messageHex);

  it('verify returns false for tampered signature', () => {
    const kp = ed25519KeypairFromSeed(seed);
    const sig = ed25519Sign(msg, kp.secretKey);
    sig[0] = sig[0]! ^ 0x01;
    expect(ed25519Verify(sig, msg, kp.publicKey)).toBe(false);
  });

  it('verify returns false for tampered message', () => {
    const kp = ed25519KeypairFromSeed(seed);
    const sig = ed25519Sign(msg, kp.secretKey);
    const tampered = new Uint8Array(msg);
    tampered[0] = tampered[0]! ^ 0x01;
    expect(ed25519Verify(sig, tampered, kp.publicKey)).toBe(false);
  });

  it('verify returns false for wrong public key', () => {
    const kp = ed25519KeypairFromSeed(seed);
    const sig = ed25519Sign(msg, kp.secretKey);
    const otherKp = generateEd25519Keypair();
    expect(ed25519Verify(sig, msg, otherKp.publicKey)).toBe(false);
  });
});

describe('Ed25519 — input validation and generator', () => {
  it('rejects secret key of wrong length on sign', () => {
    expect(() => ed25519Sign(new Uint8Array(1), new Uint8Array(32))).toThrow(
      /secretKey must be 64/,
    );
  });

  it('rejects signature of wrong length on verify', () => {
    expect(() =>
      ed25519Verify(new Uint8Array(32), new Uint8Array(0), new Uint8Array(32)),
    ).toThrow(/signature must be 64/);
  });

  it('rejects public key of wrong length on verify', () => {
    expect(() =>
      ed25519Verify(new Uint8Array(64), new Uint8Array(0), new Uint8Array(16)),
    ).toThrow(/publicKey must be 32/);
  });

  it('generator returns keys matching the constants', () => {
    const kp = generateEd25519Keypair();
    expect(kp.publicKey.length).toBe(ED25519_PUBLIC_KEY_BYTES);
    expect(kp.secretKey.length).toBe(ED25519_SECRET_KEY_BYTES);
  });

  it('round-trip: generated key signs and verifies', () => {
    const kp = generateEd25519Keypair();
    const msg = new TextEncoder().encode('test');
    const sig = ed25519Sign(msg, kp.secretKey);
    expect(sig.length).toBe(ED25519_SIGNATURE_BYTES);
    expect(ed25519Verify(sig, msg, kp.publicKey)).toBe(true);
  });
});
