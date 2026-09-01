import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateEd25519Keypair,
  generateX25519Keypair,
  lengthPrefixedConcat,
  randomSecretboxNonce,
  secretboxEncrypt,
  toBase64,
} from '@truecairn/crypto';
import { generateEnrollmentMaterial, unlock, withTierKey, type KeyMaterial } from '@truecairn/client-crypto';
import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';
import { decryptContactLabel } from '../src/contacts/crypto.js';
import { evaluateContactKeyState, rewrapKeyPin } from '../src/contacts/key-pin.js';
import type { ContactRow } from '../src/contacts/api.js';

// ── F1 + F2 backfill ─────────────────────────────────────────────────────────
//
// The migration was forward-only, so pre-0068 rows are still under the S1 tier
// key. Moving them is mostly mechanical; the one part that is NOT mechanical is
// the pin, and that is what this file is about.
//
// A pin records WHAT THE OWNER CONFIRMED out of band. Re-deriving it from the
// contact's CURRENT public keys during the rekey would be easier and would be a
// hole: if the server had substituted a key since, re-deriving would launder the
// substitution into a fresh-looking confirmation the owner never made — turning
// the migration into the exact attack the pin exists to detect (docs/15 §5.7.5
// Path E). So the plaintext is decrypted and re-sealed verbatim, and the test
// below is the one that would catch a "simplification" back to re-derivation.

const PASS = 'correct horse battery staple';
const USER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const utf8 = (s: string): Uint8Array => new Uint8Array(new TextEncoder().encode(s));

let material: KeyMaterial;
beforeAll(() => {
  material = generateEnrollmentMaterial(utf8(PASS)).material;
});
const unlocked = (): void => unlock(utf8(PASS), material);

// A pin as it was written BEFORE 0068: under the S1 tier key.
function legacyPin(x: Uint8Array, e: Uint8Array): { keyPinCiphertext: string; keyPinNonce: string } {
  // The REAL lengthPrefixedConcat and the REAL domain string. A hand-rolled copy
  // of either would drift from production and this fixture would then be
  // testing itself rather than the code.
  const enc = new TextEncoder();
  const lp = lengthPrefixedConcat;
  const aad = lp([enc.encode('truecairn/contact-key-pin/v1'), enc.encode(USER), enc.encode(CONTACT)]);
  return withTierKey('s1', (tierKey) => {
    const nonce = randomSecretboxNonce();
    const ct = secretboxEncrypt({ key: tierKey, nonce, plaintext: lp([x, e]), additionalData: aad });
    return { keyPinCiphertext: toBase64(ct), keyPinNonce: toBase64(nonce) };
  });
}

function row(over: Partial<ContactRow>): ContactRow {
  return {
    contactId: CONTACT,
    role: 'personal',
    status: 'enrolled',
    displayLabelCiphertext: '',
    displayLabelNonce: '',
    x25519Pubkey: null,
    ed25519Pubkey: null,
    keyPinCiphertext: null,
    keyPinNonce: null,
    keyPinConfirmedAt: null,
    contactPinVersion: CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
    ...over,
  } as ContactRow;
}

describe('contact metadata rekey (F1+F2 backfill)', () => {
  it('a v1 label written under the S1 tier key still reads, so it can be rewritten', () => {
    unlocked();
    const legacy = withTierKey('s1', (tierKey) => {
      const nonce = randomSecretboxNonce();
      const ct = secretboxEncrypt({ key: tierKey, nonce, plaintext: utf8('Aunt Meredith') });
      return { ct: toBase64(ct), nonce: toBase64(nonce) };
    });
    expect(decryptContactLabel(legacy.ct, legacy.nonce, CONTACT_PIN_VERSION_V1_S1_TIER_KEY)).toBe(
      'Aunt Meredith',
    );
  });

  it('rewraps a pin to v2 and the contact still reads verified', () => {
    unlocked();
    const x = generateX25519Keypair();
    const e = generateEd25519Keypair();
    const old = legacyPin(x.publicKey, e.publicKey);

    const rewrapped = rewrapKeyPin({
      userId: USER,
      contactId: CONTACT,
      fromVersion: CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
      ...old,
    });
    expect(rewrapped).not.toBeNull();

    const after = row({
      x25519Pubkey: toBase64(x.publicKey),
      ed25519Pubkey: toBase64(e.publicKey),
      keyPinCiphertext: rewrapped!.keyPinCiphertext,
      keyPinNonce: rewrapped!.keyPinNonce,
      keyPinConfirmedAt: new Date().toISOString(),
      contactPinVersion: 2,
    });
    expect(evaluateContactKeyState(USER, after).kind).toBe('verified');
  });

  it('THE POINT: a rekey does NOT re-confirm a key the server substituted', () => {
    unlocked();
    const original = { x: generateX25519Keypair(), e: generateEd25519Keypair() };
    const old = legacyPin(original.x.publicKey, original.e.publicKey);

    // The rekey happens with the ORIGINAL pin bytes...
    const rewrapped = rewrapKeyPin({
      userId: USER,
      contactId: CONTACT,
      fromVersion: CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
      ...old,
    })!;

    // ...but the server is now serving a SUBSTITUTED key.
    const substituted = generateX25519Keypair();
    const after = row({
      x25519Pubkey: toBase64(substituted.publicKey),
      ed25519Pubkey: toBase64(original.e.publicKey),
      keyPinCiphertext: rewrapped.keyPinCiphertext,
      keyPinNonce: rewrapped.keyPinNonce,
      keyPinConfirmedAt: new Date().toISOString(),
      contactPinVersion: 2,
    });

    // The alarm must survive the migration. If rewrapKeyPin re-derived the pin
    // from the row's current pubkeys, this would read 'verified' and the
    // substitution would have been laundered by our own backfill.
    expect(evaluateContactKeyState(USER, after).kind).toBe('changed');
  });

  it('returns null rather than rewriting a pin it cannot open', () => {
    unlocked();
    const garbage = {
      keyPinCiphertext: toBase64(new Uint8Array(48).fill(9)),
      keyPinNonce: toBase64(randomSecretboxNonce()),
    };
    expect(
      rewrapKeyPin({
        userId: USER,
        contactId: CONTACT,
        fromVersion: CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
        ...garbage,
      }),
    ).toBeNull();
  });

  it('a rewrapped pin stays bound to its own contact — it is not portable', () => {
    unlocked();
    const x = generateX25519Keypair();
    const e = generateEd25519Keypair();
    const rewrapped = rewrapKeyPin({
      userId: USER,
      contactId: CONTACT,
      fromVersion: CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
      ...legacyPin(x.publicKey, e.publicKey),
    })!;

    // Same bytes, different contact id: the AAD must reject it.
    const transplanted = row({
      contactId: '33333333-3333-4333-8333-333333333333',
      x25519Pubkey: toBase64(x.publicKey),
      ed25519Pubkey: toBase64(e.publicKey),
      keyPinCiphertext: rewrapped.keyPinCiphertext,
      keyPinNonce: rewrapped.keyPinNonce,
      keyPinConfirmedAt: new Date().toISOString(),
      contactPinVersion: 2,
    });
    expect(evaluateContactKeyState(USER, transplanted).kind).toBe('tampered');
  });
});
