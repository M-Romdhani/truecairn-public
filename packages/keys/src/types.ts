// Type-level enforcement of the key hierarchy.
//
// Every key in docs/18 §"Key hierarchy" has at minimum two distinct brands:
//   - the raw (unwrapped) form, ephemeral in memory
//   - the wrapped (ciphertext) form, safe to store
//
// Brands are nominal: a Uint8Array tagged `UnwrappedTierKey` is not assignable
// to a parameter typed `UnwrappedMasterKey`, even though both are 32 bytes.
// This is the whole point of the package — every misuse of "the wrong key" is
// a compile error, not a runtime mystery.

import type { VaultTier } from '@truecairn/shared';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

// A struct holding a ciphertext + the nonce it was encrypted with. The
// `_KIND` brand on the struct (not just the ciphertext field) prevents one
// wrapped form from being passed where another is expected.
type WrappedForm<KIND extends string, Extras = {}> = Brand<
  { readonly ciphertext: Uint8Array; readonly nonce: Uint8Array } & Extras,
  KIND
>;

// =============================================================================
// LEVEL 1 — Passphrases / codes
// =============================================================================
// Never stored. Provided by the user at enrollment, at login, and at sensitive
// action authentication. Always raw bytes (UTF-8 of a string, or the random
// bytes underlying a BIP-39 phrase in the recovery code case).

export type MasterPassphrase = Brand<Uint8Array, 'MasterPassphrase'>;
export type ReleasePassphrase = Brand<Uint8Array, 'ReleasePassphrase'>;
export type RecoveryCode = Brand<Uint8Array, 'RecoveryCode'>;

// Per-user, per-purpose salts. 16 bytes each, generated at enrollment,
// stored in user_key_material.
export type MasterKdfSalt = Brand<Uint8Array, 'MasterKdfSalt'>;
export type RecoveryKdfSalt = Brand<Uint8Array, 'RecoveryKdfSalt'>;
export type ReleaseKdfSalt = Brand<Uint8Array, 'ReleaseKdfSalt'>;

// =============================================================================
// LEVEL 2 — User master key + KEKs derived from passphrase / recovery code
// =============================================================================
// The master key is generated random at enrollment and never stored in raw
// form. It is wrapped TWICE: once under PassphraseKek (for normal login),
// once under RecoveryKek (for recovery-code login). Both wraps live in
// user_key_material.

export type UnwrappedMasterKey = Brand<Uint8Array, 'UnwrappedMasterKey'>;

export type PassphraseKek = Brand<Uint8Array, 'PassphraseKek'>;
export type RecoveryKek = Brand<Uint8Array, 'RecoveryKek'>;

export type MasterKeyWrappedByPassphrase = WrappedForm<'MasterKeyWrappedByPassphrase'>;
export type MasterKeyWrappedByRecovery = WrappedForm<'MasterKeyWrappedByRecovery'>;

// Subkeys derived from UnwrappedMasterKey via a domain-separated KDF
// (proposed: libsodium crypto_kdf_derive_from_key with distinct ctx + id).
// These are the only things the master key produces — the master key itself
// is never used directly as a wrapping key or a signing key. Key separation.

export type AuditSigningSeed = Brand<Uint8Array, 'AuditSigningSeed'>;
export type TierWrappingKey = Brand<Uint8Array, 'TierWrappingKey'>;

// The master-derived key that encrypts contact labels and pins (F1+F2, §1.2).
// Branded so it can never be passed where a tier key is expected — the whole
// point of the change is that these two keys have different audiences.
export type ContactPinKey = Brand<Uint8Array, 'ContactPinKey'>;

// A CONTACT's affirmation keypairs are derived from the CONTACT's own master key
// (docs/15, docs/18, PHASE3_2 §: "the passphrase-derived affirmation key") — so
// they are recoverable from the passphrase, never server-stored. Same derive-from-
// master pattern as AuditSigningSeed: an X25519 seed (sealed-box / share receipt)
// and an Ed25519 seed (affirmation + enrolment possession proof).
export type ContactX25519Seed = Brand<Uint8Array, 'ContactX25519Seed'>;
export type ContactEd25519Seed = Brand<Uint8Array, 'ContactEd25519Seed'>;

// The OWNER's own X25519 keypair for write-only capture (docs/34). A device that
// holds only the public half can seal new items to the vault and cannot open one
// — including the ones it sealed itself, because crypto_box_seal discards the
// ephemeral secret. Master-derived like every other subkey here, so it is
// recoverable from the passphrase and never server-stored.
//
// Its own context rather than a second job for AuditSigningSeed (docs/34 D2):
// the audit key's whole value is that an owner signature means exactly one
// thing.
export type VaultCaptureX25519Seed = Brand<Uint8Array, 'VaultCaptureX25519Seed'>;

