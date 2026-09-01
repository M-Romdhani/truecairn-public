import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const LS_SECRET = 'ls-webhook-secret-0123456789';
const sign = (body: string): string =>
  createHmac('sha256', LS_SECRET).update(Buffer.from(body, 'utf8')).digest('hex');

// LemonSqueezy subscription-event payload shaped like the real webhook.
const subEvent = (opts: {
  event: string;
  userId?: string;
  subId?: string;
  status: string;
  endsAt?: string | null;
  renewsAt?: string | null;
  customerId?: number;
  testMode?: boolean;
}) => ({
  meta: {
    event_name: opts.event,
    ...(opts.userId !== undefined ? { custom_data: { user_id: opts.userId } } : {}),
    // LemonSqueezy sends meta.test_mode on EVERY event. Omitted here by default
    // so the existing cases keep asserting the live-event path, which must never
    // be gated by the guard below.
    ...(opts.testMode !== undefined ? { test_mode: opts.testMode } : {}),
  },
  data: {
    type: 'subscriptions',
    id: opts.subId ?? 'ls-sub-1',
    attributes: {
      customer_id: opts.customerId ?? 999,
      variant_id: 42,
      status: opts.status,
      renews_at: opts.renewsAt ?? null,
      ends_at: opts.endsAt ?? null,
    },
  },
});

