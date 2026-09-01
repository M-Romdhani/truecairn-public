import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession, SESSION_COOKIE } from '../auth/session.js';
import {
  bytesToBase64url,
  type AuthenticationOutcome,
  type RegistrationOutcome,
  type WebAuthnVerifier,
} from '../auth/webauthn.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// A fixed credential id used across a register→login pair. The fake verifier
// reports it on registration; the login response echoes it as `id`.
const CID = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

function regResponse(credentialId: Uint8Array): Record<string, unknown> {
  const id = bytesToBase64url(credentialId);
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: '', attestationObject: '' },
    clientExtensionResults: {},
  };
}

function authResponse(credentialId: Uint8Array): Record<string, unknown> {
  const id = bytesToBase64url(credentialId);
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: '', authenticatorData: '', signature: '' },
    clientExtensionResults: {},
  };
}

describeIfDb('WebAuthn register + authenticate routes (integration)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;

  // Mutable per-test verifier outcomes; the injected verifier reads these.
  let fake: { reg: RegistrationOutcome; auth: AuthenticationOutcome };
  const verifier: WebAuthnVerifier = {
    verifyRegistration: async () => fake.reg,
    verifyAuthentication: async () => fake.auth,
  };

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE auth_challenges, webauthn_credentials, sessions, audit_log_locks, audit_log, users CASCADE`;
    fake = {
      reg: {
        verified: true,
        credentialId: CID,
        publicKey: new Uint8Array([1, 1, 1]),
        counter: 0,
        transports: null,
        aaguid: null,
      },
      auth: { verified: true, newCounter: 1 },
    };
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql, webauthnVerifier: verifier });
    // A protected route to prove the issued session actually authorizes.
    app.get('/protected', { preHandler: requireSession }, async (request) => ({
      userId: request.session?.userId ?? null,
    }));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function registerOptions(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register/options',
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    return res.json().challengeId as string;
  }

  async function loginOptions(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/options',
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    return res.json().challengeId as string;
  }

  it('register/options creates a pending user and stores a register challenge', async () => {
    const challengeId = await registerOptions('founder@example.com');
    expect(typeof challengeId).toBe('string');

    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0]!.accountStatus).toBe('pending');

    const challenges = await db.select().from(schema.authChallenges);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.purpose).toBe('webauthn_register');
  });

  it('register/options rejects the reserved tombstone email domain (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register/options',
      payload: { email: 'attacker@deleted.truecairn.local' },
    });
    expect(res.statusCode).toBe(400);
    // No user or challenge was created.
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });

  it('register → login round-trip issues a working session cookie', async () => {
    const email = 'a@example.com';
    const c1 = await registerOptions(email);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register/verify',
      payload: { challengeId: c1, response: regResponse(CID) },
    });
    expect(verifyRes.statusCode).toBe(201);
    expect(verifyRes.json().credentialId).toBe(bytesToBase64url(CID));

    const creds = await db.select().from(schema.webauthnCredentials);
    expect(creds).toHaveLength(1);
    expect(creds[0]!.isHardwareKey).toBe(false);

    const c2 = await loginOptions(email);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/verify',
      payload: { challengeId: c2, response: authResponse(CID) },
    });
    expect(loginRes.statusCode).toBe(200);
    const cookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(String(cookie!.sameSite).toLowerCase()).toBe('strict');

    // sign_count advanced to the presented counter.
    const after = await db.select().from(schema.webauthnCredentials);
    expect(after[0]!.signCount).toBe(1);

    // The issued cookie authorizes a requireSession route.
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE]: cookie!.value },
    });
    expect(protectedRes.statusCode).toBe(200);
    expect(protectedRes.json().userId).toBe(creds[0]!.userId);
  });

  it('a verified passkey assertion RELEASES an account lock (audit finding 1)', async () => {
    // The lock is set by the PASSWORD route, keyed on an attacker-supplied
    // email, and a no-password account still reaches it via the reject path. It
    // used to be cleared only by that same route — which a passkey-only owner
    // never calls — so they stayed locked in the database indefinitely, long
    // past the one-hour expiry, with no way out. A valid assertion is
    // cryptographic proof of possession: whoever holds it is by definition not
    // the guesser the lock was raised against.
    const email = 'locked-passkey@example.com';
    const c1 = await registerOptions(email);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register/verify',
      payload: { challengeId: c1, response: regResponse(CID) },
    });
    const [cred] = await db.select().from(schema.webauthnCredentials);
    const userId = cred!.userId;

    // Lock it the way recordAttempt does, an hour out.
    await db
      .update(schema.users)
      .set({ accountStatus: 'locked', lockedUntil: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(schema.users.id, userId));

    const c2 = await loginOptions(email);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/verify',
      payload: { challengeId: c2, response: authResponse(CID) },
    });
    expect(loginRes.statusCode).toBe(200);

    const [after] = await db
      .select({ status: schema.users.accountStatus, until: schema.users.lockedUntil })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(after?.status).toBe('active');
    expect(after?.until).toBeNull();

    // And the session it issued actually works — before this fix the login
    // succeeded and every subsequent request 403'd, which is the trap.
    const cookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE);
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { [SESSION_COOKIE]: cookie!.value },
    });
    expect(protectedRes.statusCode).toBe(200);
  });

  it('register/verify rejects a replayed challenge', async () => {
    const c1 = await registerOptions('b@example.com');
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/register/verify',
      payload: { challengeId: c1, response: regResponse(CID) },
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/register/verify',
      payload: { challengeId: c1, response: regResponse(CID) },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('register/verify rejects an unverified attestation and stores nothing', async () => {
    const c1 = await registerOptions('c@example.com');
    fake.reg = { ...fake.reg, verified: false };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register/verify',
      payload: { challengeId: c1, response: regResponse(CID) },
    });
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(schema.webauthnCredentials)).toHaveLength(0);
  });

  it('login/verify returns 401 for an unknown credential', async () => {
    // No credential registered for this account at all.
    await registerOptions('d@example.com'); // creates the user only
    const c2 = await loginOptions('d@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/verify',
      payload: { challengeId: c2, response: authResponse(new Uint8Array([9, 9, 9])) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('login/verify rejects a sign_count regression AND writes an audit entry', async () => {
    const email = 'e@example.com';
    // Register with a stored counter of 5.
    fake.reg = { ...fake.reg, counter: 5 };
    const c1 = await registerOptions(email);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register/verify',
      payload: { challengeId: c1, response: regResponse(CID) },
    });
    const userId = (await db.select().from(schema.webauthnCredentials))[0]!.userId;

    // Present a flat counter (5 <= 5) — the clone signal.
    fake.auth = { verified: true, newCounter: 5 };
    const c2 = await loginOptions(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/verify',
      payload: { challengeId: c2, response: authResponse(CID) },
    });
    expect(res.statusCode).toBe(401);

    // No session was issued...
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
    // ...but the regression was recorded (committed in the same tx as the consume).
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.userId, userId), isNull(schema.auditLog.userSignature)),
      );
    const regression = entries.find((e) => e.eventType === 'webauthn.signcount_regression');
    expect(regression).toBeDefined();
    expect((regression!.eventPayload as { action?: string }).action).toBe('reject');
  });
});
