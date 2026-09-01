// Ceremony ephemeral key + per-recipient share re-wrapping.
//
// CEREMONY_PROPOSAL.md §d (as amended for per-recipient reconstruction):
// each RECIPIENT generates a ceremony-specific X25519 ephemeral keypair on
// their own device; the public key is registered server-side
// (ceremony_recipients.ephemeral_pubkey), the private key never leaves the
// device. Each affirming contact re-wraps their unwrapped Shamir share to
// EACH recipient's ephemeral pubkey via crypto_box_seal. At reconstruction the
// recipient's device opens the sealed shares with its ephemeral private key.
//
// The platform only ever sees ephemeral PUBLIC keys and sealed ciphertexts —
// it cannot open them (it holds no ephemeral private key), which is what keeps
// reconstruction client-side and the platform unable to decrypt.

import {
  generateX25519Keypair,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  type X25519Keypair,
} from '@truecairn/crypto';
import type { TierKeyShare } from '@truecairn/keys';
import type { VaultTier } from '@truecairn/shared';

export type CeremonyEphemeralKeypair = X25519Keypair;

// Generated on the recipient's device. Returns both halves; only the public
// key is uploaded.
export function generateCeremonyEphemeralKeypair(): CeremonyEphemeralKeypair {
  return generateX25519Keypair();
}

// Re-wrap an affirming contact's unwrapped Shamir share to a recipient's
// ceremony ephemeral pubkey. Output is a sealed box (carries its own ephemeral
// pubkey + tag; no separate nonce). Stored in
// ceremony_affirmation_shares.sealed_share_ciphertext.
export function rewrapShareToRecipient(
  share: TierKeyShare,
  recipientEphemeralPublicKey: Uint8Array,
): Uint8Array {
  return sealedBoxEncrypt({
    recipientPublicKey: recipientEphemeralPublicKey,
    plaintext: share.bytes,
  });
}

// Open a sealed share with the recipient's ceremony ephemeral keypair. The
// tier is supplied from the ceremony context (the sealed bytes carry only the
// raw share); the returned TierKeyShare is ready for combineTierKey.
export function unwrapShareFromCeremony(
  sealedShareCiphertext: Uint8Array,
  ephemeral: CeremonyEphemeralKeypair,
  tier: VaultTier,
): TierKeyShare {
  const bytes = sealedBoxDecrypt({
    recipientPublicKey: ephemeral.publicKey,
    recipientSecretKey: ephemeral.secretKey,
    ciphertext: sealedShareCiphertext,
  });
  return { bytes, tier } as TierKeyShare;
}
