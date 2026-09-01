import { schema, type Database } from '@truecairn/db';
import { DbChannelLookup } from '@truecairn/engine';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import {
  type UserId,
  type VaultItemDto,
  type VaultListDto,
  type VaultAttachmentSummaryDto,
  type VaultTier,
  type VaultCategory,
  VAULT_TIERS,
  VAULT_CATEGORIES,
} from '@truecairn/shared';
import {
  createVaultItem,
  decryptOuterEnvelope,
  rewrapInnerForUpdate,
  type InnerBytes,
} from '@truecairn/vault';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertCanAddVaultItem } from '../billing/limits.js';
import { requireSession } from '../auth/session.js';
import { requireStepUp, type StepUpContext } from '../auth/stepup.js';
import type { ApiConfig } from '../config.js';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.js';
import { assertVaultWritable, noteOwnerReadAccess } from '../vault/engine-gate.js';

const VAULT_OWNER_REQUIRED_TYPE = 'https://truecairn.app/problems/vault-owner-required';
const VAULT_TIER_VIA_SENSITIVE_TYPE = 'https://truecairn.app/problems/vault-tier-change-is-sensitive';
const CONTENT_TOO_LARGE_TYPE = 'https://truecairn.app/problems/vault-item-too-large';
const NO_BACKUP_TYPE = 'https://truecairn.app/problems/vault-no-restorable-backup';
const VAULT_RENAME_BLOCKED_BY_TIER_MOVE_TYPE =
  'https://truecairn.app/problems/vault-rename-blocked-by-pending-tier-move';

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_WINDOW_DAYS = 7;

const uuidStr = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const;
const b64 = { type: 'string', minLength: 1, maxLength: 1_500_000 } as const;

// The step-up proof recorded in the action's audit payload (the same forensic
// linkage every step-up route writes; signature base64url).
export function stepUpLinkage(stepUp: StepUpContext): { challengeId: string; signature: string } {
  return { challengeId: stepUp.challengeId, signature: Buffer.from(stepUp.signature).toString('base64url') };
}

// Owner gate: only an account with master-key material (a real vault owner) may
// reach these routes. A contact-only user (no user_key_material) is 409'd — they
// have no vault. Runs after requireSession.
export function requireVaultOwner(db: Database) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const rows = await db
      .select({ userId: schema.userKeyMaterial.userId })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, session.userId))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ApiError(
        409,
        'Vault owner required',
        'this account has no master-key material; only a vault owner can use vault routes',
        VAULT_OWNER_REQUIRED_TYPE,
      );
    }
  };
}

