// Level 2 — KEK derivation from passphrase / recovery code, plus the
// level 6 release-passphrase share derivation. Every output is brand-typed
// so callers can't accidentally use a passphrase-derived KEK where a
// recovery-derived KEK is expected, etc.

import {
  ARGON2ID_PRODUCTION_MEMLIMIT,
  ARGON2ID_PRODUCTION_OPSLIMIT,
  blake2b256,
  deriveKey,
  deriveSubkey,
  KDF_SALT_BYTES,
  randomKdfSalt,
  wipe,
} from '@truecairn/crypto';
import type { VaultTier } from '@truecairn/shared';
import {
  PASSPHRASE_KEK_BYTES,
  RECOVERY_KEK_BYTES,
  TIER_KEY_BYTES,
  type MasterKdfSalt,
  type MasterPassphrase,
  type PassphraseKek,
  type RecoveryCode,
  type RecoveryKdfSalt,
  type RecoveryKek,
  type ReleaseKdfSalt,
  type ReleasePassphrase,
  type ReleasePassphraseShare,
} from './types.js';

// 1, 2, 3 → s1/s2/s3. Same mapping as buildOuterLayerAad.
const TIER_BYTE: Record<VaultTier, number> = { s1: 1, s2: 2, s3: 3 };

// 8-byte context for the per-call-salt KDF. Same shape as the audit/wrap
// subkey contexts in subkeys.ts.
const KDF_CONTEXT_RELEASE_SALT = 'tc-relsl';

// ---------------------------------------------------------------------------
// Salt generators. All three return 16 random bytes (matching the underlying
// crypto wrapper's KDF_SALT_BYTES). Brand-typed to keep them straight at
// call sites; runtime bytes are identical.
// ---------------------------------------------------------------------------

export function generateMasterKdfSalt(): MasterKdfSalt {
  return randomKdfSalt() as MasterKdfSalt;
}

export function generateRecoveryKdfSalt(): RecoveryKdfSalt {
  return randomKdfSalt() as RecoveryKdfSalt;
}

export function generateReleaseKdfSalt(): ReleaseKdfSalt {
  return randomKdfSalt() as ReleaseKdfSalt;
}

// ---------------------------------------------------------------------------
// derivePassphraseKek — Argon2id with locked production params.
// docs/01 §"Cryptographic primitives": memory=256 MiB, ops=4, parallelism=1.
// ---------------------------------------------------------------------------

export function derivePassphraseKek(
  passphrase: MasterPassphrase,
  salt: MasterKdfSalt,
): PassphraseKek {
  const bytes = deriveKey({
    password: passphrase,
    salt,
    outputLength: PASSPHRASE_KEK_BYTES,
    params: {
      opslimit: ARGON2ID_PRODUCTION_OPSLIMIT,
      memlimit: ARGON2ID_PRODUCTION_MEMLIMIT,
    },
  });
  return bytes as PassphraseKek;
}

export function deriveRecoveryKek(
  code: RecoveryCode,
  salt: RecoveryKdfSalt,
): RecoveryKek {
  const bytes = deriveKey({
    password: code,
    salt,
    outputLength: RECOVERY_KEK_BYTES,
    params: {
      opslimit: ARGON2ID_PRODUCTION_OPSLIMIT,
      memlimit: ARGON2ID_PRODUCTION_MEMLIMIT,
    },
  });
  return bytes as RecoveryKek;
}

// ---------------------------------------------------------------------------
// deriveReleasePassphraseShare — produces a (tier, shareIndex)-bound share
// value from the release-only passphrase.
//
// docs/18 §"Key hierarchy" item 6: "Release-only passphrase ... Derives, via
// Argon2id, the share value that participates in Shamir reconstruction for
// S2 and S3 release ceremonies."
//
// Construction (per the user-directed design):
//   perCallSalt = derivePerCallReleaseSalt(baseSalt, tier, shareIndex)
//   evaluation  = Argon2id(passphrase, perCallSalt, production_params, 32 bytes)
//   share       = [shareIndex] || evaluation
//
// The per-call salt is derived deterministically from (baseSalt, tier,
// shareIndex) via BLAKE2b-256 + crypto_kdf_derive_from_key. Using a per-
// call salt is textbook Argon2id usage; appending binding to the password
// input (the previous approach) was a slight misuse of the primitive.
//
// Each (tier, shareIndex) produces a distinct per-call salt — so the same
// release passphrase derives different shares for different positions /
// tiers without any input-mangling.
// ---------------------------------------------------------------------------

// Exposed for KAT — the test pins this intermediate so a salt-reuse
// regression (e.g. accidentally using baseSalt for two different
// (tier, shareIndex) pairs) fails visibly instead of just silently
// producing the wrong share.
export function derivePerCallReleaseSalt(
  baseSalt: ReleaseKdfSalt,
  tier: VaultTier,
  shareIndex: number,
): Uint8Array {
  if (!Number.isInteger(shareIndex) || shareIndex < 1 || shareIndex > 255) {
    throw new Error(`shareIndex must be an integer in [1, 255], got ${shareIndex}`);
  }
  // Extend the 16-byte base salt to the 32-byte key length required by
  // crypto_kdf_derive_from_key. BLAKE2b-256 is preimage-resistant, so the
  // extension does not leak the base salt nor allow distinct base salts to
  // collide.
  const extendedKey = blake2b256(baseSalt);
  // subkey_id encoding: (tier_byte << 8) | shareIndex. Both values fit in
  // a single byte, so the composite fits comfortably in 16 bits of a u64.
  const tierByte = TIER_BYTE[tier];
  const subkeyId = (tierByte << 8) | shareIndex;
  return deriveSubkey({
    masterKey: extendedKey,
    context: KDF_CONTEXT_RELEASE_SALT,
    subkeyId,
    subkeyLength: KDF_SALT_BYTES,
  });
}

export function deriveReleasePassphraseShare(
  passphrase: ReleasePassphrase,
  salt: ReleaseKdfSalt,
  tier: VaultTier,
  shareIndex: number,
): ReleasePassphraseShare {
  if (!Number.isInteger(shareIndex) || shareIndex < 1 || shareIndex > 255) {
    throw new Error(`shareIndex must be an integer in [1, 255], got ${shareIndex}`);
  }

  const perCallSalt = derivePerCallReleaseSalt(salt, tier, shareIndex);

  const evaluation = deriveKey({
    password: passphrase,
    salt: perCallSalt as ReleaseKdfSalt,
    outputLength: TIER_KEY_BYTES,
    params: {
      opslimit: ARGON2ID_PRODUCTION_OPSLIMIT,
      memlimit: ARGON2ID_PRODUCTION_MEMLIMIT,
    },
  });

  try {
    const shareBytes = new Uint8Array(1 + TIER_KEY_BYTES);
    shareBytes[0] = shareIndex;
    shareBytes.set(evaluation, 1);

    return { bytes: shareBytes, tier } as ReleasePassphraseShare;
  } finally {
    // `evaluation` is a full-strength Argon2id tier key, and `set` above COPIES
    // it — so once shareBytes holds it, this buffer is a second live copy of
    // release-grade key material with no remaining reader. The repo convention
    // is that such a buffer is wiped in a `finally` (docs/38 F8); the copy the
    // caller now owns is theirs to zeroize.
    wipe(evaluation);
  }
}
