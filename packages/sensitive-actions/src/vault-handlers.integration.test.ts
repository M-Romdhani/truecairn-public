import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createVaultItem, decryptOuterEnvelope, envKekProvider, type InnerBytes, type KekProvider } from '@truecairn/vault';
import { eq } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { cancelSensitiveAction, requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const KEK = { id: 'outer_layer-cccccccccccc', key: new Uint8Array(32).fill(3) };
const keks: KekProvider = envKekProvider({ currentId: KEK.id, byId: new Map([[KEK.id, KEK]]) });

// Original content + a first per-item-key wrap. Nonces are 24 bytes (the
// secretbox length the bundle serializer asserts).
const CONTENT = new Uint8Array([10, 20, 30, 40, 50, 60]);
const CONTENT_NONCE = new Uint8Array(24).fill(1);
const W1 = new Uint8Array([1, 1, 1]);
const W1_NONCE = new Uint8Array(24).fill(2);
// The new per-item-key wrap the client supplies for the destination tier.
const W2 = new Uint8Array([9, 9, 9, 9]);
const NEW_TITLE = new Uint8Array([7, 7, 7, 7]);
const NEW_TITLE_NONCE = new Uint8Array(24).fill(5);
const W2_NONCE = new Uint8Array(24).fill(4);

function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

describeIfDb('vault-domain sensitive-action handlers (integration)', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE vault_items, outer_layer_keys, sensitive_actions, notification_deliveries, notification_channels, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function makeItem(userId: UserId, tier: 's1' | 's2' | 's3'): Promise<string> {
    const inner: InnerBytes = {
      contentCiphertext: CONTENT,
      contentNonce: CONTENT_NONCE,
      wrappedPerItemKey: W1,
      wrappedPerItemKeyNonce: W1_NONCE,
    };
    const { id } = await createVaultItem(db, keks, {
      id: randomUUID(),
      userId,
      tier,
      category: 'crypto_wallets',
      inner,
      titleCiphertext: new Uint8Array([7]),
      titleNonce: new Uint8Array([8]),
      contentSizeBytes: CONTENT.length,
      clientOrdinal: null,
      now: new Date(),
    });
    return id;
  }
  function applyAt(now: Date) {
    return applyDueActions({ db, audit, now, outerLayerKeks: keks }, 50);
  }

  // PROMOTION S1 → S2 — the direction three production tier-moves were stuck on
  // (2026-07-18). Coverage gap: only demotions were tested. Promotion re-wraps
  // the same content under the higher tier's outer key and flips the tier.
  it('set_vault_item_tier (S1 → S2 promotion): applies + re-wraps with byte-identical content', async () => {
    const userId = await makeUser('promote@example.com');
    const itemId = await makeItem(userId, 's1');
    const t0 = new Date('2026-06-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'set_vault_item_tier',
      payload: { itemId, newTier: 's2', wrappedPerItemKey: b64(W2), wrappedPerItemKeyNonce: b64(W2_NONCE), titleCiphertext: b64(NEW_TITLE), titleNonce: b64(NEW_TITLE_NONCE) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);
    const [item] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
    expect(item!.tier).toBe('s2');
    // Content survives the re-wrap byte-for-byte (only the outer wrap changed).
    const inner = await decryptOuterEnvelope(db, keks, item!);
    expect(Buffer.from(inner.contentCiphertext)).toEqual(Buffer.from(CONTENT));
    expect(Buffer.from(inner.wrappedPerItemKey)).toEqual(Buffer.from(W2));
  });

  // ── The title moves with the tier (regression, 2026-08-09) ─────────────────
  //
  // The title is encrypted under the TIER key, and this handler used to rewrite
  // `tier` while leaving `title_ciphertext` untouched. The reader then tried the
  // NEW tier key against a title sealed under the old one and threw — which, in
  // an uncaught render path, took the owner's whole vault list down with it. The
  // content was intact the entire time; the title failure buried it.
  //
  // Permanent: a "fix" that drops these fields from the update is that bug back.
  it('set_vault_item_tier: rewrites the title, so it is readable under the new tier', async () => {
    const userId = await makeUser('title-moves@example.com');
    const itemId = await makeItem(userId, 's1');
    const t0 = new Date('2026-06-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'set_vault_item_tier',
      payload: { itemId, newTier: 's2', wrappedPerItemKey: b64(W2), wrappedPerItemKeyNonce: b64(W2_NONCE), titleCiphertext: b64(NEW_TITLE), titleNonce: b64(NEW_TITLE_NONCE) },
      now: t0,
    });
    expect((await applyAt(new Date(t0.getTime() + 8 * DAY))).applied).toBe(1);

    const [item] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
    expect(item!.tier).toBe('s2');
    // The stored title is the one re-encrypted under the DESTINATION tier key,
    // not the original still sealed under the source tier.
    expect(Buffer.from(item!.titleCiphertext)).toEqual(Buffer.from(NEW_TITLE));
    expect(Buffer.from(item!.titleNonce)).toEqual(Buffer.from(NEW_TITLE_NONCE));
    // And a re-sealed item lands at the current AAD version.
    expect(item!.aadVersion).toBe(2);
  });

  // A payload with no re-encrypted title is a pre-2026-08-09 enqueue. Applying
  // it would strand the title under the tier the item just left, so the handler
  // refuses rather than half-applying.
  it('set_vault_item_tier: CANCELS a payload that carries no re-encrypted title', async () => {
    const userId = await makeUser('title-missing@example.com');
    const itemId = await makeItem(userId, 's1');
    const t0 = new Date('2026-06-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'set_vault_item_tier',
      payload: { itemId, newTier: 's2', wrappedPerItemKey: b64(W2), wrappedPerItemKeyNonce: b64(W2_NONCE) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(0);
    const [item] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
    // Fail closed: the item did not move at all.
    expect(item!.tier).toBe('s1');
  });

  // The dangerous direction: DEMOTING S3 → S1 drops the diverse-role consensus
  // (S3 = 3-of-4; S1 = a single contact) and the long cooldown to the first
  // release stage — releasing content with LESS protection than the user chose.
  // It must be a delayed, cancellable action, and the content must survive the
  // re-wrap byte-for-byte.
  it('set_vault_item_tier (S3→S1 demotion): pending through cooldown, then flips tier + re-wraps with byte-identical content', async () => {
    const userId = await makeUser('demote@example.com');
    const itemId = await makeItem(userId, 's3');
    const t0 = new Date('2026-06-01T00:00:00Z');
    const { id, effectiveAt } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'set_vault_item_tier',
      payload: { itemId, newTier: 's1', wrappedPerItemKey: b64(W2), wrappedPerItemKeyNonce: b64(W2_NONCE), titleCiphertext: b64(NEW_TITLE), titleNonce: b64(NEW_TITLE_NONCE) },
      now: t0,
    });
    expect(effectiveAt.getTime()).toBe(t0.getTime() + 7 * DAY);

    // (a) BEFORE the cooldown: nothing applies; the item is STILL S3.
    const before = await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect(before.applied).toBe(0);
    expect((await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id)))[0]!.status).toBe('pending');
    expect((await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId)))[0]!.tier).toBe('s3');

    // (b) AFTER the cooldown + a tick: tier flips S3→S1, and the content
    // ciphertext is byte-identical (only the per-item-key wrap + outer layer changed).
    const after = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(after.applied).toBe(1);
    const [item] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
    expect(item!.tier).toBe('s1');
    const inner = await decryptOuterEnvelope(db, keks, item!);
    expect(Buffer.from(inner.contentCiphertext)).toEqual(Buffer.from(CONTENT));
    expect(Buffer.from(inner.contentNonce)).toEqual(Buffer.from(CONTENT_NONCE));
    expect(Buffer.from(inner.wrappedPerItemKey)).toEqual(Buffer.from(W2));

    // The audit records BOTH the old and new tier.
    const applied = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId))
    ).find((e) => e.eventType === 'sensitive_action.applied');
    expect((applied!.eventPayload as { details?: { fromTier?: string; toTier?: string } }).details).toMatchObject({
      fromTier: 's3',
      toTier: 's1',
    });
  });

  it('set_vault_item_tier: a cancel during the cooldown stops the move (tier stays S3)', async () => {
    const userId = await makeUser('cancel@example.com');
    const itemId = await makeItem(userId, 's3');
    const t0 = new Date('2026-06-01T00:00:00Z');
    const { id } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'set_vault_item_tier',
      payload: { itemId, newTier: 's1', wrappedPerItemKey: b64(W2), wrappedPerItemKeyNonce: b64(W2_NONCE), titleCiphertext: b64(NEW_TITLE), titleNonce: b64(NEW_TITLE_NONCE) },
      now: t0,
    });
    // Cancel-from-any-device during the cooldown.
    const cancelled = await cancelSensitiveAction(db, audit, {
      sensitiveActionId: id,
      via: 'another_device',
      reason: 'user_cancelled',
      now: new Date(t0.getTime() + 2 * DAY),
    });
    expect(cancelled).toBe(true);

    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(0);
    expect((await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId)))[0]!.tier).toBe('s3');
  });

  // QA P3-4. The ENQUEUE route stamps vault_items.pending_delete_at so the UI can
  // show "pending deletion" during the cooldown, and the APPLY handler clears it.
  // Cancel used to touch only the sensitive_actions row, so a cancelled deletion
  // left the marker set forever — on attachments that is user-visible as a
  // permanent "pending deletion" with no pending action behind it and no way to
  // clear it. The marker now rides the cancel, in the same transaction.
  it('delete_vault_item: cancelling clears pending_delete_at, not just the action row', async () => {
    const userId = await makeUser('pending-marker@example.com');
    const itemId = await makeItem(userId, 's2');
    const t0 = new Date('2026-06-01T00:00:00Z');
    const { id, effectiveAt } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'delete_vault_item',
      payload: { itemId },
      now: t0,
    });
    // The route sets the marker at enqueue; mirror that here.
    await db
      .update(schema.vaultItems)
      .set({ pendingDeleteAt: effectiveAt, updatedAt: t0 })
      .where(eq(schema.vaultItems.id, itemId));

    const ok = await cancelSensitiveAction(db, audit, {
      sensitiveActionId: id,
      via: 'another_device',
      reason: 'user_cancelled',
      now: new Date(t0.getTime() + 2 * DAY),
    });
    expect(ok).toBe(true);

    const [item] = await db
      .select()
      .from(schema.vaultItems)
      .where(eq(schema.vaultItems.id, itemId));
    expect(item!.pendingDeleteAt).toBeNull();
    // And the cancel still did its real job.
    expect(item!.deletedAt).toBeNull();
    await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(
      (await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId)))[0]!
        .deletedAt,
    ).toBeNull();
  });

  it('delete_vault_item: applies as a soft-delete (deleted_at set) after the cooldown', async () => {
    const userId = await makeUser('del@example.com');
    const itemId = await makeItem(userId, 's2');
    const t0 = new Date('2026-06-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'delete_vault_item',
      payload: { itemId },
      now: t0,
    });
    // Before cooldown: not deleted.
    await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect((await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId)))[0]!.deletedAt).toBeNull();
    // After: soft-deleted.
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);
    const [item] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
    expect(item!.deletedAt).not.toBeNull();
  });
});
