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
const SHARE_CT = Buffer.from(new Uint8Array([11, 22, 33, 44])).toString('base64');

describeIfDb('contact share-assignment endpoint (step-up gated, end-to-end)', () => {
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
    await sql`TRUNCATE contacts, sensitive_actions, auth_challenges, totp_credentials, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // A logged-in owner with a confirmed TOTP factor (the second-factor sub-step)
  // and an enrolled audit signing key (the step-up signature verifies against
  // its public half). Returns the cookie, ids, and the signing secret.
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

    const { id, token } = await createSession(db, { userId: ownerId, now: new Date() });
    return { cookie: token, ownerId, sessionId: id, signingSecret: kp.secretKey };
  }

  async function makeContact(
    ownerId: UserId,
    status: 'pending_keygen' | 'enrolled',
  ): Promise<string> {
    const [cu] = await db
      .insert(schema.users)
      .values({ email: `c-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const [c] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId: cu!.id,
        role: 'professional',
        status,
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array([2]),
        contactX25519Pubkey: new Uint8Array(32),
        contactEd25519Pubkey: new Uint8Array(32),
      })
      .returning({ id: schema.contacts.id });
    return c!.id;
  }

  it('rejects a share assignment for a pending_keygen contact with 409 — before any step-up cost', async () => {
    const { cookie, ownerId } = await seedOwner('owner@example.com');
    const contactId = await makeContact(ownerId, 'pending_keygen');

    // A well-formed body, but NO step-up headers. requireContactEnrolled runs
    // before requireStepUp, so this is a cheap 409 — not a 403.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/shares',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { contactId, tier: 's2', shareIndex: 1, wrappedShareCiphertext: SHARE_CT },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/contact-not-enrolled');
    // Nothing was enqueued.
    expect(await db.select().from(schema.sensitiveActions)).toHaveLength(0);
  });

  it('R1 → 403 step-up-required → second-factor → R2 with signature → 202, recording session + step-up linkage', async () => {
    const { cookie, ownerId, sessionId, signingSecret } = await seedOwner('founder@example.com');
    const contactId = await makeContact(ownerId, 'enrolled');
    const body = { contactId, tier: 's2', shareIndex: 1, wrappedShareCiphertext: SHARE_CT };

    // R1: no step-up headers → 403 step-up-required + a fresh challenge.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/contacts/shares',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: body,
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().type).toBe('https://truecairn.app/problems/step-up-required');
    const stepUp = r1.json().stepUp;
    expect(stepUp.actionType).toBe('add_contact');
    expect(stepUp.secondFactor.satisfiedBySession).toBe(false);
    const stepChallengeId = stepUp.challengeId as string;
    const stepChallenge = new Uint8Array(Buffer.from(stepUp.challenge as string, 'base64url'));

    // Second-factor sub-step: prove TOTP → stamps last_stepup_at on the session.
    const sf = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
    });
    expect(sf.statusCode).toBe(200);

    // R2: re-send the IDENTICAL body, now signing the canonical step-up payload
    // (action + challenge + body) with the passphrase key.
    const signingInput = buildStepUpSigningInput(ownerId, 'add_contact', stepChallenge, body);
    const signature = ed25519Sign(signingInput, signingSecret);
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/contacts/shares',
      cookies: { [SESSION_COOKIE]: cookie },
      headers: {
        'x-truecairn-stepup-challenge': stepChallengeId,
        'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
      },
      payload: body,
    });
    expect(r2.statusCode).toBe(202);
    const { sensitiveActionId, effectiveAt } = r2.json();
    expect(typeof sensitiveActionId).toBe('string');
    expect(new Date(effectiveAt).getTime()).toBeGreaterThan(Date.now());

    // The enqueued action is pending, carries the payload, and is attributed to
    // the requesting session (PHASE3_1 §f).
    const [action] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, sensitiveActionId));
    expect(action!.status).toBe('pending');
    expect(action!.actionType).toBe('add_contact');
    expect(action!.requestedBySessionId).toBe(sessionId);
    expect(action!.actionPayload).toMatchObject({ contactId, tier: 's2', shareIndex: 1 });

    // The step-up proof is recorded in the action's audit PAYLOAD for forensic
    // linkage (NOT as audit_log.user_signature).
    const requested = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, ownerId))
    ).find((e) => e.eventType === 'sensitive_action.requested');
    expect(requested).toBeDefined();
    const ap = requested!.eventPayload as { stepUpChallengeId?: string; stepUpSignature?: string };
    expect(ap.stepUpChallengeId).toBe(stepChallengeId);
    expect(ap.stepUpSignature).toBe(Buffer.from(signature).toString('base64url'));
    expect(requested!.userSignature).toBeNull();

    // The share has NOT been written yet — the 7-day cooldown still applies.
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('enrolled');
  });

  it('a retried assignment for the same contact+tier answers with the EXISTING pending action — never a duplicate (QA Pass 2 Finding B)', async () => {
    const { cookie, ownerId, signingSecret } = await seedOwner('retry@example.com');
    const contactId = await makeContact(ownerId, 'enrolled');
    const body = { contactId, tier: 's2', shareIndex: 1, wrappedShareCiphertext: SHARE_CT };

    // A full step-up enqueue round: R1 (403 + challenge) → second factor → R2.
    async function enqueue(): Promise<{ sensitiveActionId: string; effectiveAt: string }> {
      const r1 = await app.inject({
        method: 'POST',
        url: '/v1/contacts/shares',
        cookies: { [SESSION_COOKIE]: cookie },
        payload: body,
      });
      expect(r1.statusCode).toBe(403);
      const stepUp = r1.json().stepUp;
      if (stepUp.secondFactor.satisfiedBySession !== true) {
        const sf = await app.inject({
          method: 'POST',
          url: '/v1/auth/step-up/second-factor',
          cookies: { [SESSION_COOKIE]: cookie },
          payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
        });
        expect(sf.statusCode).toBe(200);
      }
      const challenge = new Uint8Array(Buffer.from(stepUp.challenge as string, 'base64url'));
      const signature = ed25519Sign(
        buildStepUpSigningInput(ownerId, 'add_contact', challenge, body),
        signingSecret,
      );
      const r2 = await app.inject({
        method: 'POST',
        url: '/v1/contacts/shares',
        cookies: { [SESSION_COOKIE]: cookie },
        headers: {
          'x-truecairn-stepup-challenge': stepUp.challengeId as string,
          'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
        },
        payload: body,
      });
      expect(r2.statusCode).toBe(202);
      return r2.json() as { sensitiveActionId: string; effectiveAt: string };
    }

    const first = await enqueue();

    // The retry (e.g. after a stalled passkey prompt left the client unsure)
    // must converge on the SAME pending action, not stack a second one.
    const second = await enqueue();
    expect(second.sensitiveActionId).toBe(first.sensitiveActionId);

    const actions = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.userId, ownerId));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.status).toBe('pending');
  });
});
