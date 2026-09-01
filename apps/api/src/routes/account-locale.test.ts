import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

// The stored language preference (docs/40 Phase 1, migration 0067). It exists so
// the WORKER can render the 13 transactional templates in the right language —
// there is no request and no Accept-Language header at that moment — and so a
// preference follows a user to a second device.

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('account locale preference', () => {
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
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/account/locale',
          payload: { locale: 'es' },
        })
      ).statusCode,
    ).toBe(401);
  });

  // NULL, not 'en'. A new account has expressed no preference, and the
  // difference matters: a default would record every existing account as having
  // CHOSEN English, which stops being cosmetic the moment we want to honour a
  // browser's language without overriding a deliberate choice.
  it('reports null for an account that has never chosen', async () => {
    const { cookie } = await session('never-chose@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/account/me', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().locale).toBeNull();
  });

  it('stores a chosen language and reads it back', async () => {
    const { userId, cookie } = await session('chooser@example.com');
    const set = await app.inject({
      method: 'POST',
      url: '/v1/account/locale',
      cookies: cookie,
      payload: { locale: 'es' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ locale: 'es' });

    const me = await app.inject({ method: 'GET', url: '/v1/account/me', cookies: cookie });
    expect(me.json().locale).toBe('es');

    const [row] = await db
      .select({ locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    expect(row?.locale).toBe('es');
  });

  // Refused at the JSON schema as a 400, so an unknown tag can never reach the
  // users_locale_vocabulary CHECK and surface as a 500 on someone's settings page.
  it('refuses a language outside the vocabulary', async () => {
    const { cookie } = await session('unknown-tag@example.com');
    for (const locale of ['fr', 'es-MX', '', 'EN']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/account/locale',
        cookies: cookie,
        payload: { locale },
      });
      expect(res.statusCode, `expected 400 for ${JSON.stringify(locale)}`).toBe(400);
    }
  });

  // additionalProperties:false under Fastify's default AJV STRIPS unknown
  // properties rather than rejecting the request (the same behaviour
  // channels.test.ts documents). What matters is therefore not the status code
  // but that the stray field is INERT: this route may write `locale` and nothing
  // else, so a smuggled displayName must not reach the users row.
  it('ignores unknown body fields instead of writing them', async () => {
    const { userId, cookie } = await session('extra-fields@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/locale',
      cookies: cookie,
      payload: { locale: 'es', displayName: 'smuggled', accountStatus: 'terminated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locale: 'es' });

    const [row] = await db
      .select({
        locale: schema.users.locale,
        displayName: schema.users.displayName,
        accountStatus: schema.users.accountStatus,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    expect(row?.locale).toBe('es');
    expect(row?.displayName).toBeNull();
    expect(row?.accountStatus).toBe('active');
  });

  // CLAUDE.md invariant #5: the audit append rides the same transaction as the
  // state change it records.
  it('audits the change in the same transaction', async () => {
    const { userId, cookie } = await session('audited@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/account/locale',
      cookies: cookie,
      payload: { locale: 'es' },
    });
    const rows = await db
      .select({ eventType: schema.auditLog.eventType, payload: schema.auditLog.eventPayload })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    const entry = rows.find((r) => r.eventType === 'account_profile_updated');
    expect(entry, 'no audit entry for the locale change').toBeDefined();
    expect(entry!.payload).toMatchObject({ setting: 'locale', value: 'es' });
  });

  // One account's preference must never be readable or writable through another's
  // session — the same cross-user scoping every account route is held to.
  it('scopes the preference to the calling session', async () => {
    const a = await session('a@example.com');
    const b = await session('b@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/account/locale',
      cookies: a.cookie,
      payload: { locale: 'es' },
    });
    const meB = await app.inject({ method: 'GET', url: '/v1/account/me', cookies: b.cookie });
    expect(meB.json().locale).toBeNull();
  });
});
