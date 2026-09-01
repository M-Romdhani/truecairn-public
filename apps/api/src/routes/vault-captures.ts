import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { schema, type Database } from '@truecairn/db';
import { VAULT_TIERS, type UserId, type VaultTier } from '@truecairn/shared';
import { blobKey, releaseUserStorage, reserveUserStorage, type BlobStore } from '@truecairn/vault';
import { and, asc, eq, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireSession } from '../auth/session.js';
import { assertCanAddVaultItem, storageCapBytes } from '../billing/limits.js';
import type { ApiConfig } from '../config.js';
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { STALE_UPLOAD_CLAIM_MS } from '../upload-windows.js';
import { assertVaultWritable } from '../vault/engine-gate.js';
import { requireVaultOwner } from './vault.js';

// Write-only vault capture (docs/34). The phone seals a new item to the owner's
// X25519 capture PUBLIC key; the owner opens and files it in the browser, where
// the master key is.
//
// Everything here is transport. The server holds a sealed key it cannot open, a
// nonce, a tier, and an opaque byte stream — the same standard as the rest of
// the vault. There is deliberately NO route that returns a capture's plaintext,
// because there is no plaintext here to return.
//
// Registered only when VAULT_CAPTURE_ENABLED is on: flags-off is byte-for-byte
// pre-capture, and a 404 from an unregistered route is a more honest answer to a
// phone than a 403 from a live one.

const CAPTURE_TOO_LARGE_TYPE = 'https://truecairn.app/problems/vault-capture-too-large';
const NO_CAPTURE_KEY_TYPE = 'https://truecairn.app/problems/vault-capture-key-missing';
const CAPTURE_KEY_CONFLICT_TYPE = 'https://truecairn.app/problems/vault-capture-key-conflict';
const QUOTA_TYPE = 'https://truecairn.app/problems/vault-storage-quota-exceeded';

const LENGTH_REQUIRED_TYPE = 'https://truecairn.app/problems/vault-content-length-required';

const uuidStr = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const;

// 80 bytes sealed (32 ephemeral pubkey + 32 key + 16 tag) and a 24-byte nonce,
// both base64. Bounded tightly: these are fixed-size values, so a generous limit
// would only ever admit something malformed.
const b64Sealed = { type: 'string', minLength: 1, maxLength: 256 } as const;
const b64Nonce = { type: 'string', minLength: 1, maxLength: 64 } as const;

const SEALED_CAPTURE_KEY_BYTES = 80;
const PAYLOAD_NONCE_BYTES = 24;
const X25519_PUBLIC_KEY_BYTES = 32;

const dec = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const enc = (b: Uint8Array): string => Buffer.from(b).toString('base64');

// Captures share the attachment blob namespace: both are opaque client-encrypted
// streams keyed by (userId, rowId), and both ids are UUIDs from the same
// generator, so they cannot collide.
const captureBlobKey = (userId: string, captureId: string): string => blobKey(userId, captureId);

