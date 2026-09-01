import type { Database } from '@truecairn/db';
import {
  applyDeliveryWebhook,
  mapMetaStatusEvent,
  metaSubscriptionChallenge,
  verifyMetaWebhookSignature,
  verifySvixWebhookSignature,
  verifyTwilioWebhookSignature,
  verifyWebhookSignature,
  type DeliveryOutcome,
} from '@truecairn/notifications';
import type { FastifyInstance } from 'fastify';
import { badRequest, notFound, unauthorized } from '../errors.js';

// Async-delivery webhook (PHASE3_5 §d; providers added by CV-2/CV-3). A
// provider calls back when a message it accepted is finally delivered or
// bounces; we flip the matching delivery row and adjust channel health. Auth
// is per-provider signature verification over the RAW body, not a session —
// so this route lives OUTSIDE the session-gated set and is mounted only when
// at least one provider's verification material is configured.
//
// Discipline (verify-before-parse, fail-closed), per provider:
//   resend — Svix scheme (svix-id/-timestamp/-signature, whsec_… secret) or
//            the x-truecairn-signature raw-body HMAC (ops/relay path), both
//            under NOTIFICATIONS_WEBHOOK_SECRET.
//   twilio — X-Twilio-Signature: HMAC-SHA1 over the exact public URL + the
//            sorted form params, keyed by TWILIO_AUTH_TOKEN. Form-encoded.
//            SMS only since CV-3 moved WhatsApp to Meta directly.
//   meta   — X-Hub-Signature-256: `sha256=<hex>` HMAC-SHA256 over the raw body,
//            keyed by WHATSAPP_CLOUD_APP_SECRET. JSON. Also the ONE provider
//            with a GET handshake (below).
// A provider whose material is not configured rejects everything (401) —
// never an unauthenticated fall-through.

const SIGNATURE_HEADER = 'x-truecairn-signature';

export interface WebhookConfig {
  secret: string | undefined;
  twilioAuthToken: string | undefined;
  metaAppSecret: string | undefined;
  metaVerifyToken: string | undefined;
  publicBaseUrl: string;
}

export function notificationsWebhookRoutes(
  app: FastifyInstance,
  db: Database,
  config: WebhookConfig,
): void {
  // A SCOPED child plugin so the raw-body parsers are encapsulated and do NOT
  // change how the rest of the API parses these content types.
  void app.register((scope, _opts, done) => {
    const rawParser = (
      _req: unknown,
      body: Buffer,
      doneParser: (err: Error | null, result: Buffer) => void,
    ): void => {
      // Hand the RAW buffer through untouched — signatures are computed over
      // exactly these bytes; parsing happens only after verification.
      doneParser(null, body);
    };
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser);
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer' },
      rawParser,
    );

    scope.post('/v1/notifications/webhook/:provider', async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const raw = Buffer.isBuffer(request.body) ? (request.body as Buffer) : Buffer.alloc(0);

      if (provider === 'resend') {
        if (config.secret === undefined) throw unauthorized('provider not configured');
        verifyResend(request.headers, raw, config.secret);
        let event: unknown;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          throw badRequest('malformed webhook body');
        }
        const mapped = mapResendEvent(event);
        if (mapped !== null) await applyDeliveryWebhook(db, { ...mapped, now: new Date() });
        return reply.status(200).send({ ok: true });
      }

      if (provider === 'twilio') {
        if (config.twilioAuthToken === undefined) throw unauthorized('provider not configured');
        const signature = request.headers['x-twilio-signature'];
        const params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        const url = `${config.publicBaseUrl}/v1/notifications/webhook/twilio`;
        if (
          typeof signature !== 'string' ||
          !verifyTwilioWebhookSignature(config.twilioAuthToken, url, params, signature)
        ) {
          throw unauthorized('invalid webhook signature');
        }
        const mapped = mapTwilioEvent(params);
        if (mapped !== null) await applyDeliveryWebhook(db, { ...mapped, now: new Date() });
        return reply.status(200).send({ ok: true });
      }

      if (provider === 'meta') {
        if (config.metaAppSecret === undefined) throw unauthorized('provider not configured');
        const signature = request.headers['x-hub-signature-256'];
        if (
          typeof signature !== 'string' ||
          !verifyMetaWebhookSignature(config.metaAppSecret, raw, signature)
        ) {
          throw unauthorized('invalid webhook signature');
        }
        let event: unknown;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          throw badRequest('malformed webhook body');
        }
        // One POST can carry statuses for several messages; each is applied
        // independently and idempotently on its wamid.
        const now = new Date();
        for (const mapped of mapMetaStatusEvent(event)) {
          await applyDeliveryWebhook(db, { ...mapped, now });
        }
        return reply.status(200).send({ ok: true });
      }

      throw notFound(`unknown webhook provider: ${provider}`);
    });

    // Meta's subscription handshake — the only GET on this route family. Meta
    // calls the same URL with hub.mode/hub.verify_token/hub.challenge when the
    // webhook is registered (and periodically after), and expects the challenge
    // echoed as bare text. A mismatched or absent token is 401, never an echo:
    // hub.challenge is attacker-supplied, so an unconditional echo would make
    // this endpoint a reflector.
    scope.get('/v1/notifications/webhook/:provider', async (request, reply) => {
      const { provider } = request.params as { provider: string };
      if (provider !== 'meta') throw notFound(`unknown webhook provider: ${provider}`);
      if (config.metaVerifyToken === undefined) throw unauthorized('provider not configured');
      const challenge = metaSubscriptionChallenge(
        config.metaVerifyToken,
        request.query as Record<string, unknown>,
      );
      if (challenge === null) throw unauthorized('invalid verification request');
      return reply.status(200).type('text/plain').send(challenge);
    });

    done();
  });
}

