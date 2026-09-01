import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { attachmentFilePath, createVaultItem, envKekProvider, LocalDiskBlobStore, type KekProvider } from '@truecairn/vault';
import { eq } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const KEK = { id: 'outer_layer-dddddddddddd', key: new Uint8Array(32).fill(5) };
const keks: KekProvider = envKekProvider({ currentId: KEK.id, byId: new Map([[KEK.id, KEK]]) });
const BLOB = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // an opaque "encrypted blob"

describeIfDb('purge_attachment handler (integration)', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;
  let dir: string;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
    dir = await mkdtemp(join(tmpdir(), 'tc-attach-'));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await sql`TRUNCATE attachments, vault_items, outer_layer_keys, sensitive_actions, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `u-${Math.random()}@example.com`, accountStatus: 'active', storageBytesUsed: BLOB.length })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  // A stored attachment: a parent vault item, an attachments row, a blob on disk,
  // and the user's reserved budget.
  async function makeStoredAttachment(userId: UserId, writeFileToo = true): Promise<string> {
    const { id: itemId } = await createVaultItem(db, keks, {
      id: randomUUID(),
      userId,
      tier: 's2',
      category: 'crypto_wallets',
      inner: {
        contentCiphertext: new Uint8Array([1]),
        contentNonce: new Uint8Array(24),
        wrappedPerItemKey: new Uint8Array([2]),
        wrappedPerItemKeyNonce: new Uint8Array(24),
      },
      titleCiphertext: new Uint8Array([3]),
      titleNonce: new Uint8Array([4]),
      contentSizeBytes: 1,
      clientOrdinal: null,
      now: new Date(),
    });
    const [att] = await db
      .insert(schema.attachments)
      .values({ vaultItemId: itemId, userId, sizeBytes: BLOB.length, status: 'stored', storagePath: 'x' })
      .returning({ id: schema.attachments.id });
    const path = attachmentFilePath(dir, userId, att!.id);
    if (writeFileToo) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, BLOB);
    }
    return att!.id;
  }
  function applyAt(now: Date) {
    return applyDueActions({ db, audit, now, blobStore: new LocalDiskBlobStore(dir) }, 50);
  }

  it('purges the row, the file, and the reserved budget after the cooldown', async () => {
    const userId = await makeUser();
    const attachmentId = await makeStoredAttachment(userId);
    const t0 = new Date('2026-06-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'purge_attachment',
      payload: { attachmentId },
      now: t0,
    });

    // Before cooldown: nothing purged.
    await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect(await db.select().from(schema.attachments)).toHaveLength(1);

    // After: row gone, file gone, budget released.
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);
    expect(await db.select().from(schema.attachments)).toHaveLength(0);
    await expect(access(attachmentFilePath(dir, userId, attachmentId))).rejects.toThrow();
    const [u] = await db.select({ used: schema.users.storageBytesUsed }).from(schema.users).where(eq(schema.users.id, userId));
    expect(u!.used).toBe(0);
  });

  // The file is best-effort: if it is already gone when the handler runs (manual
  // cleanup, disk failure), the purge still completes — the DB row is the truth.
  it('still completes when the blob file is already gone', async () => {
    const userId = await makeUser();
    const attachmentId = await makeStoredAttachment(userId, /* writeFileToo */ false);
    const t0 = new Date('2026-06-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'purge_attachment',
      payload: { attachmentId },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);
    expect(await db.select().from(schema.attachments)).toHaveLength(0);
  });
});
