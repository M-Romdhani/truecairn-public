import {
  ed25519KeypairFromSeed,
  ed25519Sign,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  wipe,
  x25519KeypairFromSeed,
} from '@truecairn/crypto';
import {
  deriveAuditSigningSeed,
  deriveContactEd25519Seed,
  deriveContactPinKey,
  deriveContactX25519Seed,
  derivePassphraseKek,
  deriveRecoveryKek,
  deriveReleasePassphraseShare,
  deriveTierWrappingKey,
  deriveVaultCaptureX25519Seed,
  RELEASE_SHARE_INDEX_S2,
  RELEASE_SHARE_INDEX_S3,
  S3_NESTED_CONTACT_SHARES,
  splitTierKeyForS2,
  splitTierKeyForS3Nested,
  unwrapMasterKeyByPassphrase,
  unwrapMasterKeyByRecovery,
  unwrapTierKey,
  type ContactPinKey,
  type MasterKdfSalt,
  type MasterKeyWrappedByPassphrase,
  type MasterKeyWrappedByRecovery,
  type MasterPassphrase,
  type PassphraseKek,
  type RecoveryCode,
  type RecoveryKdfSalt,
  type RecoveryKek,
  type ReleaseKdfSalt,
  type ReleasePassphrase,
  type TierKeyWrappedByMaster,
  type UnwrappedMasterKey,
  type UnwrappedTierKey,
} from '@truecairn/keys';
import type { VaultTier } from '@truecairn/shared';
import type { KeyMaterial } from './material.js';

// The crypto session: the ONE place the unwrapped master key lives while the
// vault is unlocked (PHASE4 §a). Module-scoped, OUTSIDE React and any serializing
// store, so the bytes are never snapshotted into component state, Redux, or
// DevTools. lock() memzeroes the key; `material` holds only ciphertext + salts +
// a public key, which are safe to retain.

// Auto-lock bounds (PHASE4 Q3): user-configurable idle timeout, default 15 min,
// floor 1 min, ceiling 60 min.
export const MIN_IDLE_MS = 60_000;
export const MAX_IDLE_MS = 60 * 60_000;
export const DEFAULT_IDLE_MS = 15 * 60_000;

interface Unlocked {
  masterKey: UnwrappedMasterKey;
  material: KeyMaterial;
}

let current: Unlocked | undefined;
let idleMs = DEFAULT_IDLE_MS;
let onLockCb: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

export function isUnlocked(): boolean {
  return current !== undefined;
}

function requireUnlocked(): Unlocked {
  if (current === undefined) throw new Error('vault is locked');
  return current;
}

// Derive the passphrase KEK, unwrap the random master key, hold it. TAKES
// OWNERSHIP of `passphrase` and zeroizes it the instant the KEK is derived
// (PHASE4 §a) — pass a fresh Uint8Array you no longer need. A wrong passphrase
// throws (the unwrap MAC fails) and nothing is held.
export function unlock(passphrase: Uint8Array, material: KeyMaterial): void {
  let kek!: PassphraseKek;
  try {
    kek = derivePassphraseKek(
      passphrase as MasterPassphrase,
      material.masterPassphraseSalt as MasterKdfSalt,
    );
  } finally {
    wipe(passphrase);
  }
  try {
    const wrapped = {
      ciphertext: material.masterKeyWrappedByPassphrase,
      nonce: material.masterKeyPassphraseNonce,
    } as MasterKeyWrappedByPassphrase;
    setUnlocked(unwrapMasterKeyByPassphrase(wrapped, kek), material);
  } finally {
    wipe(kek);
  }
}

// Recovery-code unlock — same result (the master key), via the recovery wrap.
export function unlockWithRecovery(recoveryCode: Uint8Array, material: KeyMaterial): void {
  let kek!: RecoveryKek;
  try {
    kek = deriveRecoveryKek(
      recoveryCode as RecoveryCode,
      material.recoveryCodeSalt as RecoveryKdfSalt,
    );
  } finally {
    wipe(recoveryCode);
  }
  try {
    const wrapped = {
      ciphertext: material.masterKeyWrappedByRecovery,
      nonce: material.masterKeyRecoveryNonce,
    } as MasterKeyWrappedByRecovery;
    setUnlocked(unwrapMasterKeyByRecovery(wrapped, kek), material);
  } finally {
    wipe(kek);
  }
}

