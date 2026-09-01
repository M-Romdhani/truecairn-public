import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// No GEMINI_* env ⇒ aiBriefing.enabled === false, so these exercise the
// session-gating + the fail-soft (disabled) path for every AI surface without
// needing real Gemini credentials.
describeIfDb('ai routes (session-gated, fail-soft when AI not configured)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai_briefings, vault_items, contacts, engine_states, sessions, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function session(email: string): Promise<{ [k: string]: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const { token } = await createSession(db, { userId: u!.id as UserId, now: new Date() });
    return { [SESSION_COOKIE]: token };
  }

  it('assist / draft-invite / plan all require a session', async () => {
    const a = await app.inject({ method: 'POST', url: '/v1/ai/assist', payload: { question: 'hi' } });
    const d = await app.inject({ method: 'POST', url: '/v1/ai/draft-invite', payload: { role: 'personal' } });
    const p = await app.inject({ method: 'GET', url: '/v1/ai/plan' });
    expect(a.statusCode).toBe(401);
    expect(d.statusCode).toBe(401);
    expect(p.statusCode).toBe(401);
  });

  it('assist is fail-soft (200, answer null) when AI is disabled', async () => {
    const cookies = await session('ai-assist@example.com');
    const res = await app.inject({ method: 'POST', url: '/v1/ai/assist', cookies, payload: { question: 'How does this work?' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBeNull();
    expect(res.json().reason).toBe('disabled');
  });

  it('draft-invite is fail-soft (200, message null) when AI is disabled', async () => {
    const cookies = await session('ai-invite@example.com');
    const res = await app.inject({ method: 'POST', url: '/v1/ai/draft-invite', cookies, payload: { role: 'recovery' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBeNull();
    expect(res.json().reason).toBe('disabled');
  });

  it('plan is fail-soft (200, empty steps) when AI is disabled', async () => {
    const cookies = await session('ai-plan@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/ai/plan', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().steps).toEqual([]);
    expect(res.json().reason).toBe('disabled');
  });

  it('draft-invite rejects an invalid role (schema validation)', async () => {
    const cookies = await session('ai-badrole@example.com');
    const res = await app.inject({ method: 'POST', url: '/v1/ai/draft-invite', cookies, payload: { role: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
});
