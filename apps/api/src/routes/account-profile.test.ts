import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('account display profile (name + honorific)', () => {
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
    expect((await app.inject({ method: 'GET', url: '/v1/account/me' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/account/profile',
          payload: { displayName: 'X', title: null },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('defaults to a null name/title and returns them on /me', async () => {
    const { cookie } = await session('me@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/account/me', cookies: cookie });
    expect(res.statusCode).toBe(200);
    // `locale` joined this response in migration 0067 (docs/40 Phase 1). null is
    // the honest default: the account has expressed no language preference, which
    // is not the same as having chosen English. Kept as an exact-shape assertion
    // — it is what caught the field being added.
    expect(res.json()).toEqual({
      email: 'me@example.com',
      displayName: null,
      title: null,
      locale: null,
    });
  });

  it('saves a name + honorific, trims it, and reflects it on /me', async () => {
    const { userId, cookie } = await session('save@example.com');
    const put = await app.inject({
      method: 'POST',
      url: '/v1/account/profile',
      cookies: cookie,
      payload: { displayName: '  Jane Doe  ', title: 'Mrs.' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ displayName: 'Jane Doe', title: 'Mrs.' });

    const me = await app.inject({ method: 'GET', url: '/v1/account/me', cookies: cookie });
    expect(me.json()).toMatchObject({ displayName: 'Jane Doe', title: 'Mrs.' });

    // The audit append rides the same transaction and records only whether the
    // fields are set — never the name value itself.
    const [row] = await db
      .select({ eventType: schema.auditLog.eventType, eventPayload: schema.auditLog.eventPayload })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(row?.eventType).toBe('account_profile_updated');
    expect(JSON.stringify(row?.eventPayload)).not.toContain('Jane');
  });

  it('normalizes an empty name to null (clearing it)', async () => {
    const { cookie } = await session('clear@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/account/profile',
      cookies: cookie,
      payload: { displayName: 'Temp', title: 'Dr.' },
    });
    const cleared = await app.inject({
      method: 'POST',
      url: '/v1/account/profile',
      cookies: cookie,
      payload: { displayName: '   ', title: null },
    });
    expect(cleared.json()).toEqual({ displayName: null, title: null });
  });

  it('rejects an unknown honorific and an over-long name', async () => {
    const { cookie } = await session('bad@example.com');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/account/profile',
          cookies: cookie,
          payload: { displayName: 'Jane', title: 'Captain' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/account/profile',
          cookies: cookie,
          payload: { displayName: 'x'.repeat(81), title: null },
        })
      ).statusCode,
    ).toBe(400);
  });
});
