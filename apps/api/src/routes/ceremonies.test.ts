import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import {
  cancelCeremoniesForUser,
  commitDueAffirmations,
  createReleaseReviewCeremonies,
  tickCeremonies,
  type CeremonyEngineSignal,
} from '@truecairn/ceremony';
import {
  ed25519KeypairFromSeed,
  ed25519Sign,
  fromBase64Url,
  initCrypto,
  randomBytes,
} from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { applyEvent, DbChannelLookup, loadRow } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// CEREMONY_COMPLETION Checkpoint A — the server side of the four properties. The
// S1 ZK decrypt itself (property #4) is the E2E; here we drive the real bridges +
// processor + engine against Postgres and assert the state machine + temporal gate.
describeIfDb('release ceremony bridges (CEREMONY_COMPLETION A)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let audit: AuditLogWriter;
  let channels: DbChannelLookup;
  const config = loadConfig({
    TOTP_KEK: Buffer.alloc(32, 7).toString('base64'),
    // The affirm route reads its revocation window from config — compress it so the
    // affirmation commits within the test (matches the E2E's CI env).
    CEREMONY_REVOCATION_WINDOW_MS: '1000',
    CEREMONY_SYNC_WINDOW_MS: '60000',
  });
  const WINDOWS = { syncWindowMs: 60_000, revocationWindowMs: 1_000 };

  // The worker's consensus→engine callback, replicated for the test.
  const signalEngine = async (
    txdb: Database,
    userId: UserId,
    sig: CeremonyEngineSignal,
    when: Date,
  ): Promise<void> => {
    const row = await loadRow(txdb, userId);
    if (row === null) return;
    const event =
      sig === 'release_review_verification_passed'
        ? ({ kind: 'release_review_verification_passed' } as const)
        : sig === 'release_review_verification_failed'
          ? ({ kind: 'release_review_verification_failed' } as const)
          : ({ kind: 'dispute_raised' } as const);
    await applyEvent(row, event, { db: txdb, audit, channels, now: when });
  };

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
    channels = new DbChannelLookup(db);
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

  // Owner in release_review + one enrolled S1 contact (its own user) holding an
  // S1 envelope. Returns the ids + the contact's affirmation keypair + a session.
  async function seedReleaseReview(): Promise<{
    ownerId: UserId;
    contactUserId: UserId;
    contactId: string;
    contactCookie: string;
    edSecret: Uint8Array;
  }> {
    const [owner] = await db.insert(schema.users).values({ email: `o${Date.now()}@x.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    const [cu] = await db.insert(schema.users).values({ email: `c${Date.now()}@x.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    const ownerId = owner!.id as UserId;
    const contactUserId = cu!.id as UserId;
    const kp = ed25519KeypairFromSeed(randomBytes(32));
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId,
        role: 'personal',
        status: 'enrolled',
        displayLabelCiphertext: randomBytes(16),
        displayLabelNonce: randomBytes(12),
        contactEd25519Pubkey: kp.publicKey,
      })
      .returning({ id: schema.contacts.id });
    const contactId = contact!.id;
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: ownerId,
      contactId,
      sealedBoxCiphertext: randomBytes(80), // opaque here; the E2E uses a real box
    });
    await db.insert(schema.engineStates).values({ userId: ownerId, state: 'release_review' });
    const { token } = await createSession(db, { userId: contactUserId, now: new Date() });
    return { ownerId, contactUserId, contactId, contactCookie: token, edSecret: kp.secretKey };
  }
  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });
  async function ceremonyOf(ownerId: UserId): Promise<{ id: string; status: string } | undefined> {
    const [c] = await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.userId, ownerId));
    return c ? { id: c.id, status: c.status } : undefined;
  }
  async function engineState(ownerId: UserId): Promise<string> {
    const [e] = await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, ownerId));
    return e!.state;
  }

  // PROPERTY 1 — create-once.
  it('creates exactly one ceremony even across repeated release_review evaluations', async () => {
    const { ownerId, contactId } = await seedReleaseReview();
    const now = new Date();
    const a = await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);
    const b = await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);
    expect(a).toBe(1);
    expect(b).toBe(0); // the partial unique index makes the re-tick a no-op
    const all = await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.userId, ownerId));
    expect(all).toHaveLength(1);
    // Enrolled: one affirmation (pending) + one recipient for the S1 holder.
    const affs = await db.select().from(schema.ceremonyAffirmations).where(eq(schema.ceremonyAffirmations.ceremonyId, all[0]!.id));
    expect(affs).toHaveLength(1);
    expect(affs[0]!.contactId).toBe(contactId);
    expect(affs[0]!.status).toBe('pending');
    expect(affs[0]!.shareId).toBeNull(); // S1 carries no Shamir share
  });

  // 2026-08-07 security audit, finding 3. Dispute is deliberately the
  // lowest-friction protective action in the product — no step-up, no
  // affirmation status required — because a false "they're alive" costs one
  // delay and a false release is irreversible. What it lacked was bounds.
  describe('dispute bounds (audit finding 3)', () => {
    async function liveCeremony(): Promise<{
      ownerId: UserId;
      contactCookie: string;
      ceremonyId: string;
    }> {
      const seeded = await seedReleaseReview();
      await createReleaseReviewCeremonies({ db, audit, now: new Date(), windows: WINDOWS }, 10);
      const c = await ceremonyOf(seeded.ownerId);
      return { ownerId: seeded.ownerId, contactCookie: seeded.contactCookie, ceremonyId: c!.id };
    }
    const dispute = (id: string, cookie: string): Promise<{ statusCode: number }> =>
      app.inject({ method: 'POST', url: `/v1/ceremonies/${id}/dispute`, cookies: as(cookie) });

    it('a pending contact can still dispute — the veto is bounded, not narrowed', async () => {
      // The contact most likely to know the owner is alive is the one who has not
      // affirmed. Any "fix" that required an affirmation status would remove
      // safety, so this asserts the low-friction path survives.
      const { ownerId, contactCookie, ceremonyId } = await liveCeremony();
      expect((await dispute(ceremonyId, contactCookie)).statusCode).toBe(200);
      expect((await ceremonyOf(ownerId))!.status).toBe('cancelled');
      expect(await engineState(ownerId)).toBe('review_required');
    });

    it('a second dispute is a no-op, not a second push into review_required', async () => {
      // The real defect. The owner's only exit from review_required costs them a
      // fresh second factor; without idempotency one contact could push it
      // straight back for as long as they cared to.
      const { ownerId, contactCookie, ceremonyId } = await liveCeremony();
      expect((await dispute(ceremonyId, contactCookie)).statusCode).toBe(200);

      // Owner resolves the review, returning the engine to a normal state.
      await db
        .update(schema.engineStates)
        .set({ state: 'active' })
        .where(eq(schema.engineStates.userId, ownerId));

      // Same contact, same affirmation: answered identically, engine untouched.
      expect((await dispute(ceremonyId, contactCookie)).statusCode).toBe(200);
      expect(await engineState(ownerId)).toBe('active');
    });

    it('a finished ceremony can no longer be disputed', async () => {
      // Affirmation rows outlive their ceremony forever, so without this a
      // contact from a ceremony that ended months ago kept a live lever on the
      // engine.
      const { ownerId, contactCookie, ceremonyId } = await liveCeremony();
      await db
        .update(schema.releaseCeremonies)
        .set({ status: 'released' })
        .where(eq(schema.releaseCeremonies.id, ceremonyId));
      await db
        .update(schema.engineStates)
        .set({ state: 'active' })
        .where(eq(schema.engineStates.userId, ownerId));

      expect((await dispute(ceremonyId, contactCookie)).statusCode).toBe(409);
      expect(await engineState(ownerId)).toBe('active');
    });

    it('a stranger still gets 404, not a 409 that would confirm the ceremony exists', async () => {
      const { ceremonyId } = await liveCeremony();
      const [outsider] = await db
        .insert(schema.users)
        .values({ email: `x${Date.now()}@x.com`, accountStatus: 'active' })
        .returning({ id: schema.users.id });
      const { token } = await createSession(db, {
        userId: outsider!.id as UserId,
        now: new Date(),
      });
      expect((await dispute(ceremonyId, token)).statusCode).toBe(404);
    });
  });

  // PROPERTY 2 — fail-closed.
  it('a sync window that expires below threshold fails the ceremony and does NOT advance the engine', async () => {
    const { ownerId } = await seedReleaseReview();
    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: { syncWindowMs: 1_000, revocationWindowMs: 1_000 } }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10); // initiated → collecting
    expect((await ceremonyOf(ownerId))!.status).toBe('collecting_affirmations');

    const past = new Date(t0.getTime() + 5_000); // past the sync window, no affirmations
    await tickCeremonies({ db, audit, now: past, signalEngine }, 10);

    expect((await ceremonyOf(ownerId))!.status).toBe('failed');
    // Fail-closed: the engine left release_review to review_required, NOT limited_release.
    expect(await engineState(ownerId)).toBe('review_required');
    const released = await db.select().from(schema.ceremonyRecipients).where(eq(schema.ceremonyRecipients.status, 'released'));
    expect(released).toHaveLength(0);
  });

  // PROPERTY 3 — abandon-on-cancel.
  it('owner cancel during collecting_affirmations cancels the ceremony, clears currentCeremonyId, releases nothing', async () => {
    const { ownerId } = await seedReleaseReview();
    const now = new Date();
    await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now, signalEngine }, 10); // collecting
    // Even with an affirmation already in hand:
    const c = await ceremonyOf(ownerId);
    await db.update(schema.ceremonyAffirmations).set({ status: 'tentative' }).where(eq(schema.ceremonyAffirmations.ceremonyId, c!.id));

    await cancelCeremoniesForUser(db, audit, ownerId, 'user_returned', new Date());

    expect((await ceremonyOf(ownerId))!.status).toBe('cancelled');
    const [e] = await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, ownerId));
    expect(e!.currentCeremonyId).toBeNull();
    const released = await db.select().from(schema.ceremonyRecipients).where(eq(schema.ceremonyRecipients.status, 'released'));
    expect(released).toHaveLength(0);
  });

  // The server spine of PROPERTY 4 + the temporal gate (the ZK decrypt is the E2E).
  it('affirm (possession proof) → consensus → engine limited_release → reconstructing; envelope gated', async () => {
    const { ownerId, contactId, contactCookie, edSecret } = await seedReleaseReview();
    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10); // collecting
    const cer = (await ceremonyOf(ownerId))!;

    // Temporal gate CLOSED before reconstructing.
    const early = await app.inject({ method: 'GET', url: `/v1/ceremonies/${cer.id}/s1-envelope`, cookies: as(contactCookie) });
    expect(early.statusCode).toBe(403);
    expect(early.json().type).toBe('https://truecairn.app/problems/release-gate-closed');

    // Affirm with the C4 Ed25519 possession proof.
    const opt = await app.inject({ method: 'POST', url: `/v1/ceremonies/${cer.id}/affirm/options`, cookies: as(contactCookie) });
    expect(opt.statusCode).toBe(200);
    const challenge = fromBase64Url(opt.json().challenge as string);
    const signature = Buffer.from(
      ed25519Sign(
        new Uint8Array(Buffer.concat([Buffer.from(challenge), Buffer.from(cer.id, 'utf8')])),
        edSecret,
      ),
    ).toString('base64');
    const aff = await app.inject({ method: 'POST', url: `/v1/ceremonies/${cer.id}/affirm`, cookies: as(contactCookie), payload: { challengeId: opt.json().challengeId, signature } });
    expect(aff.statusCode).toBe(200);
    expect(aff.json().status).toBe('tentative');

    // The affirm ran at real wall-clock; advance `now` well past its 1s revocation
    // window (and still inside the 60s sync window) so the affirmation commits.
    const t1 = new Date(Date.now() + 5_000);
    await commitDueAffirmations({ db, audit, now: t1 });
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10); // threshold_met → awaiting_outer_key + engine limited_release
    expect(await engineState(ownerId)).toBe('limited_release');
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10); // awaiting_outer_key → reconstructing
    expect((await ceremonyOf(ownerId))!.status).toBe('reconstructing');

    // Temporal gate OPEN now: the envelope is served to the recipient contact.
    const env = await app.inject({ method: 'GET', url: `/v1/ceremonies/${cer.id}/s1-envelope`, cookies: as(contactCookie) });
    expect(env.statusCode).toBe(200);
    expect(typeof env.json().sealedBoxCiphertext).toBe('string');

    // Recipient reports reconstruction → ceremony released.
    const done = await app.inject({ method: 'POST', url: `/v1/ceremonies/${cer.id}/reconstructed`, cookies: as(contactCookie) });
    expect(done.statusCode).toBe(200);
    expect((await ceremonyOf(ownerId))!.status).toBe('released');
    const [rec] = await db.select().from(schema.ceremonyRecipients).where(eq(schema.ceremonyRecipients.recipientContactId, contactId));
    expect(rec!.status).toBe('released');
  });

  // PROPERTY — S1 designated beneficiary (backlog #4). A non-affirming contact who
  // holds their OWN sealed S1 envelope: the bridge enrols them as a RECIPIENT but
  // NOT an affirmer; once the holder reaches consensus and the gate opens, the
  // beneficiary fetches their own envelope. A non-recipient is refused.
  it('S1 beneficiary: enrolled as a non-affirming recipient, served their own envelope once reconstructing', async () => {
    const { ownerId, contactCookie, edSecret } = await seedReleaseReview();

    // A designated S1 beneficiary: a separate enrolled contact with their OWN
    // envelope (distinct bytes) + an active designation, exactly as
    // designate_beneficiary lands them.
    const [bu] = await db.insert(schema.users).values({ email: `ben${Date.now()}@x.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    const benUserId = bu!.id as UserId;
    const [benContact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId: benUserId,
        role: 'recovery',
        status: 'enrolled',
        displayLabelCiphertext: randomBytes(16),
        displayLabelNonce: randomBytes(12),
        contactEd25519Pubkey: ed25519KeypairFromSeed(randomBytes(32)).publicKey,
      })
      .returning({ id: schema.contacts.id });
    const benContactId = benContact!.id;
    const benEnvelope = randomBytes(80);
    await db.insert(schema.s1TierKeyEnvelopes).values({ userId: ownerId, contactId: benContactId, sealedBoxCiphertext: benEnvelope });
    await db.insert(schema.releaseBeneficiaries).values({ userId: ownerId, tier: 's1', contactId: benContactId });
    const { token: benCookie } = await createSession(db, { userId: benUserId, now: new Date() });

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10); // collecting
    const cer = (await ceremonyOf(ownerId))!;

    // The bridge enrolled the beneficiary as a RECIPIENT but NOT an affirmer.
    const benRec = await db.select().from(schema.ceremonyRecipients).where(and(eq(schema.ceremonyRecipients.ceremonyId, cer.id), eq(schema.ceremonyRecipients.recipientContactId, benContactId)));
    expect(benRec).toHaveLength(1);
    const benAff = await db.select().from(schema.ceremonyAffirmations).where(and(eq(schema.ceremonyAffirmations.ceremonyId, cer.id), eq(schema.ceremonyAffirmations.contactId, benContactId)));
    expect(benAff).toHaveLength(0);

    // Gate closed before reconstructing for the beneficiary too.
    expect((await app.inject({ method: 'GET', url: `/v1/ceremonies/${cer.id}/s1-envelope`, cookies: as(benCookie) })).statusCode).toBe(403);

    // The HOLDER affirms → consensus → reconstructing.
    const opt = await app.inject({ method: 'POST', url: `/v1/ceremonies/${cer.id}/affirm/options`, cookies: as(contactCookie) });
    const signature = Buffer.from(
      ed25519Sign(
        new Uint8Array(
          Buffer.concat([
            Buffer.from(fromBase64Url(opt.json().challenge as string)),
            Buffer.from(cer.id, 'utf8'),
          ]),
        ),
        edSecret,
      ),
    ).toString('base64');
    await app.inject({ method: 'POST', url: `/v1/ceremonies/${cer.id}/affirm`, cookies: as(contactCookie), payload: { challengeId: opt.json().challengeId, signature } });
    const t1 = new Date(Date.now() + 5_000);
    await commitDueAffirmations({ db, audit, now: t1 });
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    expect((await ceremonyOf(ownerId))!.status).toBe('reconstructing');

    // The beneficiary receives THEIR OWN envelope (their distinct bytes).
    const env = await app.inject({ method: 'GET', url: `/v1/ceremonies/${cer.id}/s1-envelope`, cookies: as(benCookie) });
    expect(env.statusCode).toBe(200);
    expect(env.json().sealedBoxCiphertext).toBe(Buffer.from(benEnvelope).toString('base64'));

    // A non-recipient stranger is refused, even with the gate open.
    const [stranger] = await db.insert(schema.users).values({ email: `str${Date.now()}@x.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    const { token: strangerCookie } = await createSession(db, { userId: stranger!.id as UserId, now: new Date() });
    expect((await app.inject({ method: 'GET', url: `/v1/ceremonies/${cer.id}/s1-envelope`, cookies: as(strangerCookie) })).statusCode).toBe(404);

    // The non-affirming beneficiary reports reconstruction → ceremony released.
    const done = await app.inject({ method: 'POST', url: `/v1/ceremonies/${cer.id}/reconstructed`, cookies: as(benCookie) });
    expect(done.statusCode).toBe(200);
    expect((await ceremonyOf(ownerId))!.status).toBe('released');
  });
});
