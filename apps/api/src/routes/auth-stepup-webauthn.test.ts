import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import {
  bytesToBase64url,
  type AuthenticationOutcome,
  type RegistrationOutcome,
  type WebAuthnVerifier,
} from '../auth/webauthn.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

// Step-up second factor via WebAuthn (PHASE4 C5A) — the bootstrap fix. A fresh
// passkey-only user re-taps their passkey to stamp last_stepup_at, which is what
// makes EVERY step-up gate reachable in a browser. These integration tests drive
// the real endpoints with the DI'd verifier fake (the orchestration — atomic
// challenge consume, cross-user binding, clone detection, the stamp — is ours; the
// cryptographic assertion is @simplewebauthn's, faked here).
const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const CID = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
const CID2 = new Uint8Array([81, 82, 83, 84, 85, 86, 87, 88]);

function regResponse(credentialId: Uint8Array): Record<string, unknown> {
  const id = bytesToBase64url(credentialId);
  return { id, rawId: id, type: 'public-key', response: { clientDataJSON: '', attestationObject: '' }, clientExtensionResults: {} };
}
function authResponse(credentialId: Uint8Array): Record<string, unknown> {
  const id = bytesToBase64url(credentialId);
  return { id, rawId: id, type: 'public-key', response: { clientDataJSON: '', authenticatorData: '', signature: '' }, clientExtensionResults: {} };
}

describeIfDb('step-up WebAuthn second factor (PHASE4 C5A)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
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
      reg: { verified: true, credentialId: CID, publicKey: new Uint8Array([1, 1, 1]), counter: 0, transports: null, aaguid: null },
      auth: { verified: true, newCounter: 1 },
    };
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql, webauthnVerifier: verifier });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // Register + login a user with credential `cid`, leaving them at sign count
  // `loginCounter`. Returns the session cookie + the user id.
  async function registerAndLogin(email: string, cid: Uint8Array, loginCounter = 1): Promise<{ cookie: string; userId: string }> {
    fake.reg = { verified: true, credentialId: cid, publicKey: new Uint8Array([1, 1, 1]), counter: 0, transports: null, aaguid: null };
    const ro = await app.inject({ method: 'POST', url: '/v1/auth/register/options', payload: { email } });
    await app.inject({ method: 'POST', url: '/v1/auth/register/verify', payload: { challengeId: ro.json().challengeId, response: regResponse(cid) } });
    fake.auth = { verified: true, newCounter: loginCounter };
    const lo = await app.inject({ method: 'POST', url: '/v1/auth/login/options', payload: { email } });
    const lr = await app.inject({ method: 'POST', url: '/v1/auth/login/verify', payload: { challengeId: lo.json().challengeId, response: authResponse(cid) } });
    const cookie = lr.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const userId = (await db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.credentialId, cid)))[0]!.userId;
    return { cookie, userId };
  }
  async function stepUpOptions(cookie: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/step-up/webauthn/options', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    return res.json().challengeId as string;
  }
  // Probe whether the session's second factor is fresh, via a step-up-gated route's
  // R1 (totp/setup). No body, no signature — R1 just reports satisfiedBySession.
  async function gateSatisfied(cookie: string): Promise<boolean> {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/totp/setup', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('https://truecairn.app/problems/step-up-required');
    return res.json().stepUp.secondFactor.satisfiedBySession as boolean;
  }

  it('options issues a session-scoped stepup_webauthn challenge', async () => {
    const { cookie, userId } = await registerAndLogin('founder@example.com', CID);
    const challengeId = await stepUpOptions(cookie);
    const [ch] = await db.select().from(schema.authChallenges).where(eq(schema.authChallenges.id, challengeId));
    expect(ch!.purpose).toBe('stepup_webauthn');
    expect(ch!.userId).toBe(userId); // bound to THIS session's user
  });

  it('a valid assertion stamps last_stepup_at + advances the sign count — satisfying the gate', async () => {
    const { cookie } = await registerAndLogin('founder@example.com', CID, 1);
    // The gate is REAL: before any step-up, the session's factor is not fresh.
    expect(await gateSatisfied(cookie)).toBe(false);

    const challengeId = await stepUpOptions(cookie);
    fake.auth = { verified: true, newCounter: 2 }; // strictly increasing — no regression
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'webauthn', challengeId, response: authResponse(CID) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // last_stepup_at stamped; the credential's counter advanced to the presented one.
    expect((await db.select().from(schema.sessions))[0]!.lastStepupAt).not.toBeNull();
    expect((await db.select().from(schema.webauthnCredentials))[0]!.signCount).toBe(2);
    // The assertion is exactly what unlocks the gate (false → true).
    expect(await gateSatisfied(cookie)).toBe(true);
  });

  it('honours the platform-passkey 0/0 counter exception (does not false-positive a regression)', async () => {
    // Touch ID / Windows Hello report counter 0 by design; a 0→0 step-up must pass.
    const { cookie } = await registerAndLogin('hello@example.com', CID, 0); // stays at 0
    const challengeId = await stepUpOptions(cookie);
    fake.auth = { verified: true, newCounter: 0 };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'webauthn', challengeId, response: authResponse(CID) },
    });
    expect(res.statusCode).toBe(200);
    expect((await db.select().from(schema.sessions))[0]!.lastStepupAt).not.toBeNull();
  });

  it("rejects an assertion whose credential belongs to ANOTHER user (401, not stamped)", async () => {
    const victim = await registerAndLogin('victim@example.com', CID);
    await registerAndLogin('attacker@example.com', CID2); // a second user + credential
    const challengeId = await stepUpOptions(victim.cookie); // victim's challenge
    // Present the attacker's credential id against the victim's session/challenge.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: victim.cookie },
      payload: { method: 'webauthn', challengeId, response: authResponse(CID2) },
    });
    expect(res.statusCode).toBe(401);
    const victimSession = (await db.select().from(schema.sessions).where(eq(schema.sessions.userId, victim.userId)))[0];
    expect(victimSession!.lastStepupAt).toBeNull(); // nothing stamped
  });

  it('rejects a sign-count regression (clone signal) without stamping', async () => {
    const { cookie } = await registerAndLogin('clone@example.com', CID, 5); // counter at 5
    const challengeId = await stepUpOptions(cookie);
    fake.auth = { verified: true, newCounter: 5 }; // flat 5 ≤ 5 — the clone signal
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'webauthn', challengeId, response: authResponse(CID) },
    });
    expect(res.statusCode).toBe(401);
    expect((await db.select().from(schema.sessions))[0]!.lastStepupAt).toBeNull();
    expect((await db.select().from(schema.webauthnCredentials))[0]!.signCount).toBe(5); // unchanged
  });

  it('rejects a replayed step-up challenge', async () => {
    const { cookie } = await registerAndLogin('replay@example.com', CID, 1);
    const challengeId = await stepUpOptions(cookie);
    fake.auth = { verified: true, newCounter: 2 };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'webauthn', challengeId, response: authResponse(CID) },
    });
    expect(first.statusCode).toBe(200);
    fake.auth = { verified: true, newCounter: 3 };
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'webauthn', challengeId, response: authResponse(CID) },
    });
    expect(replay.statusCode).toBe(401); // the challenge was single-use
  });
});
