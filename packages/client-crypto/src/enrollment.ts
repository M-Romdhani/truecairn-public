import { ed25519KeypairFromSeed, wipe, x25519KeypairFromSeed } from '@truecairn/crypto';
import {
  createTierKeyCheck,
  deriveAuditSigningSeed,
  derivePassphraseKek,
  deriveRecoveryKek,
  deriveTierWrappingKey,
  deriveVaultCaptureX25519Seed,
  generateMasterKdfSalt,
  generateMasterKey,
  generateRecoveryCode,
  generateRecoveryKdfSalt,
  generateReleaseKdfSalt,
  generateTierKey,
  wrapMasterKeyByPassphrase,
  wrapMasterKeyByRecovery,
  wrapTierKey,
  type MasterKdfSalt,
  type MasterPassphrase,
  type RecoveryCode,
  type RecoveryKdfSalt,
} from '@truecairn/keys';
import { ALL_TIERS, type KeyMaterial, type TierKeyMaterial } from './material.js';

export interface EnrollmentResult {
  // Everything the enrollment `provision` POST uploads (ciphertext + salts +
  // pubkey only — no plaintext secret).
  material: KeyMaterial;
  // The 256-bit recovery code, for the UI to render as a BIP-39 24-word phrase
  // (PHASE4 Q7). The caller MUST zeroize it after display — it is the only copy.
  recoveryCode: Uint8Array;
}

// Generate a brand-new account's key material entirely client-side (PHASE4 R0.2):
//   - a RANDOM master key (never derived from the passphrase, never stored raw);
//   - wrapped twice, under the passphrase-KEK and the recovery-code-KEK;
//   - the master-derived Ed25519 audit/step-up public key;
//   - all three tier keys (S1/S2/S3), each wrapped under the master-derived tier-
//     wrapping key + a random tier-key-check sentinel (Q8: tiers exist from day one);
//   - the three KDF salts (master / recovery / release).
//
// Plaintext-lifetime discipline (PHASE4 §a): the passphrase is the CALLER's to
// zeroize (it may reuse it to derive the release-passphrase salt-bound shares
// later in the same ceremony); every intermediate secret WE create — the KEKs,
// the master key, the tier-wrapping key, each tier key, the audit seed — is
// wiped before return. Only the recovery code is handed back (for display).
export function generateEnrollmentMaterial(passphrase: Uint8Array): EnrollmentResult {
  const masterKey = generateMasterKey();
  const recoveryCode = generateRecoveryCode();
  const masterPassphraseSalt = generateMasterKdfSalt();
  const recoveryCodeSalt = generateRecoveryKdfSalt();
  const releasePassphraseSalt = generateReleaseKdfSalt();

  const passKek = derivePassphraseKek(passphrase as MasterPassphrase, masterPassphraseSalt);
  const recKek = deriveRecoveryKek(recoveryCode as RecoveryCode, recoveryCodeSalt);
  try {
    const wrappedByPass = wrapMasterKeyByPassphrase(masterKey, passKek);
    const wrappedByRec = wrapMasterKeyByRecovery(masterKey, recKek);

    const auditSeed = deriveAuditSigningSeed(masterKey);
    let auditSigningPubkey: Uint8Array;
    try {
      auditSigningPubkey = ed25519KeypairFromSeed(auditSeed).publicKey;
    } finally {
      wipe(auditSeed);
    }

    // The owner's write-only capture PUBLIC key (docs/34). Derived at enrollment
    // so a new account can receive a capture from the first moment, rather than
    // waiting for a later unlock to backfill it.
    const captureSeed = deriveVaultCaptureX25519Seed(masterKey);
    let vaultCapturePubkey: Uint8Array;
    try {
      const kp = x25519KeypairFromSeed(captureSeed);
      try {
        vaultCapturePubkey = kp.publicKey;
      } finally {
        wipe(kp.secretKey);
      }
    } finally {
      wipe(captureSeed);
    }

    const twk = deriveTierWrappingKey(masterKey);
    const tierKeys: TierKeyMaterial[] = [];
    try {
      for (const tier of ALL_TIERS) {
        const tk = generateTierKey(tier);
        try {
          const wtk = wrapTierKey(tk, twk, 1);
          const check = createTierKeyCheck(tk, 1);
          tierKeys.push({
            tier,
            generation: 1,
            tierKeyWrappedByMaster: wtk.ciphertext,
            tierKeyMasterNonce: wtk.nonce,
            tierKeyCheckPlaintext: check.plaintext,
            tierKeyCheckCiphertext: check.ciphertext,
            tierKeyCheckNonce: check.nonce,
          });
        } finally {
          wipe(tk);
        }
      }
    } finally {
      wipe(twk);
    }

    const material: KeyMaterial = {
      masterPassphraseSalt,
      masterKeyWrappedByPassphrase: wrappedByPass.ciphertext,
      masterKeyPassphraseNonce: wrappedByPass.nonce,
      recoveryCodeSalt,
      masterKeyWrappedByRecovery: wrappedByRec.ciphertext,
      masterKeyRecoveryNonce: wrappedByRec.nonce,
      releasePassphraseSalt,
      auditSigningPubkey,
      vaultCapturePubkey,
      generation: 1,
      tierKeys,
    };
    return { material, recoveryCode };
  } finally {
    wipe(passKek);
    wipe(recKek);
    wipe(masterKey);
  }
}

// Re-export the salt brand casts the caller may need when deriving the release-
// passphrase shares later in onboarding from material.releasePassphraseSalt.
export type { MasterKdfSalt, RecoveryKdfSalt };
