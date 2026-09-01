import { fromBase64, secretboxDecrypt, toBase64, wipe } from '@truecairn/crypto';
import { openSealedCapture, vaultCapturePublicKey } from '@truecairn/client-crypto';
import type { VaultTier } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';
import { coerceCategory } from './category.js';
import { createItem } from './api.js';
import { uploadAttachment } from './attachments.js';
import { ITEM_AAD_VERSION_CURRENT } from '@truecairn/keys';

// Progress reported while a capture is filed. A STRUCTURED value, not a rendered
// sentence: this module is not a component, so it cannot reach the translation
// catalog — and a string built here would be permanently English however the app
// is set. The caller renders it, which also means a language change mid-filing
// re-renders the line instead of freezing it.
export type FilingPhase =
  | { kind: 'opening' }
  | { kind: 'saving' }
  | { kind: 'reencrypting'; n: number; total: number }
  | { kind: 'clearing' };

// The browser half of write-only capture (docs/34). The phone seals; this files.
//
// Filing is the act that puts captured content under a TIER key and therefore
// into the release ladder — an unfiled capture is sealed to a master-derived key
// no ceremony reconstructs, so it can only ever be opened here (docs/34 D4).
// That is why the UI is direct about the queue rather than treating it as an
// inbox that can be ignored indefinitely.

const dec = new TextDecoder();
const MAGIC = 'TCCAP1';

export interface PendingCapture {
  id: string;
  tier: VaultTier;
  sizeBytes: number;
  createdAt: string;
}

interface CaptureEnvelopeDto {
  id: string;
  tier: VaultTier;
  sealedCaptureKey: string;
  payloadNonce: string;
  sizeBytes: number;
  createdAt: string;
}

export interface CaptureContents {
  title: string;
  category: string;
  content: string;
  attachments: Array<{ name: string; mime: string; bytes: Uint8Array }>;
}

// AAD binding the ciphertext to the tier the owner picked on the phone (docs/34
// §4). The tier is also a plaintext column, so without this a tampering server
// could relabel an S3 capture as S1 and have it file into the wrong tier; with
// it, relabeling breaks authentication and filing fails closed.
function captureAad(tier: VaultTier): Uint8Array {
  const index = { s1: 1, s2: 2, s3: 3 }[tier];
  return new Uint8Array([0x56, 0x43, index]); // 'V', 'C', tier
}

