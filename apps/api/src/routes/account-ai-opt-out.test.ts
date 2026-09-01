import { verifyChain } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('AI opt-out settings endpoints', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE audit_log, audit_log_locks, sessions, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function session(email: string): Promise<{ userId: UserId; cookie: { [k: string]: string } }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: { [SESSION_COOKIE]: token } };
  }

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/account/ai-settings' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/account/ai-opt-out', payload: { optOut: true } }))
        .statusCode,
    ).toBe(401);
  });

  it('defaults to opted-in, toggles on, and persists', async () => {
    const { userId, cookie } = await session('opt@example.com');
    const before = await app.inject({ method: 'GET', url: '/v1/account/ai-settings', cookies: cookie });
    expect(before.json().optOut).toBe(false);

    const set = await app.inject({
      method: 'POST',
      url: '/v1/account/ai-opt-out',
      cookies: cookie,
      payload: { optOut: true },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().optOut).toBe(true);

    const [row] = await db
      .select({ optOut: schema.users.aiOptOut })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(row!.optOut).toBe(true);

    const after = await app.inject({ method: 'GET', url: '/v1/account/ai-settings', cookies: cookie });
    expect(after.json().optOut).toBe(true);
  });

  it('writes an ai_config_changed audit event (actor=owner) that keeps the chain valid', async () => {
    const { userId, cookie } = await session('opt-audit@example.com');
    await app.inject({ method: 'POST', url: '/v1/account/ai-opt-out', cookies: cookie, payload: { optOut: true } });
    const [ev] = await db
      .select({ eventType: schema.auditLog.eventType, actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_config_changed')));
    expect(ev!.actor).toBe('owner');
    const verified = await verifyChain(db, userId);
    expect(verified.ok).toBe(true);
  });

  it('rejects a malformed body (wrong type / missing field)', async () => {
    const { cookie } = await session('opt-bad@example.com');
    const wrongType = await app.inject({
      method: 'POST',
      url: '/v1/account/ai-opt-out',
      cookies: cookie,
      payload: { optOut: 'yes' },
    });
    expect(wrongType.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/account/ai-opt-out',
      cookies: cookie,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
  });

  it('is scoped to the session user (A cannot change B)', async () => {
    const a = await session('opt-a@example.com');
    const b = await session('opt-b@example.com');
    await app.inject({ method: 'POST', url: '/v1/account/ai-opt-out', cookies: a.cookie, payload: { optOut: true } });
    // B's flag is untouched.
    const [rowB] = await db
      .select({ optOut: schema.users.aiOptOut })
      .from(schema.users)
      .where(eq(schema.users.id, b.userId));
    expect(rowB!.optOut).toBe(false);
  });
});

describeIfDb('AI autonomy settings endpoints', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE audit_log, audit_log_locks, sessions, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function session(email: string): Promise<{ userId: UserId; cookie: { [k: string]: string } }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: { [SESSION_COOKIE]: token } };
  }

  it('defaults to disabled + no floor', async () => {
    const { cookie } = await session('auton-def@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/account/ai-autonomy', cookies: cookie });
    expect(res.json()).toEqual({ enabled: false, checkinFloorDays: null });
  });

  it('opts in with a floor and persists', async () => {
    const { userId, cookie } = await session('auton-set@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/ai-autonomy',
      cookies: cookie,
      payload: { enabled: true, checkinFloorDays: 14 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, checkinFloorDays: 14 });
    const [row] = await db
      .select({ enabled: schema.users.aiAutonomyEnabled, floor: schema.users.aiCheckinFloorDays })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(row).toEqual({ enabled: true, floor: 14 });
  });

  it('clears the floor with null (nudges only)', async () => {
    const { cookie } = await session('auton-clear@example.com');
    await app.inject({ method: 'POST', url: '/v1/account/ai-autonomy', cookies: cookie, payload: { enabled: true, checkinFloorDays: 30 } });
    const res = await app.inject({ method: 'POST', url: '/v1/account/ai-autonomy', cookies: cookie, payload: { enabled: true, checkinFloorDays: null } });
    expect(res.json().checkinFloorDays).toBeNull();
  });

  it('rejects a floor below 1 (schema)', async () => {
    const { cookie } = await session('auton-bad@example.com');
    const res = await app.inject({ method: 'POST', url: '/v1/account/ai-autonomy', cookies: cookie, payload: { enabled: true, checkinFloorDays: 0 } });
    expect(res.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/account/ai-autonomy' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/account/ai-autonomy', payload: { enabled: true } })).statusCode).toBe(401);
  });
});
