import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BriefingGenerator, GenerateResult } from '../gemini.js';
import { buildApp } from '../../app.js';
import { SESSION_COOKIE } from '../../auth/session.js';
import { loadConfig } from '../../config.js';
import { PLAN_STEP_KINDS } from '../plan-prompt.js';
import { PLAN_INJECTION_CASES } from './corpus.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// End-to-end injection eval: a FakeGenerator feeds each adversarial PLAN output
// through the real /v1/ai/plan route; the response must never surface a
// non-allowlisted kind or a smuggled field (plan §0.6 — injected instructions
// inert, no forbidden effect reachable).
describeIfDb('injection corpus via the /v1/ai/plan route (FakeGenerator)', () => {
  let db: Database;
  let sql: Sql;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });
  const allowed = new Set<string>(PLAN_STEP_KINDS);

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  let app: FastifyInstance;
  afterEach(async () => {
    if (app !== undefined) await app.close();
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai_usage_daily, auth_attempts, ai_briefings, sessions, users CASCADE`;
  });

  function generatorReturning(output: string): BriefingGenerator {
    return {
      async generate(): Promise<GenerateResult> {
        return { text: output, usage: { inputTokens: 10, outputTokens: 10 } };
      },
    };
  }

  async function sessionCookie(email: string): Promise<{ [k: string]: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const { token } = await createSession(db, { userId: u!.id as UserId, now: new Date() });
    return { [SESSION_COOKIE]: token };
  }

  it.each(PLAN_INJECTION_CASES.map((c) => [c.name, c] as const))(
    'drops injected kinds: %s',
    async (_name, c) => {
      app = buildApp({ ...config, logLevel: 'silent' }, { db, sql, aiGenerator: generatorReturning(c.output) });
      await app.ready();
      const cookies = await sessionCookie(`plan-${Math.random().toString(36).slice(2)}@example.com`);
      const res = await app.inject({ method: 'GET', url: '/v1/ai/plan', cookies });
      expect(res.statusCode).toBe(200);
      const steps = (res.json().steps ?? []) as { kind: string }[];
      for (const step of steps) {
        expect(allowed.has(step.kind)).toBe(true);
        expect(Object.keys(step).sort()).toEqual(['kind', 'title', 'why']);
      }
      expect(steps.length).toBeLessThanOrEqual(c.maxValidSurviving);
    },
  );
});
