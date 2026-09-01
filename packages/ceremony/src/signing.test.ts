import { beforeAll, describe, expect, it } from 'vitest';
import {
  blake2b256,
  bytesToHex,
  ed25519KeypairFromSeed,
  ed25519Sign,
  generateEd25519Keypair,
  generateX25519Keypair,
  hexToBytes,
  initCrypto,
  randomBytes,
} from '@truecairn/crypto';
import {
  buildAffirmationSigningInput,
  buildShareSigningInput,
  verifyAffirmation,
  verifyShareSignature,
} from './signing.js';
import type { AffirmationSigningInput, ShareSigningInput } from './signing.js';

beforeAll(async () => {
  await initCrypto();
});

const BASE: AffirmationSigningInput = {
  ceremonyId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  contactId: '33333333-3333-3333-3333-333333333333',
  shareId: '44444444-4444-4444-4444-444444444444',
  tier: 's3',
};

// Frozen payload for the BASE input. Layout (94 bytes):
//   01                                      version
//   00000018                                lp length = 24
//   truecairn.affirmation.v1                domain tag (24 bytes)
//   1111...(16)  2222...(16)  3333...(16)  4444...(16)   four uuids
//   03                                      tier s3
const FROZEN_PAYLOAD_HEX =
  '010000001874727565636169726e2e61666669726d6174696f6e2e7631' +
  '11111111111111111111111111111111' +
  '22222222222222222222222222222222' +
  '33333333333333333333333333333333' +
  '44444444444444444444444444444444' +
  '03';

describe('buildAffirmationSigningInput — frozen KAT', () => {
  it('produces the documented byte layout', () => {
    expect(bytesToHex(buildAffirmationSigningInput(BASE))).toBe(FROZEN_PAYLOAD_HEX);
  });

  it('payload length is 94 bytes (1 + 4 + 24 + 4×16 + 1)', () => {
    expect(buildAffirmationSigningInput(BASE).length).toBe(94);
  });

  it('is deterministic', () => {
    expect(bytesToHex(buildAffirmationSigningInput(BASE))).toBe(
      bytesToHex(buildAffirmationSigningInput(BASE)),
    );
  });

  it('rejects a malformed uuid', () => {
    expect(() => buildAffirmationSigningInput({ ...BASE, ceremonyId: 'not-a-uuid' })).toThrow();
  });
});

describe('buildAffirmationSigningInput — every field is bound', () => {
  const baseline = bytesToHex(buildAffirmationSigningInput(BASE));
  const variants: Array<[string, AffirmationSigningInput]> = [
    ['ceremonyId', { ...BASE, ceremonyId: '11111111-1111-1111-1111-111111111112' }],
    ['userId', { ...BASE, userId: '22222222-2222-2222-2222-222222222223' }],
    ['contactId', { ...BASE, contactId: '33333333-3333-3333-3333-333333333334' }],
    ['shareId', { ...BASE, shareId: '44444444-4444-4444-4444-444444444445' }],
    ['tier', { ...BASE, tier: 's2' }],
  ];
  for (const [field, variant] of variants) {
    it(`changing ${field} changes the payload`, () => {
      expect(bytesToHex(buildAffirmationSigningInput(variant))).not.toBe(baseline);
    });
  }
});

describe('verifyAffirmation — happy path', () => {
  it('verifies a signature made over the canonical payload', () => {
    const kp = generateEd25519Keypair(); // stands in for the contact affirmation key
    const sig = ed25519Sign(buildAffirmationSigningInput(BASE), kp.secretKey);
    expect(verifyAffirmation(sig, BASE, kp.publicKey)).toBe(true);
  });

  it('verifies deterministically with a seeded key', () => {
    const kp = ed25519KeypairFromSeed(hexToBytes('a'.repeat(64)));
    const sig = ed25519Sign(buildAffirmationSigningInput(BASE), kp.secretKey);
    expect(verifyAffirmation(sig, BASE, kp.publicKey)).toBe(true);
  });
});

