import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { DbChannelLookup } from '@truecairn/engine';
import { tickDeliveries, type NotificationProvider, type SendInput } from '@truecairn/notifications';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('channel enrolment (CV-0.0): add, code round-trip, remove', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE notification_deliveries, notification_channels, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
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
  // Grant a user the Pro plan (an active LemonSqueezy subscription) so paid
  // channels (SMS/WhatsApp) are enrollable.
  async function makePro(userId: UserId): Promise<void> {
    await db
      .insert(schema.billingSubscriptions)
      .values({ userId, lsSubscriptionId: `sub-${userId}`, status: 'active' });
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });

  async function addChannel(cookie: string, destination = 'owner@example.com') {
    return app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'email', destination },
    });
  }
  async function pendingCode(channelId: string): Promise<string> {
    // The plaintext code exists only on the queued delivery row (payload_params);
    // the channel row holds a hash. The test reads it the way the worker would.
    const rows = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.channelId, channelId));
    const withParams = rows.filter((r) => r.payloadParams?.['code'] !== undefined);
    const code = withParams[withParams.length - 1]?.payloadParams?.['code'];
    expect(code).toBeDefined();
    return code!;
  }
  async function channelRow(id: string) {
    const [c] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, id));
    return c!;
  }

  it('adds a channel unverified, enqueues a code delivery, and never picks it for notices', async () => {
    const { userId, cookie } = await makeOwner('a@example.com');
    const res = await addChannel(cookie);
    expect(res.statusCode).toBe(201);
    const { id, verified } = res.json() as { id: string; verified: boolean };
    expect(verified).toBe(false);

    const row = await channelRow(id);
    expect(row.verified).toBe(false);
    expect(row.verificationCodeHash).not.toBeNull();
    expect(row.verificationExpiresAt).not.toBeNull();

    // The code goes out through the channel being verified…
    const code = await pendingCode(id);
    expect(code).toMatch(/^\d{6}$/);
    // …and the code is NOT stored in the clear on the channel row.
    expect(Buffer.from(row.verificationCodeHash!).toString('utf8')).not.toContain(code);

    // Verified-channel invariant: an unverified channel is never selected.
    const lookup = new DbChannelLookup(db);
    expect(await lookup.pickPrimaryChannel(userId)).toBeNull();
  });

  it('completes the round-trip: worker renders the code into the body, owner verifies, channel becomes selectable', async () => {
    const { userId, cookie } = await makeOwner('b@example.com');
    const add = await addChannel(cookie);
    const { id } = add.json() as { id: string };
    const code = await pendingCode(id);

    // Fake provider capturing the send — the body must carry the code.
    const sent: SendInput[] = [];
    const provider: NotificationProvider = {
      channelType: 'email',
      name: 'fake',
      send: (input) => {
        sent.push(input);
        return Promise.resolve({ providerMessageId: `fake-${sent.length}` });
      },
    };
    await tickDeliveries(
      { db, providers: new Map([['email', provider]]), now: new Date() },
      10,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(code);
    expect(sent[0]!.destination).toBe('owner@example.com');

    // The plaintext code left the DB with the send.
    const [d] = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.channelId, id));
    expect(d!.status).toBe('sent');
    expect(d!.payloadParams).toBeNull();

    const verify = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    expect((verify.json() as { verified: boolean }).verified).toBe(true);

    const row = await channelRow(id);
    expect(row.verified).toBe(true);
    expect(row.verificationCodeHash).toBeNull();

    // Now — and only now — the channel is selectable for notices.
    const lookup = new DbChannelLookup(db);
    expect(await lookup.pickPrimaryChannel(userId)).toBe(id);

    // The audit chain recorded the enrolment.
    const events = await db
      .select({ eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('notification_channel.added');
    expect(types).toContain('notification_channel.verified');
  });

  it('rejects a wrong code (400) and bounds guessing: attempts exhaust, the code burns', async () => {
    const { cookie } = await makeOwner('c@example.com');
    const add = await addChannel(cookie);
    const { id } = add.json() as { id: string };
    const real = await pendingCode(id);
    const wrong = real === '000001' ? '000002' : '000001'; // guaranteed wrong

    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/settings/channels/${id}/verify`,
        cookies: as(cookie),
        payload: { code: wrong },
      });
      expect(r.statusCode).toBe(400);
    }
    // Attempt 6: exhausted — a distinct problem type, and the hash is burned.
    const exhausted = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code: await pendingCode(id) },
    });
    expect(exhausted.statusCode).toBe(400);
    expect((exhausted.json() as { type: string }).type).toContain('channel-verification-expired');
    expect((await channelRow(id)).verificationCodeHash).toBeNull();

    // Even the RIGHT code is now useless (it was burned) — must re-request.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code: await pendingCode(id) },
    });
    expect(again.statusCode).toBe(400);
    expect((again.json() as { type: string }).type).toContain('channel-verification-expired');
  });

  it('rejects an expired code with the stable problem type', async () => {
    const { cookie } = await makeOwner('d@example.com');
    const add = await addChannel(cookie);
    const { id } = add.json() as { id: string };
    const code = await pendingCode(id);
    // DB-precondition write (no test-mode branch in product code): expire it.
    await db
      .update(schema.notificationChannels)
      .set({ verificationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.notificationChannels.id, id));
    const r = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { type: string }).type).toContain('channel-verification-expired');
  });

  it('is cross-user safe: another account sees 404 on verify and delete', async () => {
    const { cookie } = await makeOwner('owner@x.com');
    const stranger = await makeOwner('stranger@x.com');
    const add = await addChannel(cookie);
    const { id } = add.json() as { id: string };
    const code = await pendingCode(id);

    const verify = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(stranger.cookie),
      payload: { code },
    });
    expect(verify.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/settings/channels/${id}`,
      cookies: as(stranger.cookie),
    });
    expect(del.statusCode).toBe(404);
    // And the owner's channel is untouched.
    expect((await channelRow(id)).removedAt).toBeNull();
  });

  it('409s a verified duplicate, re-issues for an unverified one, and revives a removed one unverified', async () => {
    const { cookie } = await makeOwner('e@example.com');
    const first = await addChannel(cookie);
    expect(first.statusCode).toBe(201);
    const { id } = first.json() as { id: string };

    // Unverified duplicate → re-issue (200, same row, fresh delivery).
    const reissue = await addChannel(cookie);
    expect(reissue.statusCode).toBe(200);
    expect((reissue.json() as { id: string }).id).toBe(id);

    // Verify with the LATEST code (re-issue replaced the hash).
    const code = await pendingCode(id);
    const verify = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);

    // Verified duplicate → 409.
    const dup = await addChannel(cookie);
    expect(dup.statusCode).toBe(409);

    // A VERIFIED channel refuses the immediate DELETE — removal goes through
    // the remove_channel sensitive action (docs/26 §4). Stable problem type so
    // the client can route to the step-up flow.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/settings/channels/${id}`,
      cookies: as(cookie),
    });
    expect(del.statusCode).toBe(409);
    expect((del.json() as { type: string }).type).toBe(
      'https://truecairn.app/problems/channel-removal-requires-stepup',
    );
    expect((await channelRow(id)).removedAt).toBeNull();

    // Once removed (here: the applied action's effect, written directly), a
    // re-add revives the row UNVERIFIED — no stale trust.
    await db
      .update(schema.notificationChannels)
      .set({ removedAt: new Date() })
      .where(eq(schema.notificationChannels.id, id));
    const revive = await addChannel(cookie);
    expect(revive.statusCode).toBe(200);
    expect((revive.json() as { id: string }).id).toBe(id);
    const row = await channelRow(id);
    expect(row.removedAt).toBeNull();
    expect(row.verified).toBe(false);
  });

  it('lists own channels with pendingVerification, and delete removes from the list', async () => {
    const { cookie } = await makeOwner('f@example.com');
    const add = await addChannel(cookie);
    const { id } = add.json() as { id: string };

    const list = await app.inject({
      method: 'GET',
      url: '/v1/settings/channels',
      cookies: as(cookie),
    });
    expect(list.statusCode).toBe(200);
    const { channels } = list.json() as {
      channels: Array<{ id: string; verified: boolean; pendingVerification: boolean }>;
    };
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe(id);
    expect(channels[0]!.verified).toBe(false);
    expect(channels[0]!.pendingVerification).toBe(true);

    await app.inject({ method: 'DELETE', url: `/v1/settings/channels/${id}`, cookies: as(cookie) });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/settings/channels',
      cookies: as(cookie),
    });
    expect((after.json() as { channels: unknown[] }).channels).toHaveLength(0);
  });

  it('rate-limits code issuance per user per hour (429)', async () => {
    const { cookie } = await makeOwner('g@example.com');
    for (let i = 0; i < 6; i += 1) {
      const r = await addChannel(cookie, `g${i}@example.com`);
      expect([200, 201]).toContain(r.statusCode);
    }
    const blocked = await addChannel(cookie, 'g-blocked@example.com');
    expect(blocked.statusCode).toBe(429);
  });

  it('channel matrix: defaults every class enabled, PUT flips one cell, cross-user 404', async () => {
    const { cookie } = await makeOwner('m@example.com');
    const stranger = await makeOwner('m-stranger@example.com');
    const add = await addChannel(cookie);
    const { id } = add.json() as { id: string };

    // Default matrix: absent preference = enabled for all three classes.
    const before = await app.inject({
      method: 'GET',
      url: '/v1/settings/channels/preferences',
      cookies: as(cookie),
    });
    expect(before.statusCode).toBe(200);
    const matrix = (before.json() as {
      channels: Array<{ id: string; classes: Record<string, boolean> }>;
    }).channels;
    expect(matrix).toHaveLength(1);
    expect(matrix[0]!.classes).toEqual({
      owner_verification: true,
      owner_notices: true,
      contact_notices: true,
    });

    // Flip one cell.
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/settings/channels/preferences',
      cookies: as(cookie),
      payload: { channelId: id, purposeClass: 'owner_verification', enabled: false },
    });
    expect(put.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/settings/channels/preferences',
      cookies: as(cookie),
    });
    const cell = (after.json() as {
      channels: Array<{ classes: Record<string, boolean> }>;
    }).channels[0]!.classes;
    expect(cell['owner_verification']).toBe(false);
    expect(cell['owner_notices']).toBe(true); // that class only

    // Idempotent upsert: flipping back works.
    const putBack = await app.inject({
      method: 'PUT',
      url: '/v1/settings/channels/preferences',
      cookies: as(cookie),
      payload: { channelId: id, purposeClass: 'owner_verification', enabled: true },
    });
    expect(putBack.statusCode).toBe(200);

    // Cross-user: a stranger cannot set preferences on my channel.
    const foreign = await app.inject({
      method: 'PUT',
      url: '/v1/settings/channels/preferences',
      cookies: as(stranger.cookie),
      payload: { channelId: id, purposeClass: 'owner_notices', enabled: false },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('enrols an SMS channel: E.164 validation, code rides the text, round-trip verifies (CV-2)', async () => {
    const { userId, cookie } = await makeOwner('sms@example.com');
    await makePro(userId); // SMS is a paid channel
    // Formatting noise is normalized away; invalid numbers are rejected.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'sms', destination: 'not-a-number' },
    });
    expect(bad.statusCode).toBe(400);
    const add = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'sms', destination: '+1 (555) 222-3333' },
    });
    expect(add.statusCode).toBe(201);
    const { id, destination } = add.json() as { id: string; destination: string };
    expect(destination).toBe('+15552223333'); // normalized E.164

    // The code goes out through the SMS itself (body only — no subject).
    const code = await pendingCode(id);
    const sent: SendInput[] = [];
    const smsProvider: NotificationProvider = {
      channelType: 'sms',
      name: 'fake-sms',
      send: (input) => {
        sent.push(input);
        return Promise.resolve({ providerMessageId: `SM-${sent.length}` });
      },
    };
    await tickDeliveries({ db, providers: new Map([['sms', smsProvider]]), now: new Date() }, 10);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe('+15552223333');
    expect(sent[0]!.body).toContain(code);

    const verify = await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    const lookup = new DbChannelLookup(db);
    expect(await lookup.pickPrimaryChannel(userId)).toBe(id);
  });

  it('enrols a push channel only with a valid subscription JSON (CV-2)', async () => {
    const { cookie } = await makeOwner('push@example.com');
    const badCases = [
      'not-json',
      JSON.stringify({ endpoint: 'http://insecure.example.com', keys: { p256dh: 'p', auth: 'a' } }),
      JSON.stringify({ endpoint: 'https://push.example.com/x', keys: { p256dh: '', auth: 'a' } }),
      JSON.stringify({ endpoint: 'https://push.example.com/x' }),
    ];
    for (const destination of badCases) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/settings/channels',
        cookies: as(cookie),
        payload: { channelType: 'push', destination },
      });
      expect(res.statusCode).toBe(400);
    }
    const good = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: {
        channelType: 'push',
        destination: JSON.stringify({
          endpoint: 'https://push.example.com/sub/1',
          expirationTime: null, // stripped by canonicalization
          keys: { p256dh: 'p256', auth: 'auth' },
        }),
      },
    });
    expect(good.statusCode).toBe(201);
    const { destination } = good.json() as { destination: string };
    expect(JSON.parse(destination)).toEqual({
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'p256', auth: 'auth' },
    });
  });

  it('exposes the VAPID public key on the list when configured', async () => {
    const { cookie } = await makeOwner('vapid@example.com');
    // Default app (no VAPID env): null → the SPA hides the push UI.
    const bare = await app.inject({
      method: 'GET',
      url: '/v1/settings/channels',
      cookies: as(cookie),
    });
    expect((bare.json() as { pushPublicKey: string | null }).pushPublicKey).toBeNull();

    const keyedApp = buildApp(
      {
        ...loadConfig({
          TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
          VAPID_PUBLIC_KEY: 'BPubKey123',
        }),
        logLevel: 'silent',
      },
      { db, sql },
    );
    await keyedApp.ready();
    try {
      const keyed = await keyedApp.inject({
        method: 'GET',
        url: '/v1/settings/channels',
        cookies: as(cookie),
      });
      expect((keyed.json() as { pushPublicKey: string | null }).pushPublicKey).toBe('BPubKey123');
    } finally {
      await keyedApp.close();
    }
  });

  it('sends the welcome email exactly once, on the first verified EMAIL channel only', async () => {
    const { userId, cookie } = await makeOwner('welcome@example.com');

    // Verify the first email channel → a welcome delivery is enqueued.
    const add1 = await addChannel(cookie, 'first@example.com');
    const { id: id1 } = add1.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id1}/verify`,
      cookies: as(cookie),
      payload: { code: await pendingCode(id1) },
    });
    const welcomes1 = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.userId, userId),
          eq(schema.notificationDeliveries.purpose, 'welcome'),
        ),
      );
    expect(welcomes1).toHaveLength(1);
    expect(welcomes1[0]!.channelId).toBe(id1);
    // The user is stamped so it never re-sends.
    const [u1] = await db
      .select({ sentAt: schema.users.welcomeEmailSentAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(u1!.sentAt).not.toBeNull();

    // A SECOND verified email channel does NOT re-send.
    const add2 = await addChannel(cookie, 'second@example.com');
    const { id: id2 } = add2.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id2}/verify`,
      cookies: as(cookie),
      payload: { code: await pendingCode(id2) },
    });
    const welcomes2 = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.userId, userId),
          eq(schema.notificationDeliveries.purpose, 'welcome'),
        ),
      );
    expect(welcomes2).toHaveLength(1); // still just the one
  });

  it('does NOT send a welcome for a verified SMS channel (email-only trigger)', async () => {
    const { userId, cookie } = await makeOwner('sms-nowelcome@example.com');
    await makePro(userId); // SMS is a paid channel
    const add = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'sms', destination: '+15552224444' },
    });
    const { id } = add.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/v1/settings/channels/${id}/verify`,
      cookies: as(cookie),
      payload: { code: await pendingCode(id) },
    });
    const welcomes = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.userId, userId),
          eq(schema.notificationDeliveries.purpose, 'welcome'),
        ),
      );
    expect(welcomes).toHaveLength(0);
    const [u] = await db
      .select({ sentAt: schema.users.welcomeEmailSentAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(u!.sentAt).toBeNull();
  });

  it('rejects unauthenticated access and malformed bodies', async () => {
    const noSession = await app.inject({ method: 'GET', url: '/v1/settings/channels' });
    expect(noSession.statusCode).toBe(401);
    const { cookie } = await makeOwner('h@example.com');
    const badType = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'webhook', destination: 'https://example.com/hook' },
    });
    expect(badType.statusCode).toBe(400); // schema enum: webhook is not owner-enrollable
    const badDest = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'email', destination: 'not-an-email' },
    });
    expect(badDest.statusCode).toBe(400);
    // additionalProperties:false under Fastify's default AJV STRIPS unknown
    // keys rather than 400ing — the request succeeds with the extra dropped.
    const extraProp = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'email', destination: 'h2@example.com', extra: true },
    });
    expect(extraProp.statusCode).toBe(201);
  });

  // ── destination_hash is the dedupe key, and now has to BE the hash ────────
  //
  // QA 2026-08-10, from a production drill transcript. destination_hash backs
  // the unique index (user_id, channel_type, destination_hash) AND the route's
  // "already enrolled?" lookup, and nothing ever checked it held
  // sha256('<type>:<destination>'). A row whose hash does not match its
  // destination is invisible to both: the same destination enrols twice, and
  // the verified-duplicate 409 never fires for it. Migration 0063 adds the
  // CHECK; these pin the two halves that migration depends on.
  it('the route writes sha256(type:destination), byte for byte', async () => {
    const { cookie, userId } = await makeOwner('hashshape@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settings/channels',
      cookies: as(cookie),
      payload: { channelType: 'email', destination: 'Hash.Shape@Example.com' },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.userId, userId));
    expect(row).toBeDefined();
    // Recomputed from what was STORED — so a normalisation change (the route
    // lowercases) is caught rather than assumed.
    const expected = new Uint8Array(
      createHash('sha256').update(`${row!.channelType}:${row!.destination}`, 'utf8').digest(),
    );
    expect(Buffer.from(row!.destinationHash).toString('hex')).toBe(
      Buffer.from(expected).toString('hex'),
    );
    expect(row!.destinationHash).toHaveLength(32);
  });

  it("the DB rejects a hash that isn't one — the drill fixture that reached production", async () => {
    const { userId } = await makeOwner('badhash@example.com');
    // Drizzle wraps the driver error, so the constraint name is on the cause,
    // not the top-level message. Walk the chain rather than matching the
    // wrapper — asserting only "it threw" would pass on an unrelated failure.
    const rejectionText = async (hash: Uint8Array): Promise<string> => {
      try {
        await db.insert(schema.notificationChannels).values({
          userId,
          channelType: 'sms',
          destination: '+15550001111',
          destinationHash: hash,
          verified: true,
        });
        return '<no error>';
      } catch (err) {
        let out = '';
        for (let e: unknown = err; e instanceof Error; e = e.cause) out += `${e.message}\n`;
        return out;
      }
    };

    // The literal residue: destination_hash '\x71612d736d73' is ASCII 'qa-sms',
    // six bytes where the route writes thirty-two, on a row marked verified.
    expect(await rejectionText(Buffer.from('qa-sms', 'utf8'))).toMatch(/destination_hash_ck/);
    // And the near-miss: right length, wrong content. A length check alone
    // would have let this through.
    expect(await rejectionText(new Uint8Array(32).fill(7))).toMatch(/destination_hash_ck/);
  });

  it("Postgres's CHECK expression and the route's hash agree", async () => {
    // The constraint recomputes the hash in SQL; the route computes it in Node.
    // If those two ever disagree, enrolment breaks for everyone — so assert
    // they produce the same bytes rather than trusting that they do.
    for (const [type, dest] of [
      ['email', 'a@b.co'],
      ['sms', '+441234567890'],
      ['push', 'https://push.example/endpoint/xyz'],
    ] as const) {
      const [r] = await sql<{ h: Buffer }[]>`
        select sha256(convert_to(${type} || ':' || ${dest}, 'UTF8')) as h`;
      const node = createHash('sha256').update(`${type}:${dest}`, 'utf8').digest('hex');
      expect(r!.h.toString('hex'), `${type}:${dest}`).toBe(node);
    }
  });
});