export function vaultCaptureRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const store = config.blobStore;
  const limits = config.vaultLimits;
  const owner = requireVaultOwner(db);
  const writableGate = async (request: FastifyRequest): Promise<void> => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    await assertVaultWritable(db, session.userId);
  };

  // The octet-stream parser is registered by vaultAttachmentRoutes, which always
  // mounts alongside this module. Re-registering would throw at boot.

  // ── The phone fetches the owner's capture public key ───────────────────────
  app.get(
    '/v1/vault/capture-key',
    { preHandler: [requireSession, owner] },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const [km] = await db
        .select({ pubkey: schema.userKeyMaterial.vaultCapturePubkey })
        .from(schema.userKeyMaterial)
        .where(eq(schema.userKeyMaterial.userId, session.userId))
        .limit(1);
      // Accounts enrolled before capture existed have no key until the owner
      // unlocks on the web once. That is a real state with a real remedy, so it
      // gets its own problem type rather than a 404 the client has to guess at.
      if (km?.pubkey == null) {
        throw new ApiError(
          409,
          'No capture key',
          'this account has not published a vault capture key yet; unlock the vault on the web once to publish it',
          NO_CAPTURE_KEY_TYPE,
        );
      }
      return { vaultCapturePubkey: enc(km.pubkey), maxCaptureBytes: limits.maxCaptureBytes };
    },
  );

  // ── Create a capture (metadata; bytes follow) ──────────────────────────────
  app.post(
    '/v1/vault/captures',
    {
      preHandler: [requireSession, owner, writableGate],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tier', 'sealedCaptureKey', 'payloadNonce', 'sizeBytes'],
          properties: {
            tier: { type: 'string', enum: [...VAULT_TIERS] },
            sealedCaptureKey: b64Sealed,
            payloadNonce: b64Nonce,
            sizeBytes: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const body = request.body as {
        tier: VaultTier;
        sealedCaptureKey: string;
        payloadNonce: string;
        sizeBytes: number;
      };

      if (body.sizeBytes > limits.maxCaptureBytes) {
        throw new ApiError(
          413,
          'Capture too large',
          `a capture may not exceed ${limits.maxCaptureBytes} bytes`,
          CAPTURE_TOO_LARGE_TYPE,
        );
      }
      const sealed = dec(body.sealedCaptureKey);
      const nonce = dec(body.payloadNonce);
      // Fixed-size crypto values. Wrong lengths mean a client bug or a probe;
      // either way the row would be undecryptable, so refuse before storing it.
      if (sealed.length !== SEALED_CAPTURE_KEY_BYTES) {
        throw badRequest(`sealedCaptureKey must be ${SEALED_CAPTURE_KEY_BYTES} bytes`);
      }
      if (nonce.length !== PAYLOAD_NONCE_BYTES) {
        throw badRequest(`payloadNonce must be ${PAYLOAD_NONCE_BYTES} bytes`);
      }

      // A capture is an item-in-waiting, so it meets the same plan cap.
      await assertCanAddVaultItem(db, session.userId, new Date());

      const [row] = await db
        .insert(schema.vaultCaptures)
        .values({
          userId: session.userId,
          tier: body.tier,
          sealedCaptureKey: sealed,
          payloadNonce: nonce,
          sizeBytes: body.sizeBytes,
          status: 'pending_upload',
          storagePath: 'pending',
        })
        .returning({ id: schema.vaultCaptures.id });
      if (!row) throw new Error('vault_captures insert returned no row');
      await db
        .update(schema.vaultCaptures)
        .set({ storagePath: captureBlobKey(session.userId, row.id) })
        .where(eq(schema.vaultCaptures.id, row.id));

      void reply.status(201);
      return { id: row.id, status: 'pending_upload' };
    },
  );

  // ── Upload the sealed bytes (streamed) ─────────────────────────────────────
  app.put(
    '/v1/vault/captures/:id/bytes',
    {
      preHandler: [requireSession, owner, writableGate],
      bodyLimit: limits.maxCaptureBytes,
      schema: { params: { type: 'object', required: ['id'], properties: { id: uuidStr } } },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      const capture = await loadOwnedCapture(db, session.userId, id);
      if (!capture) throw notFound('capture not found');
      if (capture.status === 'stored') throw conflict('capture bytes already uploaded');

      const cl = Number(request.headers['content-length']);
      if (!Number.isInteger(cl) || cl <= 0) {
        throw new ApiError(411, 'Length Required', 'a Content-Length is required', LENGTH_REQUIRED_TYPE);
      }
      if (cl !== capture.sizeBytes) {
        throw badRequest('Content-Length must equal the declared sizeBytes');
      }
      if (cl > limits.maxCaptureBytes) {
        throw new ApiError(413, 'Capture too large', 'exceeds the per-capture limit', CAPTURE_TOO_LARGE_TYPE);
      }

      // Status-guarded claim before reserving or writing (2026-08-07 audit,
      // finding 2 — the same TOCTOU as the attachment path, verbatim). Two
      // concurrent PUTs both passed the read above, both reserved `cl` bytes, and
      // both streamed into the same blob key. See routes/vault-attachments.ts for
      // the full reasoning; this is the identical fix on the sibling route,
      // including the claim TOKEN that makes the re-assert below able to tell our
      // claim from a takeover (2026-08-08 re-audit, N-2).
      const claimToken = randomUUID();
      const claimedAt = new Date();
      const claimed = await db
        .update(schema.vaultCaptures)
        .set({ status: 'uploading', uploadClaim: claimToken, updatedAt: claimedAt })
        .where(
          and(
            eq(schema.vaultCaptures.id, id),
            eq(schema.vaultCaptures.userId, session.userId),
            or(
              eq(schema.vaultCaptures.status, 'pending_upload'),
              and(
                eq(schema.vaultCaptures.status, 'uploading'),
                lt(
                  schema.vaultCaptures.updatedAt,
                  new Date(claimedAt.getTime() - STALE_UPLOAD_CLAIM_MS),
                ),
              ),
            ),
          ),
        )
        .returning({ id: schema.vaultCaptures.id });
      if (claimed.length === 0) {
        throw conflict('an upload for this capture is already in progress');
      }

      const capBytes = await storageCapBytes(
        db,
        session.userId,
        new Date(),
        limits.maxUserTotalBytes,
      );
      const reserved = await reserveUserStorage(db, session.userId, cl, capBytes);
      if (!reserved) {
        // Nothing reserved, nothing read — hand OUR slot straight back.
        await db
          .update(schema.vaultCaptures)
          .set({ status: 'pending_upload', uploadClaim: null, updatedAt: new Date() })
          .where(
            and(
              eq(schema.vaultCaptures.id, id),
              eq(schema.vaultCaptures.uploadClaim, claimToken),
            ),
          );
        throw new ApiError(
          413,
          'Storage quota exceeded',
          'this capture would exceed your plan storage quota',
          QUOTA_TYPE,
        );
      }

      const key = captureBlobKey(session.userId, id);
      let bytesWritten: number;
      try {
        ({ bytesWritten } = await store.put(key, request.body as Readable, cl));
      } catch (err) {
        await rollbackCapture(db, store, session.userId, id, cl, claimToken);
        throw err;
      }
      if (bytesWritten !== cl) {
        await rollbackCapture(db, store, session.userId, id, cl, claimToken);
        throw badRequest('uploaded byte count did not match Content-Length');
      }
      // By TOKEN, not by status — 'uploading' is also what a takeover writes, so
      // the old predicate matched for a writer whose slot had been stolen.
      const stored = await db
        .update(schema.vaultCaptures)
        .set({ status: 'stored', uploadClaim: null, updatedAt: new Date() })
        .where(
          and(eq(schema.vaultCaptures.id, id), eq(schema.vaultCaptures.uploadClaim, claimToken)),
        )
        .returning({ id: schema.vaultCaptures.id });
      if (stored.length === 0) {
        // Claim taken over after the stale window; give back the reservation and
        // leave the blob to whoever holds the slot now.
        await releaseUserStorage(db, session.userId, cl);
        throw conflict('this upload was superseded by another for the same capture');
      }
      return { id, status: 'stored', sizeBytes: cl };
    },
  );

  // ── The filing queue ───────────────────────────────────────────────────────
  app.get('/v1/vault/captures', { preHandler: [requireSession, owner] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    // Oldest first: filing is a queue, and the thing waiting longest is the thing
    // that has been outside the release ladder longest (docs/34 D4).
    const rows = await db
      .select()
      .from(schema.vaultCaptures)
      .where(
        and(
          eq(schema.vaultCaptures.userId, session.userId),
          eq(schema.vaultCaptures.status, 'stored'),
        ),
      )
      .orderBy(asc(schema.vaultCaptures.createdAt));
    return {
      captures: rows.map((r) => ({
        id: r.id,
        tier: r.tier,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // ── One capture's sealed key + nonce (the web opens it from here) ──────────
  app.get(
    '/v1/vault/captures/:id',
    {
      preHandler: [requireSession, owner],
      schema: { params: { type: 'object', required: ['id'], properties: { id: uuidStr } } },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      const capture = await loadOwnedCapture(db, session.userId, id);
      if (!capture || capture.status !== 'stored') throw notFound('capture not found');
      return {
        id: capture.id,
        tier: capture.tier,
        sealedCaptureKey: enc(capture.sealedCaptureKey),
        payloadNonce: enc(capture.payloadNonce),
        sizeBytes: capture.sizeBytes,
        createdAt: capture.createdAt.toISOString(),
      };
    },
  );

  // ── The sealed bytes (streamed) ────────────────────────────────────────────
  //
  // Note what this is NOT: a read path into the vault. It returns the ciphertext
  // the sender produced, to a client that may or may not be able to open it. The
  // phone can call this and learn nothing — it holds no capture secret key.
  app.get(
    '/v1/vault/captures/:id/bytes',
    {
      preHandler: [requireSession, owner],
      schema: { params: { type: 'object', required: ['id'], properties: { id: uuidStr } } },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      const capture = await loadOwnedCapture(db, session.userId, id);
      if (!capture || capture.status !== 'stored') throw notFound('capture bytes not found');
      const blob = await store.get(captureBlobKey(session.userId, id));
      if (!blob) throw notFound('capture bytes not found');
      void reply.header('content-type', 'application/octet-stream');
      void reply.header('content-length', blob.sizeBytes);
      return reply.send(blob.stream);
    },
  );

  // ── Discard (also the last step of filing) ─────────────────────────────────
  //
  // No step-up and no cooldown, unlike deleting a vault ITEM. A capture is not
  // yet part of the vault: it has never been under a tier key, has never been
  // reachable by a release, and the owner is discarding something they are
  // looking at. Making it a sensitive action would put a 7-day delay on tidying
  // up a mis-scan.
  app.delete(
    '/v1/vault/captures/:id',
    {
      preHandler: [requireSession, owner],
      schema: { params: { type: 'object', required: ['id'], properties: { id: uuidStr } } },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      const capture = await loadOwnedCapture(db, session.userId, id);
      if (!capture) throw notFound('capture not found');

      // Row first, blob second: the row is the durable state. A crash between the
      // two leaves an orphaned blob (recoverable, invisible) rather than a row
      // pointing at bytes that are gone (a filing queue entry that always fails).
      await db.delete(schema.vaultCaptures).where(eq(schema.vaultCaptures.id, id));
      if (capture.status === 'stored') {
        await releaseUserStorage(db, session.userId, capture.sizeBytes);
      }
      await store.delete(captureBlobKey(session.userId, id)).catch(() => undefined);
      void reply.status(204);
      return null;
    },
  );
}

// ── The owner publishes the capture public key (from the web, on unlock) ──────
//
// Separate from vaultCaptureRoutes because it is NOT behind the capture flag:
// the key is a public value derived deterministically from the master key, and
// publishing it early means that flipping the flag on later does not strand
// every account behind a "unlock on the web once" step it could have taken care
// of already.
export function vaultCaptureKeyRoutes(app: FastifyInstance, db: Database): void {
  app.put(
    '/v1/account/capture-key',
    {
      preHandler: [requireSession],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['vaultCapturePubkey'],
          properties: { vaultCapturePubkey: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { vaultCapturePubkey } = request.body as { vaultCapturePubkey: string };
      const pubkey = dec(vaultCapturePubkey);
      if (pubkey.length !== X25519_PUBLIC_KEY_BYTES) {
        throw badRequest(`vaultCapturePubkey must be ${X25519_PUBLIC_KEY_BYTES} bytes`);
      }

      const [km] = await db
        .select({ existing: schema.userKeyMaterial.vaultCapturePubkey })
        .from(schema.userKeyMaterial)
        .where(eq(schema.userKeyMaterial.userId, session.userId))
        .limit(1);
      if (km === undefined) throw notFound('no key material provisioned for this account');

      if (km.existing != null) {
        // The derivation is deterministic, so the SAME key from a second browser
        // is the normal case and must be a no-op. A DIFFERENT key means the
        // master key changed underneath us; accepting it would silently strand
        // every capture already sealed to the old one, so it fails closed.
        if (Buffer.from(km.existing).equals(Buffer.from(pubkey))) {
          void reply.status(204);
          return null;
        }
        throw new ApiError(
          409,
          'Capture key conflict',
          'a different vault capture key is already published for this account',
          CAPTURE_KEY_CONFLICT_TYPE,
        );
      }

      await db
        .update(schema.userKeyMaterial)
        .set({ vaultCapturePubkey: pubkey, updatedAt: new Date() })
        .where(eq(schema.userKeyMaterial.userId, session.userId));
      void reply.status(204);
      return null;
    },
  );
}

async function loadOwnedCapture(
  db: Database,
  userId: UserId,
  id: string,
): Promise<typeof schema.vaultCaptures.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(schema.vaultCaptures)
    .where(and(eq(schema.vaultCaptures.id, id), eq(schema.vaultCaptures.userId, userId)))
    .limit(1);
  return row ?? null;
}

// Undo a failed upload: release the budget, drop any partial blob, and leave the
// row in pending_upload so the client can retry the same capture id.
// Token-guarded, exactly as rollbackUpload is and for the same reason — see
// routes/vault-attachments.ts.
async function rollbackCapture(
  db: Database,
  store: BlobStore,
  userId: UserId,
  captureId: string,
  bytes: number,
  claimToken: string,
): Promise<void> {
  // Hand the upload slot back so the owner can retry immediately. Before the
  // claim existed this row simply stayed 'pending_upload'; now it is 'uploading'
  // and would sit stuck for the stale window without this.
  const released = await db
    .update(schema.vaultCaptures)
    .set({ status: 'pending_upload', uploadClaim: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.vaultCaptures.id, captureId),
        eq(schema.vaultCaptures.uploadClaim, claimToken),
      ),
    )
    .returning({ id: schema.vaultCaptures.id });
  // Our reservation goes back either way; the blob and the row only if the slot
  // is still ours.
  await releaseUserStorage(db, userId, bytes);
  if (released.length === 0) return;
  await store.delete(captureBlobKey(userId, captureId)).catch(() => undefined);
}
