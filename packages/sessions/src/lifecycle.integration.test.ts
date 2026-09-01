import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import {
  createSession,
  isStepUpFresh,
  resolveSession,
  revokeAllUserSessions,
  revokeSession,
} from './lifecycle.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;

describeIfDb('sessions lifecycle (integration)', () => {
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
    await sql`TRUNCATE sessions, device_registrations, users CASCADE`;
  });

  async function makeUser(
    email: string,
    accountStatus: 'pending' | 'active' | 'locked' = 'active',
  ): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('createSession stores only the hash; expiries follow the TTLs', async () => {
    const userId = await makeUser('a@example.com');
    const now = new Date('2026-05-01T00:00:00Z');
    const created = await createSession(db, { userId, now });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);

    const [row] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, created.id));
    expect(row).toBeDefined();
    expect(Buffer.from(row!.tokenHash)).toHaveLength(32);
    expect(row!.idleExpiresAt.getTime()).toBe(now.getTime() + 7 * DAY);
    expect(row!.absoluteExpiresAt.getTime()).toBe(now.getTime() + 30 * DAY);
  });

  it('resolveSession validates a good token and slides the idle window', async () => {
    const userId = await makeUser('b@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { token, id } = await createSession(db, { userId, now: t0 });

    const t1 = new Date(t0.getTime() + 2 * DAY);
    const ctx = await resolveSession(db, token, t1);
    expect(ctx).not.toBeNull();
    expect(ctx!.id).toBe(id);
    expect(ctx!.userId).toBe(userId);
    expect(ctx!.lastSeenAt.getTime()).toBe(t1.getTime());
    expect(ctx!.idleExpiresAt.getTime()).toBe(t1.getTime() + 7 * DAY);
  });

  it('resolveSession returns null for malformed and unknown tokens', async () => {
    expect(await resolveSession(db, 'not-a-real-token', new Date())).toBeNull();
    const unknown = Buffer.alloc(32, 7).toString('base64url');
    expect(await resolveSession(db, unknown, new Date())).toBeNull();
  });

  it('resolveSession never slides the idle window past the absolute cap', async () => {
    const userId = await makeUser('c@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { token } = await createSession(db, {
      userId,
      now: t0,
      idleTtlMs: 7 * DAY,
      absoluteTtlMs: DAY,
    });
    const t1 = new Date(t0.getTime() + 6 * 60 * 60 * 1000); // 6h in, still valid
    const ctx = await resolveSession(db, token, t1);
    expect(ctx).not.toBeNull();
    // idle would be t1 + 7d, but is clamped to the absolute cap t0 + 1d.
    expect(ctx!.idleExpiresAt.getTime()).toBe(t0.getTime() + DAY);
  });

  it('resolveSession returns null after idle expiry', async () => {
    const userId = await makeUser('d@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { token } = await createSession(db, {
      userId,
      now: t0,
      idleTtlMs: 60_000,
      absoluteTtlMs: 30 * DAY,
    });
    expect(await resolveSession(db, token, new Date(t0.getTime() + 120_000))).toBeNull();
  });

  it('resolveSession returns null after absolute expiry even if recently active', async () => {
    const userId = await makeUser('e@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { token } = await createSession(db, {
      userId,
      now: t0,
      idleTtlMs: 30 * DAY,
      absoluteTtlMs: DAY,
    });
    expect(await resolveSession(db, token, new Date(t0.getTime() + 2 * DAY))).toBeNull();
  });

  it('revokeSession invalidates the token and is idempotent', async () => {
    const userId = await makeUser('f@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { token, id } = await createSession(db, { userId, now: t0 });
    expect(await revokeSession(db, id, 'logout', t0)).toBe(true);
    expect(await resolveSession(db, token, new Date(t0.getTime() + 1000))).toBeNull();
    expect(await revokeSession(db, id, 'logout', t0)).toBe(false);
  });

  it('revokeAllUserSessions revokes all active, respecting exceptSessionId', async () => {
    const userId = await makeUser('g@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const a = await createSession(db, { userId, now: t0 });
    const b = await createSession(db, { userId, now: t0 });
    const c = await createSession(db, { userId, now: t0 });

    const revoked = await revokeAllUserSessions(db, userId, 'rotate', t0, c.id);
    expect(revoked).toBe(2);

    const t1 = new Date(t0.getTime() + 1000);
    expect(await resolveSession(db, a.token, t1)).toBeNull();
    expect(await resolveSession(db, b.token, t1)).toBeNull();
    expect(await resolveSession(db, c.token, t1)).not.toBeNull();
  });

  it('a stamped last_stepup_at surfaces through resolveSession for the freshness check', async () => {
    const userId = await makeUser('h@example.com');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { token, id } = await createSession(db, { userId, now: t0 });
    await db.update(schema.sessions).set({ lastStepupAt: t0 }).where(eq(schema.sessions.id, id));

    const ctx = await resolveSession(db, token, new Date(t0.getTime() + 60_000));
    expect(ctx).not.toBeNull();
    expect(isStepUpFresh(ctx!, new Date(t0.getTime() + 60_000))).toBe(true);
    expect(isStepUpFresh(ctx!, new Date(t0.getTime() + 11 * 60_000))).toBe(false);
  });
});
