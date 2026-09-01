import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ed25519Sign, generateEd25519Keypair, initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { SessionId, UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildStepUpSigningInput } from '../auth/stepup.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_KEK_B64 = Buffer.alloc(32, 7).toString('base64');
const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));

// ── Check-in cadence, the request half ───────────────────────────────────────
//
// The APPLIER for `change_inactivity_threshold` has existed in
// packages/sensitive-actions since the engine was built. Nothing could request
// one: no route in apps/api referenced the action type at all, so the most
// personal setting in a continuity product — how long you may be silent before
// it starts asking — was unreachable.
//
// What matters here is that this route only ENQUEUES. The delay is the
// protection, so the assertions below are mostly about what has NOT happened
// yet: the engine row is untouched, the old cadence still governs, and the
// pending action is cancellable for the whole window.
describeIfDb('POST /v1/engine/cadence', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: TOTP_KEK_B64 });
  const currentKek = config.totpKeks.byId.get(config.totpKeks.currentId)!;

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
    await sql`TRUNCATE sensitive_actions, auth_challenges, totp_credentials, user_key_material, engine_states, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function seedOwner(email: string): Promise<{
    cookie: string;
    ownerId: UserId;
    sessionId: SessionId;
    signingSecret: Uint8Array;
  }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const ownerId = u!.id as UserId;
    const enc = encryptTotpSecret(currentKek.key, TOTP_SECRET);
    await db.insert(schema.totpCredentials).values({
      userId: ownerId,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: currentKek.id,
      confirmedAt: new Date(),
    });
    const kp = generateEd25519Keypair();
    const ph = new Uint8Array(16);
    await db.insert(schema.userKeyMaterial).values({
      userId: ownerId,
      masterPassphraseSalt: ph,
      masterKeyWrappedByPassphrase: ph,
      masterKeyPassphraseNonce: ph,
      recoveryCodeSalt: ph,
      masterKeyWrappedByRecovery: ph,
      masterKeyRecoveryNonce: ph,
      releasePassphraseSalt: ph,
      auditSigningPubkey: kp.publicKey,
    });
    await db.insert(schema.engineStates).values({ userId: ownerId, state: 'active' });
    const { id, token } = await createSession(db, { userId: ownerId, now: new Date() });
    return { cookie: token, ownerId, sessionId: id, signingSecret: kp.secretKey };
  }

  // One full step-up round: R1 (403 + challenge) → TOTP if stale → signed R2.
  async function setCadence(
    owner: { cookie: string; ownerId: UserId; signingSecret: Uint8Array },
    days: number,
  ) {
    const body = { days };
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/engine/cadence',
      cookies: { [SESSION_COOKIE]: owner.cookie },
      payload: body,
    });
    if (r1.statusCode !== 403) return r1;
    const stepUp = r1.json().stepUp;
    expect(stepUp.actionType).toBe('change_inactivity_threshold');
    if (stepUp.secondFactor.satisfiedBySession !== true) {
      const sf = await app.inject({
        method: 'POST',
        url: '/v1/auth/step-up/second-factor',
        cookies: { [SESSION_COOKIE]: owner.cookie },
        payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
      });
      expect(sf.statusCode).toBe(200);
    }
    const challenge = new Uint8Array(Buffer.from(stepUp.challenge as string, 'base64url'));
    const signature = ed25519Sign(
      buildStepUpSigningInput(owner.ownerId, 'change_inactivity_threshold', challenge, body),
      owner.signingSecret,
    );
    return app.inject({
      method: 'POST',
      url: '/v1/engine/cadence',
      cookies: { [SESSION_COOKIE]: owner.cookie },
      headers: {
        'x-truecairn-stepup-challenge': stepUp.challengeId as string,
        'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
      },
      payload: body,
    });
  }

  it('is step-up gated, and enqueues WITHOUT changing the cadence yet', async () => {
    const owner = await seedOwner('cadence@example.com');

    const r2 = await setCadence(owner, 14);
    expect(r2.statusCode).toBe(202);
    const { sensitiveActionId, effectiveAt } = r2.json() as {
      sensitiveActionId: string;
      effectiveAt: string;
    };
    expect(sensitiveActionId).toBeTruthy();
    expect(new Date(effectiveAt).getTime()).toBeGreaterThan(Date.now());

    // The delay IS the protection: nothing about the engine has moved.
    const [row] = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, owner.ownerId));
    expect(row!.inactivityThresholdDays).toBe(30);

    const [act] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, sensitiveActionId));
    expect(act!.actionType).toBe('change_inactivity_threshold');
    expect(act!.status).toBe('pending');
    expect(act!.initiatedBy).toBe('owner');
    expect(act!.actionPayload).toMatchObject({ days: 14 });
  });

  it('reports the current cadence on the status route, so a UI can show it', async () => {
    const owner = await seedOwner('status@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/engine/status',
      cookies: { [SESSION_COOKIE]: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inactivityThresholdDays).toBe(30);
  });

  it('converges a retried submission on the SAME pending action', async () => {
    const owner = await seedOwner('retry@example.com');
    const first = await setCadence(owner, 21);
    const second = await setCadence(owner, 21);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().sensitiveActionId).toBe(first.json().sensitiveActionId);

    const rows = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.userId, owner.ownerId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a no-op change rather than queueing seven days of nothing', async () => {
    const owner = await seedOwner('noop@example.com');
    const res = await setCadence(owner, 30);
    expect(res.statusCode).toBe(409);
  });

  // Bounded at the edge. A zero-day threshold would leave the account
  // permanently overdue; past a year the engine stops being a continuity
  // mechanism. Both are rejected before any step-up work happens.
  it.each([0, -1, 366])('rejects an out-of-range cadence: %i', async (days) => {
    const owner = await seedOwner(`bound${days}@example.com`);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/engine/cadence',
      cookies: { [SESSION_COOKIE]: owner.cookie },
      payload: { days },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses when the engine has never been armed', async () => {
    const owner = await seedOwner('unarmed@example.com');
    await db.delete(schema.engineStates).where(eq(schema.engineStates.userId, owner.ownerId));
    const res = await setCadence(owner, 14);
    expect(res.statusCode).toBe(409);
  });
});
