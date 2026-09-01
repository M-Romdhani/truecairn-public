import { fromBase64, toBase64 } from '@truecairn/crypto';
import { VAULT_TIERS, type VaultTier } from '@truecairn/shared';

// The client's key material: everything needed to unlock the vault and unwrap
// tier keys. Held in memory as raw bytes; the wire form (DTO) is base64.
//
// All byte fields are ciphertext + salts + a public key — NO plaintext secret.
// This is exactly what the enrollment `provision` POST uploads and the login
// `bootstrap` GET returns (PHASE4 R0.4). The master key itself never appears
// here: it is unwrapped in memory by the session and never persisted or sent.

export interface TierKeyMaterial {
  tier: VaultTier;
  generation: number;
  tierKeyWrappedByMaster: Uint8Array;
  tierKeyMasterNonce: Uint8Array;
  // Random sentinel encrypted under the tier key — lets a client verify a
  // reconstructed/unwrapped tier key is correct even with zero vault items.
  tierKeyCheckPlaintext: Uint8Array;
  tierKeyCheckCiphertext: Uint8Array;
  tierKeyCheckNonce: Uint8Array;
}

export interface KeyMaterial {
  masterPassphraseSalt: Uint8Array;
  masterKeyWrappedByPassphrase: Uint8Array;
  masterKeyPassphraseNonce: Uint8Array;
  recoveryCodeSalt: Uint8Array;
  masterKeyWrappedByRecovery: Uint8Array;
  masterKeyRecoveryNonce: Uint8Array;
  releasePassphraseSalt: Uint8Array;
  auditSigningPubkey: Uint8Array;
  // The owner's write-only capture PUBLIC key (docs/34). Optional because
  // accounts enrolled before capture existed have none until their next unlock
  // publishes one — and because it is a derived value, so its absence costs
  // nothing but a round-trip.
  vaultCapturePubkey?: Uint8Array;
  generation: number; // master-key generation
  tierKeys: TierKeyMaterial[];
}

// ── Wire DTOs (base64) ──────────────────────────────────────────────────────
// The provision POST body and the bootstrap GET response. The API validates and
// stores/returns these exact field names; the provision→bootstrap round-trip
// test proves client codecs and server storage agree byte-for-byte.

export interface TierKeyMaterialDto {
  tier: VaultTier;
  generation: number;
  tierKeyWrappedByMaster: string;
  tierKeyMasterNonce: string;
  tierKeyCheckPlaintext: string;
  tierKeyCheckCiphertext: string;
  tierKeyCheckNonce: string;
}

export interface KeyMaterialDto {
  masterPassphraseSalt: string;
  masterKeyWrappedByPassphrase: string;
  masterKeyPassphraseNonce: string;
  recoveryCodeSalt: string;
  masterKeyWrappedByRecovery: string;
  masterKeyRecoveryNonce: string;
  releasePassphraseSalt: string;
  auditSigningPubkey: string;
  vaultCapturePubkey?: string | null;
  generation: number;
  tierKeys: TierKeyMaterialDto[];
}

export function encodeKeyMaterial(m: KeyMaterial): KeyMaterialDto {
  return {
    masterPassphraseSalt: toBase64(m.masterPassphraseSalt),
    masterKeyWrappedByPassphrase: toBase64(m.masterKeyWrappedByPassphrase),
    masterKeyPassphraseNonce: toBase64(m.masterKeyPassphraseNonce),
    recoveryCodeSalt: toBase64(m.recoveryCodeSalt),
    masterKeyWrappedByRecovery: toBase64(m.masterKeyWrappedByRecovery),
    masterKeyRecoveryNonce: toBase64(m.masterKeyRecoveryNonce),
    releasePassphraseSalt: toBase64(m.releasePassphraseSalt),
    auditSigningPubkey: toBase64(m.auditSigningPubkey),
    ...(m.vaultCapturePubkey !== undefined
      ? { vaultCapturePubkey: toBase64(m.vaultCapturePubkey) }
      : {}),
    generation: m.generation,
    tierKeys: m.tierKeys.map((t) => ({
      tier: t.tier,
      generation: t.generation,
      tierKeyWrappedByMaster: toBase64(t.tierKeyWrappedByMaster),
      tierKeyMasterNonce: toBase64(t.tierKeyMasterNonce),
      tierKeyCheckPlaintext: toBase64(t.tierKeyCheckPlaintext),
      tierKeyCheckCiphertext: toBase64(t.tierKeyCheckCiphertext),
      tierKeyCheckNonce: toBase64(t.tierKeyCheckNonce),
    })),
  };
}

export function decodeKeyMaterial(dto: KeyMaterialDto): KeyMaterial {
  return {
    masterPassphraseSalt: fromBase64(dto.masterPassphraseSalt),
    masterKeyWrappedByPassphrase: fromBase64(dto.masterKeyWrappedByPassphrase),
    masterKeyPassphraseNonce: fromBase64(dto.masterKeyPassphraseNonce),
    recoveryCodeSalt: fromBase64(dto.recoveryCodeSalt),
    masterKeyWrappedByRecovery: fromBase64(dto.masterKeyWrappedByRecovery),
    masterKeyRecoveryNonce: fromBase64(dto.masterKeyRecoveryNonce),
    releasePassphraseSalt: fromBase64(dto.releasePassphraseSalt),
    auditSigningPubkey: fromBase64(dto.auditSigningPubkey),
    ...(dto.vaultCapturePubkey != null
      ? { vaultCapturePubkey: fromBase64(dto.vaultCapturePubkey) }
      : {}),
    generation: dto.generation,
    tierKeys: dto.tierKeys.map((t) => ({
      tier: t.tier,
      generation: t.generation,
      tierKeyWrappedByMaster: fromBase64(t.tierKeyWrappedByMaster),
      tierKeyMasterNonce: fromBase64(t.tierKeyMasterNonce),
      tierKeyCheckPlaintext: fromBase64(t.tierKeyCheckPlaintext),
      tierKeyCheckCiphertext: fromBase64(t.tierKeyCheckCiphertext),
      tierKeyCheckNonce: fromBase64(t.tierKeyCheckNonce),
    })),
  };
}

// All three tiers, in canonical order, are always provisioned (PHASE4 Q8: tier
// keys exist from enrollment so S2/S3 release composition can be set up later).
export const ALL_TIERS: readonly VaultTier[] = VAULT_TIERS;
