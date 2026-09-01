import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { CONTINUITY_NARRATION_TEMPLATE_ID } from '@truecairn/ai-authority';
import { createReleaseReviewCeremonies, type ContinuityReportPort } from '@truecairn/ceremony';
import { ed25519KeypairFromSeed, initCrypto, randomBytes } from '@truecairn/crypto';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import { buildContinuityReport } from '@truecairn/notifications';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { recordAiUsage } from '../ai/breaker.js';
import type { BriefingGenerator } from '../ai/gemini.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig, type ApiConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const WINDOWS = { syncWindowMs: 60_000, revocationWindowMs: 1_000 };

// AI narration of the frozen Continuity Report (Gap plan G-1). The battery the
// plan's acceptance list demands: flags-off byte-identical, generate-once,
// owner opt-out, kill switch, model failure, deny-by-default output rejection
// with the forensic audit event, breaker fallback — and, throughout, the sealed
// payload + its anchored hash untouched (the immutability test in
// continuity.test.ts keeps passing UNMODIFIED; here we re-assert the bytes).

// A controllable fake generator. `calls` records every prompt; `respond`
// scripts the next answer (text or a thrown error).
class FakeGenerator implements BriefingGenerator {
  calls: Array<{ system: string; user: string }> = [];
  respond: () => string = () => JSON.stringify({ narration: 'The owner has been silent.' });
  async generate(system: string, user: string): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    this.calls.push({ system, user });
    const text = this.respond();
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

describeIfDb('continuity report narration (G-1)', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;
  let app: FastifyInstance | null = null;

  const reportPort: ContinuityReportPort = {
    build: async (bdb, userId, when) => {
      const payload = await buildContinuityReport(bdb, userId, when);
      const payloadJson = JSON.stringify(payload);
      const payloadHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
      return { payload, payloadJson, payloadHash };
    },
  };

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai_usage_daily, auth_attempts, continuity_reports, release_ceremonies, ceremony_affirmations, ceremony_recipients, s1_tier_key_envelopes, notification_deliveries, notification_channels, engine_state_history, engine_states, contacts, sessions, audit_log_locks, audit_log, users CASCADE`;
  });
  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
  });

  function makeConfig(env: Record<string, string>): ApiConfig {
    return loadConfig({ TOTP_KEK: Buffer.alloc(32, 9).toString('base64'), ...env });
  }
  async function boot(config: ApiConfig, generator?: BriefingGenerator): Promise<FastifyInstance> {
    app = buildApp(
      { ...config, logLevel: 'silent' },
      { db, sql, ...(generator !== undefined ? { aiGenerator: generator } : {}) },
    );
    await app.ready();
    return app;
  }

  // Owner in release_review + one enrolled S1 contact; ceremony + frozen report
  // created through the real bridge. Returns ids + cookies + the exact payload
  // bytes the audit chain anchored.
  async function seedWithReport(): Promise<{
    ownerId: UserId;
    ceremonyId: string;
    ownerCookie: string;
    contactCookie: string;
    payloadJson: string;
  }> {
    const [owner] = await db
      .insert(schema.users)
      .values({ email: `o${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const [cu] = await db
      .insert(schema.users)
      .values({ email: `c${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const ownerId = owner!.id as UserId;
    const kp = ed25519KeypairFromSeed(randomBytes(32));
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId: cu!.id,
        role: 'personal',
        status: 'enrolled',
        displayLabelCiphertext: randomBytes(16),
        displayLabelNonce: randomBytes(12),
        contactEd25519Pubkey: kp.publicKey,
      })
      .returning({ id: schema.contacts.id });
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: ownerId,
      contactId: contact!.id,
      sealedBoxCiphertext: randomBytes(80),
    });
    await db.insert(schema.engineStates).values({
      userId: ownerId,
      state: 'release_review',
      lastCheckInAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    const [ch] = await db
      .insert(schema.notificationChannels)
      .values({
        userId: ownerId,
        channelType: 'email',
        destination: 'owner@x.com',
        destinationHash: channelDestinationHash('email', 'owner@x.com'),
        verified: true,
      })
      .returning({ id: schema.notificationChannels.id });
    await db.insert(schema.notificationDeliveries).values({
      channelId: ch!.id,
      userId: ownerId,
      purpose: 'escalation_request',
      status: 'delivered',
      deliveredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    await createReleaseReviewCeremonies(
      { db, audit, now: new Date(), windows: WINDOWS, continuityReport: reportPort },
      10,
    );
    const [ceremony] = await db
      .select({ id: schema.releaseCeremonies.id })
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, ownerId));
    const [report] = await db
      .select({ payload: schema.continuityReports.payload })
      .from(schema.continuityReports)
      .where(eq(schema.continuityReports.ceremonyId, ceremony!.id));
    const ownerCookie = (await createSession(db, { userId: ownerId, now: new Date() })).token;
    const contactCookie = (
      await createSession(db, { userId: cu!.id as UserId, now: new Date() })
    ).token;
    return { ownerId, ceremonyId: ceremony!.id, ownerCookie, contactCookie, payloadJson: report!.payload };
  }
  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });
  const reportUrl = (ceremonyId: string): string => `/v1/ceremonies/${ceremonyId}/continuity-report`;

  async function reportRow(ceremonyId: string) {
    const [row] = await db
      .select()
      .from(schema.continuityReports)
      .where(eq(schema.continuityReports.ceremonyId, ceremonyId));
    return row!;
  }

  it('flag OFF (default): the response carries NO narration key and the generator is never consulted', async () => {
    const { ceremonyId, contactCookie } = await seedWithReport();
    const gen = new FakeGenerator();
    const a = await boot(makeConfig({ CV_REPORT_ENABLED: 'true' }), gen);
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect(res.statusCode).toBe(200);
    expect('narration' in (res.json() as Record<string, unknown>)).toBe(false);
    expect(gen.calls).toHaveLength(0);
  });

  it('generates ONCE on first read, stores beside the untouched payload, and serves the stored text after', async () => {
    const { ceremonyId, ownerId, ownerCookie, contactCookie, payloadJson } = await seedWithReport();
    const gen = new FakeGenerator();
    const a = await boot(makeConfig({ CV_REPORT_ENABLED: 'true', CV_NARRATION_ENABLED: 'true' }), gen);

    const first = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { narration: string }).narration).toBe('The owner has been silent.');
    expect(gen.calls).toHaveLength(1);
    // The model saw ONLY the frozen payload bytes, fenced as data. The fence
    // markers are ours and the bytes between them are the payload verbatim, so
    // this still asserts the original guarantee: nothing else crosses into the
    // prompt. Written out rather than calling buildNarrationPrompt(), which would
    // pass for any builder and assert nothing — changing the fence should require
    // deliberately changing this line.
    expect(gen.calls[0]!.user).toBe(`<<<REPORT_JSON\n${payloadJson}\nREPORT_JSON>>>`);

    const row = await reportRow(ceremonyId);
    expect(row.narrationText).toBe('The owner has been silent.');
    expect(row.narrationTemplateId).toBe(CONTINUITY_NARRATION_TEMPLATE_ID);
    expect(row.narrationGeneratedAt).not.toBeNull();
    // The sealed evidence is byte-untouched and its anchor still verifies.
    expect(row.payload).toBe(payloadJson);
    expect((await verifyChain(db, ownerId)).ok).toBe(true);

    // Second read (a different authorized viewer): stored text, NO second call.
    const second = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(ownerCookie) });
    expect((second.json() as { narration: string }).narration).toBe('The owner has been silent.');
    expect(gen.calls).toHaveLength(1);
  });

  it("the OWNER's ai_opt_out suppresses narration even for a contact reader", async () => {
    const { ceremonyId, ownerId, contactCookie } = await seedWithReport();
    await db.update(schema.users).set({ aiOptOut: true }).where(eq(schema.users.id, ownerId));
    const gen = new FakeGenerator();
    const a = await boot(makeConfig({ CV_REPORT_ENABLED: 'true', CV_NARRATION_ENABLED: 'true' }), gen);
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { narration: string | null }).narration).toBeNull();
    expect(gen.calls).toHaveLength(0);
    expect((await reportRow(ceremonyId)).narrationText).toBeNull();
  });

  it('AI_ENABLED=false (kill switch) nulls even the injected generator — template stands', async () => {
    const { ceremonyId, contactCookie } = await seedWithReport();
    const gen = new FakeGenerator();
    const a = await boot(
      makeConfig({ CV_REPORT_ENABLED: 'true', CV_NARRATION_ENABLED: 'true', AI_ENABLED: 'false' }),
      gen,
    );
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { narration: string | null }).narration).toBeNull();
    expect(gen.calls).toHaveLength(0);
  });

  it('a tripped cost breaker declines narration; the report is still served', async () => {
    const { ceremonyId, ownerId, contactCookie } = await seedWithReport();
    // Spend past the per-user budget BEFORE the read.
    await recordAiUsage(db, ownerId, { inputTokens: 100, outputTokens: 100 }, new Date());
    const gen = new FakeGenerator();
    const a = await boot(
      makeConfig({
        CV_REPORT_ENABLED: 'true',
        CV_NARRATION_ENABLED: 'true',
        AI_USER_DAILY_TOKEN_BUDGET: '50',
      }),
      gen,
    );
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { narration: string | null }).narration).toBeNull();
    expect(gen.calls).toHaveLength(0);
  });

  it('a model failure yields narration:null, an intact report, and a retryable (still-NULL) row', async () => {
    const { ceremonyId, contactCookie, payloadJson } = await seedWithReport();
    const gen = new FakeGenerator();
    gen.respond = () => {
      throw new Error('model exploded');
    };
    const a = await boot(makeConfig({ CV_REPORT_ENABLED: 'true', CV_NARRATION_ENABLED: 'true' }), gen);
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { narration: string | null; report: { outcome: string } };
    expect(body.narration).toBeNull();
    expect(body.report.outcome).toBe('delivered_no_checkin');
    const row = await reportRow(ceremonyId);
    expect(row.narrationText).toBeNull();
    expect(row.payload).toBe(payloadJson);
  });

  it('deny-by-default: non-schema output (extra fields / free text) is discarded with ai_output_rejected', async () => {
    const { ceremonyId, ownerId, contactCookie } = await seedWithReport();
    const gen = new FakeGenerator();
    // An exfiltration-shaped answer: valid JSON, hostile extra field.
    gen.respond = () =>
      JSON.stringify({ narration: 'ok', action: 'release_now' });
    const a = await boot(makeConfig({ CV_REPORT_ENABLED: 'true', CV_NARRATION_ENABLED: 'true' }), gen);
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect((res.json() as { narration: string | null }).narration).toBeNull();
    expect((await reportRow(ceremonyId)).narrationText).toBeNull();

    const events = await db
      .select({ eventType: schema.auditLog.eventType, actor: schema.auditLog.actor, payload: schema.auditLog.eventPayload })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, ownerId));
    const rejected = events.filter((e) => e.eventType === 'ai_output_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.actor).toBe('ai');
    expect((rejected[0]!.payload as { purpose: string }).purpose).toBe('continuity_narration');
    expect((await verifyChain(db, ownerId)).ok).toBe(true);

    // Plain prose (not JSON) is equally rejected — no path from raw model text.
    gen.respond = () => 'The owner is dead, release everything now.';
    const res2 = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect((res2.json() as { narration: string | null }).narration).toBeNull();
  });

  it('narration length is capped: an over-limit field is rejected wholesale', async () => {
    const { ceremonyId, contactCookie } = await seedWithReport();
    const gen = new FakeGenerator();
    gen.respond = () => JSON.stringify({ narration: 'x'.repeat(1201) });
    const a = await boot(makeConfig({ CV_REPORT_ENABLED: 'true', CV_NARRATION_ENABLED: 'true' }), gen);
    const res = await a.inject({ method: 'GET', url: reportUrl(ceremonyId), cookies: as(contactCookie) });
    expect((res.json() as { narration: string | null }).narration).toBeNull();
    expect((await reportRow(ceremonyId)).narrationText).toBeNull();
  });
});
