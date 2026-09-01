import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { AUTH_ATTEMPT_RETENTION_DAYS, pruneAuthAttempts } from './retention-sweep.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY_MS = 24 * 60 * 60 * 1000;

// 2026-08-07 security audit, finding 6. auth_attempts had no retention at all
// while status_samples has had a 90-day prune since it was introduced — and the
// AI rate limiter later reused this table as its counter store, so it now takes a
// row per model call on top of every login and TOTP attempt.
describeIfDb('pruneAuthAttempts', () => {
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
    await sql`TRUNCATE auth_attempts CASCADE`;
  });

  async function seed(ageDays: number, n: number, now: Date): Promise<void> {
    const at = new Date(now.getTime() - ageDays * DAY_MS);
    await db.insert(schema.authAttempts).values(
      Array.from({ length: n }, () => ({
        scope: 'login' as const,
        identifier: 'someone@example.com',
        ipHash: null,
        succeeded: false,
        attemptedAt: at,
      })),
    );
  }
  const count = async (): Promise<number> =>
    (await db.select({ id: schema.authAttempts.id }).from(schema.authAttempts)).length;

  it('deletes rows past the retention window and keeps everything inside it', async () => {
    const now = new Date();
    await seed(AUTH_ATTEMPT_RETENTION_DAYS + 3, 5, now); // expired
    await seed(1, 4, now); // still inside every window that reads this table
    expect(await count()).toBe(9);

    expect(await pruneAuthAttempts(db, now)).toBe(5);
    expect(await count()).toBe(4);
  });

  it('is a no-op when nothing has expired, so an idle deployment does no work', async () => {
    const now = new Date();
    await seed(1, 3, now);
    expect(await pruneAuthAttempts(db, now)).toBe(0);
    expect(await count()).toBe(3);
  });

  it('drains in bounded batches — a first run on a huge table is never one delete', async () => {
    // The backlog case: this table has never been pruned, so the first sweep
    // could otherwise be a single enormous statement holding a long transaction.
    const now = new Date();
    await seed(AUTH_ATTEMPT_RETENTION_DAYS + 1, 25, now);

    expect(await pruneAuthAttempts(db, now, { limit: 10 })).toBe(10);
    expect(await pruneAuthAttempts(db, now, { limit: 10 })).toBe(10);
    expect(await pruneAuthAttempts(db, now, { limit: 10 })).toBe(5);
    expect(await pruneAuthAttempts(db, now, { limit: 10 })).toBe(0);
    expect(await count()).toBe(0);
  });
});