export function lock(): void {
  if (current !== undefined) {
    wipe(current.masterKey);
    current = undefined;
  }
  clearTimer();
}

// Run `fn` with the unwrapped tier key, derived on demand and zeroized after
// (PHASE4 Q4: derive-on-demand, don't cache — derivation is microseconds). The
// key is wiped once `fn` returns, so copy out only non-secret results.
export function withTierKey<T>(tier: VaultTier, fn: (tierKey: UnwrappedTierKey) => T): T {
  const u = requireUnlocked();
  touch();
  const twk = deriveTierWrappingKey(u.masterKey);
  try {
    const m = u.material.tierKeys.find((t) => t.tier === tier);
    if (m === undefined) throw new Error(`no tier key provisioned for ${tier}`);
    const wrapped = {
      ciphertext: m.tierKeyWrappedByMaster,
      nonce: m.tierKeyMasterNonce,
      tier,
      generation: m.generation,
    } as TierKeyWrappedByMaster;
    const tierKey = unwrapTierKey(wrapped, twk);
    try {
      return fn(tierKey);
    } finally {
      wipe(tierKey);
    }
  } finally {
    wipe(twk);
  }
}

// Run `fn` with the contact-metadata key — the master-derived key that encrypts
// contact display labels and key pins (F1+F2, migration 0068). Same
// derive-on-demand-and-wipe discipline as withTierKey.
//
// The point of this existing at all is that it is NOT withTierKey('s1', …).
// The S1 tier key is sealed to the S1 beneficiary and unsealed in their browser
// on release, so anything encrypted under it is readable by that one recipient —
// which is how a label written about an S3-only contact ended up inside an S1
// release. This key is derived from the master key, and no ceremony ever
// reconstructs the master key.
export function withContactPinKey<T>(fn: (key: ContactPinKey) => T): T {
  const u = requireUnlocked();
  touch();
  const key = deriveContactPinKey(u.masterKey);
  try {
    return fn(key);
  } finally {
    wipe(key);
  }
}

// Sign a message with the master-key-derived Ed25519 key (the step-up signing
// key; PHASE4 R0.3). Derived on demand, secret zeroized after. The C2 step-up
// interceptor builds the canonical payload and calls this.
export function signWithUserKey(message: Uint8Array): Uint8Array {
  const u = requireUnlocked();
  touch();
  const seed = deriveAuditSigningSeed(u.masterKey);
  try {
    const kp = ed25519KeypairFromSeed(seed);
    try {
      return ed25519Sign(message, kp.secretKey);
    } finally {
      wipe(kp.secretKey);
    }
  } finally {
    wipe(seed);
  }
}

// The audit/step-up PUBLIC key for this session (non-secret).
export function auditSigningPubkey(): Uint8Array {
  return requireUnlocked().material.auditSigningPubkey;
}

// ── Contact affirmation keys (PHASE4 C4) ────────────────────────────────────
// Derived from THIS user's master key when they act AS a contact for someone
// else (receive sealed shares, prove possession at enrolment, sign affirmations).
// Secrets are derived on demand and wiped; only public keys / results escape.

export function contactPublicKeys(): { x25519Pubkey: Uint8Array; ed25519Pubkey: Uint8Array } {
  const u = requireUnlocked();
  touch();
  const xSeed = deriveContactX25519Seed(u.masterKey);
  const eSeed = deriveContactEd25519Seed(u.masterKey);
  try {
    const xkp = x25519KeypairFromSeed(xSeed);
    const ekp = ed25519KeypairFromSeed(eSeed);
    try {
      return { x25519Pubkey: xkp.publicKey, ed25519Pubkey: ekp.publicKey };
    } finally {
      wipe(xkp.secretKey);
      wipe(ekp.secretKey);
    }
  } finally {
    wipe(xSeed);
    wipe(eSeed);
  }
}

