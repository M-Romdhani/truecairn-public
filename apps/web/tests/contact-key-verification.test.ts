import {
  generateEnrollmentMaterial,
  lock,
  unlock,
  type KeyMaterial,
} from '@truecairn/client-crypto';
import {
  contactSafetyNumber,
  fromBase64,
  randomBytes,
  toBase64,
  x25519KeypairFromSeed,
} from '@truecairn/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContactRow } from '../src/contacts/api.js';
import { encryptContactLabel, sealS1EnvelopeToContact } from '../src/contacts/crypto.js';
import {
  evaluateContactKeyState,
  requireVerifiedContactKey,
  sealKeyPin,
  UnverifiedContactKeyError,
} from '../src/contacts/key-pin.js';

// ── THE KEY-SUBSTITUTION GATE ────────────────────────────────────────────────
//
// These are negative tests in the sense of CLAUDE.md invariant #2, and they are
// permanent. A "fix" that flips one is a bug.
//
// What they encode: the server distributes contact public keys, and before this
// gate existed the owner's client sealed release shares to whatever it received.
// One UPDATE against contacts.contact_x25519_pubkey — no code change, so the
// reproducible build stays clean and /security/build reports nothing wrong —
// handed the operator the S1 tier key outright, or the S2 tier key with two
// substitutions. The possession proof does not close it: the server issues and
// verifies that proof, so it demonstrates the submitter holds the secrets for
// the keys the SERVER chose to challenge, and says nothing to the owner.
//
// The gate is the owner's out-of-band comparison, pinned. Everything below
// asserts that sealing is impossible without it, and that the states which mean
// "someone interfered" are distinguishable from the state that means "not done
// yet".

const PASS = 'key-verification-test-passphrase';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';
const CONTACT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_CONTACT_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

let material: KeyMaterial;
beforeAll(() => {
  material = generateEnrollmentMaterial(utf8(PASS)).material;
  unlock(utf8(PASS), material);
});
afterAll(() => lock());

function keypair(): { x: Uint8Array; e: Uint8Array } {
  return { x: x25519KeypairFromSeed(randomBytes(32)).publicKey, e: randomBytes(32) };
}

// A contact row exactly as the server would serve it: enrolled, keys present,
// no pin. This is the shape that used to be sufficient to seal a share.
function enrolledRow(contactId: string, keys: { x: Uint8Array; e: Uint8Array }): ContactRow {
  const label = encryptContactLabel('a contact');
  return {
    contactId,
    role: 'personal',
    status: 'enrolled',
    displayLabelCiphertext: label.displayLabelCiphertext,
    displayLabelNonce: label.displayLabelNonce,
    x25519Pubkey: toBase64(keys.x),
    ed25519Pubkey: toBase64(keys.e),
    keyPinCiphertext: null,
    keyPinNonce: null,
    keyPinConfirmedAt: null,
    // The row declares the version its label was written under, and the pin
    // below is sealed under that same version — exactly as production does.
    contactPinVersion: label.contactPinVersion,
  };
}

// The same row after the owner compared the security code and confirmed.
function confirmed(row: ContactRow, userId = USER_ID): ContactRow {
  const pin = sealKeyPin({
    userId,
    contactId: row.contactId,
    x25519Pubkey: row.x25519Pubkey!,
    ed25519Pubkey: row.ed25519Pubkey!,
    // The ROW's version, not a literal: the pin route cannot move a row between
    // versions, so sealing under anything else is not a state production can reach.
    contactPinVersion: row.contactPinVersion!,
  });
  return { ...row, ...pin, keyPinConfirmedAt: new Date().toISOString() };
}

