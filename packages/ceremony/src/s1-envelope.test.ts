import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, generateX25519Keypair, initCrypto } from '@truecairn/crypto';
import { generateTierKey } from '@truecairn/keys';
import { openS1TierKeyEnvelope, sealS1TierKeyToContact } from './s1-envelope.js';

beforeAll(async () => {
  await initCrypto();
});

describe('S1 tier-key envelope', () => {
  it('seals an S1 tier key to a contact and opens it back (any-one-contact)', () => {
    const s1Key = generateTierKey('s1');
    const contact = generateX25519Keypair();
    const sealed = sealS1TierKeyToContact(s1Key, contact.publicKey);
    const opened = openS1TierKeyEnvelope(sealed, contact);
    expect(bytesToHex(opened)).toBe(bytesToHex(s1Key));
    expect(opened.tier).toBe('s1');
  });

  it('each S1-authorised contact gets an independently openable envelope', () => {
    const s1Key = generateTierKey('s1');
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const sealedForAlice = sealS1TierKeyToContact(s1Key, alice.publicKey);
    const sealedForBob = sealS1TierKeyToContact(s1Key, bob.publicKey);
    expect(bytesToHex(openS1TierKeyEnvelope(sealedForAlice, alice))).toBe(bytesToHex(s1Key));
    expect(bytesToHex(openS1TierKeyEnvelope(sealedForBob, bob))).toBe(bytesToHex(s1Key));
  });

  it('a non-recipient contact cannot open the envelope', () => {
    const s1Key = generateTierKey('s1');
    const intended = generateX25519Keypair();
    const attacker = generateX25519Keypair();
    const sealed = sealS1TierKeyToContact(s1Key, intended.publicKey);
    expect(() => openS1TierKeyEnvelope(sealed, attacker)).toThrow();
  });

  it('a tampered envelope fails to open', () => {
    const s1Key = generateTierKey('s1');
    const contact = generateX25519Keypair();
    const sealed = sealS1TierKeyToContact(s1Key, contact.publicKey);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0x01;
    expect(() => openS1TierKeyEnvelope(sealed, contact)).toThrow();
  });

  it('refuses to seal a non-S1 tier key', () => {
    const s3Key = generateTierKey('s3');
    const contact = generateX25519Keypair();
    expect(() => sealS1TierKeyToContact(s3Key, contact.publicKey)).toThrow(/s1 tier key/);
  });
});