describeIfDb('billing (LemonSqueezy): webhook, status, checkout, channel gating', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const configEnv = {
    TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
    LEMONSQUEEZY_WEBHOOK_SECRET: LS_SECRET,
    LEMONSQUEEZY_CHECKOUT_PRO_MONTHLY: 'https://store.lemonsqueezy.com/checkout/buy/monthly-uuid',
    LEMONSQUEEZY_CHECKOUT_PRO_ANNUAL: 'https://store.lemonsqueezy.com/checkout/buy/annual-uuid',
    LEMONSQUEEZY_CUSTOMER_PORTAL_URL: 'https://store.lemonsqueezy.com/billing',
  };
  const config = loadConfig(configEnv);

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    // Provider credentials, because enrollableChannelTypes() intersects the PLAN
    // with what the deployment can actually deliver (2026-08-31). This test is
    // about the plan gate, so the provider side is held configured — otherwise
    // it would be asserting the provider gate by accident and would read as a
    // billing regression when it is nothing of the sort. `configuredChannelTypes()`
    // reads process.env directly, on purpose: /status and this picker must never
    // disagree about whether a channel can be delivered, and that is only
    // guaranteed while they read the same source.
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('NOTIFICATIONS_FROM', 'notices@example.com');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
    vi.stubEnv('TWILIO_SMS_FROM', '+15550001111');
    vi.stubEnv('VAPID_PUBLIC_KEY', 'vapid-pub');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-priv');
    await sql`TRUNCATE billing_subscriptions, security_events, notification_deliveries, notification_channels, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  async function makeOwner(email: string): Promise<{ userId: UserId; cookie: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token };
  }
  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });
  const postHook = (body: string, signature: string | undefined) =>
    app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/lemonsqueezy',
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined ? { 'x-signature': signature } : {}),
      },
      payload: body,
    });
  async function plan(cookie: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/v1/billing/status', cookies: as(cookie) });
    return (res.json() as { plan: string }).plan;
  }

  it('a signed subscription_created flips the user to pro; forged/missing signatures are 401 no-ops', async () => {
    const { userId, cookie } = await makeOwner('bill@example.com');
    expect(await plan(cookie)).toBe('free');

    const body = JSON.stringify(
      subEvent({ event: 'subscription_created', userId, status: 'active', renewsAt: '2026-09-01T00:00:00Z' }),
    );

    // Forged + missing signatures change nothing.
    expect((await postHook(body, 'deadbeef')).statusCode).toBe(401);
    expect((await postHook(body, undefined)).statusCode).toBe(401);
    expect(await plan(cookie)).toBe('free');

    // Valid signature applies.
    const ok = await postHook(body, sign(body));
    expect(ok.statusCode).toBe(200);
    expect(await plan(cookie)).toBe('pro');
    const [sub] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, userId));
    expect(sub!.status).toBe('active');
    expect(sub!.lsSubscriptionId).toBe('ls-sub-1');
  });

  it('lifecycle: cancelled-with-future-end keeps pro; expired drops to free; idempotent replays', async () => {
    const { userId, cookie } = await makeOwner('life@example.com');
    const created = JSON.stringify(subEvent({ event: 'subscription_created', userId, status: 'active' }));
    await postHook(created, sign(created));
    expect(await plan(cookie)).toBe('pro');

    // Cancelled but paid through next month → still pro.
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const cancelled = JSON.stringify(
      subEvent({ event: 'subscription_cancelled', userId, status: 'cancelled', endsAt: future }),
    );
    await postHook(cancelled, sign(cancelled));
    expect(await plan(cookie)).toBe('pro');

    // A duplicate cancelled event is a no-op (still one row, still pro).
    await postHook(cancelled, sign(cancelled));
    const rows = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(await plan(cookie)).toBe('pro');

    // Expired → free.
    const expired = JSON.stringify(subEvent({ event: 'subscription_expired', userId, status: 'expired' }));
    await postHook(expired, sign(expired));
    expect(await plan(cookie)).toBe('free');
  });

  it('past_due keeps access; a cancelled-and-already-ended subscription does not', async () => {
    const { userId, cookie } = await makeOwner('grace@example.com');
    const pastDue = JSON.stringify(subEvent({ event: 'subscription_updated', userId, status: 'past_due' }));
    await postHook(pastDue, sign(pastDue));
    expect(await plan(cookie)).toBe('pro');

    const pastEnd = new Date(Date.now() - 1000).toISOString();
    const endedCancel = JSON.stringify(
      subEvent({ event: 'subscription_updated', userId, status: 'cancelled', endsAt: pastEnd }),
    );
    await postHook(endedCancel, sign(endedCancel));
    expect(await plan(cookie)).toBe('free');
  });

  it('ignores non-subscription events (invoices) with 200 and no row', async () => {
    const { userId, cookie } = await makeOwner('inv@example.com');
    const invoice = JSON.stringify({
      meta: { event_name: 'subscription_payment_success', custom_data: { user_id: userId } },
      data: { type: 'subscription-invoices', id: 'inv-1', attributes: { status: 'paid' } },
    });
    const res = await postHook(invoice, sign(invoice));
    expect(res.statusCode).toBe(200);
    expect(await plan(cookie)).toBe('free');
  });

  // ── test_mode (2026-08-10) ────────────────────────────────────────────────
  // Nothing read meta.test_mode until now, which was harmless only while the
  // store had never left test mode. Once it is live, a stray test-mode event —
  // a replay, a sandbox still pointed at the production endpoint, a mis-set
  // dashboard URL — would have entitled a real account to a plan nobody paid
  // for. The guard is deliberately ASYMMETRIC, and both halves are pinned here:
  // failing closed on LIVE events would be the worse bug, because a silent
  // entitlement failure after a real charge is a refund and an apology.
  const testModeIgnored = async (): Promise<number> =>
    (
      await db
        .select({ id: schema.securityEvents.id })
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.eventType, 'billing_test_mode_event_ignored'))
    ).length;

  it('a test-mode event does NOT entitle an account, and is recorded', async () => {
    const { userId, cookie } = await makeOwner('testmode@example.com');
    const body = JSON.stringify(
      subEvent({ event: 'subscription_created', userId, status: 'active', testMode: true }),
    );
    // 200, not an error: LemonSqueezy retries a 5xx forever, and this refusal
    // would never resolve.
    expect((await postHook(body, sign(body))).statusCode).toBe(200);
    expect(await plan(cookie)).toBe('free');
    expect(await testModeIgnored()).toBe(1);
  });

  it('with LEMONSQUEEZY_TEST_MODE set, a test-mode event entitles — the pre-launch purchase', async () => {
    // The ordering the switchover depends on (docs/28): the pre-launch test
    // purchase happens in TEST mode against the LIVE deployment, so the flag has
    // to be settable there. A NODE_ENV-derived guard would have refused exactly
    // that purchase — the failure this guard exists to prevent, moved one step
    // earlier and onto the person checking that payments work at all.
    const permissive = buildApp(
      { ...loadConfig({ ...configEnv, LEMONSQUEEZY_TEST_MODE: 'true' }), logLevel: 'silent' },
      { db, sql },
    );
    await permissive.ready();
    try {
      const { userId, cookie } = await makeOwner('prelaunch@example.com');
      const body = JSON.stringify(
        subEvent({ event: 'subscription_created', userId, status: 'active', testMode: true }),
      );
      const res = await permissive.inject({
        method: 'POST',
        url: '/v1/billing/webhook/lemonsqueezy',
        headers: { 'content-type': 'application/json', 'x-signature': sign(body) },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const status = await permissive.inject({
        method: 'GET',
        url: '/v1/billing/status',
        cookies: as(cookie),
      });
      expect((status.json() as { plan: string }).plan).toBe('pro');
      expect(await testModeIgnored()).toBe(0);
    } finally {
      await permissive.close();
    }
  });

  it('a LIVE event still entitles — the guard is one-directional', async () => {
    // The half that matters more. test_mode present and false is the shape every
    // real event has once the store goes live.
    const { userId, cookie } = await makeOwner('livemode@example.com');
    const body = JSON.stringify(
      subEvent({ event: 'subscription_created', userId, status: 'active', testMode: false }),
    );
    await postHook(body, sign(body));
    expect(await plan(cookie)).toBe('pro');
    expect(await testModeIgnored()).toBe(0);
  });

  // 2026-08-08 re-audit, N-6. custom_data.user_id is BUYER-CONTROLLABLE: the
  // server sets it on the hosted-checkout URL, but that URL goes to the browser
  // and the query parameter is editable before paying. The signature proves the
  // event came from LemonSqueezy; it says nothing about who typed that UUID.
  // Because the upsert is keyed on user_id, an unguarded accept let a buyer
  // overwrite someone else's subscription row — then cancel, and a paying
  // customer silently lost their plan.
  const rejections = async (): Promise<Array<Record<string, unknown>>> => {
    const rows = await db
      .select({ payload: schema.securityEvents.payload })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.eventType, 'billing_user_mapping_rejected'));
    return rows.map((r) => r.payload as Record<string, unknown>);
  };

  it('a user_id matching no user is unmapped, not a 500 LemonSqueezy retries forever', async () => {
    // The FK to users.id used to throw out of the transaction. LS retries a 5xx,
    // and this particular failure would never resolve — a poison pill in the queue.
    const body = JSON.stringify(
      subEvent({
        event: 'subscription_created',
        userId: '00000000-0000-4000-8000-000000000000',
        status: 'active',
      }),
    );
    const res = await postHook(body, sign(body));
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(schema.billingSubscriptions);
    expect(rows).toHaveLength(0);
    expect((await rejections())[0]?.['reason']).toBe('unknown_user');
  });

  it('the subscription→user binding is immutable: a later event cannot move it', async () => {
    const victim = await makeOwner('bound-victim@example.com');
    const attacker = await makeOwner('bound-attacker@example.com');
    const created = JSON.stringify(
      subEvent({ event: 'subscription_created', userId: victim.userId, status: 'active' }),
    );
    await postHook(created, sign(created));
    expect(await plan(victim.cookie)).toBe('pro');

    // Same LS subscription id, different claimed user. LS mints subscription ids
    // and no buyer can choose one, so the id is the authority and the claim loses.
    const hijack = JSON.stringify(
      subEvent({ event: 'subscription_updated', userId: attacker.userId, status: 'active' }),
    );
    expect((await postHook(hijack, sign(hijack))).statusCode).toBe(200);

    expect(await plan(victim.cookie)).toBe('pro'); // untouched
    expect(await plan(attacker.cookie)).toBe('free'); // gained nothing
    expect((await rejections())[0]?.['reason']).toBe('subscription_bound_to_another_user');
  });

  it('a different LemonSqueezy customer cannot evict a live subscription', async () => {
    // The eviction attack proper: a NEW subscription id (so the binding guard is
    // inert) claiming a victim who is already paying. The upsert is keyed on
    // user_id, so this would have replaced their row outright.
    const victim = await makeOwner('evict-victim@example.com');
    const created = JSON.stringify(
      subEvent({
        event: 'subscription_created',
        userId: victim.userId,
        status: 'active',
        customerId: 999,
      }),
    );
    await postHook(created, sign(created));

    const evict = JSON.stringify(
      subEvent({
        event: 'subscription_created',
        userId: victim.userId,
        subId: 'ls-sub-attacker',
        status: 'active',
        customerId: 777, // a different buyer
      }),
    );
    expect((await postHook(evict, sign(evict))).statusCode).toBe(200);

    expect(await plan(victim.cookie)).toBe('pro');
    const [sub] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, victim.userId));
    expect(sub!.lsSubscriptionId).toBe('ls-sub-1'); // still theirs
    expect((await rejections())[0]?.['reason']).toBe('would_evict_live_subscription');
  });

  it('but the SAME customer resubscribing inside the grace window still applies', async () => {
    // The regression guard that matters. The customer id is the discriminator
    // precisely so the documented legitimate flows keep working: a cancel leaves
    // the owner entitled until ends_at, and resubscribing during that window mints
    // a NEW subscription id while the old row is still live. Refusing that would
    // be the fix breaking real customers to stop a theoretical one.
    const { userId, cookie } = await makeOwner('resub@example.com');
    const created = JSON.stringify(
      subEvent({ event: 'subscription_created', userId, status: 'active', customerId: 999 }),
    );
    await postHook(created, sign(created));

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const cancelled = JSON.stringify(
      subEvent({ event: 'subscription_updated', userId, status: 'cancelled', endsAt: future }),
    );
    await postHook(cancelled, sign(cancelled));
    expect(await plan(cookie)).toBe('pro'); // still entitled — the grace window

    const resub = JSON.stringify(
      subEvent({
        event: 'subscription_created',
        userId,
        subId: 'ls-sub-2',
        status: 'active',
        customerId: 999, // same person
      }),
    );
    expect((await postHook(resub, sign(resub))).statusCode).toBe(200);

    const [sub] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.userId, userId));
    expect(sub!.lsSubscriptionId).toBe('ls-sub-2');
    expect(sub!.status).toBe('active');
    expect(await rejections()).toEqual([]); // and nothing was flagged
  });

  it('the channel picker + gate: free blocked from SMS (402), pro allowed; enrollable types reflect the plan', async () => {
    const { userId, cookie } = await makeOwner('gate@example.com');

    // Free: list advertises email+push only; adding SMS is 402.
    const list1 = await app.inject({ method: 'GET', url: '/v1/settings/channels', cookies: as(cookie) });
    const l1 = list1.json() as { plan: string; enrollableChannelTypes: string[] };
    expect(l1.plan).toBe('free');
    expect(l1.enrollableChannelTypes).toEqual(['email', 'push']);
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'sms', destination: '+15551234567' },
    });
    expect(blocked.statusCode).toBe(402);
    expect((blocked.json() as { type: string }).type).toContain('upgrade-required');

    // Email still works on free.
    const email = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'email', destination: 'gate@example.com' },
    });
    expect(email.statusCode).toBe(201);

    // Upgrade to pro via the webhook → SMS now allowed + advertised.
    const created = JSON.stringify(subEvent({ event: 'subscription_created', userId, status: 'active' }));
    await postHook(created, sign(created));
    const list2 = await app.inject({ method: 'GET', url: '/v1/settings/channels', cookies: as(cookie) });
    expect((list2.json() as { enrollableChannelTypes: string[] }).enrollableChannelTypes).toContain('sms');
    const smsOk = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'sms', destination: '+15551234567' },
    });
    expect(smsOk.statusCode).toBe(201);
  });

  // ── Downgrade notice (docs/28): the entitled→not-entitled edge ─────────────
  async function insertChannel(
    userId: UserId,
    channelType: 'email' | 'sms' | 'whatsapp',
    destination: string,
    verified = true,
  ): Promise<string> {
    const [row] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType,
        destination,
        destinationHash: channelDestinationHash(channelType, destination),
        verified,
      })
      .returning({ id: schema.notificationChannels.id });
    return row!.id;
  }
  const downgradeDeliveries = (userId: UserId) =>
    db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.userId, userId))
      .then((rows) => rows.filter((r) => r.purpose === 'plan_downgraded'));

  it('lapse with residual paid channels → ONE plan_downgraded notice to the email channel; replays never re-send', async () => {
    const { userId } = await makeOwner('lapse@example.com');
    const emailId = await insertChannel(userId, 'email', 'lapse@example.com');
    await insertChannel(userId, 'sms', '+15551230001');

    const created = JSON.stringify(subEvent({ event: 'subscription_created', userId, status: 'active' }));
    await postHook(created, sign(created));
    expect(await downgradeDeliveries(userId)).toHaveLength(0);

    const expired = JSON.stringify(subEvent({ event: 'subscription_expired', userId, status: 'expired' }));
    await postHook(expired, sign(expired));
    const after = await downgradeDeliveries(userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.channelId).toBe(emailId);
    expect(after[0]!.status).toBe('queued');

    // The replayed event finds the row already not-entitled — no second notice.
    await postHook(expired, sign(expired));
    expect(await downgradeDeliveries(userId)).toHaveLength(1);

    // The paid channel itself is untouched: still verified, still live.
    const sms = (
      await db
        .select()
        .from(schema.notificationChannels)
        .where(eq(schema.notificationChannels.userId, userId))
    ).find((c) => c.channelType === 'sms');
    expect(sms!.verified).toBe(true);
    expect(sms!.removedAt).toBeNull();
  });

  it('no notice when nothing is grandfathered, when entitlement survives, or on a fresh-free account', async () => {
    // Lapse with only a free channel enrolled → nothing to say.
    const a = await makeOwner('quiet@example.com');
    await insertChannel(a.userId, 'email', 'quiet@example.com');
    const aCreated = JSON.stringify(subEvent({ event: 'subscription_created', userId: a.userId, status: 'active', subId: 'ls-a' }));
    await postHook(aCreated, sign(aCreated));
    const aExpired = JSON.stringify(subEvent({ event: 'subscription_expired', userId: a.userId, status: 'expired', subId: 'ls-a' }));
    await postHook(aExpired, sign(aExpired));
    expect(await downgradeDeliveries(a.userId)).toHaveLength(0);

    // active → past_due keeps entitlement → not an edge.
    const b = await makeOwner('pastdue@example.com');
    await insertChannel(b.userId, 'sms', '+15551230002');
    const bCreated = JSON.stringify(subEvent({ event: 'subscription_created', userId: b.userId, status: 'active', subId: 'ls-b' }));
    await postHook(bCreated, sign(bCreated));
    const bPastDue = JSON.stringify(subEvent({ event: 'subscription_updated', userId: b.userId, status: 'past_due', subId: 'ls-b' }));
    await postHook(bPastDue, sign(bPastDue));
    expect(await downgradeDeliveries(b.userId)).toHaveLength(0);

    // A first-ever event that is ALREADY not-entitled (no prior row) → no edge.
    const c = await makeOwner('neverpro@example.com');
    await insertChannel(c.userId, 'whatsapp', '+15551230003');
    const cExpired = JSON.stringify(subEvent({ event: 'subscription_expired', userId: c.userId, status: 'expired', subId: 'ls-c' }));
    await postHook(cExpired, sign(cExpired));
    expect(await downgradeDeliveries(c.userId)).toHaveLength(0);
  });

  it('the notice honours the channel matrix (owner_notices) and falls back past an opted-out email', async () => {
    const { userId } = await makeOwner('matrix@example.com');
    const emailId = await insertChannel(userId, 'email', 'matrix@example.com');
    const smsId = await insertChannel(userId, 'sms', '+15551230004');
    // The owner opted the email channel OUT of routine owner notices.
    await db.insert(schema.channelPreferences).values({
      userId,
      channelId: emailId,
      purposeClass: 'owner_notices',
      enabled: false,
    });

    const created = JSON.stringify(subEvent({ event: 'subscription_created', userId, status: 'active', subId: 'ls-m' }));
    await postHook(created, sign(created));
    const expired = JSON.stringify(subEvent({ event: 'subscription_expired', userId, status: 'expired', subId: 'ls-m' }));
    await postHook(expired, sign(expired));

    const after = await downgradeDeliveries(userId);
    expect(after).toHaveLength(1);
    // Email was matrix-disabled for this class → the next eligible channel got it.
    expect(after[0]!.channelId).toBe(smsId);
  });

  it('checkout returns a hosted URL carrying the user id + email; unknown plan is 404', async () => {
    const { userId, cookie } = await makeOwner('checkout@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/billing/checkout/pro_monthly',
      cookies: as(cookie),
    });
    expect(res.statusCode).toBe(200);
    const { url: checkoutUrl } = res.json() as { url: string };
    const parsed = new URL(checkoutUrl);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://store.lemonsqueezy.com/checkout/buy/monthly-uuid',
    );
    expect(parsed.searchParams.get('checkout[custom][user_id]')).toBe(userId);
    expect(parsed.searchParams.get('checkout[email]')).toBe('checkout@example.com');

    const annual = await app.inject({
      method: 'GET',
      url: '/v1/billing/checkout/pro_annual',
      cookies: as(cookie),
    });
    expect(annual.statusCode).toBe(200);

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/billing/checkout/enterprise',
      cookies: as(cookie),
    });
    expect(unknown.statusCode).toBe(404);
  });

  // "Cancel anytime" is promised on the LemonSqueezy checkout description and in
  // the /upgrade fine print. Until 2026-08-10 the product had no route to it at
  // all — a subscriber's only way out was finding the receipt email. These pin
  // the route that makes the promise keepable.
  it('a subscriber gets the cancel path; a free user with no subscription gets none', async () => {
    const { userId, cookie } = await makeOwner('portal@example.com');
    const status = async (c: string) =>
      (
        (
          await app.inject({ method: 'GET', url: '/v1/billing/status', cookies: as(c) })
        ).json() as { plan: string; customerPortalUrl: string | null }
      );

    // No subscription row yet — nothing to manage, so no link.
    expect((await status(cookie)).customerPortalUrl).toBeNull();

    const body = JSON.stringify(subEvent({ event: 'subscription_created', userId, status: 'active' }));
    expect((await postHook(body, sign(body))).statusCode).toBe(200);

    const active = await status(cookie);
    expect(active.plan).toBe('pro');
    expect(active.customerPortalUrl).toBe('https://store.lemonsqueezy.com/billing');
  });

  it('a LAPSED subscriber still gets it — that is who needs it most', async () => {
    // Gated on holding a subscription row, not on being entitled. Someone whose
    // payment is failing or who has already cancelled is exactly the person
    // reaching for the billing page, and gating on `plan === 'pro'` would hide
    // it from them.
    const { userId, cookie } = await makeOwner('lapsed-portal@example.com');
    for (const s of ['past_due', 'expired']) {
      const body = JSON.stringify(subEvent({ event: 'subscription_updated', userId, status: s }));
      expect((await postHook(body, sign(body))).statusCode).toBe(200);
      const res = await app.inject({ method: 'GET', url: '/v1/billing/status', cookies: as(cookie) });
      const json = res.json() as { plan: string; customerPortalUrl: string | null };
      expect(json.customerPortalUrl, `status=${s} must still expose the cancel path`).toBe(
        'https://store.lemonsqueezy.com/billing',
      );
      if (s === 'expired') expect(json.plan).toBe('free');
    }
  });

  it('an unconfigured deployment returns null rather than a dead link', async () => {
    const bare = buildApp(
      { ...loadConfig({ ...configEnv, LEMONSQUEEZY_CUSTOMER_PORTAL_URL: '' }), logLevel: 'silent' },
      { db, sql },
    );
    await bare.ready();
    try {
      const { userId, cookie } = await makeOwner('noportal@example.com');
      const body = JSON.stringify(
        subEvent({ event: 'subscription_created', userId, status: 'active' }),
      );
      expect(
        (
          await bare.inject({
            method: 'POST',
            url: '/v1/billing/webhook/lemonsqueezy',
            headers: { 'content-type': 'application/json', 'x-signature': sign(body) },
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
      const res = await bare.inject({
        method: 'GET',
        url: '/v1/billing/status',
        cookies: as(cookie),
      });
      const json = res.json() as { plan: string; customerPortalUrl: string | null };
      expect(json.plan).toBe('pro');
      expect(json.customerPortalUrl).toBeNull();
    } finally {
      await bare.close();
    }
  });

  it('billing routes are session-gated', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/billing/status' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/billing/checkout/pro_monthly' })).statusCode,
    ).toBe(401);
  });
});