// Sign the enrolment Ed25519 challenge (and, later, affirmations) with the
// contact-affirmation key.
export function signContactChallenge(challenge: Uint8Array): Uint8Array {
  const u = requireUnlocked();
  touch();
  const seed = deriveContactEd25519Seed(u.masterKey);
  try {
    const kp = ed25519KeypairFromSeed(seed);
    try {
      return ed25519Sign(challenge, kp.secretKey);
    } finally {
      wipe(kp.secretKey);
    }
  } finally {
    wipe(seed);
  }
}

// Open a sealed box addressed to this user's contact X25519 key — the enrolment
// possession-proof nonce, and (later) sealed shares.
export function openSealedToContact(sealed: Uint8Array): Uint8Array {
  const u = requireUnlocked();
  touch();
  const seed = deriveContactX25519Seed(u.masterKey);
  try {
    const kp = x25519KeypairFromSeed(seed);
    try {
      return sealedBoxDecrypt({
        recipientPublicKey: kp.publicKey,
        recipientSecretKey: kp.secretKey,
        ciphertext: sealed,
      });
    } finally {
      wipe(kp.secretKey);
    }
  } finally {
    wipe(seed);
  }
}

// ── Write-only vault capture (docs/34) ──────────────────────────────────────
// The owner's own X25519 keypair. The PUBLIC half is published so a phone can
// seal new items to it; the secret half is derived here, used, and wiped — it
// never leaves this module, and it is the only thing that can open a capture.

export function vaultCapturePublicKey(): Uint8Array {
  const u = requireUnlocked();
  touch();
  const seed = deriveVaultCaptureX25519Seed(u.masterKey);
  try {
    const kp = x25519KeypairFromSeed(seed);
    try {
      return kp.publicKey;
    } finally {
      wipe(kp.secretKey);
    }
  } finally {
    wipe(seed);
  }
}

// Open a capture's sealed per-capture key. The one direction the phone cannot
// go: it holds the public half, and sealing with it discards the ephemeral
// secret, so "this phone cannot read back what it sent" is a property of
// crypto_box_seal rather than a promise about our code.
export function openSealedCapture(sealed: Uint8Array): Uint8Array {
  const u = requireUnlocked();
  touch();
  const seed = deriveVaultCaptureX25519Seed(u.masterKey);
  try {
    const kp = x25519KeypairFromSeed(seed);
    try {
      return sealedBoxDecrypt({
        recipientPublicKey: kp.publicKey,
        recipientSecretKey: kp.secretKey,
        ciphertext: sealed,
      });
    } finally {
      wipe(kp.secretKey);
    }
  } finally {
    wipe(seed);
  }
}

// ── S2/S3 release-share split (CEREMONY_COMPLETION Checkpoint B) ────────────
// The owner's side of the Shamir path, run at the FIRST S2/S3 share assignment
// (Q8: deferred capture). Derives the release-passphrase share from the
// passphrase + the enrollment-provisioned salt (the value is never stored, only
// reproducible) and seals each CONTACT share to the matching contact's verified
// X25519 pubkey. Returns only sealed ciphertexts; every intermediate secret is
// zeroized. TAKES OWNERSHIP of `releasePassphrase` and wipes it.
//
// S2 (flat 2-of-3): the passphrase is the reserved last share (an OPTIONAL
// fallback); 2 contact shares fill indices 1..N-1. S3 (nested, docs/24): the
// passphrase is the MANDATORY XOR mask and the contacts hold a 2-of-3 split of
// the masked key — so colluding contacts alone never reconstruct S3.

export interface SealedContactShare {
  shareIndex: number;
  wrappedShareCiphertext: Uint8Array;
}