export function vaultRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const channels = new DbChannelLookup(db);
  const keks = config.outerLayerKeks;
  const limits = config.vaultLimits;
  const owner = requireVaultOwner(db);
  // Cheap write-gate, before any step-up cost: a doomed mutation during a
  // release state 409s here rather than paying for a step-up challenge first.
  const writableGate = async (request: FastifyRequest): Promise<void> => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    await assertVaultWritable(db, session.userId);
  };
  // Cheap precondition for a tier move, BEFORE the step-up cost (mirrors 3.2's
  // requireContactEnrolled): the item must exist, be live, and actually change
  // tier. The apply-time handler re-checks (7 days can change the world).
  const tierMovePrecondition = async (request: FastifyRequest): Promise<void> => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const body = request.body as { itemId: string; newTier: VaultTier };
    const item = await loadOwnedItem(db, session.userId, body.itemId);
    if (!item || item.deletedAt !== null) throw notFound('vault item not found');
    if (item.tier === body.newTier) throw badRequest('item is already in that tier');
  };

  // ── Create an item ─────────────────────────────────────────────────────────
  app.post(
    '/v1/vault/items',
    {
      preHandler: [requireSession, owner],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'tier',
            'category',
            'contentCiphertext',
            'contentNonce',
            'wrappedPerItemKey',
            'wrappedPerItemKeyNonce',
            'titleCiphertext',
            'titleNonce',
            'contentSizeBytes',
          ],
          properties: {
            // Client-chosen (F3): both AAD layers bind it, so it must exist
            // before the client encrypts anything. A duplicate is rejected, not
            // overwritten — see the handler.
            id: uuidStr,
            tier: { type: 'string', enum: [...VAULT_TIERS] },
            // Mirrors the CHECK added in migration 0065 so an unknown category
            // is a clean 400 here rather than a driver error from the database.
            category: { type: 'string', enum: [...VAULT_CATEGORIES] },
            contentCiphertext: b64,
            contentNonce: b64,
            wrappedPerItemKey: b64,
            wrappedPerItemKeyNonce: b64,
            titleCiphertext: b64,
            titleNonce: b64,
            contentSizeBytes: { type: 'integer', minimum: 0 },
            clientOrdinal: { type: 'integer' },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const body = request.body as CreateBody;
      await assertVaultWritable(db, session.userId);
      // Free-tier vault-item cap (docs/28): fail closed with 402 before creating.
      await assertCanAddVaultItem(db, session.userId, new Date());

      const inner = decodeInner(body);
      if (inner.contentCiphertext.length > limits.maxItemContentBytes) {
        throw new ApiError(
          413,
          'Vault item too large',
          `item content ciphertext exceeds the ${limits.maxItemContentBytes}-byte limit`,
          CONTENT_TOO_LARGE_TYPE,
        );
      }

      const result = await createVaultItem(db, keks, {
        id: body.id,
        userId: session.userId,
        tier: body.tier,
        category: body.category,
        inner,
        titleCiphertext: b64ToBytes(body.titleCiphertext),
        titleNonce: b64ToBytes(body.titleNonce),
        contentSizeBytes: body.contentSizeBytes,
        clientOrdinal: body.clientOrdinal ?? null,
        now: new Date(),
      });
      void reply.status(201);
      return { id: result.id, createdAt: result.createdAt.toISOString() };
    },
  );

  // ── Fetch one item (transparent outer-unwrap; engine-state aware) ──────────
  app.get(
    '/v1/vault/items/:id',
    {
      preHandler: [requireSession, owner],
      schema: { params: { type: 'object', required: ['id'], properties: { id: uuidStr } } },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      const item = await loadOwnedItem(db, session.userId, id);
      if (!item) throw notFound('vault item not found');

      // Owner read during a release state = "user showed up": pause the ladder
      // (engine user_authenticated_during_release → returning) + audit. Served
      // regardless — it is the owner's own (inner) ciphertext.
      const audit = app.audit;
      if (audit !== null) {
        await noteOwnerReadAccess({ db, audit, channels, now: new Date() }, session.userId);
      }

      const inner = await decryptOuterEnvelope(db, keks, item);
      const attachmentRows = await db
        .select({
          id: schema.attachments.id,
          sizeBytes: schema.attachments.sizeBytes,
          status: schema.attachments.status,
          // A purge sets this and LEAVES status on 'stored', so status cannot
          // stand in for it — without the field the client shows a live row and
          // a "Remove (7-day)" button for a file already scheduled to go.
          pendingDeleteAt: schema.attachments.pendingDeleteAt,
          createdAt: schema.attachments.createdAt,
        })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.vaultItemId, id),
            eq(schema.attachments.userId, session.userId),
            isNull(schema.attachments.deletedAt),
          ),
        )
        .orderBy(schema.attachments.createdAt);
      return fetchedItemResponse(
        item,
        inner,
        attachmentRows.map((a) => ({
          id: a.id,
          sizeBytes: a.sizeBytes,
          status: a.status,
          pendingDeleteAt: a.pendingDeleteAt?.toISOString() ?? null,
          createdAt: a.createdAt.toISOString(),
        })),
      );
    },
  );

  // ── List items (metadata + titles only; never content) ─────────────────────
  app.get(
    '/v1/vault/items',
    {
      preHandler: [requireSession, owner],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tier: { type: 'string', enum: [...VAULT_TIERS] },
            // Constrained on the read path too. A filter value outside the
            // vocabulary can match nothing by construction, so "400, that is not
            // a category" is a more useful answer than an empty list that reads
            // as "you have none of those".
            category: { type: 'string', enum: [...VAULT_CATEGORIES] },
            updatedSince: { type: 'string', format: 'date-time' },
            includeDeleted: { type: 'boolean' },
            cursor: { type: 'string', minLength: 1, maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    // Return type annotated (not inferred) so the contract is checked HERE, at
    // the serializer, rather than trusted downstream — the list row is built
    // inline and inference would happily accept whatever it happens to build.
    async (request): Promise<VaultListDto> => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const q = request.query as ListQuery;
      const limit = q.limit ?? 50;

      const conds = [eq(schema.vaultItems.userId, session.userId)];
      if (q.tier !== undefined) conds.push(eq(schema.vaultItems.tier, q.tier));
      if (q.category !== undefined) conds.push(eq(schema.vaultItems.category, q.category));
      if (q.updatedSince !== undefined) {
        conds.push(gte(schema.vaultItems.updatedAt, new Date(q.updatedSince)));
      }
      if (q.includeDeleted !== true) conds.push(isNull(schema.vaultItems.deletedAt));
      const cursor = q.cursor !== undefined ? decodeCursor(q.cursor) : null;
      if (cursor) {
        // Keyset pagination over (updated_at, id) descending — stable + index-friendly.
        conds.push(
          sql`(${schema.vaultItems.updatedAt}, ${schema.vaultItems.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          id: schema.vaultItems.id,
          tier: schema.vaultItems.tier,
          // The client rebuilds the title AAD from (tier, id) and must know
          // which construction was used — a v1 title carried no AAD at all,
          // which is not the same as an empty one (F3, migration 0062).
          aadVersion: schema.vaultItems.aadVersion,
          category: schema.vaultItems.category,
          clientOrdinal: schema.vaultItems.clientOrdinal,
          titleCiphertext: schema.vaultItems.titleCiphertext,
          titleNonce: schema.vaultItems.titleNonce,
          contentSizeBytes: schema.vaultItems.contentSizeBytes,
          updatedAt: schema.vaultItems.updatedAt,
          deletedAt: schema.vaultItems.deletedAt,
          pendingDeleteAt: schema.vaultItems.pendingDeleteAt,
        })
        .from(schema.vaultItems)
        .where(and(...conds))
        .orderBy(desc(schema.vaultItems.updatedAt), desc(schema.vaultItems.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor(last.updatedAt.toISOString(), last.id)
          : null;

      return {
        items: page.map((r) => ({
          id: r.id,
          tier: r.tier,
          // Selected above for the client's title AAD — it has to survive into
          // the response. It did not, and every title in the list read as
          // "Title unavailable": the client asserts the version before
          // rebuilding the AAD, and `undefined` is not 2.
          aadVersion: r.aadVersion,
          category: r.category,
          clientOrdinal: r.clientOrdinal,
          titleCiphertext: bytesToB64(r.titleCiphertext),
          titleNonce: bytesToB64(r.titleNonce),
          contentSizeBytes: r.contentSizeBytes,
          updatedAt: r.updatedAt.toISOString(),
          deletedAt: r.deletedAt?.toISOString() ?? null,
          // The list is where an owner looks first, so a scheduled deletion has
          // to be visible from the row as well as from the item.
          pendingDeleteAt: r.pendingDeleteAt?.toISOString() ?? null,
        })),
        nextCursor,
      };
    },
  );

  // ── Patch non-sensitive fields (metadata + content replacement) ────────────
  app.patch(
    '/v1/vault/items/:id',
    {
      preHandler: [requireSession, owner],
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuidStr } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // tier is accepted only to 422 it with a helpful redirect — moves
            // are a sensitive action, not an immediate patch.
            tier: { type: 'string', enum: [...VAULT_TIERS] },
            category: { type: 'string', enum: [...VAULT_CATEGORIES] },
            titleCiphertext: b64,
            titleNonce: b64,
            clientOrdinal: { type: 'integer' },
            contentCiphertext: b64,
            contentNonce: b64,
            wrappedPerItemKey: b64,
            wrappedPerItemKeyNonce: b64,
            contentSizeBytes: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      const body = request.body as PatchBody;

      if (body.tier !== undefined) {
        throw new ApiError(
          422,
          'Tier change is a sensitive action',
          'moving an item between tiers changes its release threshold and stage — use POST /v1/vault/items/:id/tier',
          VAULT_TIER_VIA_SENSITIVE_TYPE,
        );
      }
      await assertVaultWritable(db, session.userId);
      const item = await loadOwnedItem(db, session.userId, id);
      if (!item) throw notFound('vault item not found');

      const now = new Date();
      const update: Record<string, unknown> = { updatedAt: now };
      if (body.category !== undefined) update['category'] = body.category;
      if (body.clientOrdinal !== undefined) update['clientOrdinal'] = body.clientOrdinal;
      if (body.titleCiphertext !== undefined || body.titleNonce !== undefined) {
        if (body.titleCiphertext === undefined || body.titleNonce === undefined) {
          throw badRequest('titleCiphertext and titleNonce must be supplied together');
        }
        // A pending tier move already carries a title re-encrypted under the
        // DESTINATION tier, computed at enqueue. Accepting a rename now would
        // mean the move silently reverts it seven days later — the handler
        // cannot tell the two apart, because both are opaque ciphertext to it.
        // Refuse instead, and hand back the deadline plus the action id so the
        // owner can cancel from the error rather than go hunting for it.
        const move = await pendingTierMove(db, session.userId, id);
        if (move !== null) {
          throw new ApiError(
            409,
            'A tier change is pending for this item',
            `renaming it now would be undone when the move applies on ${move.effectiveAt.toISOString()}. Cancel the tier change first, then rename.`,
            VAULT_RENAME_BLOCKED_BY_TIER_MOVE_TYPE,
            { sensitiveActionId: move.id, effectiveAt: move.effectiveAt.toISOString() },
          );
        }
        update['titleCiphertext'] = b64ToBytes(body.titleCiphertext);
        update['titleNonce'] = b64ToBytes(body.titleNonce);
      }

      const contentFields = [
        body.contentCiphertext,
        body.contentNonce,
        body.wrappedPerItemKey,
        body.wrappedPerItemKeyNonce,
        body.contentSizeBytes,
      ];
      const someContent = contentFields.some((f) => f !== undefined);
      if (someContent) {
        if (contentFields.some((f) => f === undefined)) {
          throw badRequest(
            'a content replacement requires contentCiphertext, contentNonce, wrappedPerItemKey, wrappedPerItemKeyNonce, and contentSizeBytes together',
          );
        }
        const inner = decodeInner(body as CreateBody);
        if (inner.contentCiphertext.length > limits.maxItemContentBytes) {
          throw new ApiError(
            413,
            'Vault item too large',
            `item content ciphertext exceeds the ${limits.maxItemContentBytes}-byte limit`,
            CONTENT_TOO_LARGE_TYPE,
          );
        }
        // Seed-once-per-window backup (Q4): the FIRST content overwrite after the
        // slot is empty/expired preserves the displaced envelope + its size; later
        // overwrites within the window leave it, so a double-overwrite can't
        // destroy the pre-burst copy. Revert restores it (one-way) and clears it.
        const slotFresh =
          item.backupAt !== null &&
          now.getTime() - item.backupAt.getTime() < BACKUP_WINDOW_DAYS * DAY_MS;
        if (!slotFresh) {
          update['backupOuterCiphertext'] = item.outerCiphertext;
          update['backupOuterNonce'] = item.outerNonce;
          update['backupContentSizeBytes'] = item.contentSizeBytes;
          update['backupAt'] = now;
        }

        const envelope = await rewrapInnerForUpdate(db, keks, item, inner);
        update['outerCiphertext'] = envelope.ciphertext;
        update['outerNonce'] = envelope.nonce;
        update['contentSizeBytes'] = body.contentSizeBytes;
      }

      const [updated] = await db
        .update(schema.vaultItems)
        .set(update)
        .where(and(eq(schema.vaultItems.id, id), eq(schema.vaultItems.userId, session.userId)))
        .returning({ id: schema.vaultItems.id, updatedAt: schema.vaultItems.updatedAt });
      if (!updated) throw notFound('vault item not found');
      return { id: updated.id, updatedAt: updated.updatedAt.toISOString() };
    },
  );

  // ── Move an item to a new tier (sensitive) ─────────────────────────────────
  // DESIGN NOTE — do NOT refactor the sensitive vault mutations (tier/delete/
  // revert) into RESTful DELETE /v1/vault/items/:id etc. The step-up signature
  // binds the request BODY (buildStepUpSigningInput signs request.body), so the
  // itemId MUST live in the body — an id-in-the-path + empty-body shape would let
  // a captured signature be replayed against a different itemId. This is the same
  // POST + id-in-body convention 3.2 established for the contact mutations.
  // Enqueues set_vault_item_tier; the worker re-wraps under the destination
  // tier's outer key after the 7-day cooldown.
  app.post(
    '/v1/vault/items/tier',
    {
      preHandler: [
        requireSession,
        owner,
        writableGate,
        tierMovePrecondition,
        requireStepUp('set_vault_item_tier'),
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          // The TITLE moves with the key. It is encrypted under the tier key
          // too, so a move that carries only the wrapped key leaves the title
          // sealed under the old tier — which is exactly what happened before
          // 2026-08-09, and made every moved item unreadable.
          required: [
            'itemId',
            'newTier',
            'wrappedPerItemKey',
            'wrappedPerItemKeyNonce',
            'titleCiphertext',
            'titleNonce',
            'aadVersion',
          ],
          properties: {
            itemId: uuidStr,
            newTier: { type: 'string', enum: [...VAULT_TIERS] },
            wrappedPerItemKey: b64,
            wrappedPerItemKeyNonce: b64,
            titleCiphertext: b64,
            titleNonce: b64,
            // A moved item is re-sealed under the destination tier, so it comes
            // out at the current version whatever it was before.
            aadVersion: { type: 'integer', enum: [2] },
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const body = request.body as {
        itemId: string;
        newTier: VaultTier;
        wrappedPerItemKey: string;
        wrappedPerItemKeyNonce: string;
        titleCiphertext: string;
        titleNonce: string;
        aadVersion: number;
      };
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'set_vault_item_tier',
        payload: {
          itemId: body.itemId,
          newTier: body.newTier,
          wrappedPerItemKey: body.wrappedPerItemKey,
          wrappedPerItemKeyNonce: body.wrappedPerItemKeyNonce,
          titleCiphertext: body.titleCiphertext,
          titleNonce: body.titleNonce,
          aadVersion: body.aadVersion,
        },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Delete an item (sensitive) ─────────────────────────────────────────────
  // Enqueues delete_vault_item + flags the item pending (visible during the
  // cooldown so the user can review/cancel); the handler sets deleted_at on apply.
  app.post(
    '/v1/vault/items/delete',
    {
      preHandler: [requireSession, owner, writableGate, requireStepUp('delete_vault_item')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['itemId'],
          properties: { itemId: uuidStr },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const { itemId } = request.body as { itemId: string };
      const item = await loadOwnedItem(db, session.userId, itemId);
      if (!item || item.deletedAt !== null) throw notFound('vault item not found');

      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'delete_vault_item',
        payload: { itemId },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      await db
        .update(schema.vaultItems)
        .set({ pendingDeleteAt: result.effectiveAt, updatedAt: new Date() })
        .where(and(eq(schema.vaultItems.id, itemId), eq(schema.vaultItems.userId, session.userId)));
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Revert content to the backup slot (immediate, step-up-gated) ───────────
  // Recovery, not a delayed action: restores the pre-burst envelope one-way and
  // clears the slot. Step-up-gated because it mutates durable state, so a warm
  // stolen session can overwrite (recoverable) but cannot revert.
  app.post(
    '/v1/vault/items/revert',
    {
      preHandler: [requireSession, owner, writableGate, requireStepUp('revert_vault_item')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['itemId'],
          properties: { itemId: uuidStr },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { itemId } = request.body as { itemId: string };
      const item = await loadOwnedItem(db, session.userId, itemId);
      if (!item) throw notFound('vault item not found');

      const restorable =
        item.backupAt !== null &&
        item.backupOuterCiphertext !== null &&
        item.backupOuterNonce !== null &&
        item.backupContentSizeBytes !== null &&
        Date.now() - item.backupAt.getTime() < BACKUP_WINDOW_DAYS * DAY_MS;
      if (!restorable) {
        throw new ApiError(
          409,
          'No restorable backup',
          'this item has no content backup within the recovery window',
          NO_BACKUP_TYPE,
        );
      }

      const now = new Date();
      const [reverted] = await db
        .update(schema.vaultItems)
        .set({
          // Non-null: the restorable guard above proved all backup fields are set.
          outerCiphertext: item.backupOuterCiphertext!,
          outerNonce: item.backupOuterNonce!,
          contentSizeBytes: item.backupContentSizeBytes!,
          backupOuterCiphertext: null,
          backupOuterNonce: null,
          backupContentSizeBytes: null,
          backupAt: null,
          updatedAt: now,
        })
        .where(and(eq(schema.vaultItems.id, itemId), eq(schema.vaultItems.userId, session.userId)))
        .returning({ id: schema.vaultItems.id });
      if (!reverted) throw notFound('vault item not found');
      return { id: itemId, reverted: true, updatedAt: now.toISOString() };
    },
  );
}

const enqueuedResponse = {
  202: {
    type: 'object',
    additionalProperties: false,
    required: ['sensitiveActionId', 'effectiveAt'],
    properties: { sensitiveActionId: { type: 'string' }, effectiveAt: { type: 'string' } },
  },
} as const;

// Is a tier move pending for this item?
//
// Read from sensitive_actions rather than a marker column on vault_items, and
// that is still the right shape even though the wart it was avoiding is gone.
//
// The precedent — pending_delete_at — is set at enqueue and cleared by the APPLY
// handler. Cancel used to touch only the action row, so a cancelled deletion left
// the flag set forever (user-visible on attachments as a permanent "pending
// deletion"); copying that shape here would have given an item that could never
// be renamed again. cancelSensitiveAction now clears the marker too, in the same
// transaction (QA P3-4, packages/sensitive-actions/src/scheduler.ts). Deriving
// from the action's own status is still preferable: it cannot drift from itself,
// so it needs no clearer on any future terminal state either.
async function pendingTierMove(
  db: Database,
  userId: UserId,
  itemId: string,
): Promise<{ id: string; effectiveAt: Date } | null> {
  const rows = await db
    .select({
      id: schema.sensitiveActions.id,
      effectiveAt: schema.sensitiveActions.effectiveAt,
      payload: schema.sensitiveActions.actionPayload,
    })
    .from(schema.sensitiveActions)
    .where(
      and(
        eq(schema.sensitiveActions.userId, userId),
        eq(schema.sensitiveActions.actionType, 'set_vault_item_tier'),
        eq(schema.sensitiveActions.status, 'pending'),
      ),
    );
  // itemId lives inside the JSON payload, so the match happens here rather than
  // in SQL — a user has at most a handful of pending actions at a time.
  for (const r of rows) {
    const p = r.payload as Record<string, unknown> | null;
    if (p !== null && p['itemId'] === itemId) return { id: r.id, effectiveAt: r.effectiveAt };
  }
  return null;
}

interface CreateBody {
  // Client-chosen; both AAD layers bind it (F3).
  id: string;
  tier: VaultTier;
  category: VaultCategory;
  contentCiphertext: string;
  contentNonce: string;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
  contentSizeBytes: number;
  clientOrdinal?: number;
}

interface PatchBody {
  tier?: VaultTier;
  category?: VaultCategory;
  titleCiphertext?: string;
  titleNonce?: string;
  clientOrdinal?: number;
  contentCiphertext?: string;
  contentNonce?: string;
  wrappedPerItemKey?: string;
  wrappedPerItemKeyNonce?: string;
  contentSizeBytes?: number;
}

interface ListQuery {
  tier?: VaultTier;
  category?: VaultCategory;
  updatedSince?: string;
  includeDeleted?: boolean;
  cursor?: string;
  limit?: number;
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

function decodeInner(body: {
  contentCiphertext: string;
  contentNonce: string;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
}): InnerBytes {
  return {
    contentCiphertext: b64ToBytes(body.contentCiphertext),
    contentNonce: b64ToBytes(body.contentNonce),
    wrappedPerItemKey: b64ToBytes(body.wrappedPerItemKey),
    wrappedPerItemKeyNonce: b64ToBytes(body.wrappedPerItemKeyNonce),
  };
}

// The item's live attachment metadata (QA 2026-07-17 issue #2 — the response
// always had the field, hardcoded empty; now populated so the UI can list
// them). Server-side metadata only: id, ciphertext size, lifecycle status —
// the filename/MIME live INSIDE the encrypted blob the client uploads.
export type AttachmentSummary = VaultAttachmentSummaryDto;

// Typed as the shared contract, not `Record<string, unknown>`. The wide return
// type was the type-level half of the gap that shipped #171: a serializer that
// promises nothing cannot be caught dropping anything.
function fetchedItemResponse(
  item: typeof schema.vaultItems.$inferSelect,
  inner: InnerBytes,
  attachments: AttachmentSummary[] = [],
): VaultItemDto {
  return {
    id: item.id,
    tier: item.tier,
    aadVersion: item.aadVersion,
    category: item.category,
    clientOrdinal: item.clientOrdinal,
    contentCiphertext: bytesToB64(inner.contentCiphertext),
    contentNonce: bytesToB64(inner.contentNonce),
    wrappedPerItemKey: bytesToB64(inner.wrappedPerItemKey),
    wrappedPerItemKeyNonce: bytesToB64(inner.wrappedPerItemKeyNonce),
    titleCiphertext: bytesToB64(item.titleCiphertext),
    titleNonce: bytesToB64(item.titleNonce),
    contentSizeBytes: item.contentSizeBytes,
    deletedAt: item.deletedAt?.toISOString() ?? null,
    // The delete route sets this and the action stays cancellable until it
    // lands. Written since the sensitive-actions lane existed and returned by
    // nothing until 2026-08-10, so the seven-day window was real and invisible
    // from the one screen that names the item it will destroy.
    pendingDeleteAt: item.pendingDeleteAt?.toISOString() ?? null,
    attachments,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function b64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
function bytesToB64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function encodeCursor(updatedAtIso: string, id: string): string {
  return Buffer.from(`${updatedAtIso}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.lastIndexOf('|');
  if (sep <= 0) return null;
  return { updatedAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
}
