// Level 2 internal — sub-key derivation from the master key.
//
// docs/18 §"Key hierarchy" item 2:
//   "User master key ... Used to derive: the audit log signing key, the
//    wrapping key for per-tier keys, and the verification key for the
//    audit log."
//
// The master key never directly wraps or signs anything in our design.
// Instead it produces domain-separated subkeys via BLAKE2b (libsodium's
// crypto_kdf_derive_from_key) with distinct (context, subkey_id) pairs:
//
//   audit signing seed → ed25519 seed for the user's audit signing keypair.
//                        the verification (public) key derives from this
//                        seed deterministically via ed25519KeypairFromSeed.
//   tier wrapping key → 32-byte XChaCha20-Poly1305 key that wraps every
//                       per-tier key for storage in user_tier_keys.
//
// Domain separation matters: a flaw in one subkey's usage cannot leak the
// other, because BLAKE2b is preimage-resistant and the contexts differ.

import { blake2bHash, deriveSubkey } from '@truecairn/crypto';
import {
  AUDIT_SIGNING_SEED_BYTES,
  CONTACT_BINDING_PURPOSE_ED25519,
  CONTACT_BINDING_PURPOSE_X25519,
  CONTACT_BINDING_ROOT_BYTES,
  CONTACT_ED25519_SEED_BYTES,
  CONTACT_X25519_SEED_BYTES,
  KDF_CONTEXT_AUDIT,
  KDF_CONTEXT_CONTACT_BINDING,
  KDF_CONTEXT_CONTACT_ED25519,
  KDF_CONTEXT_CONTACT_X25519,
  KDF_CONTEXT_VAULT_CAPTURE,
  KDF_CONTEXT_CONTACT_PIN,
  KDF_CONTEXT_WRAP,
  KDF_SUBKEY_ID_AUDIT_SIGNING,
  KDF_SUBKEY_ID_CONTACT_BINDING,
  KDF_SUBKEY_ID_CONTACT_ED25519,
  KDF_SUBKEY_ID_CONTACT_X25519,
  KDF_SUBKEY_ID_TIER_WRAPPING,
  KDF_SUBKEY_ID_VAULT_CAPTURE,
  CONTACT_PIN_KEY_BYTES,
  KDF_SUBKEY_ID_CONTACT_PIN,
  TIER_WRAPPING_KEY_BYTES,
  VAULT_CAPTURE_X25519_SEED_BYTES,
  type AuditSigningSeed,
  type ContactEd25519Seed,
  type ContactPinKey,
  type ContactX25519Seed,
  type TierWrappingKey,
  type UnwrappedMasterKey,
  type VaultCaptureX25519Seed,
} from './types.js';

export function deriveAuditSigningSeed(masterKey: UnwrappedMasterKey): AuditSigningSeed {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_AUDIT,
    subkeyId: KDF_SUBKEY_ID_AUDIT_SIGNING,
    subkeyLength: AUDIT_SIGNING_SEED_BYTES,
  }) as AuditSigningSeed;
}

export function deriveTierWrappingKey(masterKey: UnwrappedMasterKey): TierWrappingKey {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_WRAP,
    subkeyId: KDF_SUBKEY_ID_TIER_WRAPPING,
    subkeyLength: TIER_WRAPPING_KEY_BYTES,
  }) as TierWrappingKey;
}

// The key that encrypts contact display labels and key pins (F1+F2, §1.2).
//
// Master-derived on purpose: a release ceremony reconstructs TIER keys, never the
// master key, so nothing a contact can ever hold reaches this. That is the whole
// fix — labels and pins used to sit under the S1 tier key, which is sealed
// directly to the S1 beneficiary and unsealed in their browser on release.
export function deriveContactPinKey(masterKey: UnwrappedMasterKey): ContactPinKey {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_CONTACT_PIN,
    subkeyId: KDF_SUBKEY_ID_CONTACT_PIN,
    subkeyLength: CONTACT_PIN_KEY_BYTES,
  }) as ContactPinKey;
}

// A contact's X25519 affirmation seed → x25519KeypairFromSeed gives the keypair
// that receives sealed shares (sealed-box) and proves possession at enrolment.
export function deriveContactX25519Seed(masterKey: UnwrappedMasterKey): ContactX25519Seed {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_CONTACT_X25519,
    subkeyId: KDF_SUBKEY_ID_CONTACT_X25519,
    subkeyLength: CONTACT_X25519_SEED_BYTES,
  }) as ContactX25519Seed;
}