// Resend verification: Svix headers when present (what Resend sends in
// production), else the legacy raw-body HMAC header. Each fails closed;
// svix-headers-present-but-invalid never falls through to the legacy scheme.
function verifyResend(
  headers: Record<string, unknown>,
  raw: Buffer,
  secret: string,
): void {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (typeof svixSignature === 'string') {
    if (
      typeof svixId !== 'string' ||
      typeof svixTimestamp !== 'string' ||
      !verifySvixWebhookSignature(
        secret,
        raw,
        { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
        new Date(),
      )
    ) {
      throw unauthorized('invalid webhook signature');
    }
    return;
  }
  const signature = headers[SIGNATURE_HEADER];
  if (typeof signature !== 'string' || !verifyWebhookSignature(secret, raw, signature)) {
    throw unauthorized('invalid webhook signature');
  }
}

// Map a Resend webhook event to our delivery outcome. Only terminal
// delivered/bounced(/complained) events move a row; everything else (sent,
// delayed, opened, clicked) is a no-op. A spam complaint is treated as a
// delivery failure for channel-health purposes.
function mapResendEvent(
  event: unknown,
): { providerMessageId: string; outcome: DeliveryOutcome } | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { type?: unknown; data?: unknown };
  if (typeof e.type !== 'string') return null;
  const data = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as {
    email_id?: unknown;
  };
  const providerMessageId = typeof data.email_id === 'string' ? data.email_id : null;
  if (providerMessageId === null) return null;
  if (e.type === 'email.delivered') return { providerMessageId, outcome: 'delivered' };
  if (e.type === 'email.bounced' || e.type === 'email.complained') {
    return { providerMessageId, outcome: 'bounced' };
  }
  return null;
}

// Map a Twilio status callback (sms + whatsapp share it). Terminal statuses
// only; 'read' (WhatsApp) is deliberately mapped to DELIVERED and nothing
// more — we record that the message reached the device, never that it was
// read (docs/26 D2: WhatsApp read receipts are ignored as read-signals).
function mapTwilioEvent(
  params: Readonly<Record<string, string>>,
): { providerMessageId: string; outcome: DeliveryOutcome } | null {
  const providerMessageId = params['MessageSid'] ?? params['SmsSid'];
  const status = params['MessageStatus'] ?? params['SmsStatus'];
  if (providerMessageId === undefined || status === undefined) return null;
  if (status === 'delivered' || status === 'read') {
    return { providerMessageId, outcome: 'delivered' };
  }
  if (status === 'undelivered' || status === 'failed') {
    return { providerMessageId, outcome: 'bounced' };
  }
  return null;
}
