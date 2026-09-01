import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createReleaseReviewCeremonies, tickCeremonies } from '@truecairn/ceremony';
import { initCrypto, randomBytes } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// The owner's release-progress view: transparency that doubles as a collusion
// alarm. Three properties pinned here: (1) the owner sees their own ceremonies'
// full consensus metadata; (2) the view is strictly owner-scoped — a contact's
// (or any other) session sees nothing through it; (3) the response carries
// METADATA ONLY — the exact key sets are asserted so a future field addition
// that would leak key material or signatures fails this test by construction.
describeIfDb('owner release-progress view (GET /v1/engine/release-progress)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let audit: AuditLogWriter;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
  const WINDOWS = { syncWindowMs: 60_000, revocationWindowMs: 1_000 };

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
    await sql`TRUNCATE release_ceremonies, ceremony_affirmations, ceremony_recipients, s1_tier_key_envelopes, engine_states, contacts, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });

  // Owner in release_review + one enrolled S1 contact holding an envelope, with
  // sessions for both sides of the scoping assertion.
  async function seed(): Promise<{
    ownerId: UserId;
    ownerCookie: string;
    contactId: string;
    contactCookie: string;
    labelCiphertext: Uint8Array;
    envelopeBytes: Uint8Array;
  }> {
    const [owner] = await db.insert(schema.users).values({ email: `o${Date.now()}@x.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    const [cu] = await db.insert(schema.users).values({ email: `c${Date.now()}@x.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    const ownerId = owner!.id as UserId;
    const contactUserId = cu!.id as UserId;
    const labelCiphertext = randomBytes(16);
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId,
        role: 'personal',
        status: 'enrolled',
        displayLabelCiphertext: labelCiphertext,
        displayLabelNonce: randomBytes(12),
        contactEd25519Pubkey: randomBytes(32),
      })
      .returning({ id: schema.contacts.id });
    const envelopeBytes = randomBytes(80);
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: ownerId,
      contactId: contact!.id,
      sealedBoxCiphertext: envelopeBytes,
    });
    await db.insert(schema.engineStates).values({ userId: ownerId, state: 'release_review' });
    const now = new Date();
    const ownerSession = await createSession(db, { userId: ownerId, now });
    const contactSession = await createSession(db, { userId: contactUserId, now });
    return {
      ownerId,
      ownerCookie: ownerSession.token,
      contactId: contact!.id,
      contactCookie: contactSession.token,
      labelCiphertext,
      envelopeBytes,
    };
  }

  it('shows the owner their ceremony with per-contact consensus metadata', async () => {
    const { ownerCookie, contactId, labelCiphertext } = await seed();
    const now = new Date();
    await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now, signalEngine: async () => {} }, 10);

    const r = await app.inject({ method: 'GET', url: '/v1/engine/release-progress', cookies: as(ownerCookie) });
    expect(r.statusCode).toBe(200);
    const { ceremonies } = r.json() as { ceremonies: Array<Record<string, unknown>> };
    expect(ceremonies).toHaveLength(1);
    const c = ceremonies[0]!;
    expect(c['tier']).toBe('s1');
    expect(c['status']).toBe('collecting_affirmations');
    expect(c['threshold']).toBe(1);
    expect(c['committed']).toBe(0);
    expect(typeof c['syncWindowExpiresAt']).toBe('string');
    const affs = c['affirmations'] as Array<Record<string, unknown>>;
    expect(affs).toHaveLength(1);
    expect(affs[0]!['contactId']).toBe(contactId);
    expect(affs[0]!['role']).toBe('personal');
    expect(affs[0]!['status']).toBe('pending');
    // The label rides through OPAQUE — the server returns exactly the bytes the
    // owner encrypted, for the owner's own device to decrypt.
    expect(affs[0]!['displayLabelCiphertext']).toBe(Buffer.from(labelCiphertext).toString('base64'));
    const recips = c['recipients'] as Array<Record<string, unknown>>;
    expect(recips).toHaveLength(1);
    expect(recips[0]!['status']).toBe('pending');
  });

  it('is strictly owner-scoped: a contact (or any other) session sees nothing', async () => {
    const { contactCookie } = await seed();
    const now = new Date();
    await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);

    const r = await app.inject({ method: 'GET', url: '/v1/engine/release-progress', cookies: as(contactCookie) });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { ceremonies: unknown[] }).ceremonies).toHaveLength(0);

    const anon = await app.inject({ method: 'GET', url: '/v1/engine/release-progress' });
    expect(anon.statusCode).toBe(401);
  });

  it('returns metadata only: exact key sets, and never the envelope or key bytes', async () => {
    const { ownerCookie, envelopeBytes } = await seed();
    const now = new Date();
    await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now, signalEngine: async () => {} }, 10);

    const r = await app.inject({ method: 'GET', url: '/v1/engine/release-progress', cookies: as(ownerCookie) });
    const { ceremonies } = r.json() as { ceremonies: Array<Record<string, unknown>> };
    // Closed field lists — a leaked signature/pubkey/share field fails here.
    expect(Object.keys(ceremonies[0]!).sort()).toEqual(
      [
        'affirmations',
        'cancellationReason',
        'ceremonyId',
        'committed',
        'failureReason',
        'initiatedAt',
        'outerKeyReleasedAt',
        'recipients',
        'reconstructionStartedAt',
        'releasedAt',
        'status',
        'syncWindowExpiresAt',
        'threshold',
        'tier',
      ].sort(),
    );
    const aff = (ceremonies[0]!['affirmations'] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(aff).sort()).toEqual(
      [
        'affirmedAt',
        'committedAt',
        'contactId',
        // A small integer naming which key opens the label beside it (0068).
        // In scope for this guard on purpose: it is metadata, not key material,
        // and the client cannot decrypt the label without it — the aadVersion
        // incident (P0-2) is what happens when a version is withheld from a
        // path that returns ciphertext.
        'contactPinVersion',
        'displayLabelCiphertext',
        'displayLabelNonce',
        'revocationWindowExpiresAt',
        'revokedAt',
        'role',
        'status',
      ].sort(),
    );
    // The S1 envelope must never ride any owner-facing payload.
    expect(r.body).not.toContain(Buffer.from(envelopeBytes).toString('base64'));
  });

  it('keeps terminal ceremonies visible with their reason (the alarm value)', async () => {
    const { ownerCookie, ownerId } = await seed();
    const t0 = new Date();
    await createReleaseReviewCeremonies(
      { db, audit, now: t0, windows: { syncWindowMs: 1_000, revocationWindowMs: 1_000 } },
      10,
    );
    await tickCeremonies({ db, audit, now: t0, signalEngine: async () => {} }, 10);
    // Sync window expires with no affirmations → failed (fail-closed).
    await tickCeremonies({ db, audit, now: new Date(t0.getTime() + 5_000), signalEngine: async () => {} }, 10);
    const [row] = await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.userId, ownerId));
    expect(row!.status).toBe('failed');

    const r = await app.inject({ method: 'GET', url: '/v1/engine/release-progress', cookies: as(ownerCookie) });
    const { ceremonies } = r.json() as { ceremonies: Array<Record<string, unknown>> };
    expect(ceremonies).toHaveLength(1);
    expect(ceremonies[0]!['status']).toBe('failed');
    expect(ceremonies[0]!['failureReason']).toBe('sync_window_expired_below_threshold');
  });

  it('counts committed affirmations toward the threshold', async () => {
    const { ownerCookie, ownerId } = await seed();
    const now = new Date();
    await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now, signalEngine: async () => {} }, 10);
    const [cer] = await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.userId, ownerId));
    await db
      .update(schema.ceremonyAffirmations)
      .set({ status: 'committed', committedAt: now })
      .where(eq(schema.ceremonyAffirmations.ceremonyId, cer!.id));

    const r = await app.inject({ method: 'GET', url: '/v1/engine/release-progress', cookies: as(ownerCookie) });
    const { ceremonies } = r.json() as { ceremonies: Array<Record<string, unknown>> };
    expect(ceremonies[0]!['committed']).toBe(1);
    const affs = ceremonies[0]!['affirmations'] as Array<Record<string, unknown>>;
    expect(affs[0]!['status']).toBe('committed');
    expect(typeof affs[0]!['committedAt']).toBe('string');
  });
});
