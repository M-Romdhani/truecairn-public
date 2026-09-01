import type { ItemAadVersion } from '@truecairn/keys';
import {
  fromBase64,
  randomSecretboxNonce,
  secretboxDecrypt,
  secretboxEncrypt,
  wipe,
} from '@truecairn/crypto';
import { withTierKey } from '@truecairn/client-crypto';
import { unwrapItemKey, type ItemKeyWrappedByTier } from '@truecairn/keys';
import type { VaultTier } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';

// Client-side encrypted attachments (QA 2026-07-17 issue #2 — the server half
// existed since Phase 3.3; this is the client half). Zero-knowledge holds by
// the same construction as item content: the file is encrypted under the
// PER-ITEM key (so, like the content, it survives tier moves untouched), and
// the filename + MIME type travel INSIDE the encrypted blob — the server
// stores an opaque byte string plus its size, nothing else.
//
// Blob layout (all client-side):
//   nonce(24) ‖ secretbox(itemKey, nonce, header_len(4 LE) ‖ header_json ‖ file)
//   header_json = {"name": string, "type": string}

const enc = new TextEncoder();
const dec = new TextDecoder();
const NONCE_LEN = 24;

interface ItemKeyRef {
  id: string;
  tier: VaultTier;
  aadVersion: ItemAadVersion;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
}

function withItemKey<T>(item: ItemKeyRef, fn: (itemKey: Uint8Array) => T): T {
  const itemKey = withTierKey(item.tier, (tierKey) =>
    unwrapItemKey(
      {
        ciphertext: fromBase64(item.wrappedPerItemKey),
        nonce: fromBase64(item.wrappedPerItemKeyNonce),
        tier: item.tier,
      } as ItemKeyWrappedByTier,
      tierKey,
      { version: item.aadVersion, itemId: item.id },
    ),
  );
  try {
    return fn(itemKey as unknown as Uint8Array);
  } finally {
    wipe(itemKey as unknown as Uint8Array);
  }
}

export function encryptAttachment(
  item: ItemKeyRef,
  fileBytes: Uint8Array,
  name: string,
  mimeType: string,
): Uint8Array {
  const header = enc.encode(JSON.stringify({ name, type: mimeType }));
  const payload = new Uint8Array(4 + header.length + fileBytes.length);
  new DataView(payload.buffer).setUint32(0, header.length, true);
  payload.set(header, 4);
  payload.set(fileBytes, 4 + header.length);
  try {
    return withItemKey(item, (itemKey) => {
      const nonce = randomSecretboxNonce();
      const ct = secretboxEncrypt({ key: itemKey, nonce, plaintext: payload });
      const blob = new Uint8Array(NONCE_LEN + ct.length);
      blob.set(nonce, 0);
      blob.set(ct, NONCE_LEN);
      return blob;
    });
  } finally {
    wipe(payload);
  }
}

export function decryptAttachment(
  item: ItemKeyRef,
  blob: Uint8Array,
): { name: string; type: string; bytes: Uint8Array } {
  if (blob.length <= NONCE_LEN) throw new Error('attachment blob too short');
  const nonce = blob.slice(0, NONCE_LEN);
  const ct = blob.slice(NONCE_LEN);
  const payload = withItemKey(item, (itemKey) =>
    secretboxDecrypt({ key: itemKey, nonce, ciphertext: ct }),
  );
  const headerLen = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
  if (4 + headerLen > payload.length) throw new Error('attachment header malformed');
  const header = JSON.parse(dec.decode(payload.slice(4, 4 + headerLen))) as {
    name?: unknown;
    type?: unknown;
  };
  return {
    name: typeof header.name === 'string' ? header.name : 'attachment',
    type: typeof header.type === 'string' ? header.type : 'application/octet-stream',
    bytes: payload.slice(4 + headerLen),
  };
}

// ── Transport (the two-step server contract) ─────────────────────────────────

export interface AttachmentSummary {
  id: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export async function uploadAttachment(
  itemId: string,
  item: ItemKeyRef,
  file: { bytes: Uint8Array; name: string; type: string },
  fetchImpl?: typeof fetch,
): Promise<AttachmentSummary> {
  const blob = encryptAttachment(item, file.bytes, file.name, file.type);
  // Step 1: reserve metadata with the CIPHERTEXT size (what the server stores).
  const createRes = await api(`/v1/vault/items/${itemId}/attachments`, {
    method: 'POST',
    body: { sizeBytes: blob.length },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const { attachmentId } = await apiJson<{ attachmentId: string }>(createRes);
  // Step 2: the bytes, as an opaque octet stream.
  const doFetch = fetchImpl ?? fetch;
  const putRes = await doFetch(`/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob as unknown as BodyInit,
  });
  const summary = await apiJson<{ attachmentId: string; sizeBytes: number }>(putRes);
  return {
    id: summary.attachmentId,
    sizeBytes: summary.sizeBytes,
    status: 'stored',
    createdAt: new Date().toISOString(),
  };
}

export async function downloadAttachment(
  itemId: string,
  attachmentId: string,
  item: ItemKeyRef,
  fetchImpl?: typeof fetch,
): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const res = await api(
    `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
    fetchImpl !== undefined ? { fetchImpl } : {},
  );
  if (!res.ok) throw new Error(`attachment download failed (${res.status})`);
  const blob = new Uint8Array(await res.arrayBuffer());
  return decryptAttachment(item, blob);
}