describe('sealing is impossible without the owner’s out-of-band confirmation', () => {
  it('REFUSES to seal to an enrolled-but-unconfirmed key', () => {
    const row = enrolledRow(CONTACT_ID, keypair());
    expect(evaluateContactKeyState(USER_ID, row).kind).toBe('unverified');
    expect(() => requireVerifiedContactKey(USER_ID, row)).toThrow(UnverifiedContactKeyError);
  });

  it('allows sealing once the owner has confirmed', () => {
    const row = confirmed(enrolledRow(CONTACT_ID, keypair()));
    expect(evaluateContactKeyState(USER_ID, row).kind).toBe('verified');
    const key = requireVerifiedContactKey(USER_ID, row);
    expect(key.contactId).toBe(CONTACT_ID);
    // And the seal actually happens through the token, not around it.
    expect(sealS1EnvelopeToContact(key).length).toBeGreaterThan(0);
  });

  // THE ATTACK. The owner confirmed the real contact's keys; the server then
  // swaps in a key whose secret the operator holds. Everything else about the
  // row is untouched and still looks enrolled.
  it('REFUSES after the served X25519 key is substituted, and calls it changed', () => {
    const real = keypair();
    const row = confirmed(enrolledRow(CONTACT_ID, real));
    const attacker = x25519KeypairFromSeed(randomBytes(32));

    const substituted: ContactRow = { ...row, x25519Pubkey: toBase64(attacker.publicKey) };

    const state = evaluateContactKeyState(USER_ID, substituted);
    expect(state.kind).toBe('changed');
    expect(() => requireVerifiedContactKey(USER_ID, substituted)).toThrow(
      UnverifiedContactKeyError,
    );
  });

  // The partial substitution the two-key fingerprint exists to catch: leave the
  // sealing key alone and swap the signing key, or vice versa.
  it('REFUSES after only the Ed25519 key is substituted', () => {
    const row = confirmed(enrolledRow(CONTACT_ID, keypair()));
    const substituted: ContactRow = { ...row, ed25519Pubkey: toBase64(randomBytes(32)) };
    expect(evaluateContactKeyState(USER_ID, substituted).kind).toBe('changed');
    expect(() => requireVerifiedContactKey(USER_ID, substituted)).toThrow();
  });

  // Deleting the pin is the one thing the server CAN do to it. That must fail
  // closed to "not confirmed", never open to "assume it was fine".
  it('REFUSES when the pin is deleted (fail closed, not fail open)', () => {
    const row = confirmed(enrolledRow(CONTACT_ID, keypair()));
    const stripped: ContactRow = {
      ...row,
      keyPinCiphertext: null,
      keyPinNonce: null,
      keyPinConfirmedAt: null,
    };
    expect(evaluateContactKeyState(USER_ID, stripped).kind).toBe('unverified');
    expect(() => requireVerifiedContactKey(USER_ID, stripped)).toThrow();
  });

  // A client talking to an older API instance mid-deploy gets a row with these
  // fields missing entirely rather than null. That must degrade to "nothing to
  // verify", not throw — a crash in the state evaluator takes out the contact
  // list, and a caller that swallows it would be back to sealing blind.
  it('treats missing fields as absent rather than throwing', () => {
    const row = enrolledRow(CONTACT_ID, keypair());
    const legacy = { ...row } as Partial<ContactRow> as ContactRow;
    delete (legacy as Partial<ContactRow>).ed25519Pubkey;
    delete (legacy as Partial<ContactRow>).keyPinCiphertext;
    delete (legacy as Partial<ContactRow>).keyPinNonce;
    delete (legacy as Partial<ContactRow>).keyPinConfirmedAt;
    expect(() => evaluateContactKeyState(USER_ID, legacy)).not.toThrow();
    expect(evaluateContactKeyState(USER_ID, legacy).kind).toBe('no_keys');
    expect(() => requireVerifiedContactKey(USER_ID, legacy)).toThrow();
  });

  it('REFUSES a contact with no keys at all', () => {
    const row = enrolledRow(CONTACT_ID, keypair());
    const noKeys: ContactRow = { ...row, x25519Pubkey: null, ed25519Pubkey: null };
    expect(evaluateContactKeyState(USER_ID, noKeys).kind).toBe('no_keys');
    expect(() => requireVerifiedContactKey(USER_ID, noKeys)).toThrow();
  });
});

describe('the pin cannot be forged, moved, or replayed by the server', () => {
  // Without the AAD binding, a server could lift the pin from a contact the
  // owner DID confirm and paste it onto a row carrying a substituted key.
  it('REJECTS a pin transplanted from another contact row', () => {
    const keys = keypair();
    const legit = confirmed(enrolledRow(CONTACT_ID, keys));
    // Same keys, same owner, different contact id — only the AAD differs.
    const victim: ContactRow = {
      ...enrolledRow(OTHER_CONTACT_ID, keys),
      keyPinCiphertext: legit.keyPinCiphertext,
      keyPinNonce: legit.keyPinNonce,
      keyPinConfirmedAt: legit.keyPinConfirmedAt,
    };
    expect(evaluateContactKeyState(USER_ID, victim).kind).toBe('tampered');
    expect(() => requireVerifiedContactKey(USER_ID, victim)).toThrow();
  });

  it('REJECTS a pin bound to a different owner', () => {
    const row = confirmed(enrolledRow(CONTACT_ID, keypair()), OTHER_USER_ID);
    expect(evaluateContactKeyState(USER_ID, row).kind).toBe('tampered');
  });

  it('REJECTS a corrupted pin rather than treating it as absent', () => {
    const row = confirmed(enrolledRow(CONTACT_ID, keypair()));
    const ct = fromBase64(row.keyPinCiphertext!);
    ct[0]! ^= 0xff;
    const corrupted: ContactRow = { ...row, keyPinCiphertext: toBase64(ct) };
    // 'tampered', not 'unverified': the difference is whether the owner is told
    // "you have not done this yet" or "something interfered with what you did".
    expect(evaluateContactKeyState(USER_ID, corrupted).kind).toBe('tampered');
  });
});

describe('the security code is what the two humans actually compare', () => {
  // The owner's screen computes it from what the SERVER sent. The contact's
  // screen computes it from their OWN master key. The comparison is only
  // meaningful if a substitution moves the owner's copy.
  it('changes when the served key is substituted', () => {
    const real = keypair();
    const attacker = x25519KeypairFromSeed(randomBytes(32));
    const honest = contactSafetyNumber({ x25519PublicKey: real.x, ed25519PublicKey: real.e });
    const shown = contactSafetyNumber({
      x25519PublicKey: attacker.publicKey,
      ed25519PublicKey: real.e,
    });
    expect(shown).not.toBe(honest);
  });

  it('is stable for the same keys, so an honest contact is never falsely alarmed', () => {
    const k = keypair();
    const a = contactSafetyNumber({ x25519PublicKey: k.x, ed25519PublicKey: k.e });
    const b = contactSafetyNumber({ x25519PublicKey: k.x, ed25519PublicKey: k.e });
    expect(a).toBe(b);
  });
});
