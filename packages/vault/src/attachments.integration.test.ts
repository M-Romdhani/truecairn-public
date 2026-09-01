import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import {
  attachmentFilePath,
  deleteAttachmentFile,
  releaseUserStorage,
  reserveUserStorage,
} from './attachments.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('attachment storage budget (integration)', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE users CASCADE`;
  });

  async function makeUser(): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `u-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function used(userId: UserId): Promise<number> {
    const [u] = await db
      .select({ used: schema.users.storageBytesUsed })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return u!.used;
  }

  // The load-bearing concurrency property: two simultaneous 600-byte reservations
  // against a 1000-byte cap must NOT both succeed. SELECT ... FOR UPDATE serialises
  // them (the pool has 10 connections, so this is genuinely concurrent).
  it('rejects the second of two concurrent over-cap reservations', async () => {
    const userId = await makeUser();
    const [a, b] = await Promise.all([
      reserveUserStorage(db, userId, 600, 1000),
      reserveUserStorage(db, userId, 600, 1000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one won
    expect(await used(userId)).toBe(600); // only one reservation landed
  });

  it('reserves up to the cap and releases back down', async () => {
    const userId = await makeUser();
    expect(await reserveUserStorage(db, userId, 400, 1000)).toBe(true);
    expect(await reserveUserStorage(db, userId, 600, 1000)).toBe(true); // exactly fills
    expect(await reserveUserStorage(db, userId, 1, 1000)).toBe(false); // now full
    expect(await used(userId)).toBe(1000);
    await releaseUserStorage(db, userId, 600);
    expect(await used(userId)).toBe(400);
    // Release never goes negative.
    await releaseUserStorage(db, userId, 99999);
    expect(await used(userId)).toBe(0);
  });

  it('deleteAttachmentFile treats an already-gone file as success', async () => {
    const userId = await makeUser();
    // No file was ever written — must resolve, not throw.
    await expect(
      deleteAttachmentFile('/tmp/truecairn-test-nonexistent', userId, 'deadbeef'),
    ).resolves.toBeUndefined();
    expect(attachmentFilePath('/base', 'u', 'a')).toBe('/base/u/a.bin');
  });
});
