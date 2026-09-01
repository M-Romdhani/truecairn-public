import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ed25519Sign, generateEd25519Keypair, initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildStepUpSigningInput } from '../auth/stepup.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const b64 = (n: number, fill = 1): string => Buffer.from(new Uint8Array(n).fill(fill)).toString('base64');

describeIfDb('account/key sensitive endpoints (step-up gated, end-to-end)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });
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
    await sql`TRUNCATE release_shares, sensitive_actions, auth_challenges, totp_credentials, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeOwner(
    email: string,
    withKeyMaterial = true,
  ): Promise<{ userId: UserId; cookie: string; signingSecret: Uint8Array }> {
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
    if (withKeyMaterial) {
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
    }
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token, signingSecret: kp.secretKey };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });

  async function stepUp(
    actionType: string,
    routeUrl: string,
    body: Record<string, unknown>,
    cookie: string,
    userId: UserId,
    signingSecret: Uint8Array,
  ) {
    const r1 = await app.inject({ method: 'POST', url: routeUrl, cookies: as(cookie), payload: body });
    expect(r1.statusCode).toBe(403);
    const challenge = new Uint8Array(Buffer.from(r1.json().stepUp.challenge as string, 'base64url'));
    await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: as(cookie),
      payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
    });
    const sig = ed25519Sign(buildStepUpSigningInput(userId, actionType, challenge, body), signingSecret);
    return app.inject({
      method: 'POST',
      url: routeUrl,
      cookies: as(cookie),
      headers: {
        'x-truecairn-stepup-challenge': r1.json().stepUp.challengeId as string,
        'x-truecairn-stepup-signature': Buffer.from(sig).toString('base64url'),
      },
      payload: body,
    });
  }

  it('refuses a contact-only account (no key material) with 409, before step-up', async () => {
    const { cookie } = await makeOwner('contact-only@example.com', /* withKeyMaterial */ false);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery-code/rotate',
      cookies: as(cookie),
      payload: { recoveryCodeSalt: b64(16), masterKeyWrappedByRecovery: b64(48), masterKeyRecoveryNonce: b64(24) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-owner-required');
  });

  it('enqueues rotate_recovery_code via the step-up handshake', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('rc@example.com');
    const body = {
      recoveryCodeSalt: b64(16, 5),
      masterKeyWrappedByRecovery: b64(48, 6),
      masterKeyRecoveryNonce: b64(24, 7),
    };
    const res = await stepUp('rotate_recovery_code', '/v1/account/recovery-code/rotate', body, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('rotate_recovery_code');
    expect(action!.status).toBe('pending');
    expect(action!.requestedBySessionId).not.toBeNull();
  });

  it('enqueues change_share_composition via the step-up handshake', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('csc@example.com');
    const body = {
      tier: 's3',
      shareIndex: 1,
      newShareType: 'hardware_key',
      wrappedShareCiphertext: b64(32, 9),
    };
    const res = await stepUp('change_share_composition', '/v1/release/share-composition', body, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('change_share_composition');
    expect((action!.actionPayload as { newShareType?: string }).newShareType).toBe('hardware_key');
  });

  it('enqueues rotate_master_passphrase (full re-wrap payload) via the step-up handshake', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('mp@example.com');
    const body = {
      masterPassphraseSalt: b64(16, 1),
      masterKeyWrappedByPassphrase: b64(48, 2),
      masterKeyPassphraseNonce: b64(24, 3),
      masterKeyWrappedByRecovery: b64(48, 4),
      masterKeyRecoveryNonce: b64(24, 5),
      auditSigningPubkey: b64(32, 6),
      generation: 2,
      tierRewraps: [
        { tier: 's1', tierKeyWrappedByMaster: b64(48, 7), tierKeyMasterNonce: b64(24, 8) },
        { tier: 's2', tierKeyWrappedByMaster: b64(48, 9), tierKeyMasterNonce: b64(24, 10) },
      ],
    };
    const res = await stepUp('rotate_master_passphrase', '/v1/account/master-passphrase/rotate', body, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('rotate_master_passphrase');
    expect((action!.actionPayload as { generation?: number }).generation).toBe(2);
  });

  it('enqueues rotate_release_passphrase via the step-up handshake', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('rp@example.com');
    const body = {
      releasePassphraseSalt: b64(16, 1),
      // Nested S3 rotation re-wraps the CONTACT shares (the passphrase is the XOR
      // mask, not a distributed share).
      shares: [
        {
          tier: 's3',
          shareIndex: 1,
          shareType: 'contact',
          contactId: '00000000-0000-0000-0000-000000000001',
          wrappedShareCiphertext: b64(48, 2),
        },
      ],
    };
    const res = await stepUp('rotate_release_passphrase', '/v1/account/release-passphrase/rotate', body, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('rotate_release_passphrase');
  });

  it('enqueues remove_hardware_key via the step-up handshake', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('rhk@example.com');
    const body = { credentialId: '11111111-1111-4111-8111-111111111111' };
    const res = await stepUp('remove_hardware_key', '/v1/account/hardware-keys/remove', body, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('remove_hardware_key');
  });

  it('enqueues delete_account via the step-up handshake', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('del@example.com');
    const res = await stepUp('delete_account', '/v1/account/delete', {}, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('delete_account');
    expect(action!.requestedBySessionId).not.toBeNull();
  });
});
