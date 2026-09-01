import { sodium, assertReady } from './init.js';
import {
  X25519_PUBLIC_KEY_BYTES,
  X25519_SECRET_KEY_BYTES,
} from './x25519.js';
import { assertLength } from './util.js';

// Sealed-box wrapping, per docs/18 §"Contact share wrapping":
//   "When a contact's share is created ... the share is encrypted to the
//    contact's public key and stored on the platform as ciphertext."
//
// libsodium's crypto_box_seal generates an ephemeral X25519 keypair internally
// per encryption, performs an authenticated DH with the recipient's pubkey,
// and prepends the ephemeral pubkey to the ciphertext. The recipient unwraps
// using their secret key alone — no prior negotiation with the sender.
//
// Ciphertext layout: ephemeral_pubkey (32 bytes) || encrypted_payload (plaintext.length + 16 bytes)

// Sealed-box constant: 32 (ephemeral pubkey) + 16 (Poly1305 tag).
export const SEALED_BOX_OVERHEAD_BYTES = 48;

export interface SealedBoxEncryptInput {
  recipientPublicKey: Uint8Array;
  plaintext: Uint8Array;
}

export interface SealedBoxDecryptInput {
  recipientPublicKey: Uint8Array;
  recipientSecretKey: Uint8Array;
  ciphertext: Uint8Array;
}

export function sealedBoxEncrypt(input: SealedBoxEncryptInput): Uint8Array {
  assertReady();
  assertLength('sealedBox recipientPublicKey', input.recipientPublicKey, X25519_PUBLIC_KEY_BYTES);
  return sodium.crypto_box_seal(input.plaintext, input.recipientPublicKey);
}

// Throws on authentication failure. Recipient must provide BOTH halves of
// their keypair: libsodium needs the public key to validate that the
// ephemeral DH result matches what was sealed.
export function sealedBoxDecrypt(input: SealedBoxDecryptInput): Uint8Array {
  assertReady();
  assertLength('sealedBox recipientPublicKey', input.recipientPublicKey, X25519_PUBLIC_KEY_BYTES);
  assertLength('sealedBox recipientSecretKey', input.recipientSecretKey, X25519_SECRET_KEY_BYTES);
  if (input.ciphertext.length < SEALED_BOX_OVERHEAD_BYTES) {
    throw new Error(
      `sealedBox ciphertext shorter than overhead (${SEALED_BOX_OVERHEAD_BYTES} bytes)`,
    );
  }
  return sodium.crypto_box_seal_open(
    input.ciphertext,
    input.recipientPublicKey,
    input.recipientSecretKey,
  );
}