// The OWNER's write-only capture seed (docs/34) → x25519KeypairFromSeed gives the
// keypair whose PUBLIC half a phone may hold. Deterministic from the master key,
// so publishing it is a backfill rather than a rotation: unlocking on a second
// browser derives the identical pubkey, and the publish route treats a repeat as
// a no-op instead of orphaning already-sealed captures.
export function deriveVaultCaptureX25519Seed(
  masterKey: UnwrappedMasterKey,
): VaultCaptureX25519Seed {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_VAULT_CAPTURE,
    subkeyId: KDF_SUBKEY_ID_VAULT_CAPTURE,
    subkeyLength: VAULT_CAPTURE_X25519_SEED_BYTES,
  }) as VaultCaptureX25519Seed;
}

// A contact's Ed25519 affirmation seed → ed25519KeypairFromSeed gives the keypair
// that signs affirmations and the enrolment possession-proof challenge.
export function deriveContactEd25519Seed(masterKey: UnwrappedMasterKey): ContactEd25519Seed {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_CONTACT_ED25519,
    subkeyId: KDF_SUBKEY_ID_CONTACT_ED25519,
    subkeyLength: CONTACT_ED25519_SEED_BYTES,
  }) as ContactEd25519Seed;
}

// ── Per-relationship contact seeds (v2) ─────────────────────────────────────
//
// See types.ts for why this exists. Summary: v1 derives ONE contact keypair from
// the master key, so the same public key appears in every owner's contacts row
// and the database reveals who shares a contact without decrypting anything.
//
// Two steps, because an 8-byte crypto_kdf context cannot carry a relationship id:
//
//   root = crypto_kdf(masterKey, 'tc-cbind', 1)          — per contact
//   seed = BLAKE2b(key = root, msg = purpose + relationshipId)  — per relationship
//
// The contact still custodies one secret. Forty relationships derive forty
// unlinkable keypairs, deterministically, with no extra storage.
//
// `relationshipId` must be stable for the life of the relationship and computable
// by both sides without an extra round-trip: it is the `contacts` row id, which
// the contact already receives in their invite.
function deriveContactBindingRoot(masterKey: UnwrappedMasterKey): Uint8Array {
  return deriveSubkey({
    masterKey,
    context: KDF_CONTEXT_CONTACT_BINDING,
    subkeyId: KDF_SUBKEY_ID_CONTACT_BINDING,
    subkeyLength: CONTACT_BINDING_ROOT_BYTES,
  });
}

function bindToRelationship(
  root: Uint8Array,
  purpose: string,
  relationshipId: string,
  outputLength: number,
): Uint8Array {
  return blake2bHash({
    key: root,
    message: new TextEncoder().encode(`${purpose}${relationshipId}`),
    outputLength,
  });
}

// v2 X25519 seed for ONE relationship. Receives sealed shares and proves
// possession at enrolment, exactly as the v1 seed does — only the derivation and
// therefore the resulting public key differ.
export function deriveContactX25519SeedForRelationship(
  masterKey: UnwrappedMasterKey,
  relationshipId: string,
): ContactX25519Seed {
  const root = deriveContactBindingRoot(masterKey);
  try {
    return bindToRelationship(
      root,
      CONTACT_BINDING_PURPOSE_X25519,
      relationshipId,
      CONTACT_X25519_SEED_BYTES,
    ) as ContactX25519Seed;
  } finally {
    root.fill(0);
  }
}

// v2 Ed25519 seed for ONE relationship. Signs affirmations and the enrolment
// possession-proof challenge.
export function deriveContactEd25519SeedForRelationship(
  masterKey: UnwrappedMasterKey,
  relationshipId: string,
): ContactEd25519Seed {
  const root = deriveContactBindingRoot(masterKey);
  try {
    return bindToRelationship(
      root,
      CONTACT_BINDING_PURPOSE_ED25519,
      relationshipId,
      CONTACT_ED25519_SEED_BYTES,
    ) as ContactEd25519Seed;
  } finally {
    root.fill(0);
  }
}
