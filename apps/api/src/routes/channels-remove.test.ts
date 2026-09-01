import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ed25519Sign, generateEd25519Keypair, initCrypto } from '@truecairn/crypto';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
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

// Removing a VERIFIED channel is a sensitive action (docs/26 §4): step-up +
// cooldown through POST /v1/settings/channels/remove. The immediate DELETE
// stays for unverified channels only (proven in channels.test.ts).
describeIfDb('channel removal via the sensitive-actions lane (step-up gated)', () => {
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
    await sql`TRUNCATE sensitive_actions, auth_challenges, totp_credentials, user_key_material, notification_deliveries, notification_channels, sessions, audit_log_locks, audit_log, users CASCADE`;
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

    const { id, token } = await createSession(db, { userId: ownerId, now: new Date() });
    return { cookie: token, ownerId, sessionId: id, signingSecret: kp.secretKey };
  }

  async function makeChannel(userId: UserId, destination: string, verified = true): Promise<string> {
    const [c] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType: 'email',
        destination,
        destinationHash: channelDestinationHash('email', destination),
        verified,
      })
      .returning({ id: schema.notificationChannels.id });
    return c!.id;
  }

  // One full step-up round: R1 (403 + challenge) → TOTP if stale → signed R2.
  async function enqueueRemoval(
    owner: { cookie: string; ownerId: UserId; signingSecret: Uint8Array },
    channelId: string,
  ) {
    const body = { channelId };
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels/remove',
      cookies: { [SESSION_COOKIE]: owner.cookie },
      payload: body,
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().type).toBe('https://truecairn.app/problems/step-up-required');
    const stepUp = r1.json().stepUp;
    expect(stepUp.actionType).toBe('remove_channel');
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
      buildStepUpSigningInput(owner.ownerId, 'remove_channel', challenge, body),
      owner.signingSecret,
    );
    return app.inject({
      method: 'POST',
      url: '/v1/settings/channels/remove',
      cookies: { [SESSION_COOKIE]: owner.cookie },
      headers: {
        'x-truecairn-stepup-challenge': stepUp.challengeId as string,
        'x-truecairn-stepup-signature': Buffer.from(signature).toString('base64url'),
      },
      payload: body,
    });
  }

  it('R1 403 → second factor → signed R2 → 202 pending; the channel stays live through the cooldown', async () => {
    const owner = await seedOwner('remove@example.com');
    const channelId = await makeChannel(owner.ownerId, 'remove@example.com');

    const r2 = await enqueueRemoval(owner, channelId);
    expect(r2.statusCode).toBe(202);
    const { sensitiveActionId, effectiveAt } = r2.json() as {
      sensitiveActionId: string;
      effectiveAt: string;
    };
    expect(new Date(effectiveAt).getTime()).toBeGreaterThan(Date.now());

    const [action] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, sensitiveActionId));
    expect(action!.status).toBe('pending');
    expect(action!.actionType).toBe('remove_channel');
    expect(action!.actionPayload).toMatchObject({ channelId });

    // NOT removed yet — the cooldown is the control.
    const [ch] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, channelId));
    expect(ch!.removedAt).toBeNull();

    // The doomed channel itself carries the pending-removal notice
    // (docs/10-threat-5.2).
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.channelId, channelId));
    expect(deliveries.some((d) => d.purpose === 'sensitive_action_notice')).toBe(true);
  });

  it('a retried removal converges on the EXISTING pending action', async () => {
    const owner = await seedOwner('retry-remove@example.com');
    const channelId = await makeChannel(owner.ownerId, 'retry-remove@example.com');

    const first = await enqueueRemoval(owner, channelId);
    expect(first.statusCode).toBe(202);
    const second = await enqueueRemoval(owner, channelId);
    expect(second.statusCode).toBe(202);
    expect((second.json() as { sensitiveActionId: string }).sensitiveActionId).toBe(
      (first.json() as { sensitiveActionId: string }).sensitiveActionId,
    );
    const actions = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.userId, owner.ownerId));
    expect(actions).toHaveLength(1);
  });

  it("404s a stranger's channel — the victim's channel is untouched", async () => {
    const owner = await seedOwner('victim-remove@example.com');
    const stranger = await seedOwner('stranger-remove@example.com');
    const channelId = await makeChannel(owner.ownerId, 'victim-remove@example.com');

    const res = await enqueueRemoval(stranger, channelId);
    expect(res.statusCode).toBe(404);
    // The victim's channel is untouched, nothing enqueued.
    const [ch] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, channelId));
    expect(ch!.removedAt).toBeNull();
    expect(await db.select().from(schema.sensitiveActions)).toHaveLength(0);
  });
});
