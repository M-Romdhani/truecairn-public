import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import {
  encodeKeyMaterial,
  generateEnrollmentMaterial,
  lock,
  signStepUp,
  unlock,
  type KeyMaterial,
} from '@truecairn/client-crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { SessionId, UserId } from '@truecairn/shared';
import { createSession, stampStepUp } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

// PHASE4 C2 — the step-up signature interop property the reviewer singled out:
// the CLIENT signs over the EXACT canonical bytes the SERVER verifies. Proven by
// construction (one shared buildStepUpSigningInput, relocated to
// @truecairn/audit/canonical) AND by test: a real user provisions (uploading the
// master-key-derived audit pubkey), unlocks, signs a real sensitive action with
// @truecairn/client-crypto's signStepUp, and the server verifies → 202. A drift
// between client signing input and server verification input would fail this.
describeIfDb('step-up signature interop (client signs, server verifies — PHASE4 C2)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

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
    await sql`TRUNCATE user_tier_keys, outer_layer_keys, user_key_material, sensitive_actions, auth_challenges, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    lock();
    await app.close();
  });

  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });

  // A provisioned, fresh-second-factored owner with the vault unlocked client-side.
  async function unlockedOwner(
    email: string,
    passphrase: string,
  ): Promise<{ userId: UserId; cookie: string; material: KeyMaterial }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { id: sessionId, token } = await createSession(db, { userId, now: new Date() });
    const { material } = generateEnrollmentMaterial(utf8(passphrase));
    const prov = await app.inject({
      method: 'POST',
      url: '/v1/account/key-material',
      cookies: as(token),
      payload: encodeKeyMaterial(material),
    });
    expect(prov.statusCode).toBe(201);
    // A fresh second factor (the other half of step-up; proven separately) so R2
    // is gated only by the signature we're testing.
    await stampStepUp(db, sessionId as SessionId, new Date());
    unlock(utf8(passphrase), material);
    return { userId, cookie: token, material };
  }

  // A valid rotate_recovery_code body (content is opaque to the signature test;
  // it just has to satisfy the route schema and be byte-stable across R1/R2).
  const recoveryRotateBody = {
    recoveryCodeSalt: b64([1, 2, 3, 4]),
    masterKeyWrappedByRecovery: b64([5, 6, 7, 8]),
    masterKeyRecoveryNonce: b64([9, 10, 11, 12]),
  };

  it('a client-produced signature verifies server-side and enqueues the action (202)', async () => {
    const { userId, cookie } = await unlockedOwner('interop@example.com', 'pw-interop');

    // R1: no step-up headers → 403 with a fresh challenge.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery-code/rotate',
      cookies: as(cookie),
      payload: recoveryRotateBody,
    });
    expect(r1.statusCode).toBe(403);
    const challenge = new Uint8Array(Buffer.from(r1.json().stepUp.challenge as string, 'base64url'));
    const challengeId = r1.json().stepUp.challengeId as string;

    // The client signs the SHARED canonical bytes with its master-key-derived key.
    const signature = signStepUp({
      userId,
      actionType: 'rotate_recovery_code',
      challenge,
      body: recoveryRotateBody,
    });

    // R2: same request + the challenge/signature headers → server verifies → 202.
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery-code/rotate',
      cookies: as(cookie),
      headers: {
        'x-truecairn-stepup-challenge': challengeId,
        'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
      },
      payload: recoveryRotateBody,
    });
    expect(r2.statusCode).toBe(202);

    const actions = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.userId, userId));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actionType).toBe('rotate_recovery_code');
  });

  it('rejects a signature that covers a different body (the signature binds the request)', async () => {
    const { userId, cookie } = await unlockedOwner('bind@example.com', 'pw-bind');

    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery-code/rotate',
      cookies: as(cookie),
      payload: recoveryRotateBody,
    });
    expect(r1.statusCode).toBe(403);
    const challenge = new Uint8Array(Buffer.from(r1.json().stepUp.challenge as string, 'base64url'));
    const challengeId = r1.json().stepUp.challengeId as string;

    // Sign one body, send a DIFFERENT one → server canonicalises the sent body,
    // the signature was over different bytes → 403 step-up-invalid, no action.
    const signature = signStepUp({
      userId,
      actionType: 'rotate_recovery_code',
      challenge,
      body: recoveryRotateBody,
    });
    const tamperedBody = { ...recoveryRotateBody, masterKeyRecoveryNonce: b64([99, 99, 99, 99]) };

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery-code/rotate',
      cookies: as(cookie),
      headers: {
        'x-truecairn-stepup-challenge': challengeId,
        'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
      },
      payload: tamperedBody,
    });
    expect(r2.statusCode).toBe(403);
    expect(
      await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.userId, userId)),
    ).toHaveLength(0);
  });
});
