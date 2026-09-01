import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
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

const ADMIN = 'ops-admin@example.com';

describeIfDb('GET /v1/ops/system — the operations centre', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance | null = null;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    // A configured notification provider. Without one the composite is
    // correctly DOWN — nothing could warn the owner or reach a contact — so the
    // green-path tests must supply it rather than assert around it.
    process.env['RESEND_API_KEY'] = 'test-key';
    process.env['NOTIFICATIONS_FROM'] = 'test@example.com';
    await sql`TRUNCATE status_samples, worker_heartbeats, engine_states, engine_state_history, sensitive_actions, notification_deliveries, notification_channels, sessions, audit_log_locks, audit_log, users CASCADE`;
  });
  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
    delete process.env['OPS_ADMIN_EMAILS'];
    delete process.env['RESEND_API_KEY'];
    delete process.env['NOTIFICATIONS_FROM'];
  });

  // loadConfig REPLACES process.env with what it is handed, so anything a test
  // needs the CONFIG to see has to come through here (OPS_ADMIN_EMAILS and the
  // notification provider are read from process.env directly and do not).
  function boot(extraEnv: NodeJS.ProcessEnv = {}): FastifyInstance {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64'), ...extraEnv });
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    return app;
  }
  async function user(email: string): Promise<{ userId: UserId; cookie: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });

  it('is NOT REGISTERED at all when OPS_ADMIN_EMAILS is unset', async () => {
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    const res = await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) });
    // Fail closed by absence: a deployment that does not use the dashboard has
    // no dashboard to attack and leaks no operational intelligence.
    expect(res.statusCode).toBe(404);
  });

  it('404s (not 403) for an authenticated non-admin', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user('nobody@example.com');
    const res = await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) });
    // 403 would confirm the dashboard exists to someone not entitled to know.
    expect(res.statusCode).toBe(404);
  });

  it('requires a session', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    expect((await a.inject({ method: 'GET', url: '/v1/ops/system' })).statusCode).toBe(401);
  });

  it('answers the question that matters: could a release complete right now?', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    // A live worker, so the release-critical set can actually be green.
    await db.insert(schema.workerHeartbeats).values({
      workerId: 'w1',
      lastTickAt: new Date(),
      workerVersion: '0.0.0',
      lastAuditVerifyAt: new Date(),
      lastAuditVerifyChecked: 5,
      lastAuditVerifyBroken: 0,
    });

    const res = await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.continuityEngine).toBe('ok');
    expect(body.continuitySummary).toMatch(/Continuity Engine Operational/);

    const byId = Object.fromEntries(
      (body.checks as Array<{ id: string; state: string; detail: string }>).map((c) => [c.id, c]),
    );
    // The outer-layer KEK is checked by a REAL wrap/unwrap round-trip — it is
    // the single cryptographic power the server holds, and config presence
    // would prove nothing about whether a release can actually be completed.
    expect(byId['outer_layer_kek']!.state).toBe('ok');
    expect(byId['outer_layer_kek']!.detail).toMatch(/round-trip verified/);
    expect(byId['database']!.state).toBe('ok');
    expect(byId['worker']!.state).toBe('ok');
    expect(byId['crypto']!.state).toBe('ok');
  });

  it('goes red — with the reason — when the release worker is stale', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    await db.insert(schema.workerHeartbeats).values({
      workerId: 'w1',
      lastTickAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    expect(body.continuityEngine).toBe('down');
    // The headline must NAME the failing component, not just go red.
    expect(body.continuitySummary).toMatch(/Release worker/);
  });

  it('reports a worker that TICKS BUT ERRORS as degraded, not healthy', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    await db.insert(schema.workerHeartbeats).values({
      workerId: 'w1',
      lastTickAt: new Date(),
      consecutiveErrors: 12,
    });
    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    const worker = (body.checks as Array<{ id: string; state: string }>).find((c) => c.id === 'worker');
    // A liveness ping would call this healthy. It is not: nothing is progressing.
    expect(worker!.state).toBe('degraded');
    expect(body.continuityEngine).toBe('degraded');
  });

  it('NEVER reports green for something it does not actually check', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    await db.insert(schema.workerHeartbeats).values({ workerId: 'w1', lastTickAt: new Date() });

    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    const byId = Object.fromEntries(
      (body.checks as Array<{ id: string; state: string; detail: string }>).map((c) => [c.id, c]),
    );
    // Backup SNAPSHOTS are a platform concern the application genuinely cannot
    // observe; what it can report is whether a human ever restored from one.
    // With no attestation set — this test sets no BACKUPS_LAST_VERIFIED_RESTORE
    // — that stays 'unknown'. A decorative green tile here would convert "we
    // don't know" into "we're fine", the exact dishonesty this dashboard exists
    // to avoid.
    expect(byId['backups']!.state).toBe('unknown');
    expect(byId['backups']!.detail).toMatch(/no verified restore recorded/);
    // And a chain that has never been swept is 'unknown', never 'ok'.
    expect(byId['audit_chain']!.state).toBe('unknown');

    // There is no Redis in this stack; inventing a dependency would be worse
    // than omitting it.
    expect(byId['redis']).toBeUndefined();
  });

  it('reports the attested restore DATE once one is recorded', async () => {
    // D6 (docs/38): the tile sat at 'unknown' from the day it was written, which
    // is how the original no-backups finding went unnoticed for a year — it read
    // the same whether backups existed or not. The date is the whole point: a
    // reader can judge the claim instead of trusting a colour.
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    process.env['BACKUPS_LAST_VERIFIED_RESTORE'] = '2026-08-10';
    try {
      const a = boot();
      await a.ready();
      const { cookie } = await user(ADMIN);
      const body = (
        await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })
      ).json();
      const backups = (body.checks as Array<{ id: string; detail: string }>).find(
        (c) => c.id === 'backups',
      );
      expect(backups?.detail).toContain('2026-08-10');
    } finally {
      delete process.env['BACKUPS_LAST_VERIFIED_RESTORE'];
    }
  });

  it('names the AI model and capabilities even when nothing has been called', async () => {
    // The operator-reported gap: with the capability flags ON in production the
    // tile said "no model calls attempted today — nothing to infer" and nothing
    // else, which is the same sentence a deployment with no credential shows.
    // This is the WIRING half — that the tile reads the live configuration
    // rather than a constant. The state machine behind it is pinned in
    // packages/ops/src/ai-status.integration.test.ts.
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot({
      AI_PROPOSER_ENABLED: 'true',
      GEMINI_MODEL: 'gemini-2.5-flash',
      // Makes the credential resolve. This follows the DEFAULT backend rather
      // than pinning one: it was GOOGLE_CLOUD_PROJECT while the default was
      // vertex, and became GEMINI_API_KEY when the default moved to the direct
      // API (2026-08-25). The test is about the tile reading live configuration,
      // so it should track whatever the default credential is.
      GEMINI_API_KEY: 'test-key',
    });
    await a.ready();
    const { cookie } = await user(ADMIN);
    const body = (
      await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })
    ).json();
    const ai = (body.checks as Array<{ id: string; detail: string }>).find((c) => c.id === 'ai');
    expect(ai?.detail).toContain('gemini-2.5-flash');
    expect(ai?.detail).toContain('proposer');
    // No credential, project id or endpoint on an ops surface (rule 2).
    expect(ai?.detail).not.toContain('test-project');
  });

  it('is DOWN when no notification provider is configured', async () => {
    delete process.env['RESEND_API_KEY'];
    delete process.env['NOTIFICATIONS_FROM'];
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    await db.insert(schema.workerHeartbeats).values({ workerId: 'w1', lastTickAt: new Date() });

    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    const n = (body.checks as Array<{ id: string; state: string; detail: string }>).find(
      (c) => c.id === 'notifications',
    );
    // With nothing configured, a release could technically complete but nobody
    // could be told it was happening — which for this product is a release path
    // that does not work.
    expect(n!.state).toBe('down');
    expect(n!.detail).toMatch(/NO provider configured/);
    expect(body.continuityEngine).toBe('down');
  });

  it('surfaces a BROKEN audit chain from the worker sweep', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    await db.insert(schema.workerHeartbeats).values({
      workerId: 'w1',
      lastTickAt: new Date(),
      lastAuditVerifyAt: new Date(),
      lastAuditVerifyChecked: 9,
      lastAuditVerifyBroken: 2,
    });
    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    const chain = (body.checks as Array<{ id: string; state: string; detail: string }>).find(
      (c) => c.id === 'audit_chain',
    );
    expect(chain!.state).toBe('down');
    expect(chain!.detail).toMatch(/FAILED verification/);
  });

  it('flags API/worker version skew', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN);
    await db.insert(schema.workerHeartbeats).values({
      workerId: 'w1',
      lastTickAt: new Date(),
      workerVersion: 'a-different-build',
    });
    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    expect(body.versions.skew).toBe(true);
  });

  it('counts accounts — registered, active, and armed', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { cookie } = await user(ADMIN); // active, never armed
    await db.insert(schema.users).values([
      // Signed up and stopped there: counts as registered, not as active.
      { email: 'half-way@example.com', accountStatus: 'pending' },
      // The one the engine is actually responsible for.
      { email: 'armed@example.com', accountStatus: 'active', armedAt: new Date() },
    ]);
    await db.insert(schema.workerHeartbeats).values({ workerId: 'w1', lastTickAt: new Date() });

    const body = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).json();
    expect(body.accounts).toEqual({ total: 3, registeredToday: 3, active: 2, armed: 1 });
  });

  // The privacy rule. An ops surface on a zero-knowledge product must aggregate
  // and nothing else — no emails, no user ids, no contact identities, no vault
  // metadata. This is asserted against the SERIALISED body so a nested field
  // cannot smuggle something past a shallow check.
  it('exposes NO user data whatsoever', async () => {
    process.env['OPS_ADMIN_EMAILS'] = ADMIN;
    const a = boot();
    await a.ready();
    const { userId, cookie } = await user(ADMIN);
    const victim = await user('secret-person@example.com');
    await db.insert(schema.workerHeartbeats).values({ workerId: 'w1', lastTickAt: new Date() });
    await db.insert(schema.engineStates).values({ userId: victim.userId, state: 'check_in_pending' });
    await db.insert(schema.engineStateHistory).values({
      userId: victim.userId,
      toState: 'notification_stalled',
      reason: 'all_channels_failing',
    });
    await db.insert(schema.contacts).values({
      ownerUserId: victim.userId,
      role: 'personal',
      status: 'enrolled',
      displayLabelCiphertext: randomBytes(16),
      displayLabelNonce: randomBytes(12),
    });

    const raw = (await a.inject({ method: 'GET', url: '/v1/ops/system', cookies: as(cookie) })).body;

    expect(raw).not.toContain('secret-person@example.com');
    expect(raw).not.toContain(victim.userId);
    expect(raw).not.toContain(userId);
    expect(raw).not.toContain(ADMIN);

    // The operational EVENT is still visible — that is the point of the alert
    // feed — but only as a type and a timestamp.
    const body = JSON.parse(raw);
    expect(body.alerts.some((x: { kind: string }) => x.kind === 'all_channels_failing')).toBe(true);

    // Same for the account totals: the two users above are visible as the
    // integer 2 and in no other way.
    expect(body.accounts).toEqual({ total: 2, registeredToday: 2, active: 2, armed: 0 });
  });

  // ── The health series behind the composite strip ───────────────────────────
  //
  // Gated exactly like /system — it is the same operational intelligence spread
  // over 24 hours, and a second admin route that forgot the allowlist would hand
  // it out to anyone with a session.
  describe('GET /v1/ops/health-series', () => {
    it('is NOT REGISTERED when OPS_ADMIN_EMAILS is unset', async () => {
      const a = boot();
      await a.ready();
      const { cookie } = await user(ADMIN);
      const res = await a.inject({
        method: 'GET',
        url: '/v1/ops/health-series',
        cookies: as(cookie),
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s for an authenticated non-admin', async () => {
      process.env['OPS_ADMIN_EMAILS'] = ADMIN;
      const a = boot();
      await a.ready();
      const { cookie } = await user('nobody@example.com');
      const res = await a.inject({
        method: 'GET',
        url: '/v1/ops/health-series',
        cookies: as(cookie),
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires a session', async () => {
      process.env['OPS_ADMIN_EMAILS'] = ADMIN;
      const a = boot();
      await a.ready();
      expect(
        (await a.inject({ method: 'GET', url: '/v1/ops/health-series' })).statusCode,
      ).toBe(401);
    });

    it('serves the composite series, with unsampled buckets as null', async () => {
      process.env['OPS_ADMIN_EMAILS'] = ADMIN;
      const a = boot();
      await a.ready();
      const { cookie } = await user(ADMIN);
      const now = new Date();
      await db.insert(schema.statusSamples).values({
        bucketAt: new Date(Math.floor(now.getTime() / 60_000) * 60_000),
        releasePath: 'ok',
        severity: 0,
        worstCheck: null,
        sampledAt: now,
      });

      const body = (
        await a.inject({ method: 'GET', url: '/v1/ops/health-series', cookies: as(cookie) })
      ).json();

      expect(body.series.bucketMinutes).toBe(5);
      expect(body.series.buckets).toHaveLength((24 * 60) / 5);
      // One sample in a 24-hour window: everything else is null, and null is
      // the point — a strip that omitted them would draw a silent worker as a
      // quiet night.
      expect(body.series.buckets.filter((b: { severity: number | null }) => b.severity === 0))
        .toHaveLength(1);
      expect(body.series.unobservedBuckets).toBe((24 * 60) / 5 - 1);
    });

    it('carries no user data — severities and check IDs only', async () => {
      process.env['OPS_ADMIN_EMAILS'] = ADMIN;
      const a = boot();
      await a.ready();
      const { cookie } = await user(ADMIN);
      const victim = await user('secret-person@example.com');
      await db.insert(schema.statusSamples).values({
        bucketAt: new Date(Math.floor(Date.now() / 60_000) * 60_000),
        releasePath: 'down',
        severity: 3,
        worstCheck: 'worker',
        sampledAt: new Date(),
      });

      const raw = (
        await a.inject({ method: 'GET', url: '/v1/ops/health-series', cookies: as(cookie) })
      ).body;
      expect(raw).not.toContain('secret-person@example.com');
      expect(raw).not.toContain(victim.userId);
      expect(raw).not.toContain(ADMIN);
    });
  });
});
