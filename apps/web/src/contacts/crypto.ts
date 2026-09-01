import {
  fromBase64,
  randomSecretboxNonce,
  sealedBoxEncrypt,
  secretboxDecrypt,
  secretboxEncrypt,
  toBase64,
} from '@truecairn/crypto';
import { splitTierKeyToContactShares, withContactPinKey, withTierKey } from '@truecairn/client-crypto';
import {
  CONTACT_PIN_VERSION_CURRENT,
  CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
  CONTACT_PIN_VERSION_V2_MASTER_DERIVED,
} from '@truecairn/keys';
import type { VerifiedContactKey } from './key-pin.js';

// Owner-side contact crypto (PHASE4 C4). Display labels are the owner's private
// note for a contact — opaque to the server, and (since migration 0068) opaque
// to every contact too.
//
// THE COMMENT THIS REPLACES SAID "opaque to the server AND to the contact",
// which was true before a release and false after one. Labels were encrypted
// under the S1 TIER key, and sealS1EnvelopeToContact — in this same file —
// seals that key to the S1 beneficiary, whose browser unseals it in
// reconstructS1Item. So one recipient could read the owner's private label for
// EVERY contact, including contacts who exist only in S2/S3 and have no part in
// S1. That is findings F1+F2.
//
// v2 encrypts labels under a master-derived key instead. No ceremony
// reconstructs the master key — a release reconstructs TIER keys — so the path
// is closed rather than narrowed. Readers still accept v1 so that existing rows
// stay readable and no owner is forced to re-confirm anything; writers always
// emit v2.

const enc = new TextEncoder();
const dec = new TextDecoder();

// Pick the key a given version's ciphertext was written under. Exported because
// key-pin.ts needs exactly the same decision for pins, and the two must never
// drift — a pin and a label on the same row are always the same version.
export function withContactMetadataKey<T>(
  version: number,
  fn: (key: Uint8Array) => T,
): T {
  if (version === CONTACT_PIN_VERSION_V2_MASTER_DERIVED) return withContactPinKey(fn);
  if (version === CONTACT_PIN_VERSION_V1_S1_TIER_KEY) return withTierKey('s1', fn);
  // Never silently fall back to a key. An unknown version means a row written by
  // a client newer than this one, and guessing would either fail the AEAD (noise)
  // or, worse, succeed against the wrong key one day.
  throw new Error(`unsupported contact metadata version ${version}`);
}

export function encryptContactLabel(label: string): {
  displayLabelCiphertext: string;
  displayLabelNonce: string;
  contactPinVersion: number;
} {
  return withContactPinKey((key) => {
    const nonce = randomSecretboxNonce();
    const ct = secretboxEncrypt({ key, nonce, plaintext: enc.encode(label) });
    return {
      displayLabelCiphertext: toBase64(ct),
      displayLabelNonce: toBase64(nonce),
      contactPinVersion: CONTACT_PIN_VERSION_CURRENT,
    };
  });
}

// `version` is required rather than defaulted on purpose: a v2 row read as v1
// fails the AEAD, and a default would put that decision somewhere no caller
// looks at. Every call site passes the row's own contactPinVersion.
export function decryptContactLabel(
  displayLabelCiphertext: string,
  displayLabelNonce: string,
  version: number,
): string {
  return withContactMetadataKey(version, (key) =>
    dec.decode(
      secretboxDecrypt({
        key,
        nonce: fromBase64(displayLabelNonce),
        ciphertext: fromBase64(displayLabelCiphertext),
      }),
    ),
  );
}

// Seal the S1 tier key to the contact's X25519 pubkey — the S1 release envelope.
//
// Takes a VerifiedContactKey, not a base64 string: S1 seals the tier key
// DIRECTLY to one contact, so a single substituted key hands over that whole
// tier. The token can only be minted by requireVerifiedContactKey(), which
// checks the owner's out-of-band pin — so there is no way to reach this
// function with a key nobody confirmed.
export function sealS1EnvelopeToContact(contactKey: VerifiedContactKey): string {
  return withTierKey('s1', (tierKey) =>
    toBase64(
      sealedBoxEncrypt({
        recipientPublicKey: fromBase64(contactKey.x25519Pubkey),
        plaintext: tierKey,
      }),
    ),
  );
}

// S2/S3 (Checkpoint B): derive the release-passphrase share, split the tier
// key with it as the fixed-index constraint, and seal each contact share to
// its contact's verified pubkey. The contacts' order decides which share index
// each holds; only sealed ciphertexts come back. Takes ownership of
// `releasePassphrase` (zeroized inside client-crypto).
//
// Every recipient must be a VerifiedContactKey. S2 is 2-of-3 over the tier key,
// so two substituted keys reach the threshold on their own — the release
// passphrase is a FALLBACK share there, not a mandatory factor, and a caller
// who verifies "most" of the contacts has not bought a partial defence. S3's
// nested mask (docs/24) does hold without this, but it takes the same token so
// that the rule is one rule.
export function splitAndSealTierShares(
  tier: 's2' | 's3',
  releasePassphrase: Uint8Array,
  contacts: VerifiedContactKey[],
): Array<{ contactId: string; shareIndex: number; wrappedShareCiphertext: string }> {
  const sealed = splitTierKeyToContactShares(
    tier,
    releasePassphrase,
    contacts.map((c) => fromBase64(c.x25519Pubkey)),
  );
  return sealed.map((s, i) => ({
    contactId: contacts[i]!.contactId,
    shareIndex: s.shareIndex,
    wrappedShareCiphertext: toBase64(s.wrappedShareCiphertext),
  }));
}
