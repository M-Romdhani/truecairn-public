import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AiError, type BriefingGenerator, type GenerateResult } from '../ai/gemini.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { resolveBriefing } from './briefing.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const MODEL = 'gemini-2.5-flash';

describeIfDb('briefing endpoint + resolveBriefing', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  // No GEMINI_* env ⇒ aiBriefing.enabled === false (the disabled fail-soft path).
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

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });
  // A generation result with token usage (the interface now returns { text, usage }).
  const ok = (text: string): GenerateResult => ({ text, usage: { inputTokens: 8, outputTokens: 8 } });

  it('GET /v1/briefing without a session is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/briefing' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/briefing is fail-soft (200, briefing null) when AI is not configured', async () => {
    const userId = await makeUser('b-disabled@example.com');
    const { token } = await createSession(db, { userId, now: new Date() });
    const res = await app.inject({ method: 'GET', url: '/v1/briefing', cookies: as(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().briefing).toBeNull();
    expect(res.json().reason).toBe('disabled');
  });

  // resolveBriefing is exercised directly with a FAKE generator — no SDK, no
  // network — so the cache + fail-soft logic is covered without real Gemini creds.
  it('generates, caches, and reuses within TTL (no second model call)', async () => {
    const userId = await makeUser('b-cache@example.com');
    let calls = 0;
    const gen: BriefingGenerator = {
      generate: async () => {
        calls += 1;
        return ok('Looking healthy. Next: enrol a second contact.');
      },
    };
    const r1 = await resolveBriefing(db, gen, userId, MODEL, new Date());
    expect(r1.briefing).toContain('second contact');
    expect(r1.stale).toBe(false);
    expect(calls).toBe(1);

    const [row] = await db
      .select()
      .from(schema.aiBriefings)
      .where(eq(schema.aiBriefings.userId, userId));
    expect(row!.briefingText).toContain('second contact');
    expect(row!.model).toBe(MODEL);

    const r2 = await resolveBriefing(db, gen, userId, MODEL, new Date());
    expect(r2.briefing).toBe(r1.briefing);
    expect(r2.stale).toBe(false);
    expect(calls).toBe(1); // served from cache — the model was not called again
  });

  it('fail-soft: null/unavailable when the model errors and there is no cache', async () => {
    const userId = await makeUser('b-failsoft@example.com');
    const gen: BriefingGenerator = {
      generate: async () => {
        throw new AiError('model down', true);
      },
    };
    const r = await resolveBriefing(db, gen, userId, MODEL, new Date());
    expect(r.briefing).toBeNull();
    expect(r.reason).toBe('unavailable');
  });

  it('fail-soft: serves the stale cached briefing when a regen errors', async () => {
    const userId = await makeUser('b-stale@example.com');
    const t0 = new Date('2026-06-01T00:00:00.000Z');
    await resolveBriefing(db, { generate: async () => ok('First briefing.') }, userId, MODEL, t0);

    // 7h later: past the 6h TTL ⇒ a regen is attempted; the model errors ⇒ the
    // last briefing is served, flagged stale, instead of breaking the dashboard.
    const t1 = new Date(t0.getTime() + 7 * 60 * 60 * 1000);
    const throwing: BriefingGenerator = {
      generate: async () => {
        throw new AiError('down', true);
      },
    };
    const r = await resolveBriefing(db, throwing, userId, MODEL, t1);
    expect(r.briefing).toBe('First briefing.');
    expect(r.stale).toBe(true);
  });
});