describe('verifyAffirmation — rejections', () => {
  it('rejects a tampered signature', () => {
    const kp = generateEd25519Keypair();
    const sig = ed25519Sign(buildAffirmationSigningInput(BASE), kp.secretKey);
    sig[0] = sig[0]! ^ 0x01;
    expect(verifyAffirmation(sig, BASE, kp.publicKey)).toBe(false);
  });

  it('rejects verification under the wrong public key (forgery by another contact)', () => {
    const realContact = generateEd25519Keypair();
    const attacker = generateEd25519Keypair();
    const sig = ed25519Sign(buildAffirmationSigningInput(BASE), attacker.secretKey);
    // Attacker signs with their own key but the server checks the REAL
    // contact's published key → rejected.
    expect(verifyAffirmation(sig, BASE, realContact.publicKey)).toBe(false);
  });

  it('rejects cross-ceremony replay (signature valid for ceremony A, presented for ceremony B)', () => {
    const kp = generateEd25519Keypair();
    const inputA = BASE;
    const inputB: AffirmationSigningInput = {
      ...BASE,
      ceremonyId: '99999999-9999-9999-9999-999999999999',
    };
    const sigForA = ed25519Sign(buildAffirmationSigningInput(inputA), kp.secretKey);
    // The same signature presented against ceremony B's payload must fail —
    // the ceremony_id binding defeats replay across instances.
    expect(verifyAffirmation(sigForA, inputB, kp.publicKey)).toBe(false);
    // And it still verifies for its own ceremony.
    expect(verifyAffirmation(sigForA, inputA, kp.publicKey)).toBe(true);
  });

  it('rejects cross-tier replay (signature for s3 presented as s2)', () => {
    const kp = generateEd25519Keypair();
    const sigForS3 = ed25519Sign(buildAffirmationSigningInput(BASE), kp.secretKey);
    expect(verifyAffirmation(sigForS3, { ...BASE, tier: 's2' }, kp.publicKey)).toBe(false);
  });

  it('rejects a signature bound to a different share_id', () => {
    const kp = generateEd25519Keypair();
    const sig = ed25519Sign(buildAffirmationSigningInput(BASE), kp.secretKey);
    expect(
      verifyAffirmation(sig, { ...BASE, shareId: '44444444-4444-4444-4444-44444444aaaa' }, kp.publicKey),
    ).toBe(false);
  });
});

// ===========================================================================
// Affirmation-share payload — per-(affirmation, recipient) re-wrap signature
// ===========================================================================

const SHARE_BASE = (): ShareSigningInput => ({
  affirmationId: '55555555-5555-5555-5555-555555555555',
  recipientContactId: '66666666-6666-6666-6666-666666666666',
  recipientEphemeralPubkey: new Uint8Array(32).fill(0x42),
  sealedShareCiphertext: hexToBytes('cafebabedeadbeef0102030405060708'),
});

