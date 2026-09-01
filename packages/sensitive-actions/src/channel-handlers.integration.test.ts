import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;

// remove_channel (docs/26 §4 follow-on): the handler's apply semantics plus the
// two notice properties the lane promises — the channel being removed still
// receives the pending-removal notice (docs/10-threat-5.2), and the owner's
// channel matrix (owner_notices) narrows the fanout.
describeIfDb('remove_channel sensitive-action handler (integration)', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE channel_preferences, sensitive_actions, notification_deliveries, notification_channels, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }
  async function makeChannel(
    userId: UserId,
    destination: string,
    verified = true,
  ): Promise<string> {
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
    if (!c) throw new Error('channel not created');
    return c.id;
  }
  async function applyAt(now: Date) {
    return applyDueActions({ db, audit, now }, 50);
  }

  it('pending through the cooldown, then soft-removes; the doomed channel received the notice', async () => {
    const ownerId = await makeUser('owner@example.com');
    const doomedId = await makeChannel(ownerId, 'doomed@example.com');
    const survivorId = await makeChannel(ownerId, 'survivor@example.com');
    const t0 = new Date('2026-06-01T00:00:00Z');

    const { id, effectiveAt } = await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'remove_channel',
      payload: { channelId: doomedId },
      now: t0,
    });
    expect(effectiveAt.getTime()).toBe(t0.getTime() + 7 * DAY);

    // docs/10-threat-5.2: the channel whose own removal is pending still gets
    // the sensitive-action notice — silencing it before the delay would defeat
    // the delay.
    const notices = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.userId, ownerId));
    const noticeChannels = new Set(
      notices.filter((n) => n.purpose === 'sensitive_action_notice').map((n) => n.channelId),
    );
    expect(noticeChannels.has(doomedId)).toBe(true);
    expect(noticeChannels.has(survivorId)).toBe(true);

    // Before the cooldown: nothing applies, the channel is untouched.
    const before = await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect(before.processed).toBe(0);
    let [doomed] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, doomedId));
    expect(doomed!.removedAt).toBeNull();

    // After: soft-removed (removed_at set, verification fields burned), the
    // other channel untouched, action applied.
    const after = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(after.applied).toBe(1);
    [doomed] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, doomedId));
    expect(doomed!.removedAt).not.toBeNull();
    expect(doomed!.verificationCodeHash).toBeNull();
    const [survivor] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, survivorId));
    expect(survivor!.removedAt).toBeNull();
    const [action] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, id));
    expect(action!.status).toBe('applied');
  });

  it('the notice fanout honours the channel matrix: an owner_notices-disabled channel is skipped', async () => {
    const ownerId = await makeUser('matrix@example.com');
    const mutedId = await makeChannel(ownerId, 'muted@example.com');
    const openId = await makeChannel(ownerId, 'open@example.com');
    await db.insert(schema.channelPreferences).values({
      userId: ownerId,
      channelId: mutedId,
      purposeClass: 'owner_notices',
      enabled: false,
    });

    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'remove_channel',
      payload: { channelId: openId },
      now: new Date('2026-06-01T00:00:00Z'),
    });

    const notices = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.userId, ownerId));
    const noticeChannels = new Set(
      notices.filter((n) => n.purpose === 'sensitive_action_notice').map((n) => n.channelId),
    );
    expect(noticeChannels.has(openId)).toBe(true);
    expect(noticeChannels.has(mutedId)).toBe(false);
  });

  it('cancels cleanly when the channel was already removed (or never existed)', async () => {
    const ownerId = await makeUser('gone@example.com');
    const channelId = await makeChannel(ownerId, 'gone-ch@example.com');
    const t0 = new Date('2026-06-01T00:00:00Z');
    const { id } = await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'remove_channel',
      payload: { channelId },
      now: t0,
    });
    // The channel vanishes during the cooldown (e.g. an earlier action landed).
    await db
      .update(schema.notificationChannels)
      .set({ removedAt: new Date(t0.getTime() + 2 * DAY) })
      .where(eq(schema.notificationChannels.id, channelId));

    const result = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(result.cancelled).toBe(1);
    const [action] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, id));
    expect(action!.status).toBe('cancelled');
  });
});
