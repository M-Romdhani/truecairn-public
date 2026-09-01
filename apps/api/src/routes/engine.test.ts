import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { EngineState, SessionId, UserId } from '@truecairn/shared';
import { createSession, stampStepUp } from '@truecairn/sessions';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('engine endpoints (end-to-end)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let audit: AuditLogWriter;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE engine_states, engine_state_history, sensitive_actions, notification_deliveries, notification_channels, auth_attempts, sessions, audit_log_locks, audit_log, users CASCADE`;
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
  // The arm prerequisite (audit B2): an ENROLLED contact. A minimal row is enough —
  // the count gate filters on status only, not the (unused-here) crypto columns.
  async function enrolContact(
    ownerUserId: UserId,
    status: 'enrolled' | 'invited' = 'enrolled',
  ): Promise<void> {
    await db.insert(schema.contacts).values({
      ownerUserId,
      role: 'personal',
      status,
      displayLabelCiphertext: randomBytes(16),
      displayLabelNonce: randomBytes(12),
    });
  }
  async function withEngine(
    email: string,
    state: EngineState,
  ): Promise<{ userId: UserId; cookie: string; sessionId: SessionId }> {
    const userId = await makeUser(email);
    await db.insert(schema.engineStates).values({ userId, state });
    const { id, token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token, sessionId: id };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });
  async function stateOf(userId: UserId): Promise<EngineState> {
    const [r] = await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, userId));
    return r!.state;
  }

  it('GET status returns the engine state and pending sensitive actions', async () => {
    const { userId, cookie } = await withEngine('status@example.com', 'active');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_recovery_code',
      payload: { x: 1 },
      now: new Date(),
    });
    const res = await app.inject({ method: 'GET', url: '/v1/engine/status', cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('active');
    expect(res.json().pendingSensitiveActions).toHaveLength(1);
    expect(res.json().pendingSensitiveActions[0].actionType).toBe('rotate_recovery_code');
  });

  it('arm: a fresh account (no engine row) with an enrolled contact arms to active and can then check in', async () => {
    const userId = await makeUser('arm@example.com');
    await enrolContact(userId); // the arm prerequisite (audit B2)
    const { token } = await createSession(db, { userId, now: new Date() });
    const before = await app.inject({ method: 'GET', url: '/v1/engine/status', cookies: as(token) });
    expect(before.json().state).toBeNull(); // no engine row yet
    expect(before.json().enrolledContactCount).toBe(1);
    const armed = await app.inject({ method: 'POST', url: '/v1/engine/arm', cookies: as(token) });
    expect(armed.statusCode).toBe(200);
    expect(armed.json().state).toBe('active');
    expect(await stateOf(userId)).toBe('active');
    // The documented check-in control now works (it 409'd before arming).
    const ci = await app.inject({ method: 'POST', url: '/v1/engine/check-in', cookies: as(token), payload: {} });
    expect(ci.statusCode).toBe(200);
    expect(ci.json().state).toBe('active');
  });

  // F-07 (docs/38), made executable. The arm prerequisite covers CONTACTS and
  // nothing else, so an owner can arm the full ladder with no verified way to be
  // reached: the check-in request the engine sends has nowhere to go, and the
  // first thing they learn about it is an escalation — or, if that is unreachable
  // too, a release.
  //
  // Asserted as CURRENT behaviour rather than fixed here, deliberately. Turning
  // this into a 409 would lock existing armed accounts out of re-arming and is a
  // product decision; the chosen remedy is a readiness GAP (no_verified_channel),
  // which warns without blocking. If arm-time enforcement is ever added, this test
  // is the one to invert.
  it('F-07: arms with ZERO verified notification channels, and says nothing about it', async () => {
    const userId = await makeUser('arm-no-channel@example.com');
    await enrolContact(userId);
    const { token } = await createSession(db, { userId, now: new Date() });

    // Precondition: the account genuinely has no channel row of any kind.
    const channelsBefore = await db
      .select({ id: schema.notificationChannels.id })
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.userId, userId));
    expect(channelsBefore).toEqual([]);

    const armed = await app.inject({ method: 'POST', url: '/v1/engine/arm', cookies: as(token) });
    expect(armed.statusCode).toBe(200);
    expect(armed.json().state).toBe('active');

    // No warning of any kind rides the response — the owner is told they are
    // protected, and by the engine's own rules they are not reachable.
    expect(JSON.stringify(armed.json())).not.toMatch(/channel/i);
  });

  // PROPERTY (audit B2, fail closed): the explicit Arm control refuses when no
  // contact is enrolled. A contactless engine could never reach release consensus,
  // so it would arm but never be able to fire — the owner must NOT be left believing
  // they are protected. The prerequisite is enforced server-side, not just in the UI.
  it('arm: refused with 409 when no contact is enrolled, and the engine stays unarmed', async () => {
    const userId = await makeUser('armnocontact@example.com');
    const { token } = await createSession(db, { userId, now: new Date() });
    const res = await app.inject({ method: 'POST', url: '/v1/engine/arm', cookies: as(token) });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/engine-arm-prerequisite');
    // Fail closed: NO engine_states row was created — the switch is genuinely off.
    const [row] = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, userId));
    expect(row).toBeUndefined();
  });

  it('arm: an invited-but-not-enrolled contact does not satisfy the prerequisite', async () => {
    const userId = await makeUser('arminvited@example.com');
    await enrolContact(userId, 'invited'); // pending enrolment — exactly the audit's case
    const { token } = await createSession(db, { userId, now: new Date() });
    const res = await app.inject({ method: 'POST', url: '/v1/engine/arm', cookies: as(token) });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/engine-arm-prerequisite');
  });

  it('arm is idempotent: arming an already-active engine is a no-op', async () => {
    const { userId, cookie } = await withEngine('armidem@example.com', 'active');
    const res = await app.inject({ method: 'POST', url: '/v1/engine/arm', cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('active');
    expect(await stateOf(userId)).toBe('active');
  });

  it('check-in from check_in_pending returns to active', async () => {
    const { userId, cookie } = await withEngine('ci@example.com', 'check_in_pending');
    const res = await app.inject({ method: 'POST', url: '/v1/engine/check-in', cookies: as(cookie), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('active');
    expect(await stateOf(userId)).toBe('active');
  });

  it('check-in from escalation_pending needs an explicit acknowledgment', async () => {
    const { userId, cookie } = await withEngine('esc@example.com', 'escalation_pending');
    const noAck = await app.inject({ method: 'POST', url: '/v1/engine/check-in', cookies: as(cookie), payload: {} });
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().type).toBe('https://truecairn.app/problems/engine-acknowledgment-required');
    expect(await stateOf(userId)).toBe('escalation_pending'); // unchanged

    const acked = await app.inject({
      method: 'POST',
      url: '/v1/engine/check-in',
      cookies: as(cookie),
      payload: { acknowledgedState: 'escalation_pending' },
    });
    expect(acked.statusCode).toBe(200);
    expect(await stateOf(userId)).toBe('active');
  });

  it('check-in in a release state is refused (use cancel-release)', async () => {
    const { cookie } = await withEngine('rel@example.com', 'release_review');
    const res = await app.inject({ method: 'POST', url: '/v1/engine/check-in', cookies: as(cookie), payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it('snooze is valid in check_in_pending, refused in active', async () => {
    const { userId, cookie } = await withEngine('sn@example.com', 'check_in_pending');
    const ok = await app.inject({ method: 'POST', url: '/v1/engine/snooze', cookies: as(cookie), payload: { snoozeDays: 3 } });
    expect(ok.statusCode).toBe(200);
    expect(await stateOf(userId)).toBe('active');

    const bad = await app.inject({ method: 'POST', url: '/v1/engine/snooze', cookies: as(cookie), payload: { snoozeDays: 3 } });
    expect(bad.statusCode).toBe(409); // now active, snooze not valid
  });

  it('cancel-release requires a fresh second factor, then reverts to active', async () => {
    const { userId, cookie, sessionId } = await withEngine('cr@example.com', 'limited_release');
    // No fresh second factor yet → 403.
    const noSf = await app.inject({ method: 'POST', url: '/v1/engine/cancel-release', cookies: as(cookie), payload: {} });
    expect(noSf.statusCode).toBe(403);
    expect(noSf.json().type).toBe('https://truecairn.app/problems/second-factor-required');
    expect(await stateOf(userId)).toBe('limited_release'); // unchanged

    // Stamp a fresh second factor (as the /step-up/second-factor sub-step does).
    await stampStepUp(db, sessionId, new Date());
    const ok = await app.inject({ method: 'POST', url: '/v1/engine/cancel-release', cookies: as(cookie), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe('active');
    expect(await stateOf(userId)).toBe('active');
  });

  it('resolve-review requires a fresh second factor, then re-arms to active (QA 2026-07-21 #3)', async () => {
    const { userId, cookie, sessionId } = await withEngine('rr@example.com', 'review_required');
    // A bare session cookie cannot clear a review hold → 403, state unchanged.
    const noSf = await app.inject({ method: 'POST', url: '/v1/engine/resolve-review', cookies: as(cookie), payload: {} });
    expect(noSf.statusCode).toBe(403);
    expect(noSf.json().type).toBe('https://truecairn.app/problems/second-factor-required');
    expect(await stateOf(userId)).toBe('review_required');

    await stampStepUp(db, sessionId, new Date());
    const ok = await app.inject({ method: 'POST', url: '/v1/engine/resolve-review', cookies: as(cookie), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe('active');
    expect(await stateOf(userId)).toBe('active');
    // The transition is audited + recorded like every engine move.
    const history = await db
      .select()
      .from(schema.engineStateHistory)
      .where(eq(schema.engineStateHistory.userId, userId));
    expect(history.some((h) => h.reason === 'owner_resolved_review' && h.toState === 'active')).toBe(true);
  });

  it('resolve-review is refused outside review_required (review-only exit)', async () => {
    const { userId, cookie, sessionId } = await withEngine('rr2@example.com', 'limited_release');
    await stampStepUp(db, sessionId, new Date());
    const res = await app.inject({ method: 'POST', url: '/v1/engine/resolve-review', cookies: as(cookie), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(await stateOf(userId)).toBe('limited_release');
  });

  // RETURNING was the last owner dead end, and the one an owner is most likely
  // to hit: the state is entered by the owner READING their own vault during a
  // release, so showing up was what locked them out. docs/02 §9 + §"Cancel
  // paths" require an owner exit; nothing emitted user_passphrase_confirm_return.
  // These three pin the exit shut against regression.
  it('confirm-return requires a fresh second factor, then reverts to active', async () => {
    const { userId, cookie, sessionId } = await withEngine('cret@example.com', 'returning');
    await db
      .update(schema.engineStates)
      .set({ previousState: 'limited_release' })
      .where(eq(schema.engineStates.userId, userId));

    // A bare session cookie cannot clear a return hold → 403, state unchanged.
    const noSf = await app.inject({ method: 'POST', url: '/v1/engine/confirm-return', cookies: as(cookie), payload: {} });
    expect(noSf.statusCode).toBe(403);
    expect(noSf.json().type).toBe('https://truecairn.app/problems/second-factor-required');
    expect(await stateOf(userId)).toBe('returning');

    await stampStepUp(db, sessionId, new Date());
    const ok = await app.inject({ method: 'POST', url: '/v1/engine/confirm-return', cookies: as(cookie), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe('active');
    expect(await stateOf(userId)).toBe('active');
    const history = await db
      .select()
      .from(schema.engineStateHistory)
      .where(eq(schema.engineStateHistory.userId, userId));
    expect(
      history.some((h) => h.reason === 'user_passphrase_confirmed_return' && h.toState === 'active'),
    ).toBe(true);
  });

  it('RETURNING is not a dead end — the owner always has a way back to active', async () => {
    const { userId, cookie, sessionId } = await withEngine('deadend@example.com', 'returning');
    await db
      .update(schema.engineStates)
      .set({ previousState: 'limited_release' })
      .where(eq(schema.engineStates.userId, userId));
    await stampStepUp(db, sessionId, new Date());

    // Check-in doesn't serve this state, but it must POINT at the door rather
    // than dead-ending the owner on a bare "not valid here".
    const checkInRes = await app.inject({ method: 'POST', url: '/v1/engine/check-in', cookies: as(cookie), payload: {} });
    expect(checkInRes.statusCode).toBe(409);
    expect(checkInRes.json().detail).toContain('/v1/engine/confirm-return');

    // And the door itself opens.
    const ok = await app.inject({ method: 'POST', url: '/v1/engine/confirm-return', cookies: as(cookie), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(await stateOf(userId)).toBe('active');
  });

  it('confirm-return is refused outside returning (return-only exit)', async () => {
    const { userId, cookie, sessionId } = await withEngine('cret2@example.com', 'limited_release');
    await stampStepUp(db, sessionId, new Date());
    const res = await app.inject({ method: 'POST', url: '/v1/engine/confirm-return', cookies: as(cookie), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(await stateOf(userId)).toBe('limited_release');
  });

  it('cancels a pending sensitive action (owner only)', async () => {
    const { userId, cookie } = await withEngine('cp@example.com', 'active');
    const { id } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_recovery_code',
      payload: { x: 1 },
      now: new Date(),
    });
    // A different user cannot cancel it.
    const otherId = await makeUser('other@example.com');
    const { token: otherCookie } = await createSession(db, { userId: otherId, now: new Date() });
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/account/sensitive-actions/cancel',
      cookies: as(otherCookie),
      payload: { sensitiveActionId: id },
    });
    expect(denied.statusCode).toBe(404);

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/account/sensitive-actions/cancel',
      cookies: as(cookie),
      payload: { sensitiveActionId: id },
    });
    expect(ok.statusCode).toBe(200);
    const [action] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id));
    expect(action!.status).toBe('cancelled');
  });
});