// =============================================================================
// LEVEL 3 — Per-tier keys (S1, S2, S3)
// =============================================================================
// Random 256-bit keys generated at enrollment. Wrapped under TierWrappingKey
// for normal user access. S2 and S3 keys are additionally Shamir-split for
// release ceremonies. S1 has no Shamir shares.

export type UnwrappedTierKey = Brand<Uint8Array, 'UnwrappedTierKey'> & {
  readonly tier: VaultTier;
};

export type TierKeyWrappedByMaster = WrappedForm<
  'TierKeyWrappedByMaster',
  { readonly tier: VaultTier; readonly generation: number }
>;

// Single Shamir share of a per-tier key. The share itself is the
// `index || evaluation` Uint8Array produced by @truecairn/crypto/shamir.
// `tier` is carried so combining shares from different tiers is a type error.
export type TierKeyShare = Brand<
  { readonly bytes: Uint8Array; readonly tier: VaultTier },
  'TierKeyShare'
>;

// =============================================================================
// LEVEL 4 — Per-item keys
// =============================================================================
// Random 256-bit key per vault item. Wrapped under the appropriate per-tier
// key. The wrapped form is what lives in vault_items.wrapped_per_item_key.

export type UnwrappedItemKey = Brand<Uint8Array, 'UnwrappedItemKey'>;

export type ItemKeyWrappedByTier = WrappedForm<
  'ItemKeyWrappedByTier',
  { readonly tier: VaultTier }
>;

// Content encrypted under a per-item key. The plaintext form is the raw vault
// content; the ciphertext form lives in vault_items.content_ciphertext.
export type ItemContentCiphertext = Brand<
  { readonly ciphertext: Uint8Array; readonly nonce: Uint8Array },
  'ItemContentCiphertext'
>;

// =============================================================================
// LEVEL 5 — Outer-layer keys (server-side temporal gate)
// =============================================================================
// Per (user, tier), random 256-bit key, held by the platform. Wrapped under a
// platform KEK reached through the KekProvider seam (packages/vault/kek.ts):
// env-backed (the KEK in process — these XChaCha20 wrap/unwrap helpers) or
// HSM-backed (GCP Cloud KMS, where the KEK never leaves the HSM). docs/18
// §outer-layer. The OuterLayerKek type below is the env-path KEK.

export type UnwrappedOuterLayerKey = Brand<Uint8Array, 'UnwrappedOuterLayerKey'>;
export type OuterLayerKek = Brand<Uint8Array, 'OuterLayerKek'>;

export type OuterLayerKeyWrappedByKek = WrappedForm<
  'OuterLayerKeyWrappedByKek',
  { readonly aad: Uint8Array }
>;

// What the outer-layer key wraps. Per docs/18 §"Outer-layer keys":
//   "used to wrap the per-tier ciphertext before storage"
// — and §"Release ceremony protocol" Phase 3:
//   "The per-tier ciphertext is decrypted using the outer-layer key, then
//    the per-tier key."
//
// Proposed model: the outer-layer key wraps the inner per-item ciphertext +
// wrapped-per-item-key bundle at server-storage time. The server applies the
// wrap on store and the unwrap on fetch when the engine permits. The inner
// form is what the client computes; the outer form is what's persisted.
//
// >>> This is one of the open questions to confirm — see PROPOSAL.md.

export type InnerVaultBundle = Brand<
  {
    readonly contentCiphertext: ItemContentCiphertext;
    readonly wrappedItemKey: ItemKeyWrappedByTier;
  },
  'InnerVaultBundle'
>;

export type OuterWrappedVaultBundle = WrappedForm<'OuterWrappedVaultBundle'>;

// =============================================================================
// LEVEL 6 — Release-only passphrase → Shamir share value
// =============================================================================
// Per docs/18 §"Key hierarchy" item 6:
//   "Release-only passphrase. Separate from the user master passphrase ...
//    Derives, via Argon2id, the share value that participates in Shamir
//    reconstruction for S2 and S3 release ceremonies."
//
// The derived value IS the share value, used in place of one of the contact
// shares during reconstruction. Treated as a TierKeyShare at use time, but
// branded distinctly at derive time so we can keep its provenance visible
// in the type when callers want to enforce "this share came from the
// release passphrase, not a contact."

export type ReleasePassphraseShare = Brand<
  { readonly bytes: Uint8Array; readonly tier: VaultTier },
  'ReleasePassphraseShare'
>;

// =============================================================================
// Constants
// =============================================================================

