import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { DeliveryStatus, UserId } from '@truecairn/shared';
import { buildContinuityReport, computeOutcome } from './continuity-report.js';
import { eligibleChannels, isChannelEnabled } from './channel-matrix.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];
const DAY = 24 * 60 * 60 * 1000;

// Golden derivation tests (docs/26 §5 task 0.4): fixture rows in → pinned
// payload out. The builder is a read model over deliveries + channels + engine
// history; nothing here creates new sources of truth.

describeIfDb('buildContinuityReport (integration goldens)', () => {
  let db: Database;
  let sql: Sql;
  const now = new Date('2026-07-13T12:00:00Z');
  const t = (daysAgo: number): Date => new Date(now.getTime() - daysAgo * DAY);

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE notification_deliveries, channel_preferences, notification_channels, engine_state_history, engine_states, users CASCADE`;
  });

  async function makeUser(): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `cr-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function makeEngine(userId: UserId, lastCheckInDaysAgo: number): Promise<void> {
    await db.insert(schema.engineStates).values({
      userId,
      state: 'escalation_pending',
      stateEnteredAt: t(7),
      lastCheckInAt: t(lastCheckInDaysAgo),
      inactivityThresholdDays: 30,
      checkInTimeoutDays: 7,
      escalationCooldownDays: 14,
    });
    await db.insert(schema.engineStateHistory).values([
      {
        userId,
        fromState: 'active',
        toState: 'check_in_pending',
        reason: 'inactivity_threshold_exceeded',
        occurredAt: t(14),
      },
      {
        userId,
        fromState: 'check_in_pending',
        toState: 'escalation_pending',
        reason: 'check_in_timeout_expired',
        occurredAt: t(7),
      },
    ]);
  }
  async function makeChannel(userId: UserId, verified = true): Promise<string> {
    const dest = `d-${Math.random()}@example.com`;
    const [c] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType: 'email' as const,
        destination: dest,
        destinationHash: channelDestinationHash('email', dest),
        verified,
      })
      .returning({ id: schema.notificationChannels.id });
    return c!.id;
  }
  async function addDelivery(
    userId: UserId,
    channelId: string,
    status: DeliveryStatus,
    daysAgo: number,
  ): Promise<void> {
    await db.insert(schema.notificationDeliveries).values({
      channelId,
      userId,
      purpose: 'escalation_request',
      status,
      createdAt: t(daysAgo),
      sentAt: status === 'queued' ? null : t(daysAgo),
      deliveredAt: status === 'delivered' ? t(daysAgo) : null,
      bouncedAt: status === 'bounced' ? t(daysAgo) : null,
    });
  }

  it('all delivered, no check-in → delivered_no_checkin with full evidence lines', async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    const ch = await makeChannel(userId);
    await addDelivery(userId, ch, 'delivered', 6);
    await addDelivery(userId, ch, 'delivered', 3);

    const report = await buildContinuityReport(db, userId, now);
    expect(report.outcome).toBe('delivered_no_checkin');
    expect(report.channels).toHaveLength(1);
    const line = report.channels[0]!;
    expect(line.attempts).toBe(2);
    expect(line.delivered).toBe(2);
    expect(line.bounced).toBe(0);
    expect(line.lastDeliveredAt).toBe(t(3).toISOString());
    expect(report.heartbeat.lastCheckInAt).toBe(t(31).toISOString());
    expect(report.heartbeat.checkInRequestedAt).toBe(t(14).toISOString());
    expect(report.heartbeat.escalationStartedAt).toBe(t(7).toISOString());
    expect(report.recovery.checkedInDuringWindow).toBe(false);
    expect(report.window.from).toBe(t(31).toISOString());
    expect(report.window.to).toBe(now.toISOString());
  });

  it('every attempt provably failed → unreachable_all_channels', async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    const ch1 = await makeChannel(userId);
    const ch2 = await makeChannel(userId);
    await addDelivery(userId, ch1, 'bounced', 6);
    await addDelivery(userId, ch1, 'bounced', 3);
    await addDelivery(userId, ch2, 'failed', 5);

    const report = await buildContinuityReport(db, userId, now);
    expect(report.outcome).toBe('unreachable_all_channels');
    expect(report.channels.map((c) => c.bounced + c.failed)).toEqual([2, 1]);
  });

  it('a delivered channel next to a bounced one → partial_delivery_no_checkin', async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    const good = await makeChannel(userId);
    const dead = await makeChannel(userId);
    await addDelivery(userId, good, 'delivered', 4);
    await addDelivery(userId, dead, 'bounced', 4);

    const report = await buildContinuityReport(db, userId, now);
    expect(report.outcome).toBe('partial_delivery_no_checkin');
  });

  it("'sent' without webhook proof is indeterminate — partial, never delivered or unreachable", async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    const ch = await makeChannel(userId);
    await addDelivery(userId, ch, 'sent', 4);

    const report = await buildContinuityReport(db, userId, now);
    expect(report.outcome).toBe('partial_delivery_no_checkin');
    expect(report.channels[0]!.sent).toBe(1);
    expect(report.channels[0]!.delivered).toBe(0);
  });

  it('no verified channels → channels_unconfigured (an unverified channel does not count)', async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    await makeChannel(userId, false);

    const report = await buildContinuityReport(db, userId, now);
    expect(report.outcome).toBe('channels_unconfigured');
  });

  it('a check-in inside the window is visible as recovery evidence', async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    await db.insert(schema.engineStateHistory).values({
      userId,
      fromState: 'escalation_pending',
      toState: 'active',
      reason: 'user_confirmed_active',
      occurredAt: t(1),
    });
    const ch = await makeChannel(userId);
    await addDelivery(userId, ch, 'delivered', 4);

    const report = await buildContinuityReport(db, userId, now);
    expect(report.recovery.checkedInDuringWindow).toBe(true);
    expect(report.recovery.recoveredAt).toBe(t(1).toISOString());
  });

  it('is deterministic: the same rows produce byte-identical payloads', async () => {
    const userId = await makeUser();
    await makeEngine(userId, 31);
    const ch = await makeChannel(userId);
    await addDelivery(userId, ch, 'delivered', 4);
    const a = await buildContinuityReport(db, userId, now);
    const b = await buildContinuityReport(db, userId, now);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('channel matrix: absent preference = enabled; a disabled row narrows eligibility', async () => {
    const userId = await makeUser();
    const ch1 = await makeChannel(userId);
    const ch2 = await makeChannel(userId);
    await makeChannel(userId, false); // unverified — never eligible

    // Pure default rule.
    expect(isChannelEnabled([], ch1, 'owner_verification')).toBe(true);
    expect(
      isChannelEnabled(
        [{ channelId: ch1, purposeClass: 'owner_verification', enabled: false }],
        ch1,
        'owner_verification',
      ),
    ).toBe(false);

    // DB-backed resolution: default everyone in…
    expect((await eligibleChannels(db, userId, 'owner_verification')).map((c) => c.id)).toEqual([
      ch1,
      ch2,
    ]);
    // …opting ch1 out of owner_verification narrows THAT class only.
    await db.insert(schema.channelPreferences).values({
      userId,
      channelId: ch1,
      purposeClass: 'owner_verification',
      enabled: false,
    });
    expect((await eligibleChannels(db, userId, 'owner_verification')).map((c) => c.id)).toEqual([
      ch2,
    ]);
    expect((await eligibleChannels(db, userId, 'owner_notices')).map((c) => c.id)).toEqual([
      ch1,
      ch2,
    ]);
  });

  it('computeOutcome edge: verified channels with zero attempts → channels_unconfigured', () => {
    expect(
      computeOutcome([
        {
          channelId: 'x',
          channelType: 'email',
          verified: true,
          health: 'healthy',
          attempts: 0,
          sent: 0,
          delivered: 0,
          bounced: 0,
          failed: 0,
          lastAttemptAt: null,
          lastDeliveredAt: null,
        },
      ]),
    ).toBe('channels_unconfigured');
  });
});
