import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { schema, type Database } from '@truecairn/db';
import { DbChannelLookup } from '@truecairn/engine';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import type { UserId, VaultAttachmentDto } from '@truecairn/shared';
import { blobKey, releaseUserStorage, reserveUserStorage, type BlobStore } from '@truecairn/vault';
import { and, eq, inArray, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { storageCapBytes } from '../billing/limits.js';
import { requireSession } from '../auth/session.js';
import { requireStepUp } from '../auth/stepup.js';
import type { ApiConfig } from '../config.js';
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { STALE_UPLOAD_CLAIM_MS } from '../upload-windows.js';
import { assertVaultWritable, noteOwnerReadAccess } from '../vault/engine-gate.js';
import { requireVaultOwner, stepUpLinkage } from './vault.js';

const QUOTA_TYPE = 'https://truecairn.app/problems/vault-storage-quota-exceeded';
const TOO_LARGE_TYPE = 'https://truecairn.app/problems/vault-attachment-too-large';
const LENGTH_REQUIRED_TYPE = 'https://truecairn.app/problems/vault-content-length-required';

const uuidStr = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const;

// Derived from the request-arrival timeout so a claim can only go stale after the
// request holding it is provably dead — see upload-windows.ts for why that
// relationship, not the number, is the safety property.

export function vaultAttachmentRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const store = config.blobStore;
  const limits = config.vaultLimits;
  const channels = new DbChannelLookup(db);
  const owner = requireVaultOwner(db);
  const writableGate = async (request: FastifyRequest): Promise<void> => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    await assertVaultWritable(db, session.userId);
  };

  // Streaming upload parser: hand the raw request stream to the handler as the
  // body WITHOUT buffering, so a 100 MiB blob never materialises in memory. Limit
  // enforcement is the handler's job (Content-Length pre-check + the streaming
  // reader), not bodyLimit. Registered once; only the bytes route sends octet-stream.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  // ── Create attachment metadata (step 1 of 2) ───────────────────────────────
  app.post(
    '/v1/vault/items/:id/attachments',
    {
      preHandler: [requireSession, owner, writableGate],
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuidStr } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sizeBytes'],
          properties: { sizeBytes: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id: itemId } = request.params as { id: string };
      const { sizeBytes } = request.body as { sizeBytes: number };
      if (sizeBytes > limits.maxAttachmentBytes) {
        throw new ApiError(
          413,
          'Attachment too large',
          `attachment exceeds the ${limits.maxAttachmentBytes}-byte per-file limit`,
          TOO_LARGE_TYPE,
        );
      }
      const item = await loadOwnedItem(db, session.userId, itemId);
      if (!item) throw notFound('vault item not found');

      const [row] = await db
        .insert(schema.attachments)
        .values({
          vaultItemId: itemId,
          userId: session.userId,
          sizeBytes,
          status: 'pending_upload',
          // Placeholder; the real path is deterministic from (userId, id). Stored
          // for forensics / future relocation (Phase 5 object-store migration).
          storagePath: 'local',
        })
        .returning({ id: schema.attachments.id });
      if (!row) throw new Error('attachments insert returned no row');
      await db
        .update(schema.attachments)
        .set({ storagePath: blobKey(session.userId, row.id) })
        .where(eq(schema.attachments.id, row.id));
      void reply.status(201);
      return { attachmentId: row.id, status: 'pending_upload' };
    },
  );

  // ── Upload the bytes (step 2 of 2; streamed) ───────────────────────────────
  app.put(
    '/v1/vault/items/:id/attachments/:attachmentId/bytes',
    {
      preHandler: [requireSession, owner, writableGate],
      // bodyLimit caps a lying Content-Length at the per-attachment ceiling before
      // the handler; the per-user budget is the handler's atomic check.
      bodyLimit: limits.maxAttachmentBytes,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'attachmentId'],
          properties: { id: uuidStr, attachmentId: uuidStr },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id: itemId, attachmentId } = request.params as { id: string; attachmentId: string };
      const att = await loadOwnedAttachment(db, session.userId, attachmentId);
      if (!att || att.vaultItemId !== itemId) throw notFound('attachment not found');
      if (att.status === 'stored') throw conflict('attachment bytes already uploaded');

      // Content-Length must be present, match the declared size, and fit the cap —
      // all checked BEFORE a single byte is read from the socket.
      const cl = Number(request.headers['content-length']);
      if (!Number.isInteger(cl) || cl <= 0) {
        throw new ApiError(411, 'Length Required', 'a Content-Length is required', LENGTH_REQUIRED_TYPE);
      }
      if (cl !== att.sizeBytes) {
        throw badRequest('Content-Length must equal the declared sizeBytes');
      }
      if (cl > limits.maxAttachmentBytes) {
        throw new ApiError(413, 'Attachment too large', 'exceeds the per-file limit', TOO_LARGE_TYPE);
      }

      // Claim the upload slot with a STATUS-GUARDED update before reserving or
      // writing anything (2026-08-07 security audit, finding 2). The check at the
      // top of this handler read outside any transaction, so two concurrent PUTs
      // both passed it: both reserved `cl` bytes (charging 2N for N, permanently —
      // the purge path releases the size once), and both opened a write stream on
      // the SAME blob key and interleaved into one file. Each stream's own
      // bytesWritten equalled cl, so the integrity check below passed for both and
      // neither rolled back. The result was a silently corrupted attachment, which
      // for opaque client-encrypted ciphertext is undetectable until a beneficiary
      // tries to open it — possibly decades later, when the owner cannot re-upload.
      //
      // Same compare-and-swap the ceremony routes use and explain
      // (routes/ceremonies.ts, the 'pending' re-assert). The loser gets zero rows
      // and a 409 rather than a second reservation.
      //
      // The claim carries a TOKEN, not just a status (2026-08-08 re-audit, N-2).
      // 'uploading' is written by the original claim AND by a takeover, so it
      // cannot identify WHICH request holds the slot; every write below that
      // must only affect our own claim predicates on this uuid instead.
      const claimToken = randomUUID();
      const claimedAt = new Date();
      const claimed = await db
        .update(schema.attachments)
        .set({ status: 'uploading', uploadClaim: claimToken, updatedAt: claimedAt })
        .where(
          and(
            eq(schema.attachments.id, attachmentId),
            eq(schema.attachments.userId, session.userId),
            or(
              // 'failed' is claimable so a rolled-back upload can be retried,
              // which is why the pre-check above rejects only 'stored'.
              inArray(schema.attachments.status, ['pending_upload', 'failed']),
              and(
                eq(schema.attachments.status, 'uploading'),
                lt(
                  schema.attachments.updatedAt,
                  new Date(claimedAt.getTime() - STALE_UPLOAD_CLAIM_MS),
                ),
              ),
            ),
          ),
        )
        .returning({ id: schema.attachments.id });
      if (claimed.length === 0) {
        throw conflict('an upload for this attachment is already in progress');
      }

      // Atomic per-user budget reservation, against the PLAN's storage cap
      // (docs/28 — Free is a small budget, Personal much larger) clamped to any
      // global operator ceiling. On a 413 here NOTHING has been read or written —
      // the stream is only opened after the reservation succeeds.
      const capBytes = await storageCapBytes(
        db,
        session.userId,
        new Date(),
        limits.maxUserTotalBytes,
      );
      const reserved = await reserveUserStorage(db, session.userId, cl, capBytes);
      if (!reserved) {
        // Release the claim: nothing was reserved and no byte was read, so the
        // attachment is still simply awaiting its upload. Leaving it 'uploading'
        // would strand it for the stale window over a quota message. Token-guarded
        // like every other write here — hand back OUR slot, never someone else's.
        await db
          .update(schema.attachments)
          .set({ status: 'pending_upload', uploadClaim: null, updatedAt: new Date() })
          .where(
            and(
              eq(schema.attachments.id, attachmentId),
              eq(schema.attachments.uploadClaim, claimToken),
            ),
          );
        throw new ApiError(
          413,
          'Storage quota exceeded',
          'this upload would exceed your plan storage quota',
          QUOTA_TYPE,
        );
      }

      // The store streams the body to the backend (local disk or S3) with
      // backpressure — a fast client can't balloon memory. On any failure we roll
      // back the reservation + remove a partial blob.
      const key = blobKey(session.userId, attachmentId);
      let bytesWritten: number;
      try {
        ({ bytesWritten } = await store.put(key, request.body as Readable, cl));
      } catch (err) {
        await rollbackUpload(db, store, session.userId, attachmentId, cl, claimToken);
        throw err;
      }
      if (bytesWritten !== cl) {
        await rollbackUpload(db, store, session.userId, attachmentId, cl, claimToken);
        throw badRequest('uploaded byte count did not match Content-Length');
      }
      // Re-assert the claim on the terminal write, BY TOKEN. The earlier version
      // of this re-asserted `status = 'uploading'`, which a takeover also writes —
      // so it matched for a writer whose slot had been stolen and published OUR
      // bytes under THEIR reservation, the exact case the re-assert was for
      // (2026-08-08 re-audit, N-2). Clearing the token on success leaves a stored
      // row with no stale claim on it.
      const stored = await db
        .update(schema.attachments)
        .set({ status: 'stored', uploadClaim: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.attachments.id, attachmentId),
            eq(schema.attachments.uploadClaim, claimToken),
          ),
        )
        .returning({ id: schema.attachments.id });
      if (stored.length === 0) {
        // We lost the claim. Give back what we reserved and let the holder finish;
        // do NOT delete the blob, which is theirs to overwrite.
        await releaseUserStorage(db, session.userId, cl);
        throw conflict('this upload was superseded by another for the same attachment');
      }
      return { attachmentId, status: 'stored', sizeBytes: cl };
    },
  );

  // ── Download the bytes (streamed) ──────────────────────────────────────────
  app.get(
    '/v1/vault/items/:id/attachments/:attachmentId/bytes',
    {
      preHandler: [requireSession, owner],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'attachmentId'],
          properties: { id: uuidStr, attachmentId: uuidStr },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id: itemId, attachmentId } = request.params as { id: string; attachmentId: string };
      const att = await loadOwnedAttachment(db, session.userId, attachmentId);
      if (!att || att.vaultItemId !== itemId || att.status !== 'stored') {
        throw notFound('attachment bytes not found');
      }
      // An owner read during a release state is a liveness signal — pause the ladder.
      const audit = app.audit;
      if (audit !== null) {
        await noteOwnerReadAccess({ db, audit, channels, now: new Date() }, session.userId);
      }
      const blob = await store.get(blobKey(session.userId, attachmentId));
      if (!blob) throw notFound('attachment bytes not found');
      void reply.header('content-type', 'application/octet-stream');
      void reply.header('content-length', blob.sizeBytes);
      return reply.send(blob.stream);
    },
  );

  // ── Attachment metadata ────────────────────────────────────────────────────
  app.get(
    '/v1/vault/items/:id/attachments/:attachmentId',
    {
      preHandler: [requireSession, owner],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'attachmentId'],
          properties: { id: uuidStr, attachmentId: uuidStr },
        },
      },
    },
    async (request): Promise<VaultAttachmentDto> => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id: itemId, attachmentId } = request.params as { id: string; attachmentId: string };
      const att = await loadOwnedAttachment(db, session.userId, attachmentId);
      if (!att || att.vaultItemId !== itemId) throw notFound('attachment not found');
      return {
        id: att.id,
        vaultItemId: att.vaultItemId,
        sizeBytes: att.sizeBytes,
        status: att.status,
        pendingDeleteAt: att.pendingDeleteAt?.toISOString() ?? null,
        createdAt: att.createdAt.toISOString(),
        updatedAt: att.updatedAt.toISOString(),
      };
    },
  );

  // ── Purge an attachment (sensitive) ────────────────────────────────────────
  // Same POST + id-in-body convention as the other sensitive vault mutations (the
  // step-up signature binds the body — see the design note in vault.ts). The
  // literal 'attachments' segment routes here, not to the create route's :id param
  // (Fastify prefers a static segment over a parameter).
  app.post(
    '/v1/vault/items/attachments/purge',
    {
      preHandler: [requireSession, owner, writableGate, requireStepUp('purge_attachment')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['attachmentId'],
          properties: { attachmentId: uuidStr },
        },
        response: {
          202: {
            type: 'object',
            additionalProperties: false,
            required: ['sensitiveActionId', 'effectiveAt'],
            properties: { sensitiveActionId: { type: 'string' }, effectiveAt: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const { attachmentId } = request.body as { attachmentId: string };
      const att = await loadOwnedAttachment(db, session.userId, attachmentId);
      if (!att) throw notFound('attachment not found');

      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'purge_attachment',
        payload: { attachmentId },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      await db
        .update(schema.attachments)
        .set({ pendingDeleteAt: result.effectiveAt, updatedAt: new Date() })
        .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.userId, session.userId)));
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );
}

