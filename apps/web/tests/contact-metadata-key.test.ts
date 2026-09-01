import { beforeAll, describe, expect, it } from 'vitest';
import { fromBase64, randomSecretboxNonce, secretboxDecrypt, secretboxEncrypt, toBase64 } from '@truecairn/crypto';
import { generateEnrollmentMaterial, unlock, withTierKey, type KeyMaterial } from '@truecairn/client-crypto';
import {
  CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
  CONTACT_PIN_VERSION_V2_MASTER_DERIVED,
} from '@truecairn/keys';
import { decryptContactLabel, encryptContactLabel } from '../src/contacts/crypto.js';

// ── F1 + F2: labels and pins must not ride the S1 tier key ───────────────────
//
// THE DEFECT. Labels and pins were encrypted under the S1 TIER key. That key is
// not the owner's alone: sealS1EnvelopeToContact seals it to the S1
// beneficiary's X25519 pubkey and reconstructS1Item unseals it in their browser.
// So the instant an S1 release completed, that one recipient could read the
// owner's private label for EVERY contact — including contacts who exist only in
// S2/S3 and have no part in S1.
//
// The test that matters is therefore not "v2 round-trips" — it is "the S1 tier
// key can no longer open a v2 label". Everything else here is supporting.

const PASS = 'correct horse battery staple';
const utf8 = (s: string): Uint8Array => new Uint8Array(new TextEncoder().encode(s));

let material: KeyMaterial;
beforeAll(() => {
  material = generateEnrollmentMaterial(utf8(PASS)).material;
});

function unlocked(): void {
  unlock(utf8(PASS), material);
}

describe('contact labels are off the S1 tier key (F1 + F2)', () => {
  it('writes v2 — never v1 — for a newly created label', () => {
    unlocked();
    expect(encryptContactLabel('Aunt Meredith').contactPinVersion).toBe(
      CONTACT_PIN_VERSION_V2_MASTER_DERIVED,
    );
  });

  it('THE POINT: the S1 tier key cannot decrypt a v2 label', () => {
    unlocked();
    const label = encryptContactLabel('Aunt Meredith');

    // Stand in for the S1 beneficiary: they hold the S1 tier key and nothing
    // else. Before this change, this call SUCCEEDED and returned the label.
    expect(() =>
      withTierKey('s1', (tierKey) =>
        secretboxDecrypt({
          key: tierKey,
          nonce: fromBase64(label.displayLabelNonce),
          ciphertext: fromBase64(label.displayLabelCiphertext),
        }),
      ),
    ).toThrow();
  });

  it('round-trips a v2 label through the owner’s own key', () => {
    unlocked();
    const label = encryptContactLabel('Aunt Meredith');
    expect(
      decryptContactLabel(
        label.displayLabelCiphertext,
        label.displayLabelNonce,
        label.contactPinVersion,
      ),
    ).toBe('Aunt Meredith');
  });

  // No forced re-confirmation (PLAN-v1-launch.md §1.2): a row written before the
  // migration must stay readable, or every owner is silently made to redo the
  // out-of-band comparison and every label renders "unavailable" (the P0-2 shape).
  it('still reads a v1 label written under the S1 tier key', () => {
    unlocked();
    const legacy = withTierKey('s1', (tierKey) => {
      const nonce = randomSecretboxNonce();
      const ct = secretboxEncrypt({ key: tierKey, nonce, plaintext: utf8('Old Contact') });
      return { ciphertext: toBase64(ct), nonce: toBase64(nonce) };
    });
    expect(
      decryptContactLabel(legacy.ciphertext, legacy.nonce, CONTACT_PIN_VERSION_V1_S1_TIER_KEY),
    ).toBe('Old Contact');
  });

  it('refuses an unknown version rather than guessing a key', () => {
    unlocked();
    const label = encryptContactLabel('Aunt Meredith');
    expect(() =>
      decryptContactLabel(label.displayLabelCiphertext, label.displayLabelNonce, 99),
    ).toThrow(/unsupported contact metadata version/);
  });

  it('reading a v2 label AS v1 fails closed — versions are not interchangeable', () => {
    unlocked();
    const label = encryptContactLabel('Aunt Meredith');
    expect(() =>
      decryptContactLabel(
        label.displayLabelCiphertext,
        label.displayLabelNonce,
        CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
      ),
    ).toThrow();
  });
});
