import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { MEASUREMENT_EPOCH, MIN_PUBLISHABLE_MS } from '@truecairn/ops';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// GET /v1/status is the ONLY unauthenticated view of the operations surface.
// These tests pin the two properties that make that safe: it is reachable with
// no session at all, and it publishes strictly less than /v1/ops/system.

describeIfDb('GET /v1/status — the public status page source', () => {
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
    process.env['RESEND_API_KEY'] = 'test-key';
    process.env['NOTIFICATIONS_FROM'] = 'test@example.com';
    await sql`TRUNCATE status_samples, worker_heartbeats, sensitive_actions, notification_deliveries, release_ceremonies CASCADE`;
  });
  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
    delete process.env['RESEND_API_KEY'];
    delete process.env['NOTIFICATIONS_FROM'];
  });

  function boot(): FastifyInstance {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    return app;
  }

  it('answers with no session, no cookie and no admin allowlist', async () => {
    // Unlike /v1/ops/system, which is absent unless OPS_ADMIN_EMAILS is set, the
    // public page must work on every deployment — a status page that vanishes
    // when unconfigured is worse than none.
    delete process.env['OPS_ADMIN_EMAILS'];
    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(['ok', 'degraded', 'down', 'unknown']).toContain(body.releasePath);
  });

  it('publishes strictly less than the admin dashboard', async () => {
    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    const raw = res.body;
    // The response schema is additionalProperties:false, so these are stripped
    // by the serializer even if the projection regressed. Asserted at the HTTP
    // layer because that is the boundary that actually faces the internet.
    for (const field of [
      'queues',
      'versions',
      'alerts',
      'continuitySummary',
      'detail',
      // How many people use this product is the operator's business, not the
      // internet's. It is composed by the ops ROUTE and never enters
      // SystemStatus, so the projection has nothing to drop — this asserts that
      // structure held.
      'accounts',
    ]) {
      expect(raw).not.toContain(field);
    }
  });

  it('names failing components by id without composing a sentence', async () => {
    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    const body = res.json();
    expect(Array.isArray(body.failing)).toBe(true);
    for (const check of body.checks) {
      expect(Object.keys(check).sort()).toEqual(['id', 'label', 'releaseCritical', 'state']);
    }
  });

  it('reports no percentage before there is evidence for one', async () => {
    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    const { availability } = res.json();
    // Empty series: the page must say "measuring since…", never a number.
    expect(availability.measuringSince).toBeNull();
    expect(availability.releasePathOkPercent).toBeNull();
  });

  // Retargeted 2026-08-09, and the reason matters more than the change.
  //
  // This used to seed three clean days and assert `releasePathOkPercent > 99`.
  // MEASUREMENT_EPOCH (packages/ops) now truncates the published window to the
  // moment the notifications check stopped mis-measuring, and the route reads
  // the REAL clock — so for the first 24 hours after the epoch the code
  // correctly publishes no figure, and the old assertion was a test that fails
  // today and passes tomorrow. That is worse than no test.
  //
  // The percentage arithmetic is exhaustively covered in
  // packages/ops/src/samples.test.ts, where the clock is a fixture and can be
  // controlled. What only THIS layer can prove is that the route surfaces the
  // availability object at all and does not invent or drop fields, so that is
  // what it asserts now.
  it('surfaces the availability object, consistent with its own window', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 3 * 24 * 60 }, (_, i) => {
      const at = new Date(now - (3 * 24 * 60 - i) * 60_000);
      return {
        bucketAt: new Date(Math.floor(at.getTime() / 60_000) * 60_000),
        releasePath: 'ok',
        severity: 0,
        worstCheck: null,
        sampledAt: at,
      };
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(schema.statusSamples).values(rows.slice(i, i + 1000));
    }

    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    const { availability } = res.json();
    // Three days of evidence is never published as the full 90-day window.
    expect(availability.requestedWindowDays).toBe(90);
    expect(availability.observedDays).toBeLessThan(4);
    // measuringSince is never earlier than the epoch, and the two must agree:
    // the span the page names has to be the span the figure covers, or the page
    // contradicts itself in the one sentence that establishes its credibility.
    expect(availability.measuringSince).not.toBeNull();
    const sinceMs = Date.parse(availability.measuringSince as string);
    expect(sinceMs).toBeGreaterThanOrEqual(MEASUREMENT_EPOCH.getTime());
    expect(availability.observedDays).toBeCloseTo((now - sinceMs) / (24 * 60 * 60 * 1000), 0);
    // And a figure only once there is a day of post-epoch evidence — the same
    // rule as the empty-series case above, applied to a truncated window.
    if (now - sinceMs >= MIN_PUBLISHABLE_MS) {
      expect(availability.releasePathOkPercent).toBeGreaterThan(99);
    } else {
      expect(availability.releasePathOkPercent).toBeNull();
    }
  });

  // ── The backups tile is PUBLISHED (2026-08-11) ────────────────────────────
  //
  // `backups` is in the public allowlist, so the attestation an operator sets is
  // a claim made to strangers, not just to the dashboard. These pin that the
  // published state is derived from the attestation rather than hardcoded — the
  // admin page and this page resolve it through one helper (ops/status-deps.ts)
  // precisely so they cannot report different colours for the same tile.
  it('publishes UNKNOWN for backups when no restore has been attested', async () => {
    delete process.env['BACKUPS_LAST_VERIFIED_RESTORE'];
    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    const check = (res.json().checks as Array<{ id: string; state: string }>).find(
      (c) => c.id === 'backups',
    );
    expect(check?.state).toBe('unknown');
  });

  it('publishes the attested restore — and still no sentence about it', async () => {
    process.env['BACKUPS_LAST_VERIFIED_RESTORE'] = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    try {
      const res = await boot().inject({ method: 'GET', url: '/v1/status' });
      const check = (res.json().checks as Array<{ id: string; state: string }>).find(
        (c) => c.id === 'backups',
      );
      expect(check?.state).toBe('ok');
      // Rule 1 of the public projection: no free text crosses the boundary. The
      // date is on the ADMIN tile only — the page owns its prose, and a
      // server-composed detail here would be the first crack in that.
      expect(res.body).not.toContain('operator-attested');
    } finally {
      delete process.env['BACKUPS_LAST_VERIFIED_RESTORE'];
    }
  });

  it('is cacheable, so a public URL cannot amplify against the KEK probe', async () => {
    // Building the answer does a wrap/unwrap round-trip against the live outer-
    // layer key. Uncached, that makes the status page a free amplifier against
    // the very key path it reports on.
    const res = await boot().inject({ method: 'GET', url: '/v1/status' });
    expect(res.headers['cache-control']).toContain('max-age=');
  });

  it('serves concurrent callers from one probe', async () => {
    const instance = boot();
    const responses = await Promise.all(
      Array.from({ length: 8 }, async () =>
        instance.inject({ method: 'GET', url: '/v1/status' }),
      ),
    );
    const observed = new Set(responses.map((r) => r.json().observedAt));
    // A thundering herd on a cold cache must collapse onto a single collection,
    // not start one KEK round-trip per connection.
    expect(observed.size).toBe(1);
  });
});
