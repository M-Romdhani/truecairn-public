import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type {
  DeliveryStatus,
  NotificationChannelHealth,
  NotificationChannelType,
  UserId,
} from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const SECRET = 'test-webhook-secret-0123456789';
const sign = (body: string): string =>
  createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex');

describeIfDb('provider-delivery webhook (PHASE3_5 §d)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({
    TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
    NOTIFICATIONS_WEBHOOK_SECRET: SECRET,
  });

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE notification_deliveries, notification_channels, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeUser(): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `wh-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function makeChannel(
    userId: UserId,
    health: NotificationChannelHealth,
    consecutiveFailures: number,
    channelType: NotificationChannelType = 'email',
  ): Promise<string> {
    const [c] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType,
        destination: 'x@example.com',
        destinationHash: channelDestinationHash(channelType, 'x@example.com'),
        verified: true,
        health,
        consecutiveFailures,
      })
      .returning({ id: schema.notificationChannels.id });
    return c!.id;
  }
  // A delivery the worker has already handed to the provider: status 'sent',
  // correlatable by provider_message_id.
  async function makeSentDelivery(
    channelId: string,
    userId: UserId,
    providerMessageId: string,
  ): Promise<string> {
    const [d] = await db
      .insert(schema.notificationDeliveries)
      .values({
        channelId,
        userId,
        purpose: 'check_in_request',
        status: 'sent',
        provider: 'resend',
        providerMessageId,
        sentAt: new Date('2026-08-01T00:00:00Z'),
      })
      .returning({ id: schema.notificationDeliveries.id });
    return d!.id;
  }
  async function delivery(id: string): Promise<{ status: DeliveryStatus; deliveredAt: Date | null; bouncedAt: Date | null }> {
    const [d] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, id));
    return d!;
  }
  async function channel(id: string): Promise<{ health: NotificationChannelHealth; consecutiveFailures: number; lastSuccessAt: Date | null }> {
    const [c] = await db.select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, id));
    return c!;
  }
  const post = (body: string, signature: string | undefined, provider = 'resend') =>
    app.inject({
      method: 'POST',
      url: `/v1/notifications/webhook/${provider}`,
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined ? { 'x-truecairn-signature': signature } : {}),
      },
      payload: body,
    });

  // ── Property 2: a VALID signature flips the delivery + adjusts channel health ──
  it('a valid delivered callback flips sent → delivered and credits channel health', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'degraded', 2); // recovering channel
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-1');
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-msg-1' } });

    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    const d = await delivery(id);
    expect(d.status).toBe('delivered');
    expect(d.deliveredAt).not.toBeNull();
    const c = await channel(channelId);
    expect(c.health).toBe('healthy'); // credited: degraded → healthy
    expect(c.consecutiveFailures).toBe(0);
    expect(c.lastSuccessAt).not.toBeNull();
  });

  it('a valid bounced callback flips sent → bounced and debits channel health', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'healthy', 0);
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-2');
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'resend-msg-2' } });

    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    const d = await delivery(id);
    expect(d.status).toBe('bounced');
    expect(d.bouncedAt).not.toBeNull();
    const c = await channel(channelId);
    expect(c.consecutiveFailures).toBe(1); // debited: 0 → 1
    expect(c.health).toBe('degraded');
  });

  // ── Property 2: an INVALID signature is rejected 401 BEFORE any state change ──
  it('rejects a forged signature with 401 and leaves the delivery untouched', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'healthy', 0);
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-3');
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-msg-3' } });

    // Right length, wrong bytes (a real HMAC over a DIFFERENT secret).
    const forged = createHmac('sha256', 'not-the-secret').update(body).digest('hex');
    const res = await post(body, forged);
    expect(res.statusCode).toBe(401);
    // No side effects: the row is still 'sent', the channel untouched.
    expect((await delivery(id)).status).toBe('sent');
    expect((await channel(channelId)).health).toBe('healthy');
  });

  it('rejects a missing signature with 401', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'healthy', 0);
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-3b');
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-msg-3b' } });
    const res = await post(body, undefined);
    expect(res.statusCode).toBe(401);
    expect((await delivery(id)).status).toBe('sent');
  });

  // ── Property 2: raw-body verification — same-parse, different-bytes is rejected ──
  it('verifies over RAW bytes: a body that parses identically but differs on the wire is rejected', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'healthy', 0);
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-4');
    const signedBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-msg-4' } });
    const signature = sign(signedBody);
    // A DIFFERENT byte sequence that JSON-parses to the same object (extra space).
    const tamperedBody = signedBody.replace('{"type"', '{ "type"');
    expect(JSON.stringify(JSON.parse(tamperedBody))).toBe(signedBody); // same parse
    expect(tamperedBody).not.toBe(signedBody); // different bytes

    const res = await post(tamperedBody, signature);
    expect(res.statusCode).toBe(401); // HMAC is over the raw bytes, so it fails
    expect((await delivery(id)).status).toBe('sent');
  });

  // ── Property 3: idempotency — the same callback twice is a no-op the 2nd time ──
  it('is idempotent on provider_message_id: a duplicate callback does not double-debit or flip-flop', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'healthy', 0);
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-5');
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'resend-msg-5' } });
    const signature = sign(body);

    const first = await post(body, signature);
    expect(first.statusCode).toBe(200);
    expect((await delivery(id)).status).toBe('bounced');
    expect((await channel(channelId)).consecutiveFailures).toBe(1);

    // Replay the identical callback: accepted (200) but a no-op — the row is no
    // longer 'sent', so health is not debited again and the status does not move.
    const second = await post(body, signature);
    expect(second.statusCode).toBe(200);
    expect((await delivery(id)).status).toBe('bounced'); // unchanged
    expect((await channel(channelId)).consecutiveFailures).toBe(1); // NOT 2
    expect((await channel(channelId)).health).toBe('degraded');
  });

  // A verified callback we don't model is acknowledged (200) with no state change.
  it('acknowledges an un-modelled event (200) without touching the delivery', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'healthy', 0);
    const id = await makeSentDelivery(channelId, userId, 'resend-msg-6');
    const body = JSON.stringify({ type: 'email.opened', data: { email_id: 'resend-msg-6' } });
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect((await delivery(id)).status).toBe('sent');
  });

  // An unknown provider segment is a 404 (the segment is public URL surface —
  // this leaks nothing); a KNOWN provider whose material isn't configured is a
  // 401 (fail closed), covered in the twilio block below.
  it('returns 404 for an unknown provider segment', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'whatever' } });
    expect((await post(body, sign(body), 'sendgrid')).statusCode).toBe(404);
    expect((await post(body, undefined, 'sendgrid')).statusCode).toBe(404);
  });

  // ── Twilio status callbacks (CV-2 sms / CV-3 whatsapp) ──────────────────────
  // Form-encoded, X-Twilio-Signature = base64(HMAC-SHA1(authToken, url +
  // sorted(k+v))). The 415 CSRF backstop exempts ONLY the webhook path for
  // urlencoded bodies — proven here by the request reaching verification.
  describe('twilio status callbacks', () => {
    const TWILIO_TOKEN = 'twilio-auth-token-xyz';
    const PUBLIC_URL = 'https://truecairn.example.com';
    const twilioApp = () => {
      const cfg = loadConfig({
        TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
        TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
        PUBLIC_BASE_URL: PUBLIC_URL,
      });
      return buildApp({ ...cfg, logLevel: 'silent' }, { db, sql });
    };
    const twilioSign = (params: Record<string, string>): string => {
      let data = `${PUBLIC_URL}/v1/notifications/webhook/twilio`;
      for (const k of Object.keys(params).sort()) data += k + params[k];
      return createHmac('sha1', TWILIO_TOKEN).update(data, 'utf8').digest('base64');
    };
    const twilioPost = (
      appx: FastifyInstance,
      params: Record<string, string>,
      signature: string | undefined,
    ) =>
      appx.inject({
        method: 'POST',
        url: '/v1/notifications/webhook/twilio',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(signature !== undefined ? { 'x-twilio-signature': signature } : {}),
        },
        payload: new URLSearchParams(params).toString(),
      });

    it('a signed delivered callback flips a sent sms delivery → delivered', async () => {
      const appx = twilioApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0, 'sms');
        const id = await makeSentDelivery(channelId, userId, 'SM_deliv_1');
        const params = { MessageSid: 'SM_deliv_1', MessageStatus: 'delivered' };
        const res = await twilioPost(appx, params, twilioSign(params));
        expect(res.statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('delivered');
      } finally {
        await appx.close();
      }
    });

    it('a signed undelivered callback flips → bounced; forged/missing signatures are 401 no-ops', async () => {
      const appx = twilioApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0, 'sms');
        const id = await makeSentDelivery(channelId, userId, 'SM_deliv_2');
        const params = { MessageSid: 'SM_deliv_2', MessageStatus: 'undelivered' };

        const forged = await twilioPost(appx, params, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
        expect(forged.statusCode).toBe(401);
        const missing = await twilioPost(appx, params, undefined);
        expect(missing.statusCode).toBe(401);
        expect((await delivery(id)).status).toBe('sent'); // untouched

        const ok = await twilioPost(appx, params, twilioSign(params));
        expect(ok.statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('bounced');
      } finally {
        await appx.close();
      }
    });

    it('acknowledges non-terminal statuses (200) without touching state, and rejects resend calls when its secret is absent', async () => {
      const appx = twilioApp(); // configured for twilio ONLY — no resend secret
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0, 'sms');
        const id = await makeSentDelivery(channelId, userId, 'SM_deliv_3');
        const params = { MessageSid: 'SM_deliv_3', MessageStatus: 'sent' };
        const res = await twilioPost(appx, params, twilioSign(params));
        expect(res.statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('sent');

        // The resend provider has no secret in THIS app: fail closed, never
        // an unauthenticated fall-through.
        const resendCall = await appx.inject({
          method: 'POST',
          url: '/v1/notifications/webhook/resend',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ type: 'email.delivered', data: { email_id: 'SM_deliv_3' } }),
        });
        expect(resendCall.statusCode).toBe(401);
      } finally {
        await appx.close();
      }
    });
  });

  // ── Meta Cloud API status callbacks (CV-3, WhatsApp direct) ─────────────────
  // JSON, X-Hub-Signature-256 = `sha256=<hex HMAC-SHA256(appSecret, raw)>`, and
  // the one provider with a GET subscription handshake. Deliberately a separate
  // vendor from Twilio's SMS callbacks above: docs/04 §4.4 independence.
  describe('meta whatsapp callbacks', () => {
    const APP_SECRET = 'meta-app-secret-abcdef';
    const VERIFY_TOKEN = 'meta-verify-token-123';
    const metaApp = () => {
      const cfg = loadConfig({
        TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
        WHATSAPP_CLOUD_APP_SECRET: APP_SECRET,
        WHATSAPP_CLOUD_VERIFY_TOKEN: VERIFY_TOKEN,
      });
      return buildApp({ ...cfg, logLevel: 'silent' }, { db, sql });
    };
    const metaSign = (body: string): string =>
      'sha256=' + createHmac('sha256', APP_SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
    const statusPayload = (id: string, status: string): string =>
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  statuses: [{ id, status, recipient_id: '15552223333' }],
                },
              },
            ],
          },
        ],
      });
    const metaPost = (appx: FastifyInstance, body: string, signature: string | undefined) =>
      appx.inject({
        method: 'POST',
        url: '/v1/notifications/webhook/meta',
        headers: {
          'content-type': 'application/json',
          ...(signature !== undefined ? { 'x-hub-signature-256': signature } : {}),
        },
        payload: body,
      });

    it('flips a sent whatsapp delivery → delivered on a signed delivered status', async () => {
      const appx = metaApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'degraded', 2, 'whatsapp');
        const id = await makeSentDelivery(channelId, userId, 'wamid.DELIV1');
        const body = statusPayload('wamid.DELIV1', 'delivered');
        const res = await metaPost(appx, body, metaSign(body));
        expect(res.statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('delivered');
        expect((await channel(channelId)).health).toBe('healthy');
      } finally {
        await appx.close();
      }
    });

    it('treats failed as a bounce, and read as delivered and nothing more (D2)', async () => {
      const appx = metaApp();
      await appx.ready();
      try {
        // Separate owners: notification_channels is unique on (user,
        // destination), and the helper uses one fixed destination.
        const failedUser = await makeUser();
        const chFailed = await makeChannel(failedUser, 'healthy', 0, 'whatsapp');
        const failedId = await makeSentDelivery(chFailed, failedUser, 'wamid.FAIL1');
        const failedBody = statusPayload('wamid.FAIL1', 'failed');
        expect((await metaPost(appx, failedBody, metaSign(failedBody))).statusCode).toBe(200);
        expect((await delivery(failedId)).status).toBe('bounced');

        // `read` proves the message reached the device; it sets 'delivered' and
        // NO read state exists to set (docs/26 D2 — read receipts are ignored
        // as read-signals, which is why there is no third status here).
        const readUser = await makeUser();
        const chRead = await makeChannel(readUser, 'healthy', 0, 'whatsapp');
        const readId = await makeSentDelivery(chRead, readUser, 'wamid.READ1');
        const readBody = statusPayload('wamid.READ1', 'read');
        expect((await metaPost(appx, readBody, metaSign(readBody))).statusCode).toBe(200);
        expect((await delivery(readId)).status).toBe('delivered');
      } finally {
        await appx.close();
      }
    });

    it("acknowledges Meta's `sent` without claiming delivery", async () => {
      // Meta's `sent` means the message left Meta toward the device — it does
      // NOT prove arrival. Recording it as delivered would put an unproven fact
      // in the Continuity Report, the same error class as the plain-body send
      // this channel was just fixed for. It stays 'sent' = indeterminate.
      const appx = metaApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0, 'whatsapp');
        const id = await makeSentDelivery(channelId, userId, 'wamid.SENT1');
        const body = statusPayload('wamid.SENT1', 'sent');
        expect((await metaPost(appx, body, metaSign(body))).statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('sent');
      } finally {
        await appx.close();
      }
    });

    it('rejects a tampered body, a forged signature and a missing one, with no state change', async () => {
      const appx = metaApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0, 'whatsapp');
        const id = await makeSentDelivery(channelId, userId, 'wamid.TAMPER');
        const body = statusPayload('wamid.TAMPER', 'delivered');
        const signature = metaSign(body);

        expect((await metaPost(appx, body, undefined)).statusCode).toBe(401);
        expect(
          (await metaPost(appx, body, 'sha256=' + 'aa'.repeat(32))).statusCode,
        ).toBe(401);
        // Right MAC, wrong bytes: the signature is over the RAW body, so a
        // payload that JSON-parses identically is still rejected.
        const tampered = body.replace('{"object"', '{ "object"');
        expect(JSON.stringify(JSON.parse(tampered))).toBe(body);
        expect(tampered).not.toBe(body);
        expect((await metaPost(appx, tampered, signature)).statusCode).toBe(401);
        // A signature without the sha256= prefix fails closed too.
        expect((await metaPost(appx, body, signature.slice(7))).statusCode).toBe(401);

        expect((await delivery(id)).status).toBe('sent');

        // …and the correctly signed original still works, so the rejections
        // above are about the signature and not about the payload.
        expect((await metaPost(appx, body, signature)).statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('delivered');
      } finally {
        await appx.close();
      }
    });

    it('echoes hub.challenge only on a matching verify token', async () => {
      const appx = metaApp();
      await appx.ready();
      try {
        const get = (query: Record<string, string>) =>
          appx.inject({
            method: 'GET',
            url: '/v1/notifications/webhook/meta',
            query,
          });

        const ok = await get({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.body).toBe('1158201444');

        // A wrong token gets no echo: hub.challenge is attacker-supplied, so an
        // unconditional echo would make this endpoint a reflector.
        const wrongToken = await get({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'not-the-token',
          'hub.challenge': '1158201444',
        });
        expect(wrongToken.statusCode).toBe(401);
        expect(wrongToken.body).not.toContain('1158201444');

        const wrongMode = await get({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        });
        expect(wrongMode.statusCode).toBe(401);

        // GET is meta-only; other providers have no handshake.
        expect(
          (
            await appx.inject({ method: 'GET', url: '/v1/notifications/webhook/twilio' })
          ).statusCode,
        ).toBe(404);
      } finally {
        await appx.close();
      }
    });

    it('rejects meta callbacks when its app secret is absent (fail closed)', async () => {
      // An app configured for resend only: the meta branch must reject, never
      // fall through unauthenticated.
      const body = statusPayload('wamid.NOSECRET', 'delivered');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/notifications/webhook/meta',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSign(body) },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Svix scheme (what Resend actually sends in production) ──────────────────
  // The SAME configured secret, interpreted per the Svix spec: whsec_<base64key>,
  // HMAC-SHA256 over `${id}.${timestamp}.${raw}`, signature `v1,<base64>`.
  describe('svix-signed callbacks (production Resend)', () => {
    const SVIX_KEY = Buffer.alloc(32, 5);
    const SVIX_SECRET = `whsec_${SVIX_KEY.toString('base64')}`;
    const svixApp = () => {
      const cfg = loadConfig({
        TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
        NOTIFICATIONS_WEBHOOK_SECRET: SVIX_SECRET,
      });
      return buildApp({ ...cfg, logLevel: 'silent' }, { db, sql });
    };
    const svixSign = (id: string, timestamp: number, body: string): string =>
      'v1,' +
      createHmac('sha256', SVIX_KEY).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
    const svixPost = (
      appx: FastifyInstance,
      body: string,
      headers: Record<string, string>,
    ) =>
      appx.inject({
        method: 'POST',
        url: '/v1/notifications/webhook/resend',
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });

    it('a valid svix signature flips sent → delivered', async () => {
      const appx = svixApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0);
        const id = await makeSentDelivery(channelId, userId, 'resend-svix-1');
        const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-svix-1' } });
        const ts = Math.floor(Date.now() / 1000);
        const res = await svixPost(appx, body, {
          'svix-id': 'msg_1',
          'svix-timestamp': String(ts),
          // A rotated-key extra entry that does NOT match must not break the one that does.
          'svix-signature': `v1,${Buffer.alloc(32, 9).toString('base64')} ${svixSign('msg_1', ts, body)}`,
        });
        expect(res.statusCode).toBe(200);
        expect((await delivery(id)).status).toBe('delivered');
      } finally {
        await appx.close();
      }
    });

    it('rejects a forged svix signature and a stale timestamp (replay bound), leaving state untouched', async () => {
      const appx = svixApp();
      await appx.ready();
      try {
        const userId = await makeUser();
        const channelId = await makeChannel(userId, 'healthy', 0);
        const id = await makeSentDelivery(channelId, userId, 'resend-svix-2');
        const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-svix-2' } });
        const ts = Math.floor(Date.now() / 1000);

        const forged = await svixPost(appx, body, {
          'svix-id': 'msg_2',
          'svix-timestamp': String(ts),
          'svix-signature': `v1,${Buffer.alloc(32, 9).toString('base64')}`,
        });
        expect(forged.statusCode).toBe(401);

        // A VALID signature over a 10-minute-old timestamp is outside the
        // replay window — rejected even though the MAC itself matches.
        const staleTs = ts - 600;
        const stale = await svixPost(appx, body, {
          'svix-id': 'msg_2',
          'svix-timestamp': String(staleTs),
          'svix-signature': svixSign('msg_2', staleTs, body),
        });
        expect(stale.statusCode).toBe(401);

        // Svix headers present but incomplete: fails closed, no fallthrough to
        // the legacy scheme.
        const incomplete = await svixPost(appx, body, {
          'svix-signature': svixSign('msg_2', ts, body),
        });
        expect(incomplete.statusCode).toBe(401);

        expect((await delivery(id)).status).toBe('sent');
      } finally {
        await appx.close();
      }
    });
  });
});
