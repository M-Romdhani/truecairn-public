import type { ItemAadVersion } from '@truecairn/keys';
import { signContactChallenge } from '@truecairn/client-crypto';
import { fromBase64Url, toBase64 } from '@truecairn/crypto';
import { api, apiJson } from '../api/client.js';

// Contact-facing release-ceremony client (CEREMONY_COMPLETION Bridge 3). All calls
// run on the contact's OWN session; affirm carries the C4 Ed25519 possession proof.

export interface CeremonyListItem {
  ceremonyId: string;
  tier: string;
  status: string;
  // null for a designated beneficiary (backlog #2) — they receive without
  // affirming, so they have a recipient row but no affirmation.
  myAffirmation: string | null;
  // MY affirmation's change-your-mind deadline while it is tentative
  // (QA 2026-07-21 D5) — null before affirming and for beneficiaries.
  myRevocationWindowExpiresAt: string | null;
  // MY recipient row's progress — 'released' once THIS contact reconstructed.
  myRecipientStatus: string;
}

export interface ReleasedItem {
  id: string;
  aadVersion: ItemAadVersion;
  contentCiphertext: string;
  contentNonce: string;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
}

export async function listCeremonies(fetchImpl?: typeof fetch): Promise<{ ceremonies: CeremonyListItem[] }> {
  return apiJson(await api('/v1/ceremonies', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

// Affirm: prove possession of the contact-affirmation key (the C4 Ed25519 key)
// over a server challenge, then submit. The signed message is
// (challenge || ceremonyId) so the proof is bound to THIS ceremony and can never
// be replayed against another. Sets the affirmation tentative.
export async function affirmCeremony(ceremonyId: string, fetchImpl?: typeof fetch): Promise<void> {
  const opt = await apiJson<{ challengeId: string; challenge: string }>(
    await api(`/v1/ceremonies/${ceremonyId}/affirm/options`, {
      method: 'POST',
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
  const challenge = fromBase64Url(opt.challenge);
  const idBytes = new TextEncoder().encode(ceremonyId);
  const message = new Uint8Array(challenge.length + idBytes.length);
  message.set(challenge);
  message.set(idBytes, challenge.length);
  const signature = signContactChallenge(message);
  await apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/affirm`, {
      method: 'POST',
      body: { challengeId: opt.challengeId, signature: toBase64(signature) },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Revoke a still-tentative affirmation — "any choice can be undone".
export async function revokeCeremony(ceremonyId: string, fetchImpl?: typeof fetch): Promise<void> {
  await apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/revoke`, {
      method: 'POST',
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Dispute: "the owner is alive" — aborts the release and pushes the engine to
// review. The strongest protective action a contact holds.
export async function disputeCeremony(ceremonyId: string, fetchImpl?: typeof fetch): Promise<void> {
  await apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/dispute`, {
      method: 'POST',
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function getS1Envelope(
  ceremonyId: string,
  fetchImpl?: typeof fetch,
): Promise<{ sealedBoxCiphertext: string }> {
  return apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/s1-envelope`, {
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function getReleasedItems(
  ceremonyId: string,
  fetchImpl?: typeof fetch,
): Promise<{ items: ReleasedItem[] }> {
  return apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/released-items`, {
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function reportReconstructed(ceremonyId: string, fetchImpl?: typeof fetch): Promise<void> {
  await apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/reconstructed`, {
      method: 'POST',
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// ── S2/S3 Shamir share collection (Checkpoint B) ────────────────────────────

export interface SealContext {
  affirmationId: string;
  tier: 's2' | 's3';
  wrappedShareCiphertext: string;
  recipients: Array<{ recipientContactId: string; ephemeralPubkey: string }>;
  sealedTo: string[];
}

export interface SharesResponse {
  tier: 's2' | 's3';
  threshold: number;
  generation: number;
  tierKeyCheck: { plaintext: string; ciphertext: string; nonce: string };
  shares: Array<{
    affirmationId: string;
    contactId: string;
    sealedShareCiphertext: string;
    shareSignature: string;
  }>;
}

export async function registerRecipientEphemeral(
  ceremonyId: string,
  ephemeralPubkeyB64: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/recipient/ephemeral`, {
      method: 'POST',
      body: { ephemeralPubkey: ephemeralPubkeyB64 },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function getSealContext(ceremonyId: string, fetchImpl?: typeof fetch): Promise<SealContext> {
  return apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/seal-context`, {
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function postSealedShare(
  ceremonyId: string,
  body: { recipientContactId: string; sealedShareCiphertext: string; shareSignature: string },
  fetchImpl?: typeof fetch,
): Promise<void> {
  await apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/seal-share`, {
      method: 'POST',
      body,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function getShares(ceremonyId: string, fetchImpl?: typeof fetch): Promise<SharesResponse> {
  return apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/shares`, {
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// The owner's release-passphrase KDF salt — fetched ONLY when the recipient
// chooses the release-passphrase fallback (a contact is missing). Gated server-
// side to reconstructing + a committed affirmer. The salt is non-secret; the
// passphrase that combines with it is never sent.
export async function getReleaseSalt(
  ceremonyId: string,
  fetchImpl?: typeof fetch,
): Promise<{ releasePassphraseSalt: string }> {
  return apiJson(
    await api(`/v1/ceremonies/${ceremonyId}/release-salt`, {
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}
