import { createHash } from 'node:crypto';
import {
  unwrapOuterLayerKey,
  wrapOuterLayerKey,
  type OuterLayerKek,
  type OuterLayerKeyWrappedByKek,
  type UnwrappedOuterLayerKey,
} from '@truecairn/keys';

// The platform KEK that wraps the per-tier outer-layer keys at rest. Versioned
// so a KEK rotation is a background re-wrap, not a forced re-enrol; the id is
// derived from the key so config never has to name it.
export interface ServerKek {
  id: string;
  key: Uint8Array;
}

export interface KekSet {
  currentId: string;
  byId: Map<string, ServerKek>;
}

// Raised when the KEK that wrapped an outer key isn't available (env: not in the
// ring — e.g. an ephemeral dev KEK lost across a restart, or a worker started
// without OUTER_LAYER_KEK). The item is unreadable until the KEK is restored — an
// operational error, not a client one. Lives here (not store.ts) so KekProviders
// can raise it.
export class OuterKekUnavailableError extends Error {
  constructor(kekId: string) {
    super(`outer-layer KEK ${kekId} is not available; the item cannot be unwrapped`);
    this.name = 'OuterKekUnavailableError';
  }
}

// ── The platform-KEK seam (Phase 5: HSM-backed KEKs) ────────────────────────
// The per-(user,tier) outer-layer KEY is wrapped under a platform KEK at rest.
// A KekProvider abstracts that wrap/unwrap so the KEK can live EITHER in process
// (EnvKekProvider — the historical default) OR in an HSM/KMS (KmsKekProvider —
// the KEK never leaves the HSM; only the small outer-layer key transits, wrapped).
// Async because a KMS call is a network round-trip; the env provider resolves
// synchronously. The outer key is a temporal gate, not a confidentiality key, so
// KEK access never widens plaintext exposure (the inner wraps still need the
// owner's master passphrase).

// The provider-agnostic wrapped form. `nonce` is the AEAD nonce for the env
// provider; empty for KMS (the HSM manages its own). The kekId is NOT carried
// here — it is the row's denormalised binding column, passed to unwrap so the
// AAD (which binds it) is reconstructed from authoritative sources.
export interface WrappedOuterKey {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export interface KekProvider {
  // Stable id of the CURRENT KEK — bound into the AAD and stored as the row's
  // kek_id at provision (env: the ring key id; KMS: the key resource name). Known
  // upfront so the AAD can bind it before wrapping.
  readonly currentKekId: string;
  // Seal an outer-layer key under the current KEK, AEAD-bound to `aad`.
  wrap(plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedOuterKey>;
  // Open a wrapped outer-layer key under the KEK named by `kekId`, re-binding `aad`.
  unwrap(kekId: string, wrapped: WrappedOuterKey, aad: Uint8Array): Promise<Uint8Array>;
}

// Env/local provider: the KEK lives in process (from OUTER_LAYER_KEK), XChaCha20
// wrap/unwrap via @truecairn/keys. A versioned ring (currentId wraps; byId unwraps
// prior generations) so a KEK rotation is a background re-wrap.
export class EnvKekProvider implements KekProvider {
  constructor(private readonly keks: KekSet) {}

  get currentKekId(): string {
    return this.keks.currentId;
  }

  async wrap(plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedOuterKey> {
    const kek = this.keks.byId.get(this.keks.currentId);
    if (kek === undefined) throw new OuterKekUnavailableError(this.keks.currentId);
    const w = wrapOuterLayerKey(plaintext as UnwrappedOuterLayerKey, kek.key as unknown as OuterLayerKek, aad);
    return { ciphertext: w.ciphertext, nonce: w.nonce };
  }

  async unwrap(kekId: string, wrapped: WrappedOuterKey, aad: Uint8Array): Promise<Uint8Array> {
    const kek = this.keks.byId.get(kekId);
    if (kek === undefined) throw new OuterKekUnavailableError(kekId);
    const w = {
      ciphertext: wrapped.ciphertext,
      nonce: wrapped.nonce,
      aad,
    } as unknown as OuterLayerKeyWrappedByKek;
    return unwrapOuterLayerKey(w, kek.key as unknown as OuterLayerKek, aad);
  }
}

export function envKekProvider(keks: KekSet): KekProvider {
  return new EnvKekProvider(keks);
}

// A minimal KMS/HSM client seam — encrypt/decrypt a small plaintext under a
// platform key, AEAD-bound to `aad`. The adapter (e.g. GcpKmsClient) implements
// this against a real KMS; the provider logic below is unit-tested with a fake.
// The KEK never crosses this boundary — only the (small) outer-layer key does.
export interface KmsClient {
  encrypt(input: { plaintext: Uint8Array; aad: Uint8Array }): Promise<Uint8Array>;
  decrypt(input: { ciphertext: Uint8Array; aad: Uint8Array }): Promise<Uint8Array>;
}

// HSM/KMS-backed provider (Phase 5, docs/18 §outer-layer): wrap/unwrap call the
// KMS, so the platform KEK is never in process memory. The stored nonce is empty
// (the KMS manages its own); currentKekId is the KMS key resource name, bound into
// the AAD so the binding survives even though the HSM holds the key.
export class KmsKekProvider implements KekProvider {
  constructor(
    private readonly kms: KmsClient,
    private readonly keyName: string,
  ) {}

  get currentKekId(): string {
    return this.keyName;
  }

  async wrap(plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedOuterKey> {
    const ciphertext = await this.kms.encrypt({ plaintext, aad });
    return { ciphertext, nonce: new Uint8Array(0) };
  }

  async unwrap(_kekId: string, wrapped: WrappedOuterKey, aad: Uint8Array): Promise<Uint8Array> {
    // The adapter is bound to one key; KMS selects the version from the ciphertext.
    // _kekId (the stored key name) is bound into `aad`, so a swapped column fails.
    return this.kms.decrypt({ ciphertext: wrapped.ciphertext, aad });
  }
}

const OUTER_PREFIX = 'outer_layer';

// Derive a KEK + its id from a base64 key. The id scheme is shared by every
// process that touches outer-layer keys (the API stores kek_id; the worker looks
// it up to apply a tier-move), so it MUST stay identical to the API config's
// resolver — the tier-move round-trip test fails loudly if they ever diverge.
export function toOuterLayerKek(b64: string): ServerKek {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('an outer-layer KEK must decode to 32 bytes');
  const key = new Uint8Array(raw);
  const id = `${OUTER_PREFIX}-` + createHash('sha256').update(key).digest('base64url').slice(0, 12);
  return { id, key };
}

// Build the outer-layer KEK ring from base64 env values, for the worker (which
// applies tier-moves). Returns an EMPTY ring if no current key — a worker without
// OUTER_LAYER_KEK simply cannot apply tier-moves (they error and retry), rather
// than minting a random key that could never match what the API sealed under.
export function resolveOuterLayerKekSet(current?: string, previous?: string): KekSet {
  const keks: ServerKek[] = [];
  if (current !== undefined && current !== '') keks.push(toOuterLayerKek(current));
  if (previous !== undefined && previous !== '') keks.push(toOuterLayerKek(previous));
  const byId = new Map<string, ServerKek>();
  for (const k of keks) byId.set(k.id, k);
  return { currentId: keks[0]?.id ?? '', byId };
}
