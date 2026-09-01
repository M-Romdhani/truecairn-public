import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAutonomySweep, type AutonomyConfig } from './ai-autonomy.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const ON: AutonomyConfig = { aiEnabled: true, autonomyEnabled: true };
const NOW = new Date('2026-07-04T00:00:00Z');

describeIfDb('runAutonomySweep', () => {
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
    await sql`TRUNCATE sensitive_actions, notification_deliveries, notification_channels, ai_usage_daily, audit_log, audit_log_locks, engine_states, users CASCADE`;
  });

  // Seed a user opted in to autonomy (with an optional floor), an engine state, and
  // a verified channel. `checkInInDays` sets when the next check-in is due.
  async function seed(opts: {
    email: string;
    optIn?: boolean;
    optOut?: boolean;
    floorDays?: number | null;
    thresholdDays?: number;
    checkInInDays?: number | null;
    state?: 'active' | 'pre_active';
  }): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({
        email: opts.email,
        accountStatus: 'active',
        aiAutonomyEnabled: opts.optIn ?? true,
        aiOptOut: opts.optOut ?? false,
        aiCheckinFloorDays: opts.floorDays ?? null,
      })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const nextCheckIn =
      opts.checkInInDays === null || opts.checkInInDays === undefined
        ? null
        : new Date(NOW.getTime() + opts.checkInInDays * 24 * 60 * 60 * 1000);
    await db.insert(schema.engineStates).values({
      userId,
      state: opts.state ?? 'active',
      inactivityThresholdDays: opts.thresholdDays ?? 90,
      nextScheduledCheckInAt: nextCheckIn,
    });
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination: opts.email,
      destinationHash: channelDestinationHash('email', opts.email),
      verified: true,
    });
    return userId;
  }

  const sweep = (config: AutonomyConfig = ON) => runAutonomySweep({ db, audit, config, now: NOW }, 50);

  it('nudges when a check-in is imminent; audits actor=ai; chain valid', async () => {
    const userId = await seed({ email: 'nudge@example.com', checkInInDays: 2, floorDays: null });
    const res = await sweep();
    expect(res.nudges).toBe(1);
    const notices = await db
      .select({ purpose: schema.notificationDeliveries.purpose })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.userId, userId));
    expect(notices.some((n) => n.purpose === 'check_in_request')).toBe(true);
    const audits = await db
      .select({ actor: schema.auditLog.actor, eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_autonomous_enqueued')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe('ai');
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('does NOT nudge when the check-in is far off', async () => {
    await seed({ email: 'far@example.com', checkInInDays: 30, floorDays: null });
    expect((await sweep()).nudges).toBe(0);
  });

  it('tightens toward the floor via a vetoable sensitive action (initiated_by=ai)', async () => {
    const userId = await seed({ email: 'tighten@example.com', floorDays: 30, thresholdDays: 90, checkInInDays: 60 });
    const res = await sweep();
    expect(res.tightens).toBe(1);
    const [action] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(and(eq(schema.sensitiveActions.userId, userId), eq(schema.sensitiveActions.actionType, 'change_inactivity_threshold')));
    expect(action?.status).toBe('pending');
    expect(action?.initiatedBy).toBe('ai');
    expect((action?.actionPayload as { days: number }).days).toBe(30); // toward the floor, shorten-only
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('does NOT tighten when no floor is set (owner has not authorised it)', async () => {
    await seed({ email: 'nofloor@example.com', floorDays: null, thresholdDays: 90, checkInInDays: 60 });
    expect((await sweep()).tightens).toBe(0);
  });

  it('does NOT tighten when already at/below the floor', async () => {
    await seed({ email: 'atfloor@example.com', floorDays: 30, thresholdDays: 30, checkInInDays: 60 });
    expect((await sweep()).tightens).toBe(0);
  });

  it('frequency caps: a second sweep enqueues nothing new', async () => {
    await seed({ email: 'cap@example.com', floorDays: 30, thresholdDays: 90, checkInInDays: 2 });
    const first = await sweep();
    expect(first.nudges + first.tightens).toBe(2);
    const second = await sweep();
    expect(second.nudges).toBe(0);
    expect(second.tightens).toBe(0);
  });

  it('does not stack a tighten on an already-pending threshold change', async () => {
    const userId = await seed({ email: 'stack@example.com', floorDays: 30, thresholdDays: 90, checkInInDays: 60 });
    // Pre-existing pending owner-initiated change.
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'change_inactivity_threshold',
      status: 'pending',
      actionPayload: { days: 45 },
      effectiveAt: new Date(NOW.getTime() + 7 * 86_400_000),
    });
    expect((await sweep()).tightens).toBe(0);
  });

  describe('every gate suppresses autonomy', () => {
    it('kill switch (aiEnabled=false)', async () => {
      await seed({ email: 'kill@example.com', floorDays: 30, thresholdDays: 90, checkInInDays: 2 });
      const res = await sweep({ aiEnabled: false, autonomyEnabled: true });
      expect(res.nudges + res.tightens).toBe(0);
    });
    it('global autonomy flag off', async () => {
      await seed({ email: 'flag@example.com', floorDays: 30, thresholdDays: 90, checkInInDays: 2 });
      const res = await sweep({ aiEnabled: true, autonomyEnabled: false });
      expect(res.nudges + res.tightens).toBe(0);
    });
    it('per-user opt-out', async () => {
      await seed({ email: 'optout@example.com', optOut: true, floorDays: 30, thresholdDays: 90, checkInInDays: 2 });
      expect((await sweep()).nudges + (await sweep()).tightens).toBe(0);
    });
    it('per-user not opted in', async () => {
      await seed({ email: 'notin@example.com', optIn: false, floorDays: 30, thresholdDays: 90, checkInInDays: 2 });
      const res = await sweep();
      expect(res.nudges + res.tightens).toBe(0);
    });
    it('breaker tripped (global daily budget exceeded)', async () => {
      await seed({ email: 'breaker@example.com', floorDays: 30, thresholdDays: 90, checkInInDays: 2 });
      await db.insert(schema.aiUsageDaily).values({ day: NOW.toISOString().slice(0, 10), userId: null, tokensIn: 900, tokensOut: 200, calls: 5 });
      const res = await runAutonomySweep({ db, audit, config: { ...ON, dailyTokenBudget: 1000 }, now: NOW }, 50);
      expect(res.nudges + res.tightens).toBe(0);
    });
  });
});
