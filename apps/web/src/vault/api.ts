import type { ItemAadVersion } from '@truecairn/keys';
import type {
  VaultCategory,
  VaultTier,
  VaultItemDto,
  VaultListDto,
  VaultListItemDto,
} from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';
import { requestWithStepUp, type StepUpDeps } from '../api/stepup.js';
import { newItemId, rewrapItemForTier, wrapItem } from './crypto.js';

// These two shapes are NOT declared here. They are the shared wire contracts in
// packages/shared/src/contracts.ts, which the API's serializers are typed
// against — so a field the server stops sending stops compiling here too.
// Restating them locally is what let the list route drop `aadVersion` while this
// file went on promising it, and every vault title read "Title unavailable"
// (#171). The aliases keep the existing names at the ~20 call sites.
export type VaultListItem = VaultListItemDto;
export type FetchedItemDto = VaultItemDto;

export interface EnqueuedAction {
  sensitiveActionId: string;
  effectiveAt: string;
}

// Create — the client wraps BEFORE upload, so the request body is ciphertext only.
// Returns the server id + the wrapped per-item key the client just generated, so
// the caller can encrypt+upload attachments under the SAME key without a refetch
// (attach-at-creation). The wrapped key is not secret — it is exactly what
// getItem returns — so echoing it back to the caller crosses no boundary.
// The id is chosen HERE and sent, rather than assigned by the server: both AAD
// layers bind it, so it has to exist before anything is encrypted (F3). A
// collision is not a real concern at 122 bits of UUIDv4 entropy, and the server
// rejects a duplicate rather than overwriting.
export async function createItem(
  input: { tier: VaultTier; category: VaultCategory; title: string; content: string },
  fetchImpl?: typeof fetch,
): Promise<{ id: string; createdAt: string; wrappedPerItemKey: string; wrappedPerItemKeyNonce: string }> {
  const id = newItemId();
  const wrapped = wrapItem(id, input.tier, input.title, input.content);
  const res = await api('/v1/vault/items', {
    method: 'POST',
    body: { id, tier: input.tier, category: input.category, ...wrapped },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const created = await apiJson<{ id: string; createdAt: string }>(res);
  // Trust OUR id, not the echo. The AAD is bound to the id this client chose,
  // so if the server answers with a different one, following it would silently
  // hand every later read the wrong binding — attachments would fail to
  // decrypt and the cause would look like corruption. A mismatch means the
  // server is not doing what it was asked, so say so here rather than limp on.
  if (created.id !== id) {
    throw new Error('the server stored this item under a different id than the one it was sealed to');
  }
  return {
    id,
    createdAt: created.createdAt,
    wrappedPerItemKey: wrapped.wrappedPerItemKey,
    wrappedPerItemKeyNonce: wrapped.wrappedPerItemKeyNonce,
  };
}

export async function listItems(
  query: { tier?: VaultTier; category?: VaultCategory; includeDeleted?: boolean; cursor?: string } = {},
  fetchImpl?: typeof fetch,
): Promise<VaultListDto> {
  const params = new URLSearchParams();
  if (query.tier !== undefined) params.set('tier', query.tier);
  if (query.category !== undefined) params.set('category', query.category);
  if (query.includeDeleted === true) params.set('includeDeleted', 'true');
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await api(`/v1/vault/items${qs ? `?${qs}` : ''}`, {
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return apiJson(res);
}

export async function getItem(id: string, fetchImpl?: typeof fetch): Promise<FetchedItemDto> {
  const res = await api(`/v1/vault/items/${id}`, {
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return apiJson(res);
}

// Metadata patch (non-sensitive): category and/or the (re-encrypted) title.
export async function patchItemMetadata(
  id: string,
  fields: {
    category?: VaultCategory;
    titleCiphertext?: string;
    titleNonce?: string;
    // The owner's own display order. Non-sensitive by design and by route: this
    // PATCH carries no step-up and no cooldown, because rearranging a list is
    // not a change to who can reach what. The server STORES it and does not sort
    // by it (the list comes back updatedAt-first), so it is a client ordering —
    // which is what the column is named for.
    clientOrdinal?: number;
  },
  fetchImpl?: typeof fetch,
): Promise<void> {
  const res = await api(`/v1/vault/items/${id}`, {
    method: 'PATCH',
    body: fields,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  await apiJson(res);
}

// ── Sensitive flows (step-up + 7-day delay) ────────────────────────────────
// These return 202 with a pending sensitive-action id + effectiveAt; the UI must
// surface the pending state and never imply the change applied immediately.

export async function moveItemTier(
  input: {
    itemId: string;
    oldTier: VaultTier;
    newTier: VaultTier;
    aadVersion: ItemAadVersion;
    wrappedPerItemKey: string;
    wrappedPerItemKeyNonce: string;
    titleCiphertext: string;
    titleNonce: string;
  },
  deps: StepUpDeps,
): Promise<EnqueuedAction> {
  // Re-key BOTH things the old tier key protected — the per-item key and the
  // title — under the destination tier key. Sending only the key is what left
  // every moved item unreadable before 2026-08-09.
  //
  // Both are computed now, at enqueue, rather than at apply seven days later:
  // the worker holds no tier key and never will, so this is the only moment
  // either value can be produced.
  const rewrapped = rewrapItemForTier(input);
  const res = await requestWithStepUp(
    {
      url: '/v1/vault/items/tier',
      method: 'POST',
      body: { itemId: input.itemId, newTier: input.newTier, ...rewrapped },
    },
    deps,
  );
  return apiJson(res);
}

export async function deleteItem(itemId: string, deps: StepUpDeps): Promise<EnqueuedAction> {
  const res = await requestWithStepUp(
    { url: '/v1/vault/items/delete', method: 'POST', body: { itemId } },
    deps,
  );
  return apiJson(res);
}

export async function revertItem(itemId: string, deps: StepUpDeps): Promise<EnqueuedAction> {
  const res = await requestWithStepUp(
    { url: '/v1/vault/items/revert', method: 'POST', body: { itemId } },
    deps,
  );
  return apiJson(res);
}
