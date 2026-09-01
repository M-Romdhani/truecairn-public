import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession, revokeSession } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { eq } from 'drizzle-orm';
import { requireSession, requireSessionAllowingLocked, SESSION_COOKIE } from './session.js';

// A protected route registered per-test to exercise the middleware (the same
// throwaway-route approach app.test.ts uses).
function protect(app: FastifyInstance): void {
  app.get('/protected', { preHandler: requireSession }, async (request) => ({
    userId: request.session?.userId ?? null,
  }));
}

describe('requireSession (fails closed without a DB backend)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('returns a 401 problem when no session backend is available', async () => {
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' });
    protect(app);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('requireSession (integration)', () => {
  let app: FastifyInstance;
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
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql });
    protect(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function makeUser(
    email: string,
    accountStatus: 'pending' | 'active' | 'locked' | 'terminated' = 'active',
  ): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('401 when no cookie is presented', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('401 for a malformed/unknown session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE]: 'garbage' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('200 with request.session populated for a valid session', async () => {
    const userId = await makeUser('a@example.com');
    const { token } = await createSession(db, { userId, now: new Date() });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId });
  });

  it('401 after the session is revoked', async () => {
    const userId = await makeUser('b@example.com');
    const { token, id } = await createSession(db, { userId, now: new Date() });
    await revokeSession(db, id, 'logout', new Date());
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 when the account is locked', async () => {
    const userId = await makeUser('c@example.com', 'locked');
    const { token } = await createSession(db, { userId, now: new Date() });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
  });

  // 2026-08-07 security audit, finding 1. An account lock is set over an
  // UNAUTHENTICATED route keyed on an email, so everything here is reachable by
  // anyone who knows the owner's address.
  describe('account lock (audit finding 1)', () => {
    async function lock(userId: UserId, until: Date | null): Promise<void> {
      await db
        .update(schema.users)
        .set({ accountStatus: 'locked', lockedUntil: until })
        .where(eq(schema.users.id, userId));
    }

    it('carries the unlock time so the client can explain the 403', async () => {
      const userId = await makeUser('lock1@example.com');
      await lock(userId, new Date(Date.now() + 30 * 60 * 1000));
      const { token } = await createSession(db, { userId, now: new Date() });
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json() as { retryAfterSeconds?: number };
      // Previously a bare forbidden with no extension: the client could not tell
      // the user why they were blocked or for how long.
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);
    });

    it('self-heals an ELAPSED lock instead of leaving the owner stuck forever', async () => {
      // The expiry used to run only in the password login route, so a
      // passkey-only owner stayed locked in the DB indefinitely past the hour.
      const userId = await makeUser('lock2@example.com');
      await lock(userId, new Date(Date.now() - 1000));
      const { token } = await createSession(db, { userId, now: new Date() });
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(res.statusCode).toBe(200);
      const [row] = await db
        .select({ status: schema.users.accountStatus, until: schema.users.lockedUntil })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      expect(row?.status).toBe('active');
      expect(row?.until).toBeNull();
    });

    it('does NOT clear a lock with no expiry recorded (fails closed)', async () => {
      // Only reachable by a hand-set row. Nothing here can prove such a lock has
      // run out, so it must not be cleared on the owner's behalf.
      const userId = await makeUser('lock3@example.com');
      await lock(userId, null);
      const { token } = await createSession(db, { userId, now: new Date() });
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(res.statusCode).toBe(403);
      const [row] = await db
        .select({ status: schema.users.accountStatus })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      expect(row?.status).toBe('locked');
    });
  });
});

// The liveness carve-out. Kept in its own app so the throwaway route is mounted
// with the permissive guard while everything above keeps the strict one.
describeIfDb('requireSessionAllowingLocked (integration)', () => {
  let app: FastifyInstance;
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
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql });
    app.get('/liveness', { preHandler: requireSessionAllowingLocked }, async (request) => ({
      userId: request.session?.userId ?? null,
    }));
    app.get('/strict', { preHandler: requireSession }, async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function lockedUser(email: string): Promise<string> {
    const [u] = await db
      .insert(schema.users)
      .values({
        email,
        accountStatus: 'locked',
        lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    const { token } = await createSession(db, { userId: u.id as UserId, now: new Date() });
    return token;
  }

  it('admits a locked account, so the owner can still prove they are alive', async () => {
    // The whole point: this product releases a vault when its owner goes silent,
    // and an attacker who knows an email can hold the lock on. Denying check-in
    // to a locked account let them simulate the owner's death from outside.
    const token = await lockedUser('live1@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/liveness',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still refuses that same session everywhere else', async () => {
    // The negative half, and as much the point as the positive one: being locked
    // out of the VAULT is correct behaviour and must survive the carve-out.
    const token = await lockedUser('live2@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/strict',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
  });

  it('still requires a valid session — locked is not a way in', async () => {
    const res = await app.inject({ method: 'GET', url: '/liveness' });
    expect(res.statusCode).toBe(401);
  });
});
