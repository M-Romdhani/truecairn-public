// Integration test: real Postgres, real Drizzle, real tickBatch.
// Skipped unless DATABASE_URL is set, so vitest run on a dev machine without
// a DB still passes the unit suite. CI runs migrations first then this.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { AuditLogPort, NotificationChannelLookup } from './applier.js';
import { tickBatch } from './applier.js';
import { addDays } from './next-action.js';

type Sql = ReturnType<typeof createClient>['sql'];

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

describeIfDb('applier (integration)', () => {
  let db: Database;
  let sql: Sql;
  // Inserts a REAL audit_log row rather than returning a synthetic id. It used
  // to return a fixed all-zero UUID, which was fine only while nothing consumed
  // the return value; engine_state_history.related_audit_id has a live FK to
  // audit_log, so a fabricated id now fails the insert. Writing a real row keeps
  // the port cheap (no signing, no chain) while letting the link be asserted —
  // and means the FK is exercised rather than mocked away.
  // Per-user seq + last entry hash. audit_log carries a DB trigger
  // (audit_log_verify_chain) that rejects an entry whose prev_entry_hash is not
  // the previous entry's entry_hash, so a stub cannot emit a constant hash — the
  // second append for a user is refused. Keeping a real chain here is what makes
  // the port usable at all, and it means the trigger is exercised rather than
  // bypassed.
  const chain = new Map<string, { seq: bigint; hash: Uint8Array }>();
  const audit: AuditLogPort & { appended: Array<{ userId: UserId; eventType: string }> } = {
    appended: [],
    async append(adb, userId, eventType, payload) {
      this.appended.push({ userId, eventType });
      const prev = chain.get(userId);
      const seq = (prev?.seq ?? 0n) + 1n;
      // Distinct per entry — a constant would satisfy the first insert and fail
      // the next, which is exactly the bug this comment exists to prevent.
      const entryHash = new Uint8Array(32);
      new DataView(entryHash.buffer).setBigUint64(0, seq);
      entryHash[8] = eventType.length & 0xff;
      const [row] = await adb
        .insert(schema.auditLog)
        .values({
          userId,
          seq,
          eventType,
          eventPayload: payload,
          ...(prev !== undefined ? { prevEntryHash: prev.hash } : {}),
          entryHash,
          serverSignature: new Uint8Array(64),
          serverKeyId: 'test',
        })
        .returning({ id: schema.auditLog.id });
      chain.set(userId, { seq, hash: entryHash });
      return { id: row!.id, seq, entryHash };
    },
  };

  let mockHealth = { totalChannels: 0, failingChannels: 0 };
  const channels: NotificationChannelLookup = {
    async pickPrimaryChannel() {
      return null;
    },
    async summarizeHealth() {
      return mockHealth;
    },
  };

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Wipe state created by previous test rows. Order matters — FKs cascade.
    await sql`TRUNCATE engine_state_history, engine_states, users CASCADE`;
    (audit as unknown as { appended: unknown[] }).appended = [];
    // The TRUNCATE above wipes audit_log, so the in-memory chain has to reset
    // with it or the next append sends a prev_entry_hash for a row that is gone.
    chain.clear();
    mockHealth = { totalChannels: 0, failingChannels: 0 };
  });

  it('tickBatch transitions ACTIVE → CHECK_IN_PENDING when inactivity exceeded', async () => {
    const now = new Date();
    const stale = addDays(now, -45);

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'a@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not created');
    const userId = user.id as UserId;

    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: stale,
      lastCheckInAt: stale,
      nextActionAt: addDays(stale, 30),
      inactivityThresholdDays: 30,
    });

    const processed = await tickBatch({ db, audit, channels, now }, 10);
    expect(processed).toBe(1);

    const after = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, userId));
    expect(after[0]?.state).toBe('check_in_pending');
    expect(after[0]?.previousState).toBe('active');
    expect(after[0]?.nextActionAt).not.toBeNull();

    const history = await db
      .select()
      .from(schema.engineStateHistory)
      .where(eq(schema.engineStateHistory.userId, userId));
    expect(history).toHaveLength(1);
    expect(history[0]?.fromState).toBe('active');
    expect(history[0]?.toState).toBe('check_in_pending');
    expect(history[0]?.reason).toBe('inactivity_threshold_exceeded');

    const log = (audit as unknown as { appended: Array<{ eventType: string }> }).appended;
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]?.eventType).toBe('engine.entered_check_in_pending');

    // The transition is JOINED to the chain entry that records it. Drill
    // evidence 2026-08-10: a full production ladder walk left every
    // engine_state_history row with related_audit_id NULL, so correlating a
    // transition to its audit entry meant matching user id + timestamp by hand,
    // on the artifact a contested release is adjudicated on.
    expect(history[0]?.relatedAuditId).not.toBeNull();
    const linked = await db
      .select({ eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, history[0]!.relatedAuditId!));
    expect(linked[0]?.eventType).toBe('engine.entered_check_in_pending');
  });

  it('every transition in a multi-hop ladder carries its audit link', async () => {
    // One NULL in the middle of a ladder is the failure that matters: it reads
    // as "no audit entry for this hop" rather than "this path forgot to link".
    const now = new Date();
    const stale = addDays(now, -40);
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'ladder-link@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id as UserId;
    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: stale,
      lastCheckInAt: stale,
      nextActionAt: addDays(stale, 30),
      inactivityThresholdDays: 30,
    });

    // Walk the clock far enough to clear several time-driven hops.
    for (const day of [0, 7, 14, 21]) {
      await tickBatch({ db, audit, channels, now: addDays(now, day) }, 10);
    }

    const history = await db
      .select()
      .from(schema.engineStateHistory)
      .where(eq(schema.engineStateHistory.userId, userId));
    expect(history.length).toBeGreaterThan(1);
    for (const h of history) {
      expect(
        h.relatedAuditId,
        `${String(h.fromState)} → ${h.toState} (${h.reason}) landed with no audit link`,
      ).not.toBeNull();
    }
  });

  it('tickBatch skips rows whose next_action_at is in the future', async () => {
    const now = new Date();
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'b@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not created');
    const userId = user.id as UserId;

    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: now,
      lastCheckInAt: now,
      nextActionAt: addDays(now, 30),
    });

    const processed = await tickBatch({ db, audit, channels, now }, 10);
    expect(processed).toBe(0);

    const after = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, userId));
    expect(after[0]?.state).toBe('active');
  });

  it('LIMITED_RELEASE → STAGED_RELEASE → FULL_RELEASE chain over two ticks', async () => {
    const now = new Date();
    const enteredAt = addDays(now, -10);
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'c@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not created');
    const userId = user.id as UserId;

    await db.insert(schema.engineStates).values({
      userId,
      state: 'limited_release',
      stateEnteredAt: enteredAt,
      nextActionAt: addDays(enteredAt, 7),
    });

    let processed = await tickBatch({ db, audit, channels, now }, 10);
    expect(processed).toBe(1);
    let state = (
      await db
        .select()
        .from(schema.engineStates)
        .where(eq(schema.engineStates.userId, userId))
    )[0];
    expect(state?.state).toBe('staged_release');

    // Fast-forward 20 more days; second tick advances to full_release.
    const later = addDays(now, 20);
    processed = await tickBatch({ db, audit, channels, now: later }, 10);
    expect(processed).toBe(1);
    state = (
      await db
        .select()
        .from(schema.engineStates)
        .where(eq(schema.engineStates.userId, userId))
    )[0];
    expect(state?.state).toBe('full_release');
    expect(state?.nextActionAt).toBeNull();
  });

  it('concurrent claims do not double-process a row (FOR UPDATE SKIP LOCKED)', async () => {
    const now = new Date();
    const stale = addDays(now, -45);
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'd@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not created');
    const userId = user.id as UserId;

    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: stale,
      lastCheckInAt: stale,
      nextActionAt: addDays(stale, 30),
    });

    const [a, b] = await Promise.all([
      tickBatch({ db, audit, channels, now }, 10),
      tickBatch({ db, audit, channels, now }, 10),
    ]);
    expect(a + b).toBe(1);

    const history = await db
      .select()
      .from(schema.engineStateHistory)
      .where(eq(schema.engineStateHistory.userId, userId));
    expect(history).toHaveLength(1);
  });

  // PHASE3_5 §c: the full notification_stalled enter -> auto-clear -> re-enter cycle.
  it('notification_stalled auto-clears on channel recovery (re-armed from now) and can re-enter', async () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'stall@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id as UserId;
    const loadState = async () =>
      (await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, userId)))[0]!;

    // A due check-in with ALL channels failing.
    mockHealth = { totalChannels: 3, failingChannels: 3 };
    await db.insert(schema.engineStates).values({
      userId,
      state: 'check_in_pending',
      stateEnteredAt: addDays(now, -1),
      nextActionAt: addDays(now, -1),
      checkInTimeoutDays: 7,
      inactivityThresholdDays: 30,
    });

    // Tick 1 -> all failing -> notification_stalled (re-checkable, nextActionAt set).
    await tickBatch({ db, audit, channels, now }, 10);
    let es = await loadState();
    expect(es.state).toBe('notification_stalled');
    expect(es.nextActionAt).not.toBeNull();

    // The user was unreachable for 10 days; then a channel recovers.
    mockHealth = { totalChannels: 3, failingChannels: 2 };
    const recoverNow = addDays(now, 10);
    await tickBatch({ db, audit, channels, now: recoverNow }, 10);
    es = await loadState();
    expect(es.state).toBe('check_in_pending');
    // Re-armed from NOW — the full window, not the stale 10-day-old deadline.
    expect(es.nextActionAt).toEqual(addDays(recoverNow, 7));

    // All channels fail again; at the (new) deadline it re-enters stalled.
    mockHealth = { totalChannels: 3, failingChannels: 3 };
    await tickBatch({ db, audit, channels, now: addDays(recoverNow, 7) }, 10);
    expect((await loadState()).state).toBe('notification_stalled');
  });
});
