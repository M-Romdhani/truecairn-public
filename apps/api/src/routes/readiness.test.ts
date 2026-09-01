import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BriefingGenerator, GenerateResult } from '../ai/gemini.js';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('GET /v1/ai/readiness', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let genCalls: number;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  afterEach(async () => {
    await app.close();
  });

  function boot(env: Record<string, string>, withGenerator: boolean): void {
    genCalls = 0;
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64'), ...env });
    const gen: BriefingGenerator = {
      async generate(): Promise<GenerateResult> {
        genCalls += 1;
        return { text: 'AI: add a professional contact to your S3 group.', usage: { inputTokens: 20, outputTokens: 20 } };
      },
    };
    app = buildApp(
      { ...config, logLevel: 'silent' },
      { db, sql, ...(withGenerator ? { aiGenerator: gen } : {}) },
    );
  }

  beforeEach(async () => {
    await sql`TRUNCATE ai_readiness, ai_usage_daily, auth_attempts, release_shares, outer_layer_keys, vault_items, contacts, engine_states, sessions, users CASCADE`;
  });

  async function seedS3DiversityCase(email: string): Promise<{ [k: string]: string }> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const [k] = await db
      .insert(schema.outerLayerKeys)
      .values({ userId, tier: 's3', kekId: 'k', outerKeyEncrypted: Buffer.alloc(32, 9), outerKeyNonce: Buffer.alloc(24, 9), outerKeyEncryptionAad: Buffer.alloc(8, 9), generation: 1 })
      .returning({ id: schema.outerLayerKeys.id });
    await db.insert(schema.vaultItems).values({
      userId, tier: 's3', category: 'personal_archive', outerLayerKeyId: k!.id, outerKekId: 'k', outerGeneration: 1,
      outerCiphertext: Buffer.alloc(8, 1), outerNonce: Buffer.alloc(24, 2), titleCiphertext: Buffer.alloc(8, 3), titleNonce: Buffer.alloc(24, 4), contentSizeBytes: 8,
    });
    // Three enrolled contacts, ALL personal, each holding an S3 contact share.
    for (let idx = 1; idx <= 3; idx++) {
      const [c] = await db
        .insert(schema.contacts)
        .values({ ownerUserId: userId, role: 'personal', status: 'enrolled', displayLabelCiphertext: Buffer.alloc(8, 5), displayLabelNonce: Buffer.alloc(24, 6) })
        .returning({ id: schema.contacts.id });
      await db.insert(schema.releaseShares).values({ userId, tier: 's3', shareIndex: idx, shareType: 'contact', contactId: c!.id, wrappedShareCiphertext: Buffer.alloc(16, 7) });
    }
    const { token } = await createSession(db, { userId, now: new Date() });
    return { [SESSION_COOKIE]: token };
  }

  it('is 401 without a session', async () => {
    boot({ AI_PROPOSER_ENABLED: 'true' }, true);
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/v1/ai/readiness' })).statusCode).toBe(401);
  });

  it('returns the disabled response when AI_PROPOSER_ENABLED is off', async () => {
    boot({ AI_PROPOSER_ENABLED: 'false' }, true);
    await app.ready();
    const cookies = await seedS3DiversityCase('rd-off@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/ai/readiness', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('disabled');
    expect(res.json().gaps).toEqual([]);
    expect(genCalls).toBe(0);
  });

  it('flag on + generator: returns the S3 diversity gap with an LLM explanation', async () => {
    boot({ AI_PROPOSER_ENABLED: 'true' }, true);
    await app.ready();
    const cookies = await seedS3DiversityCase('rd-llm@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/ai/readiness', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gaps.map((g: { code: string }) => g.code)).toContain('s3_role_diversity_unsatisfiable');
    expect(body.llmWritten).toBe(true);
    expect(body.explanation).toContain('professional contact');
    expect(genCalls).toBe(1);
  });

  it('caches: a second call within TTL does not re-invoke the model', async () => {
    boot({ AI_PROPOSER_ENABLED: 'true' }, true);
    await app.ready();
    const cookies = await seedS3DiversityCase('rd-cache@example.com');
    await app.inject({ method: 'GET', url: '/v1/ai/readiness', cookies });
    await app.inject({ method: 'GET', url: '/v1/ai/readiness', cookies });
    expect(genCalls).toBe(1); // served from cache the second time
  });

  it('no generator (AI off): deterministic gaps + template explanation, llmWritten false', async () => {
    boot({ AI_PROPOSER_ENABLED: 'true' }, false);
    await app.ready();
    const cookies = await seedS3DiversityCase('rd-template@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/ai/readiness', cookies });
    const body = res.json();
    expect(body.gaps.map((g: { code: string }) => g.code)).toContain('s3_role_diversity_unsatisfiable');
    expect(body.llmWritten).toBe(false);
    expect(body.explanation.length).toBeGreaterThan(0); // template still explains
  });
});