// Undo a failed upload — but ONLY our own (2026-08-08 re-audit, N-2). The
// claim-token check is the first thing here, and it gates the blob delete and the
// storage refund as much as the status reset: a writer that lost its slot and then
// errored used to delete the HOLDER's blob and refund the HOLDER's bytes, turning
// one failed upload into a second corrupted one.
async function rollbackUpload(
  db: Database,
  store: BlobStore,
  userId: UserId,
  attachmentId: string,
  bytes: number,
  claimToken: string,
): Promise<void> {
  const released = await db
    .update(schema.attachments)
    .set({ status: 'failed', uploadClaim: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.attachments.id, attachmentId),
        eq(schema.attachments.uploadClaim, claimToken),
      ),
    )
    .returning({ id: schema.attachments.id });
  // Our reservation is refunded either way — we are storing nothing, and a
  // reservation nobody releases is the permanent overcharge finding 2 was about.
  await releaseUserStorage(db, userId, bytes);
  // The blob and the row, however, belong to whoever holds the slot now. Zero
  // rows means that is not us: leave their bytes on disk and their status alone.
  if (released.length === 0) return;
  await store.delete(blobKey(userId, attachmentId));
}

async function loadOwnedItem(
  db: Database,
  userId: string,
  id: string,
): Promise<typeof schema.vaultItems.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.vaultItems)
    .where(and(eq(schema.vaultItems.id, id), eq(schema.vaultItems.userId, userId)))
    .limit(1);
  return rows[0];
}

async function loadOwnedAttachment(
  db: Database,
  userId: string,
  id: string,
): Promise<typeof schema.attachments.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.id, id), eq(schema.attachments.userId, userId)))
    .limit(1);
  return rows[0];
}