describe('buildShareSigningInput', () => {
  it('is deterministic', () => {
    expect(bytesToHex(buildShareSigningInput(SHARE_BASE()))).toBe(
      bytesToHex(buildShareSigningInput(SHARE_BASE())),
    );
  });

  it('binds the ephemeral pubkey: a different recipient ephemeral changes the payload', () => {
    const a = buildShareSigningInput(SHARE_BASE());
    const b = buildShareSigningInput({
      ...SHARE_BASE(),
      recipientEphemeralPubkey: new Uint8Array(32).fill(0x43),
    });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('binds the ciphertext via blake2b256: a different sealed share changes the payload', () => {
    const a = buildShareSigningInput(SHARE_BASE());
    const b = buildShareSigningInput({
      ...SHARE_BASE(),
      sealedShareCiphertext: hexToBytes('cafebabedeadbeef0102030405060709'),
    });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('embeds blake2b256(ciphertext) as the trailing 32 bytes', () => {
    const input = SHARE_BASE();
    const payload = buildShareSigningInput(input);
    const trailing = payload.slice(payload.length - 32);
    expect(bytesToHex(trailing)).toBe(bytesToHex(blake2b256(input.sealedShareCiphertext)));
  });

  it('rejects an ephemeral pubkey of the wrong length', () => {
    expect(() =>
      buildShareSigningInput({ ...SHARE_BASE(), recipientEphemeralPubkey: new Uint8Array(16) }),
    ).toThrow(/32 bytes/);
  });
});

describe('verifyShareSignature', () => {
  it('verifies a signature made by the affirming contact', () => {
    const contact = generateEd25519Keypair();
    const input = SHARE_BASE();
    const sig = ed25519Sign(buildShareSigningInput(input), contact.secretKey);
    expect(verifyShareSignature(sig, input, contact.publicKey)).toBe(true);
  });

  it('rejects a tampered sealed_share_ciphertext (mutated ciphertext)', () => {
    const contact = generateEd25519Keypair();
    const input = SHARE_BASE();
    const sig = ed25519Sign(buildShareSigningInput(input), contact.secretKey);
    // Server swaps the stored ciphertext; the signature no longer matches.
    const tampered: ShareSigningInput = {
      ...input,
      sealedShareCiphertext: hexToBytes('00000000000000000000000000000000'),
    };
    expect(verifyShareSignature(sig, tampered, contact.publicKey)).toBe(false);
  });

  it('rejects a swapped recipient (different recipient_contact_id)', () => {
    const contact = generateEd25519Keypair();
    const input = SHARE_BASE();
    const sig = ed25519Sign(buildShareSigningInput(input), contact.secretKey);
    const swapped: ShareSigningInput = {
      ...input,
      recipientContactId: '66666666-6666-6666-6666-66666666aaaa',
    };
    expect(verifyShareSignature(sig, swapped, contact.publicKey)).toBe(false);
  });

  it('rejects a swapped recipient ephemeral pubkey', () => {
    const contact = generateEd25519Keypair();
    const input = SHARE_BASE();
    const sig = ed25519Sign(buildShareSigningInput(input), contact.secretKey);
    const swapped: ShareSigningInput = {
      ...input,
      recipientEphemeralPubkey: generateX25519Keypair().publicKey,
    };
    expect(verifyShareSignature(sig, swapped, contact.publicKey)).toBe(false);
  });

  it('rejects verification under the wrong contact key (server fabricated row)', () => {
    const realContact = generateEd25519Keypair();
    const server = generateEd25519Keypair();
    const input = SHARE_BASE();
    // A server with DB write access fabricates a row and signs with its own
    // key; verification against the real contact's published key fails.
    const sig = ed25519Sign(buildShareSigningInput(input), server.secretKey);
    expect(verifyShareSignature(sig, input, realContact.publicKey)).toBe(false);
  });

  it('rejects a real signature reused for a different affirmation_id', () => {
    const contact = generateEd25519Keypair();
    const input = SHARE_BASE();
    const sig = ed25519Sign(buildShareSigningInput(input), contact.secretKey);
    const otherAffirmation: ShareSigningInput = {
      ...input,
      affirmationId: '55555555-5555-5555-5555-5555555555ff',
    };
    expect(verifyShareSignature(sig, otherAffirmation, contact.publicKey)).toBe(false);
  });

  it('round-trips with a real sealed share + ephemeral keypair', () => {
    const contact = generateEd25519Keypair();
    const recipientEphemeral = generateX25519Keypair();
    const sealed = randomBytes(80); // stand-in for a crypto_box_seal output
    const input: ShareSigningInput = {
      affirmationId: '55555555-5555-5555-5555-555555555555',
      recipientContactId: '66666666-6666-6666-6666-666666666666',
      recipientEphemeralPubkey: recipientEphemeral.publicKey,
      sealedShareCiphertext: sealed,
    };
    const sig = ed25519Sign(buildShareSigningInput(input), contact.secretKey);
    expect(verifyShareSignature(sig, input, contact.publicKey)).toBe(true);
  });
});