export function splitTierKeyToContactShares(
  tier: 's2' | 's3',
  releasePassphrase: Uint8Array,
  contactX25519Pubkeys: Uint8Array[],
): SealedContactShare[] {
  const u = requireUnlocked();
  touch();
  const releaseIndex = tier === 's2' ? RELEASE_SHARE_INDEX_S2 : RELEASE_SHARE_INDEX_S3;
  // S2 (flat 2-of-3): contacts fill indices 1..releaseIndex-1 and the passphrase
  // is the reserved last share (optional fallback). S3 (nested, docs/24): the
  // passphrase is the MANDATORY XOR mask and the contacts hold a 2-of-3 split of
  // the masked key — S3_NESTED_CONTACT_SHARES contact shares, no passphrase share.
  const contactShareCount = tier === 's2' ? releaseIndex - 1 : S3_NESTED_CONTACT_SHARES;
  if (contactX25519Pubkeys.length !== contactShareCount) {
    wipe(releasePassphrase);
    throw new Error(
      `${tier} needs exactly ${contactShareCount} contact pubkeys, got ${contactX25519Pubkeys.length}`,
    );
  }

  let releaseShare;
  try {
    // For S2 the derived share is the fixed Shamir share at releaseIndex; for S3
    // its 32 evaluation bytes are the XOR mask (the index byte is dropped by the
    // nested split). Same deterministic derivation → reconstruction re-derives an
    // identical mask from the recipient-entered passphrase.
    releaseShare = deriveReleasePassphraseShare(
      releasePassphrase as ReleasePassphrase,
      u.material.releasePassphraseSalt as ReleaseKdfSalt,
      tier,
      releaseIndex,
    );
  } finally {
    wipe(releasePassphrase);
  }

  try {
    return withTierKey(tier, (tierKey) => {
      // S2: flat split — the passphrase share at releaseIndex is filtered out
      // below so only contact shares are sealed. S3: the nested split returns
      // ONLY contact shares (the passphrase never becomes a distributed share).
      const shares =
        tier === 's2'
          ? splitTierKeyForS2(tierKey, releaseShare)
          : splitTierKeyForS3Nested(tierKey, releaseShare);
      try {
        const sealed: SealedContactShare[] = [];
        const contactShares =
          tier === 's2' ? shares.filter((s) => s.bytes[0] !== releaseIndex) : shares;
        for (let i = 0; i < contactShares.length; i++) {
          const share = contactShares[i]!;
          sealed.push({
            shareIndex: share.bytes[0]!,
            wrappedShareCiphertext: sealedBoxEncrypt({
              recipientPublicKey: contactX25519Pubkeys[i]!,
              plaintext: share.bytes,
            }),
          });
        }
        return sealed;
      } finally {
        for (const s of shares) wipe(s.bytes);
      }
    });
  } finally {
    wipe(releaseShare.bytes);
  }
}

// ── auto-lock ───────────────────────────────────────────────────────────────

export function configureAutoLock(opts: { idleMs?: number; onLock?: () => void }): void {
  if (opts.idleMs !== undefined) {
    if (!Number.isFinite(opts.idleMs) || opts.idleMs < MIN_IDLE_MS || opts.idleMs > MAX_IDLE_MS) {
      throw new Error(`idleMs must be within [${MIN_IDLE_MS}, ${MAX_IDLE_MS}], got ${opts.idleMs}`);
    }
    idleMs = opts.idleMs;
  }
  if (opts.onLock !== undefined) onLockCb = opts.onLock;
  if (current !== undefined) armTimer();
}

// Reset the idle countdown — wire to user activity (keypress/pointer) and to
// visibilitychange/pagehide in the C2 app shell.
export function noteActivity(): void {
  if (current !== undefined) armTimer();
}

function setUnlocked(masterKey: UnwrappedMasterKey, material: KeyMaterial): void {
  current = { masterKey, material };
  armTimer();
}

function touch(): void {
  armTimer();
}

function armTimer(): void {
  clearTimer();
  timer = setTimeout(() => {
    lock();
    onLockCb?.();
  }, idleMs);
  // Don't keep a Node process alive on a pending lock timer (tests, SSR).
  (timer as { unref?: () => void }).unref?.();
}

function clearTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}
