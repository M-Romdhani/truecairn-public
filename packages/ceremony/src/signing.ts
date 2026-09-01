import { blake2b256, ed25519Verify } from '@truecairn/crypto';
import type { VaultTier } from '@truecairn/shared';

// All ceremony signing payloads live here. Both use the same length-prefixed
// canonical encoding as the audit log canonical encoder and buildOuterLayerAad
// — the shared byte helpers below are that one lp()/uuid16 implementation.
//
// Two payloads:
//   1. The affirmation payload — a contact's "I affirm this release" intent.
//   2. The affirmation-share payload — binds one re-wrapped share to a specific
//      recipient ephemeral key + the exact sealed ciphertext, giving per-share
//      non-repudiation (an auditor can prove contact C produced THIS sealed
//      share for THIS recipient).
//
// Both are signed by the contact's Ed25519 affirmation key (derived from the
// contact's passphrase + device binding — Phase 3) and verified against
// contacts.contact_ed25519_pubkey. This module never derives or holds a key.

const TIER_BYTE: Record<VaultTier, number> = { s1: 1, s2: 2, s3: 3 };

// ---------------------------------------------------------------------------
// Affirmation payload
//   0x01
//   lp("truecairn.affirmation.v1")
//   uuid16(ceremony_id) uuid16(user_id) uuid16(contact_id) uuid16(share_id)
//   tier_byte
// ceremony_id provides instance binding (defeats cross-ceremony replay).
// ---------------------------------------------------------------------------

export const AFFIRMATION_VERSION = 0x01;
const AFFIRMATION_DOMAIN = 'truecairn.affirmation.v1';

export interface AffirmationSigningInput {
  ceremonyId: string;
  userId: string;
  contactId: string;
  shareId: string;
  tier: VaultTier;
}

export function buildAffirmationSigningInput(input: AffirmationSigningInput): Uint8Array {
  return concat([
    Uint8Array.of(AFFIRMATION_VERSION),
    lengthPrefixed(utf8(AFFIRMATION_DOMAIN)),
    uuidBytes(input.ceremonyId),
    uuidBytes(input.userId),
    uuidBytes(input.contactId),
    uuidBytes(input.shareId),
    Uint8Array.of(TIER_BYTE[input.tier]),
  ]);
}

export function verifyAffirmation(
  signature: Uint8Array,
  input: AffirmationSigningInput,
  contactEd25519Pubkey: Uint8Array,
): boolean {
  return ed25519Verify(signature, buildAffirmationSigningInput(input), contactEd25519Pubkey);
}

// ---------------------------------------------------------------------------
// Affirmation-share payload
//   0x01
//   lp("truecairn.affirmation_share.v1")
//   uuid16(affirmation_id) uuid16(recipient_contact_id)
//   recipient_ephemeral_pubkey (32 bytes)
//   blake2b256(sealed_share_ciphertext) (32 bytes)
// Binds the re-wrap to a specific recipient ephemeral key AND the exact
// sealed ciphertext. A server that swaps either breaks the signature.
// ---------------------------------------------------------------------------

export const AFFIRMATION_SHARE_VERSION = 0x01;
const AFFIRMATION_SHARE_DOMAIN = 'truecairn.affirmation_share.v1';

export interface ShareSigningInput {
  affirmationId: string;
  recipientContactId: string;
  recipientEphemeralPubkey: Uint8Array; // 32 bytes
  sealedShareCiphertext: Uint8Array;
}

export function buildShareSigningInput(input: ShareSigningInput): Uint8Array {
  if (input.recipientEphemeralPubkey.length !== 32) {
    throw new Error('recipientEphemeralPubkey must be 32 bytes');
  }
  return concat([
    Uint8Array.of(AFFIRMATION_SHARE_VERSION),
    lengthPrefixed(utf8(AFFIRMATION_SHARE_DOMAIN)),
    uuidBytes(input.affirmationId),
    uuidBytes(input.recipientContactId),
    input.recipientEphemeralPubkey,
    blake2b256(input.sealedShareCiphertext),
  ]);
}

export function verifyShareSignature(
  signature: Uint8Array,
  input: ShareSigningInput,
  contactEd25519Pubkey: Uint8Array,
): boolean {
  return ed25519Verify(signature, buildShareSigningInput(input), contactEd25519Pubkey);
}

// ---------------------------------------------------------------------------
// shared byte helpers (one lp()/uuid16 implementation, mirroring the audit
// canonical encoder and buildOuterLayerAad)
// ---------------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function u32be(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function lengthPrefixed(payload: Uint8Array): Uint8Array {
  return concat([u32be(payload.length), payload]);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid uuid: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