export const MASTER_KEY_BYTES = 32;
export const PASSPHRASE_KEK_BYTES = 32;
export const RECOVERY_KEK_BYTES = 32;
export const AUDIT_SIGNING_SEED_BYTES = 32;
export const TIER_WRAPPING_KEY_BYTES = 32;
export const TIER_KEY_BYTES = 32;
export const ITEM_KEY_BYTES = 32;
export const OUTER_LAYER_KEY_BYTES = 32;
export const OUTER_LAYER_KEK_BYTES = 32;

// Shamir presets per docs/01-decisions-locked.md §3 and docs/18.
export const S2_THRESHOLD = 2;
export const S2_SHARES = 3;
export const S3_THRESHOLD = 3;
export const S3_SHARES = 4;

// S3 nested scheme (docs/24 — collusion-threshold decision): the release
// passphrase is a MANDATORY XOR mask over the S3 tier key, and the contacts hold
// a 2-of-3 Shamir split of the MASKED secret. So S3 reconstruction needs the
// passphrase AND any 2 of 3 contacts — colluding contacts alone recover only the
// masked secret, never the tier key. (S2 stays flat 2-of-3 with the passphrase as
// an optional fallback share.)
export const S3_NESTED_CONTACT_THRESHOLD = 2;
export const S3_NESTED_CONTACT_SHARES = 3;

// Fixed share index for the release-passphrase share within each tier's
// Shamir scheme. docs/01-decisions-locked.md §3: 2-of-3 for S2 (3 shares
// total → release share is the last, index 3); 3-of-4 for S3 (4 shares
// total → release share is index 4). Contact shares occupy indices
// 1..(totalShares-1); the release-passphrase share is always the last.
// Fixed positions so callers can't accidentally place it at the wrong index.
export const RELEASE_SHARE_INDEX_S2 = 3;
export const RELEASE_SHARE_INDEX_S3 = 4;

// KDF subkey context strings + ids. Domain-separated. 8-byte context per
// libsodium's crypto_kdf_derive_from_key requirement.
export const KDF_CONTEXT_AUDIT = 'tc-audit';   // 8 bytes
export const KDF_CONTEXT_WRAP = 'tc-twrap';    // 8 bytes
export const KDF_SUBKEY_ID_AUDIT_SIGNING = 1;
export const KDF_SUBKEY_ID_TIER_WRAPPING = 1;

// Contact affirmation-key derivation contexts (8 bytes each, domain-separated).
export const KDF_CONTEXT_CONTACT_X25519 = 'tc-cx519'; // 8 bytes
export const KDF_CONTEXT_CONTACT_ED25519 = 'tc-ced25'; // 8 bytes
export const KDF_SUBKEY_ID_CONTACT_X25519 = 1;
export const KDF_SUBKEY_ID_CONTACT_ED25519 = 1;
export const CONTACT_X25519_SEED_BYTES = 32;
export const CONTACT_ED25519_SEED_BYTES = 32;

// ── Per-relationship contact keys (v2) ──────────────────────────────────────
//
// THE PROBLEM v1 HAS. deriveContactX25519Seed / deriveContactEd25519Seed take
// only the master key: fixed context, fixed subkey id, no per-relationship input.
// So a contact derives ONE keypair and presents the SAME public key in every
// owner's `contacts` row. Anyone with database access can then reconstruct
// "these N people share this contact" without decrypting anything — a social
// graph in plaintext, which is the adversary class docs/15 is written about.
//
// Today that is noise: a normal person is a contact for one or two owners. It
// becomes a structure exactly as the professional-recipient case succeeds, where
// one lawyer or notary is the professional contact for dozens of clients. The
// leak therefore grows with adoption, which is the wrong direction for a risk to
// move, and it is cheapest to fix before real contacts are enrolled.
//
// THE SHAPE. An 8-byte crypto_kdf context cannot carry a relationship id, so this
// is two steps: derive a per-contact ROOT from the master key with its own
// context, then key a BLAKE2b PRF with that root over the relationship id. One
// secret custodied, N unlinkable keypairs derived deterministically.
//
// 'tc-cbind' = contact binding. Deliberately its own context rather than reusing
// tc-cx519/tc-ced25: those seeds are already used directly AS keypair seeds, and
// a value should not be both a seed and a PRF key.
export const KDF_CONTEXT_CONTACT_BINDING = 'tc-cbind'; // 8 bytes
export const KDF_SUBKEY_ID_CONTACT_BINDING = 1;
export const CONTACT_BINDING_ROOT_BYTES = 32;

