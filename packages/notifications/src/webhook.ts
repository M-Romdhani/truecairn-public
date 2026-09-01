import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import { and, eq } from 'drizzle-orm';
import { recordChannelFailure, recordChannelSuccess } from './processor.js';

// Async-delivery webhook support (PHASE3_5 §d). A provider (Resend) calls back
// when an accepted message is actually delivered or bounces. Two concerns live
// here, both transport-agnostic so the route stays thin:
//   - verifyWebhookSignature: constant-time HMAC-SHA256 over the RAW body. The
//     route MUST verify before parsing — a forged body never reaches a state
//     change (fail-closed).
//   - applyDeliveryWebhook: idempotent correlate-by-provider_message_id flip of
//     a delivery sent -> delivered/bounced, plus the channel-health credit/debit.

export type DeliveryOutcome = 'delivered' | 'bounced';

// HMAC-SHA256 of the raw request bytes under the shared secret, compared in
// constant time against the hex signature the provider sent. Verifying over the
// RAW bytes (not a re-serialised parse) is the point: two byte sequences that
// JSON-parse identically but differ on the wire produce different MACs, so a
// tampered-then-reparsed body is rejected. A missing/malformed/short signature
// fails closed (length mismatch -> false, never a timingSafeEqual throw).
export function verifyWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  signature: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Svix webhook verification — the scheme Resend actually signs with in
// production (svix-id / svix-timestamp / svix-signature headers; secret issued
// as `whsec_<base64key>`). Spec: HMAC-SHA256 over `${id}.${timestamp}.${raw}`
// keyed by the base64-DECODED secret; the signature header carries one or more
// space-separated `v1,<base64sig>` entries (key rotation) — any single match
// verifies. The timestamp is bounded (default ±5 min) so a captured callback
// cannot be replayed later to flip a future delivery row. Every malformed
// input fails closed.
export function verifySvixWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  headers: { id: string; timestamp: string; signature: string },
  now: Date,
  toleranceMs = 5 * 60 * 1000,
): boolean {
  const b64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(b64, 'base64');
  if (key.length === 0) return false;
  const ts = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now.getTime() - ts * 1000) > toleranceMs) return false;
  const expected = createHmac('sha256', key)
    .update(Buffer.from(`${headers.id}.${headers.timestamp}.`, 'utf8'))
    .update(rawBody)
    .digest();
  for (const part of headers.signature.split(' ')) {
    const commaAt = part.indexOf(',');
    if (commaAt <= 0 || part.slice(0, commaAt) !== 'v1') continue;
    const provided = Buffer.from(part.slice(commaAt + 1), 'base64');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

// Twilio webhook verification: X-Twilio-Signature = base64(HMAC-SHA1(authToken,
// url + concat(sorted param names + values))). The url must be EXACTLY what
// Twilio called (scheme, host, path — hence the PUBLIC_BASE_URL config), and
// the params are the decoded form fields. Fails closed on any malformed input.
export function verifyTwilioWebhookSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  signature: string,
): boolean {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest();
  const provided = Buffer.from(signature, 'base64');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Meta Cloud API webhook verification: X-Hub-Signature-256 = `sha256=<hex>`,
// HMAC-SHA256 over the RAW body keyed by the META APP SECRET (not the access
// token — a different credential with a different lifetime, which is why they
// are separate env vars). Verified over the raw bytes for the same reason as
// every other provider here: two byte sequences that JSON-parse identically but
// differ on the wire produce different MACs. Any malformed input fails closed.
export function verifyMetaWebhookSignature(
  appSecret: string,
  rawBody: Uint8Array,
  signature: string,
): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const provided = Buffer.from(signature.slice('sha256='.length), 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Meta's GET subscription handshake. Meta calls the webhook URL with
// hub.mode=subscribe and a token we configured in its dashboard; we echo
// hub.challenge verbatim to prove we own the endpoint. Returns null on any
// mismatch so the route answers 401 rather than echoing to an unverified
// caller — the challenge is attacker-supplied and echoing it unconditionally
// would turn the endpoint into a reflector.
export function metaSubscriptionChallenge(
  verifyToken: string,
  query: Readonly<Record<string, unknown>>,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') {
    return null;
  }
  const provided = Buffer.from(token, 'utf8');
  const expected = Buffer.from(verifyToken, 'utf8');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return challenge;
}

// Map a Meta Cloud API status callback. The payload nests
// entry[].changes[].value.statuses[], and one POST may carry several statuses
// for several messages, so this returns a LIST rather than one outcome.
//
// Three rules, all deliberate:
//   - `delivered` and `read` both mean the message reached the device, and
//     nothing more is recorded from either (docs/26 D2 — read receipts are
//     ignored AS read-signals; there is no read state to set).
//   - `failed` is a bounce.
//   - `sent` is a NO-OP, not a delivery. Meta's `sent` means the message left
//     Meta toward the device; it does not prove arrival. Recording it as
//     delivered would inflate the Continuity Report with a fact the provider
//     did not prove — the same error class as the plain-body send this channel
//     was just fixed for. It stays `sent` in our rows, which the report scores
//     as indeterminate: honest, never counted as reached, never as unreachable.
//     This matches the Twilio branch, where `sent` is also a no-op.
export function mapMetaStatusEvent(
  event: unknown,
): { providerMessageId: string; outcome: DeliveryOutcome }[] {
  if (typeof event !== 'object' || event === null) return [];
  const entries = (event as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const out: { providerMessageId: string; outcome: DeliveryOutcome }[] = [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const statuses = (change as { value?: { statuses?: unknown } })?.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const { id, status } = (s ?? {}) as { id?: unknown; status?: unknown };
        if (typeof id !== 'string' || typeof status !== 'string') continue;
        if (status === 'delivered' || status === 'read') {
          out.push({ providerMessageId: id, outcome: 'delivered' });
        } else if (status === 'failed') {
          out.push({ providerMessageId: id, outcome: 'bounced' });
        }
      }
    }
  }
  return out;
}

// Apply a delivered/bounced callback. Idempotent and self-correlating: it only
// acts on a row still in 'sent' (the state the worker leaves after handing the
// message to the provider), matched by provider_message_id. A duplicate callback
// — or one for a row already delivered/bounced — matches nothing, returns false,
// and touches no channel health (no double-credit, no status flip-flop). Returns
// true exactly when this call performed the one-and-only transition.
export async function applyDeliveryWebhook(
  db: Database,
  input: { providerMessageId: string; outcome: DeliveryOutcome; now: Date },
): Promise<boolean> {
  return db.transaction(async (txRaw): Promise<boolean> => {
    const tx = txRaw as unknown as Database;
    const set =
      input.outcome === 'delivered'
        ? { status: 'delivered' as const, deliveredAt: input.now, updatedAt: input.now }
        : { status: 'bounced' as const, bouncedAt: input.now, updatedAt: input.now };
    const updated = await tx
      .update(schema.notificationDeliveries)
      .set(set)
      .where(
        and(
          eq(schema.notificationDeliveries.providerMessageId, input.providerMessageId),
          eq(schema.notificationDeliveries.status, 'sent'),
        ),
      )
      .returning({ channelId: schema.notificationDeliveries.channelId });
    const row = updated[0];
    if (row === undefined) return false; // duplicate / unknown id / already terminal
    if (input.outcome === 'delivered') await recordChannelSuccess(tx, row.channelId, input.now);
    else await recordChannelFailure(tx, row.channelId, input.now);
    return true;
  });
}
