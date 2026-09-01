import { schema, type Database } from '@truecairn/db';
import { verifyWebhookSignature } from '@truecairn/notifications';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { applyLemonSqueezyWebhook } from '../billing/webhook.js';
import { getEntitlement } from '../billing/entitlement.js';
import { badRequest, notFound, unauthorized } from '../errors.js';

// Billing routes (LemonSqueezy, docs/28).
//   POST /v1/billing/webhook/lemonsqueezy — X-Signature (HMAC-SHA256 hex over
//     the RAW body) verified BEFORE parse, fail-closed. Mounted only when the
//     signing secret is configured. Drives the subscription row.
//   GET  /v1/billing/status — the caller's plan + subscription status.
//   GET  /v1/billing/checkout/:plan — a ready hosted LemonSqueezy checkout URL
//     for pro_monthly | pro_annual, carrying the caller's user id (so the
//     webhook can attribute the purchase) and a prefilled email.

export interface BillingConfig {
  webhookSecret: string | undefined;
  checkoutProMonthly: string | undefined;
  checkoutProAnnual: string | undefined;
  // The store's stable billing page, where a subscriber cancels or updates a
  // card. Unset ⇒ /v1/billing/status returns null and the client shows no
  // manage link (never a dead one).
  customerPortalUrl: string | undefined;
  // Whether this deployment accepts LemonSqueezy TEST-MODE events. Off by
  // default: once the store is live, a stray test event must not entitle a real
  // account. Live events are never gated by it — see webhook.ts.
  allowTestMode: boolean;
}

export function billingRoutes(app: FastifyInstance, db: Database, config: BillingConfig): void {
  // ── Webhook (HMAC-authed, not session-gated) ────────────────────────────────
  if (config.webhookSecret !== undefined) {
    const secret = config.webhookSecret;
    void app.register((scope, _opts, done) => {
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_req, body, doneParser) => doneParser(null, body),
      );
      scope.post('/v1/billing/webhook/lemonsqueezy', async (request, reply) => {
        const raw = Buffer.isBuffer(request.body) ? (request.body as Buffer) : Buffer.alloc(0);
        // Verify FIRST, over the raw bytes. LemonSqueezy signs with hex
        // HMAC-SHA256 — the same scheme as our raw-body notification webhook.
        const signature = request.headers['x-signature'];
        if (typeof signature !== 'string' || !verifyWebhookSignature(secret, raw, signature)) {
          throw unauthorized('invalid webhook signature');
        }
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw badRequest('malformed webhook body');
        }
        await applyLemonSqueezyWebhook(db, body, new Date(), {
          allowTestMode: config.allowTestMode,
        });
        return reply.status(200).send({ ok: true });
      });
      done();
    });
  }

  // ── Status (read) ───────────────────────────────────────────────────────────
  app.get('/v1/billing/status', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const ent = await getEntitlement(db, session.userId, new Date());
    // "Cancel anytime" is promised at the point of sale — on the LemonSqueezy
    // checkout description and in the /upgrade fine print — and until now the
    // product offered no way to do it. There is no cancel API here and there
    // should not be: LemonSqueezy owns the subscription, and proxying a cancel
    // would mean holding an API key that can mutate billing. The honest fix is
    // to make their portal reachable.
    //
    // Gated on having a subscription ROW (status !== null), not on being
    // entitled: someone who has already cancelled, or whose payment is failing,
    // is exactly who needs this link. A free user with no row sees null.
    const customerPortalUrl = ent.status === null ? null : (config.customerPortalUrl ?? null);
    return { ...ent, customerPortalUrl };
  });

  // ── Checkout (returns a hosted LemonSqueezy URL) ────────────────────────────
  app.get('/v1/billing/checkout/:plan', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { plan } = request.params as { plan: string };
    const base =
      plan === 'pro_monthly'
        ? config.checkoutProMonthly
        : plan === 'pro_annual'
          ? config.checkoutProAnnual
          : undefined;
    if (base === undefined) throw notFound('unknown or unconfigured plan');

    const [u] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId));
    // LemonSqueezy hosted-checkout query params: attribute the purchase to this
    // user (echoed back in the webhook's meta.custom_data) and prefill email.
    const url = new URL(base);
    url.searchParams.set('checkout[custom][user_id]', session.userId);
    if (u?.email !== undefined) url.searchParams.set('checkout[email]', u.email);
    return { url: url.toString() };
  });
}
