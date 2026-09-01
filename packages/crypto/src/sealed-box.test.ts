import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/sealed-box.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  SEALED_BOX_OVERHEAD_BYTES,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
} from './sealed-box.js';
import { x25519KeypairFromSeed } from './x25519.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

// Frozen-fixture tests because sealed_box ciphertext is non-deterministic
// (ephemeral X25519 keypair is fresh per encryption). The frozen ciphertext
// in vectors/sealed-box.json was generated once by this same wrapper and
// pinned. Structural tests verify the layout invariants documented in the
// libsodium reference (ephemeral pubkey || sealed payload).

describe('Sealed box (frozen libsodium fixture)', () => {
  const recipientPub = hexToBytes(vectorFile.recipient.publicKey);
  const recipientSec = hexToBytes(vectorFile.recipient.secretKey);
  const recipientSeed = hexToBytes(vectorFile.recipient.seed);
  const plaintext = hexToBytes(vectorFile.plaintextHex);
  const frozenCt = hexToBytes(vectorFile.frozenCiphertext);

  it('recipient keypair derived from seed matches the fixture', () => {
    const kp = x25519KeypairFromSeed(recipientSeed);
    expect(bytesToHex(kp.publicKey)).toBe(vectorFile.recipient.publicKey);
    expect(bytesToHex(kp.secretKey)).toBe(vectorFile.recipient.secretKey);
  });

  it('decryption of the frozen ciphertext recovers the original plaintext', () => {
    const recovered = sealedBoxDecrypt({
      recipientPublicKey: recipientPub,
      recipientSecretKey: recipientSec,
      ciphertext: frozenCt,
    });
    expect(bytesToHex(recovered)).toBe(vectorFile.plaintextHex);
  });

  it('frozen ciphertext has the expected length: overhead + plaintext', () => {
    expect(frozenCt.length).toBe(SEALED_BOX_OVERHEAD_BYTES + plaintext.length);
  });
});

describe('Sealed box — structural and round-trip', () => {
  const recipientPub = hexToBytes(vectorFile.recipient.publicKey);
  const recipientSec = hexToBytes(vectorFile.recipient.secretKey);
  const plaintext = new TextEncoder().encode('hello world');

  it('fresh encryption produces ciphertext of expected length', () => {
    const ct = sealedBoxEncrypt({ recipientPublicKey: recipientPub, plaintext });
    expect(ct.length).toBe(SEALED_BOX_OVERHEAD_BYTES + plaintext.length);
  });

  it('round-trip: encrypt then decrypt yields the original plaintext', () => {
    const ct = sealedBoxEncrypt({ recipientPublicKey: recipientPub, plaintext });
    const recovered = sealedBoxDecrypt({
      recipientPublicKey: recipientPub,
      recipientSecretKey: recipientSec,
      ciphertext: ct,
    });
    expect(bytesToHex(recovered)).toBe(bytesToHex(plaintext));
  });

  it('two encryptions of the same plaintext produce different ciphertexts (ephemeral randomness)', () => {
    const a = sealedBoxEncrypt({ recipientPublicKey: recipientPub, plaintext });
    const b = sealedBoxEncrypt({ recipientPublicKey: recipientPub, plaintext });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

describe('Sealed box — authentication failures', () => {
  const recipientPub = hexToBytes(vectorFile.recipient.publicKey);
  const recipientSec = hexToBytes(vectorFile.recipient.secretKey);
  const plaintext = new TextEncoder().encode('hello world');

  it('flipped byte in ciphertext throws on decrypt', () => {
    const ct = sealedBoxEncrypt({ recipientPublicKey: recipientPub, plaintext });
    ct[ct.length - 1] = ct[ct.length - 1]! ^ 0x01;
    expect(() =>
      sealedBoxDecrypt({
        recipientPublicKey: recipientPub,
        recipientSecretKey: recipientSec,
        ciphertext: ct,
      }),
    ).toThrow();
  });

  it('wrong recipient secret key throws on decrypt', () => {
    // X25519 secret keys are clamped: bits 0, 1, 2 of byte 0 are forced to 0,
    // and bit 7 of byte 31 is forced to 1. Flipping a clamped bit (e.g. 0x01)
    // is a no-op for scalar multiplication — the resulting "wrong" key
    // becomes identical to the original after clamping. Flip bit 3 instead.
    const ct = sealedBoxEncrypt({ recipientPublicKey: recipientPub, plaintext });
    const wrongSec = new Uint8Array(recipientSec);
    wrongSec[0] = wrongSec[0]! ^ 0x08;
    expect(() =>
      sealedBoxDecrypt({
        recipientPublicKey: recipientPub,
        recipientSecretKey: wrongSec,
        ciphertext: ct,
      }),
    ).toThrow();
  });

  it('rejects ciphertext shorter than overhead', () => {
    expect(() =>
      sealedBoxDecrypt({
        recipientPublicKey: recipientPub,
        recipientSecretKey: recipientSec,
        ciphertext: new Uint8Array(16),
      }),
    ).toThrow(/shorter than overhead/);
  });
});
