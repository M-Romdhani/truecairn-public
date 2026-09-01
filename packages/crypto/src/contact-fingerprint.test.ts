import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/contact-fingerprint.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  CONTACT_FINGERPRINT_DOMAIN,
  CONTACT_FINGERPRINT_GROUPS,
  CONTACT_FINGERPRINT_GROUP_DIGITS,
  contactKeyFingerprint,
  contactSafetyNumber,
  formatContactSafetyNumber,
} from './contact-fingerprint.js';
import { bytesToHex, hexToBytes, randomBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

interface Vector {
  name: string;
  x25519PublicKeyHex: string;
  ed25519PublicKeyHex: string;
  expectedDigestHex: string;
  expectedSafetyNumber: string;
}

function inputOf(v: Vector): { x25519PublicKey: Uint8Array; ed25519PublicKey: Uint8Array } {
  return {
    x25519PublicKey: hexToBytes(v.x25519PublicKeyHex),
    ed25519PublicKey: hexToBytes(v.ed25519PublicKeyHex),
  };
}

describe('contact key fingerprint — frozen vectors', () => {
  it('the vector file pins the construction parameters the digest depends on', () => {
    expect(vectorFile.domain).toBe(CONTACT_FINGERPRINT_DOMAIN);
    expect(vectorFile.groups).toBe(CONTACT_FINGERPRINT_GROUPS);
    expect(vectorFile.groupDigits).toBe(CONTACT_FINGERPRINT_GROUP_DIGITS);
  });

  for (const v of vectorFile.vectors as Vector[]) {
    it(`reproduces the digest and number for ${v.name}`, () => {
      const input = inputOf(v);
      expect(bytesToHex(contactKeyFingerprint(input))).toBe(v.expectedDigestHex);
      expect(contactSafetyNumber(input)).toBe(v.expectedSafetyNumber);
    });
  }

  // The whole point of covering both keys: no two distinct key pairs in the
  // fixture set — including the partial substitution and the slot swap —
  // collapse to the same number.
  it('every fixture pair yields a distinct number', () => {
    const seen = new Set((vectorFile.vectors as Vector[]).map((v) => v.expectedSafetyNumber));
    expect(seen.size).toBe(vectorFile.vectors.length);
  });
});

describe('contact key fingerprint — properties', () => {
  const x = hexToBytes('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  const e = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');

  it('is deterministic', () => {
    const a = contactSafetyNumber({ x25519PublicKey: x, ed25519PublicKey: e });
    const b = contactSafetyNumber({ x25519PublicKey: x, ed25519PublicKey: e });
    expect(a).toBe(b);
  });

  // A substitution of EITHER key must move the number. Flipping one bit is the
  // smallest change an attacker could hope to hide behind.
  it('changes when a single bit of either key changes', () => {
    const base = contactSafetyNumber({ x25519PublicKey: x, ed25519PublicKey: e });
    const xFlipped = Uint8Array.from(x);
    xFlipped[0]! ^= 0x01;
    const eFlipped = Uint8Array.from(e);
    eFlipped[31]! ^= 0x80;
    expect(contactSafetyNumber({ x25519PublicKey: xFlipped, ed25519PublicKey: e })).not.toBe(base);
    expect(contactSafetyNumber({ x25519PublicKey: x, ed25519PublicKey: eFlipped })).not.toBe(base);
  });

  it('renders the documented shape: 6 groups of 5 digits', () => {
    const n = contactSafetyNumber({ x25519PublicKey: x, ed25519PublicKey: e });
    expect(n).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(n.split(' ')).toHaveLength(CONTACT_FINGERPRINT_GROUPS);
  });

  // Leading zeros in a group must survive as digits — dropping them would
  // shorten the number and, worse, make two different digests render the same.
  it('zero-pads a group whose value is small', () => {
    const digest = new Uint8Array(32); // all zero -> every group is 00000
    expect(formatContactSafetyNumber(digest)).toBe('00000 00000 00000 00000 00000 00000');
  });

  it('rejects an empty key', () => {
    expect(() =>
      contactKeyFingerprint({ x25519PublicKey: new Uint8Array(0), ed25519PublicKey: e }),
    ).toThrow(/both public keys/);
    expect(() =>
      contactKeyFingerprint({ x25519PublicKey: x, ed25519PublicKey: new Uint8Array(0) }),
    ).toThrow(/both public keys/);
  });

  it('rejects a digest too short to render', () => {
    expect(() => formatContactSafetyNumber(randomBytes(16))).toThrow(/needs >= 30 digest bytes/);
  });

  // Sanity check on the digit extraction rather than the hash: distinct random
  // key pairs should not collide across a sample this small.
  it('does not collide across 500 random key pairs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(
        contactSafetyNumber({ x25519PublicKey: randomBytes(32), ed25519PublicKey: randomBytes(32) }),
      );
    }
    expect(seen.size).toBe(500);
  });
});