// Publish the owner's capture PUBLIC key. Called on every unlock: the derivation
// is deterministic, so the server treats a repeat as a no-op, and doing it every
// time means an account enrolled before capture existed heals itself the next
// time its owner unlocks rather than needing a migration that can't reach the
// master key.
export async function publishCaptureKey(fetchImpl?: typeof fetch): Promise<void> {
  const pubkey = vaultCapturePublicKey();
  await api('/v1/account/capture-key', {
    method: 'PUT',
    body: { vaultCapturePubkey: toBase64(pubkey) },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

// Set once the server has told us it does not serve captures at all
// (VAULT_CAPTURE_ENABLED off ⇒ the routes are not registered, docs/34).
//
// Remembered for the page's lifetime so the answer costs exactly one request
// rather than one per mount. A flag-off server will never grow a capture
// mid-session, so re-asking on every visit to the vault is work that cannot
// succeed — and it puts a recurring 404 in the network tab of a deployment where
// nothing is wrong.
let captureUnavailable = false;

export async function listCaptures(fetchImpl?: typeof fetch): Promise<PendingCapture[]> {
  if (captureUnavailable) return [];
  const res = await api('/v1/vault/captures', {
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  if (res.status === 404) {
    captureUnavailable = true;
    return [];
  }
  const { captures } = await apiJson<{ captures: PendingCapture[] }>(res);
  return captures;
}

// Test seam: the memo above is module state, which would otherwise leak between
// cases in the same file.
export function resetCaptureAvailability(): void {
  captureUnavailable = false;
}

// Open one capture: unseal its key, fetch the ciphertext, decrypt, parse.
export async function openCapture(
  id: string,
  fetchImpl?: typeof fetch,
): Promise<{ tier: VaultTier; contents: CaptureContents }> {
  const envelope = await apiJson<CaptureEnvelopeDto>(
    await api(`/v1/vault/captures/${id}`, { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }),
  );
  const bytesRes = await api(`/v1/vault/captures/${id}/bytes`, {
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const ciphertext = new Uint8Array(await bytesRes.arrayBuffer());

  const captureKey = openSealedCapture(fromBase64(envelope.sealedCaptureKey));
  try {
    const container = secretboxDecrypt({
      key: captureKey,
      nonce: fromBase64(envelope.payloadNonce),
      ciphertext,
      additionalData: captureAad(envelope.tier),
    });
    return { tier: envelope.tier, contents: parseContainer(container) };
  } finally {
    wipe(captureKey);
  }
}

// The container the phone built (docs/34 §4). Length-prefixed binary rather than
// JSON-with-base64: a 3 MB photo should cost 3 MB, not 4.
export function parseContainer(container: Uint8Array): CaptureContents {
  const magic = dec.decode(container.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('capture container: bad magic');
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const metaLen = view.getUint32(MAGIC.length, false);
  const metaStart = MAGIC.length + 4;
  const metaEnd = metaStart + metaLen;
  if (metaEnd > container.length) throw new Error('capture container: truncated metadata');

  const meta = JSON.parse(dec.decode(container.subarray(metaStart, metaEnd))) as {
    title?: unknown;
    category?: unknown;
    content?: unknown;
    attachments?: unknown;
  };
  const declared = Array.isArray(meta.attachments) ? meta.attachments : [];

  const attachments: CaptureContents['attachments'] = [];
  let offset = metaEnd;
  for (const raw of declared) {
    const a = raw as { name?: unknown; mime?: unknown; size?: unknown };
    const size = typeof a.size === 'number' ? a.size : 0;
    if (offset + size > container.length) throw new Error('capture container: truncated attachment');
    attachments.push({
      name: typeof a.name === 'string' ? a.name : 'attachment',
      mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
      bytes: container.subarray(offset, offset + size),
    });
    offset += size;
  }

  return {
    title: typeof meta.title === 'string' ? meta.title : '',
    // Both the missing case and the unknown-value case go through ONE rule.
    // 'general' used to sit here as the fallback, which was itself outside the
    // vocabulary — so a container with no category and a container from an old
    // client took different paths to the same silent rewrite. coerceCategory is
    // that rule, and it lands on personal_archive: the narrowest column docs/03
    // offers, which is where a category we cannot infer belongs.
    category: coerceCategory(typeof meta.category === 'string' ? meta.category : ''),
    content: typeof meta.content === 'string' ? meta.content : '',
    attachments,
  };
}

export async function discardCapture(id: string, fetchImpl?: typeof fetch): Promise<void> {
  await api(`/v1/vault/captures/${id}`, {
    method: 'DELETE',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

export interface FileResult {
  itemId: string;
  failedAttachments: string[];
}

// File one capture: open it, create a real vault item under a FRESH per-item key
// wrapped by the tier key, re-encrypt each attachment under that key, and delete
// the capture LAST.
//
// The capture key deliberately does not become the per-item key. It was
// generated on a phone and sealed in transit; the long-lived key a release
// ceremony will one day reconstruct is generated here, like every other item's.
//
// Delete-last makes filing resumable: a failure at any step leaves the capture in
// the queue. A duplicate item is visible and fixable; a lost capture is neither.
export async function fileCapture(
  capture: PendingCapture,
  onPhase?: (phase: FilingPhase) => void,
  fetchImpl?: typeof fetch,
): Promise<FileResult> {
  onPhase?.({ kind: 'opening' });
  const { tier, contents } = await openCapture(capture.id, fetchImpl);

  onPhase?.({ kind: 'saving' });
  const created = await createItem(
    { tier, category: coerceCategory(contents.category), title: contents.title, content: contents.content },
    fetchImpl,
  );

  const failedAttachments: string[] = [];
  if (contents.attachments.length > 0) {
    const itemKeyRef = {
      tier,
      id: created.id,
      aadVersion: ITEM_AAD_VERSION_CURRENT,
      wrappedPerItemKey: created.wrappedPerItemKey,
      wrappedPerItemKeyNonce: created.wrappedPerItemKeyNonce,
    };
    let n = 0;
    for (const a of contents.attachments) {
      n += 1;
      onPhase?.({ kind: 'reencrypting', n, total: contents.attachments.length });
      try {
        await uploadAttachment(
          created.id,
          itemKeyRef,
          { bytes: a.bytes, name: a.name, type: a.mime },
          fetchImpl,
        );
      } catch {
        failedAttachments.push(a.name);
      }
    }
  }

  // Only once the item and every file are safely stored.
  if (failedAttachments.length === 0) {
    onPhase?.({ kind: 'clearing' });
    await discardCapture(capture.id, fetchImpl);
  }
  return { itemId: created.id, failedAttachments };
}
