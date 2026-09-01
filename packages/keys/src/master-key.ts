// Level 2 — the master key itself + its two stored wrapped forms.
//
// docs/18 §"Key hierarchy" item 2:
//   "User master key. Derived from passphrase via Argon2id. Never stored."
//
// In practice the master key is GENERATED random at enrollment (not derived
// from the passphrase — deriving it would mean a passphrase change requires
// re-wrapping every per-tier key). It is then wrapped TWICE for storage:
// once under PassphraseKek, once under RecoveryKek. Both wraps live in
// user_key_material.
//
// At login, the user provides their passphrase → derivePassphraseKek →
// unwrapMasterKeyByPassphrase. For recovery, they provide the recovery code
// → deriveRecoveryKek → unwrapMasterKeyByRecovery. Either path yields the
// same master key bytes.

import { randomBytes } from '@truecairn/crypto';
import { unwrapBytes, wrapBytes } from './internals/xchacha20.js';
import {
  MASTER_KEY_BYTES,
  type MasterKeyWrappedByPassphrase,
  type MasterKeyWrappedByRecovery,
  type PassphraseKek,
  type RecoveryKek,
  type UnwrappedMasterKey,
} from './types.js';

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateMasterKey(): UnwrappedMasterKey {
  return randomBytes(MASTER_KEY_BYTES) as UnwrappedMasterKey;
}

// ---------------------------------------------------------------------------
// Wrap / unwrap by passphrase-derived KEK
// ---------------------------------------------------------------------------

export function wrapMasterKeyByPassphrase(
  masterKey: UnwrappedMasterKey,
  kek: PassphraseKek,
): MasterKeyWrappedByPassphrase {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(`masterKey must be ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`);
  }
  const w = wrapBytes(masterKey, kek);
  return { ciphertext: w.ciphertext, nonce: w.nonce } as MasterKeyWrappedByPassphrase;
}

export function unwrapMasterKeyByPassphrase(
  wrapped: MasterKeyWrappedByPassphrase,
  kek: PassphraseKek,
): UnwrappedMasterKey {
  const plaintext = unwrapBytes(wrapped, kek);
  if (plaintext.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `unwrapped master key has unexpected length ${plaintext.length} (expected ${MASTER_KEY_BYTES})`,
    );
  }
  return plaintext as UnwrappedMasterKey;
}

// ---------------------------------------------------------------------------
// Wrap / unwrap by recovery-code-derived KEK
//
// Structurally identical to the passphrase path. Brand-typed separately so
// you cannot pass a recovery-wrapped blob to the passphrase unwrapper, or
// vice versa — that mistake is caught at compile time.
// ---------------------------------------------------------------------------

export function wrapMasterKeyByRecovery(
  masterKey: UnwrappedMasterKey,
  kek: RecoveryKek,
): MasterKeyWrappedByRecovery {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(`masterKey must be ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`);
  }
  const w = wrapBytes(masterKey, kek);
  return { ciphertext: w.ciphertext, nonce: w.nonce } as MasterKeyWrappedByRecovery;
}

export function unwrapMasterKeyByRecovery(
  wrapped: MasterKeyWrappedByRecovery,
  kek: RecoveryKek,
): UnwrappedMasterKey {
  const plaintext = unwrapBytes(wrapped, kek);
  if (plaintext.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `unwrapped master key has unexpected length ${plaintext.length} (expected ${MASTER_KEY_BYTES})`,
    );
  }
  return plaintext as UnwrappedMasterKey;
}

// ---------------------------------------------------------------------------
// Recovery-code generation
//
// docs/18 §"Recovery and reset flows": "Backup recovery codes are 256-bit
// random values, displayed to the user at enrollment in a recoverable format
// (hex or BIP-39 word list)." This module returns the raw 32 bytes; the UI
// in Phase 4 will encode them for display.
// ---------------------------------------------------------------------------

export function generateRecoveryCode(): import('./types.js').RecoveryCode {
  return randomBytes(MASTER_KEY_BYTES) as import('./types.js').RecoveryCode;
}
