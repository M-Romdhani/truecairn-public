// S1 tier-key envelopes (CEREMONY_PROPOSAL.md §e / Q3 option C).
//
// S1 has no Shamir scheme. The full S1 tier key is sealed to each
// S1-authorised contact's long-term X25519 pubkey (crypto_box_seal). After the
// platform releases the temporal gate, any one such contact opens the envelope
// with their own X25519 secret key — the server never holds a usable copy.
// S1 = 1-of-N + temporal gate (docs/02, threat 5.4.6 "5.4 alone reaches S1
// worst-case").

import {
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  type X25519Keypair,
} from '@truecairn/crypto';
import { tierKeyFromBytes, type UnwrappedTierKey } from '@truecairn/keys';

// Seal the S1 tier key to a contact's X25519 public key. Output is stored in
// s1_tier_key_envelopes.sealed_box_ciphertext. The S1 tier key must carry
// tier 's1'.
export function sealS1TierKeyToContact(
  s1TierKey: UnwrappedTierKey,
  contactX25519PublicKey: Uint8Array,
): Uint8Array {
  if (s1TierKey.tier !== 's1') {
    throw new Error(`sealS1TierKeyToContact expects an s1 tier key, got ${s1TierKey.tier}`);
  }
  return sealedBoxEncrypt({ recipientPublicKey: contactX25519PublicKey, plaintext: s1TierKey });
}

// Open an S1 envelope with the contact's X25519 keypair. Returns the S1 tier
// key tagged 's1'. Throws (via the sealed-box AEAD) if the envelope was not
// sealed to this contact, or is tampered.
export function openS1TierKeyEnvelope(
  sealedBoxCiphertext: Uint8Array,
  contactX25519Keypair: X25519Keypair,
): UnwrappedTierKey {
  const bytes = sealedBoxDecrypt({
    recipientPublicKey: contactX25519Keypair.publicKey,
    recipientSecretKey: contactX25519Keypair.secretKey,
    ciphertext: sealedBoxCiphertext,
  });
  return tierKeyFromBytes(bytes, 's1');
}