// Domain separation INSIDE the PRF, so the X25519 and Ed25519 seeds for the same
// relationship are independent. Prefixed rather than appended: the relationship
// id is variable-length input, and a suffix would let a crafted id collide with
// another purpose's message.
export const CONTACT_BINDING_PURPOSE_X25519 = 'x25519:';
export const CONTACT_BINDING_PURPOSE_ED25519 = 'ed25519:';

// v1 = one global keypair per contact (the correlating form above).
// v2 = one keypair per (contact, owner) relationship.
// Stored per contact row so both can be read during the migration window; new
// enrolments write v2. PLAN-v1-launch.md §1.2's rule applies here too — versioned
// read, opportunistic upgrade, and never a forced re-confirmation.
export const CONTACT_KEY_VERSION_V1_GLOBAL = 1;
export const CONTACT_KEY_VERSION_V2_PER_RELATIONSHIP = 2;
export const CONTACT_KEY_VERSION_CURRENT = CONTACT_KEY_VERSION_V2_PER_RELATIONSHIP;

// ── Contact pins and labels (F1 + F2, PLAN-v1-launch.md §1.2) ───────────────
//
// WHAT WAS WRONG. Contact display labels and key pins were encrypted under the
// S1 TIER key. That key is not the owner's alone: sealS1EnvelopeToContact seals
// it directly to the S1 beneficiary's X25519 pubkey, and reconstructS1Item
// unseals it into their browser. So the moment an S1 release completes, that one
// recipient can decrypt the owner's private label and pin for EVERY contact —
// including contacts who exist only in S2/S3 and have nothing to do with S1.
// Labels are the larger half: every contact has one, pins only the confirmed.
//
// 'tc-cmeta' is master-derived, so it is disclosed to nobody, ever. No ceremony
// reconstructs the master key — a release reconstructs TIER keys — which is
// exactly why moving these off a tier key closes the path rather than narrowing
// it.
//
// FLAT, NOT RELATIONSHIP-BOUND, and the distinction is deliberate. tc-cbind
// exists because a CONTACT's public key is visible to every owner who enrolled
// them, so it must be unlinkable across owners. A label and a pin are the
// opposite: they are written by one owner, stored as ciphertext, and read back
// by that same owner and nobody else. There is no second party to be unlinkable
// from, so a per-relationship PRF would add machinery and a second thing to
// version while defending against nothing this data is exposed to.
// NOT 'tc-cpin', which PLAN-v1-launch.md §1.2 specifies: that string is SEVEN
// bytes and libsodium's crypto_kdf_derive_from_key requires exactly eight, so it
// throws at the first call ("subkey context must encode to exactly 8 bytes, got
// 7"). Every other context here — tc-audit, tc-twrap, tc-cx519, tc-ced25,
// tc-cbind, tc-vcapt — is 8. The plan's name cannot be used; this is the
// correction, and it is also the more accurate name, because this key protects
// display LABELS as well as pins.
export const KDF_CONTEXT_CONTACT_PIN = 'tc-cmeta'; // 8 bytes
export const KDF_SUBKEY_ID_CONTACT_PIN = 1;
export const CONTACT_PIN_KEY_BYTES = 32;

// v1 = label + pin under the S1 tier key (the leaking form above).
// v2 = label + pin under the master-derived tc-cmeta key.
//
// ONE version for both, because both move under the same key in the same pass:
// splitting them would mean two migration states on one row and no case where
// they legitimately differ. Readers accept 1 and 2; writers always emit 2; a v1
// row is re-encrypted opportunistically on unlock, when the client holds both
// the S1 tier key to read it and the master key to rewrite it.
//
// Deliberately NOT reusing CONTACT_KEY_VERSION_* above: that pair versions the
// contact's KEYPAIR DERIVATION (v1 global vs v2 per-relationship) and is a
// separate migration with separate preconditions. Two independent crypto
// migrations get two independent columns, or neither can move without the other.
export const CONTACT_PIN_VERSION_V1_S1_TIER_KEY = 1;
export const CONTACT_PIN_VERSION_V2_MASTER_DERIVED = 2;
export const CONTACT_PIN_VERSION_CURRENT = CONTACT_PIN_VERSION_V2_MASTER_DERIVED;

// Owner write-only capture (docs/34 D2). 'v' for vault, 'capt' for capture —
// distinct from tc-cx519, which is a CONTACT's X25519 seed and must never
// collide with the owner's.
export const KDF_CONTEXT_VAULT_CAPTURE = 'tc-vcapt'; // 8 bytes
export const KDF_SUBKEY_ID_VAULT_CAPTURE = 1;
export const VAULT_CAPTURE_X25519_SEED_BYTES = 32;
