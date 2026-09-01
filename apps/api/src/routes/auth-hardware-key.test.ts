import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ed25519Sign,
  generateEd25519Keypair,
  initCrypto,
} from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession, stampStepUp } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildStepUpSigningInput } from '../auth/stepup.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
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

const TOTP_KEK_B64 = Buffer.alloc(32, 7).toString('base64');
const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const HW_CID = new Uint8Array([200, 201, 202, 203]);

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

describeIfDb('hardware-key registration via the step-up handshake (end-to-end)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: TOTP_KEK_B64 });
  const currentKek = config.totpKeks.byId.get(config.totpKeks.currentId)!;

  const fake = {
    reg: {
      verified: true,
      credentialId: HW_CID,
      publicKey: new Uint8Array([5, 5, 5]),
      counter: 0,
      transports: null,
      aaguid: null,
    } as RegistrationOutcome,
    auth: { verified: true, newCounter: 1 } as AuthenticationOutcome,
  };
  const verifier: WebAuthnVerifier = {
    verifyRegistration: async () => fake.reg,
    verifyAuthentication: async () => fake.auth,
  };

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
    await sql`TRUNCATE auth_challenges, webauthn_credentials, totp_credentials, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql, webauthnVerifier: verifier });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // A logged-in user holding: a confirmed TOTP factor (for the second-factor
  // sub-step) and an enrolled audit signing key (the step-up signature verifies
  // against its public half). Returns the session cookie and the signing secret.
  async function seedLoggedInUser(
    email: string,
  ): Promise<{ cookie: string; userId: UserId; signingSecret: Uint8Array }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;

    const enc = encryptTotpSecret(currentKek.key, TOTP_SECRET);
    await db.insert(schema.totpCredentials).values({
      userId,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: currentKek.id,
      confirmedAt: new Date(),
    });

    const kp = generateEd25519Keypair();
    const ph = new Uint8Array(16);
    await db.insert(schema.userKeyMaterial).values({
      userId,
      masterPassphraseSalt: ph,
      masterKeyWrappedByPassphrase: ph,
      masterKeyPassphraseNonce: ph,
      recoveryCodeSalt: ph,
      masterKeyWrappedByRecovery: ph,
      masterKeyRecoveryNonce: ph,
      releasePassphraseSalt: ph,
      auditSigningPubkey: kp.publicKey,
    });

    const { token } = await createSession(db, { userId, now: new Date() });
    return { cookie: token, userId, signingSecret: kp.secretKey };
  }

  it('R1 → 403 step-up-required → second-factor → R2 with signature → 201', async () => {
    const { cookie, userId, signingSecret } = await seedLoggedInUser('founder@example.com');

    // First, get the registration options (session-only).
    const optsRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/options',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(optsRes.statusCode).toBe(200);
    const regChallengeId = optsRes.json().challengeId as string;
    const body = { challengeId: regChallengeId, response: regResponse(HW_CID) };

    // R1: verify WITHOUT step-up headers → 403 step-up-required + a challenge.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/verify',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: body,
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().type).toBe('https://truecairn.app/problems/step-up-required');
    const stepUp = r1.json().stepUp;
    expect(stepUp.secondFactor.satisfiedBySession).toBe(false);
    const stepChallengeId = stepUp.challengeId as string;
    const stepChallenge = new Uint8Array(Buffer.from(stepUp.challenge as string, 'base64url'));

    // Second-factor sub-step: prove TOTP → stamps last_stepup_at.
    const sf = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
    });
    expect(sf.statusCode).toBe(200);

    // R2: re-send the IDENTICAL action body, now carrying the passphrase
    // signature over the canonical step-up payload (action + challenge + body).
    const signingInput = buildStepUpSigningInput(
      userId,
      'register_hardware_key',
      stepChallenge,
      body,
    );
    const signature = ed25519Sign(signingInput, signingSecret);
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/verify',
      cookies: { [SESSION_COOKIE]: cookie },
      headers: {
        'x-truecairn-stepup-challenge': stepChallengeId,
        'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
      },
      payload: body,
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().credentialId).toBe(bytesToBase64url(HW_CID));

    // The credential is stored as a hardware key...
    const creds = await db
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId));
    expect(creds).toHaveLength(1);
    expect(creds[0]!.isHardwareKey).toBe(true);

    // ...and the enrolment audit entry records the step-up linkage.
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    const reg = entries.find((e) => e.eventType === 'hardware_key.registered');
    expect(reg).toBeDefined();
    expect((reg!.eventPayload as { stepUpChallengeId?: string }).stepUpChallengeId).toBe(
      stepChallengeId,
    );
  });

  it('R2 with a WRONG signature is refused (403 step-up-invalid) and stores nothing', async () => {
    const { cookie, userId, signingSecret } = await seedLoggedInUser('b@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
    });
    const optsRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/options',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    const body = { challengeId: optsRes.json().challengeId as string, response: regResponse(HW_CID) };

    // Issue a real step-up challenge via an R1 probe.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/verify',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: body,
    });
    const stepChallengeId = r1.json().stepUp.challengeId as string;

    // Sign the WRONG bytes (different action type) → verification fails.
    const wrong = ed25519Sign(
      buildStepUpSigningInput(userId, 'totp_setup', new Uint8Array(32), body),
      signingSecret,
    );
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/verify',
      cookies: { [SESSION_COOKIE]: cookie },
      headers: {
        'x-truecairn-stepup-challenge': stepChallengeId,
        'x-truecairn-stepup-signature': Buffer.from(wrong).toString('base64url'),
      },
      payload: body,
    });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().type).toBe('https://truecairn.app/problems/step-up-invalid');
    expect(await db.select().from(schema.webauthnCredentials)).toHaveLength(0);
  });

  it('a fresh second factor alone (no signature) is still 403 — both predicates required', async () => {
    const { cookie, userId } = await seedLoggedInUser('c@example.com');
    // Make the second factor fresh directly.
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    await stampStepUp(db, sessions[0]!.id as never, new Date());

    const optsRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/options',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    const body = { challengeId: optsRes.json().challengeId as string, response: regResponse(HW_CID) };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/verify',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: body, // fresh factor, but NO signature headers
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('https://truecairn.app/problems/step-up-required');
  });

  it('the options endpoint requires a session (401 without a cookie)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/hardware-key/register/options',
    });
    expect(res.statusCode).toBe(401);
  });
});
