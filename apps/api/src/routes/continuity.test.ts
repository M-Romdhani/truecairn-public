import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { createReleaseReviewCeremonies, type ContinuityReportPort } from '@truecairn/ceremony';
import { ed25519KeypairFromSeed, initCrypto, randomBytes } from '@truecairn/crypto';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import { buildContinuityReport } from '@truecairn/notifications';
import type { ContinuityReportPayload, UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const WINDOWS = { syncWindowMs: 60_000, revocationWindowMs: 1_000 };

// CV-1 (docs/26 §6): the frozen report rides the ceremony-creation transaction,
// its hash is anchored in the audit chain, and the route serves the SNAPSHOT to
// recipients and the owner — 404 to everyone else.

describeIfDb('continuity report — frozen snapshot + recipient-gated route', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let audit: AuditLogWriter;
  const config = loadConfig({
    TOTP_KEK: Buffer.alloc(32, 9).toString('base64'),
    CV_REPORT_ENABLED: 'true',
  });

  // The exact port worker main wires when CV_REPORT_ENABLED is on.
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
    await sql`TRUNCATE continuity_reports, release_ceremonies, ceremony_affirmations, ceremony_recipients, s1_tier_key_envelopes, notification_deliveries, notification_channels, engine_state_history, engine_states, contacts, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // Owner in release_review with verification evidence + one enrolled S1
  // contact (its own user) — the minimal fixture for a ceremony with a report.
  async function seed(): Promise<{
    ownerId: UserId;
    ownerCookie: string;
    contactCookie: string;
    strangerCookie: string;
  }> {
    const [owner] = await db
      .insert(schema.users)
      .values({ email: `o${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const [cu] = await db
      .insert(schema.users)
      .values({ email: `c${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const [su] = await db
      .insert(schema.users)
      .values({ email: `s${Math.random()}@x.com`, accountStatus: 'active' })
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
    // Verification evidence: one verified channel with a delivered escalation.
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
    const ownerCookie = (await createSession(db, { userId: ownerId, now: new Date() })).token;
    const contactCookie = (
      await createSession(db, { userId: cu!.id as UserId, now: new Date() })
    ).token;
    const strangerCookie = (
      await createSession(db, { userId: su!.id as UserId, now: new Date() })
    ).token;
    return { ownerId, ownerCookie, contactCookie, strangerCookie };
  }
  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });

  it('freezes exactly one report per ceremony in the creation tx, hash-anchored, idempotent on re-runs', async () => {
    const { ownerId } = await seed();
    const now = new Date();
    await createReleaseReviewCeremonies(
      { db, audit, now, windows: WINDOWS, continuityReport: reportPort },
      10,
    );
    // Re-run: create-once makes it a no-op — no duplicate report either.
    await createReleaseReviewCeremonies(
      { db, audit, now, windows: WINDOWS, continuityReport: reportPort },
      10,
    );

    const ceremonies = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, ownerId));
    expect(ceremonies).toHaveLength(1); // S1 holders only in this fixture
    const reports = await db
      .select()
      .from(schema.continuityReports)
      .where(eq(schema.continuityReports.ceremonyId, ceremonies[0]!.id));
    expect(reports).toHaveLength(1);
    const payloadJson = reports[0]!.payload; // the exact anchored bytes (TEXT)
    const payload = JSON.parse(payloadJson) as ContinuityReportPayload;
    expect(payload.outcome).toBe('delivered_no_checkin');

    // The audit chain anchors sha256 over the STORED bytes — and still verifies.
    const events = await db
      .select({ eventType: schema.auditLog.eventType, payload: schema.auditLog.eventPayload })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, ownerId));
    const attached = events.filter((e) => e.eventType === 'ceremony.continuity_report_attached');
    expect(attached).toHaveLength(1);
    const anchoredHash = (attached[0]!.payload as { payloadHash: string }).payloadHash;
    expect(anchoredHash).toBe(createHash('sha256').update(payloadJson, 'utf8').digest('hex'));
    expect((await verifyChain(db, ownerId)).ok).toBe(true);
  });

  it('without the port (flags off) no report is attached — pre-CV behaviour', async () => {
    const { ownerId } = await seed();
    await createReleaseReviewCeremonies({ db, audit, now: new Date(), windows: WINDOWS }, 10);
    const ceremonies = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, ownerId));
    expect(ceremonies).toHaveLength(1); // the ceremony itself is unaffected
    const reports = await db.select().from(schema.continuityReports);
    expect(reports).toHaveLength(0);
  });

  it('serves the FROZEN snapshot to recipient and owner; stranger gets 404; later rows do not change it', async () => {
    const { ownerId, ownerCookie, contactCookie, strangerCookie } = await seed();
    await createReleaseReviewCeremonies(
      { db, audit, now: new Date(), windows: WINDOWS, continuityReport: reportPort },
      10,
    );
    const [ceremony] = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, ownerId));
    const url_ = `/v1/ceremonies/${ceremony!.id}/continuity-report`;

    const asContact = await app.inject({ method: 'GET', url: url_, cookies: as(contactCookie) });
    expect(asContact.statusCode).toBe(200);
    const body = asContact.json() as { report: ContinuityReportPayload };
    expect(body.report.outcome).toBe('delivered_no_checkin');
    expect(body.report.channels[0]!.delivered).toBe(1);
    // No addresses anywhere in what a recipient sees (D2 discipline).
    expect(JSON.stringify(body)).not.toContain('owner@x.com');

    const asOwner = await app.inject({ method: 'GET', url: url_, cookies: as(ownerCookie) });
    expect(asOwner.statusCode).toBe(200);

    const asStranger = await app.inject({ method: 'GET', url: url_, cookies: as(strangerCookie) });
    expect(asStranger.statusCode).toBe(404);
    const noSession = await app.inject({ method: 'GET', url: url_ });
    expect(noSession.statusCode).toBe(401);

    // Frozen: evidence written AFTER creation must not appear in the snapshot.
    const [ch] = await db
      .select({ id: schema.notificationChannels.id })
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.userId, ownerId));
    await db.insert(schema.notificationDeliveries).values({
      channelId: ch!.id,
      userId: ownerId,
      purpose: 'escalation_request',
      status: 'bounced',
      bouncedAt: new Date(),
    });
    const again = await app.inject({ method: 'GET', url: url_, cookies: as(contactCookie) });
    const frozen = again.json() as { report: ContinuityReportPayload };
    expect(frozen.report.channels[0]!.bounced).toBe(0); // still the snapshot
    expect(frozen.report.outcome).toBe('delivered_no_checkin');
  });

  it('owner live view: flag-gated, recomputed on demand', async () => {
    const { ownerCookie } = await seed();
    const live = await app.inject({
      method: 'GET',
      url: '/v1/engine/verification-status',
      cookies: as(ownerCookie),
    });
    expect(live.statusCode).toBe(200);
    const { report } = live.json() as { report: ContinuityReportPayload };
    expect(report.outcome).toBe('delivered_no_checkin');
    expect(report.heartbeat.lastCheckInAt).not.toBeNull();

    // Flag off: the surface is absent (D8).
    const offApp = buildApp(
      { ...loadConfig({ TOTP_KEK: Buffer.alloc(32, 9).toString('base64') }), logLevel: 'silent' },
      { db, sql },
    );
    await offApp.ready();
    const gated = await offApp.inject({
      method: 'GET',
      url: '/v1/engine/verification-status',
      cookies: as(ownerCookie),
    });
    expect(gated.statusCode).toBe(404);
    await offApp.close();
  });
});
