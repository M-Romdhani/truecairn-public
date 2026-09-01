import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { EngineState, UserId } from '@truecairn/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCvCadence, type CvCadenceConfig } from './cv-cadence.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-07-10T12:00:00Z');
const CONFIG: CvCadenceConfig = { attemptSpacingMs: 24 * HOUR, maxAttemptsPerChannel: 3 };

// The CV-1 fanout sweep (docs/26 §3.2): waves across matrix-enabled verified
// channels, spacing + caps respected, idempotent under concurrency. Nothing
// here touches the engine — the sweep only writes delivery rows.

describeIfDb('runCvCadence', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE notification_deliveries, channel_preferences, notification_channels, engine_states, users CASCADE`;
  });

  async function seed(opts: {
    state?: EngineState;
    enteredHoursAgo?: number;
    channels?: Array<{ verified: boolean; optedOut?: boolean }>;
  }): Promise<{ userId: UserId; channelIds: string[] }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `cv-${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    await db.insert(schema.engineStates).values({
      userId,
      state: opts.state ?? 'escalation_pending',
      stateEnteredAt: new Date(NOW.getTime() - (opts.enteredHoursAgo ?? 48) * HOUR),
    });
    const channelIds: string[] = [];
    for (const ch of opts.channels ?? [{ verified: true }]) {
      const dest = `d${Math.random()}@x.com`;
      const [c] = await db
        .insert(schema.notificationChannels)
        .values({
          userId,
          channelType: 'email',
          destination: dest,
          destinationHash: channelDestinationHash('email', dest),
          verified: ch.verified,
        })
        .returning({ id: schema.notificationChannels.id });
      channelIds.push(c!.id);
      if (ch.optedOut) {
        await db.insert(schema.channelPreferences).values({
          userId,
          channelId: c!.id,
          purposeClass: 'owner_verification',
          enabled: false,
        });
      }
    }
    return { userId, channelIds };
  }

  async function waveRows(userId: UserId) {
    return db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.userId, userId),
          isNotNull(schema.notificationDeliveries.cvWave),
        ),
      );
  }

  it('enqueues one wave per verified channel once the spacing has elapsed, and repeats up to the cap', async () => {
    const { userId, channelIds } = await seed({
      enteredHoursAgo: 25, // past the 24h spacing → wave 1 due
      channels: [{ verified: true }, { verified: true }],
    });

    const first = await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    expect(first.enqueued).toBe(2); // one wave per channel
    let rows = await waveRows(userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cvWave)).toEqual([1, 1]);
    expect(new Set(rows.map((r) => r.channelId))).toEqual(new Set(channelIds));
    expect(rows.every((r) => r.purpose === 'escalation_request')).toBe(true);
    expect(rows.every((r) => r.status === 'queued')).toBe(true);

    // Immediately again: wave 2 is not due yet — nothing happens.
    const again = await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    expect(again.enqueued).toBe(0);

    // A day later wave 2 fires; two days after that wave 3; then the cap holds.
    await runCvCadence({ db, config: CONFIG, now: new Date(NOW.getTime() + 25 * HOUR) }, 50);
    await runCvCadence({ db, config: CONFIG, now: new Date(NOW.getTime() + 50 * HOUR) }, 50);
    const capped = await runCvCadence(
      { db, config: CONFIG, now: new Date(NOW.getTime() + 100 * HOUR) },
      50,
    );
    expect(capped.enqueued).toBe(0); // maxAttemptsPerChannel = 3
    rows = await waveRows(userId);
    expect(rows).toHaveLength(6); // 3 waves × 2 channels
  });

  it('uses check_in_request during check_in_pending and skips other engine states', async () => {
    const { userId } = await seed({ state: 'check_in_pending', enteredHoursAgo: 25 });
    await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    const rows = await waveRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe('check_in_request');

    const idle = await seed({ state: 'active', enteredHoursAgo: 100 });
    const released = await seed({ state: 'release_review', enteredHoursAgo: 100 });
    await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    expect(await waveRows(idle.userId)).toHaveLength(0);
    expect(await waveRows(released.userId)).toHaveLength(0);
  });

  it('never selects unverified channels, and the matrix narrows the fanout', async () => {
    const { userId, channelIds } = await seed({
      enteredHoursAgo: 25,
      channels: [{ verified: true }, { verified: false }, { verified: true, optedOut: true }],
    });
    await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    const rows = await waveRows(userId);
    expect(rows).toHaveLength(1); // only the verified, not-opted-out channel
    expect(rows[0]!.channelId).toBe(channelIds[0]);
  });

  it('respects the spacing before the FIRST wave (the entry one-shot covers time zero)', async () => {
    const { userId } = await seed({ enteredHoursAgo: 1 }); // entered 1h ago, spacing 24h
    const r = await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    expect(r.enqueued).toBe(0);
    expect(await waveRows(userId)).toHaveLength(0);
  });

  it('two concurrent sweeps produce no duplicate waves (SKIP LOCKED + the unique index)', async () => {
    const seeded = await Promise.all(
      Array.from({ length: 5 }, () => seed({ enteredHoursAgo: 25 })),
    );
    const [a, b] = await Promise.all([
      runCvCadence({ db, config: CONFIG, now: NOW }, 50),
      runCvCadence({ db, config: CONFIG, now: NOW }, 50),
    ]);
    // Between the two racing sweeps every due wave fired exactly once.
    expect(a.enqueued + b.enqueued).toBe(5);
    for (const { userId } of seeded) {
      const rows = await waveRows(userId);
      expect(rows).toHaveLength(1);
    }
  });

  it('the unique index is the backstop: a pre-existing wave row makes the insert a no-op', async () => {
    const { userId, channelIds } = await seed({ enteredHoursAgo: 25 });
    const [engine] = await db
      .select({ enteredAt: schema.engineStates.stateEnteredAt })
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, userId));
    // Simulate the race loser's view: wave 1 already exists (created "now", so
    // the next wave is also not yet due).
    await db.insert(schema.notificationDeliveries).values({
      channelId: channelIds[0]!,
      userId,
      purpose: 'escalation_request',
      status: 'queued',
      nextAttemptAt: NOW,
      createdAt: NOW,
      cvEpisodeAt: engine!.enteredAt,
      cvWave: 1,
    });
    const r = await runCvCadence({ db, config: CONFIG, now: NOW }, 50);
    expect(r.enqueued).toBe(0);
    expect(await waveRows(userId)).toHaveLength(1);
  });
});
