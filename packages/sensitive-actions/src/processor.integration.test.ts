import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { AppendedAuditEntry, AuditLogPort } from '@truecairn/engine';
import type { SensitiveActionType, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction, cancelSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

// Wraps the real AuditLogWriter and records events on the side so tests can
// assert what was written. The FK on sensitive_actions.audit_id_* references
// audit_log.id, so we MUST write through the real chain — a memory-only
// stub returning random uuids would violate the FK.
class RecordingAuditPort implements AuditLogPort {
  appended: Array<{ userId: UserId; eventType: string; payload: Record<string, unknown> }> = [];
  constructor(private readonly inner: AuditLogPort) {}
  async append(
    db: Database,
    userId: UserId,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<AppendedAuditEntry> {
    const result = await this.inner.append(db, userId, eventType, payload);
    this.appended.push({ userId, eventType, payload });
    return result;
  }
  reset(): void {
    this.appended = [];
  }
}

describeIfDb('sensitive-actions processor + scheduler (integration)', () => {
  let db: Database;
  let sql: Sql;
  let audit: RecordingAuditPort;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    const signer = await resolveServerSigner(db);
    audit = new RecordingAuditPort(new AuditLogWriter(signer));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE sensitive_actions, notification_deliveries, notification_channels, engine_state_history, engine_states, audit_log_locks, audit_log, users CASCADE`;
    audit.reset();
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'pending' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('requestSensitiveAction writes the row + audit + 2 notices per channel', async () => {
    const userId = await makeUser('a@example.com');
    // Verified channel
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination: 'a@example.com',
      destinationHash: channelDestinationHash('email', 'a@example.com'),
      verified: true,
    });

    const now = new Date('2026-03-01T00:00:00Z');
    const { id, effectiveAt } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'change_inactivity_threshold' as SensitiveActionType,
      payload: { days: 45 },
      now,
    });
    expect(effectiveAt.getTime() - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);

    const row = (
      await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id))
    )[0];
    expect(row?.status).toBe('pending');
    expect(row?.auditIdRequest).not.toBeNull();

    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.relatedEntityId, id));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.purpose).every((p) => p === 'sensitive_action_notice')).toBe(
      true,
    );

    expect(audit.appended.map((a) => a.eventType)).toEqual(['sensitive_action.requested']);
  });

  it('initiatedBy=ai: marks the row, audits it, names the AI in the notice, still vetoable', async () => {
    const userId = await makeUser('ai-init@example.com');
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination: 'ai-init@example.com',
      destinationHash: channelDestinationHash('email', 'ai-init@example.com'),
      verified: true,
    });
    const now = new Date('2026-03-01T00:00:00Z');
    const { id } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'change_inactivity_threshold' as SensitiveActionType,
      payload: { days: 30 },
      now,
      initiatedBy: 'ai',
    });

    const [row] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id));
    expect(row?.initiatedBy).toBe('ai');
    // The audit records the initiator.
    const req = audit.appended.find((a) => a.eventType === 'sensitive_action.requested');
    expect(req?.payload['initiatedBy']).toBe('ai');
    // The owner's notice names the AI.
    const deliveries = await db
      .select({ summary: schema.notificationDeliveries.payloadSummary })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.relatedEntityId, id));
    expect(deliveries.some((d) => /AI/.test(d.summary ?? ''))).toBe(true);

    // It is STILL fully vetoable — the delay + veto is autonomy's control.
    const cancelled = await cancelSensitiveAction(db, audit, {
      sensitiveActionId: id,
      via: 'owner_veto',
      reason: 'not wanted',
      now: new Date(now.getTime() + 1000),
    });
    expect(cancelled).toBe(true);
    const [after] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id));
    expect(after?.status).toBe('cancelled');
  });

  it('applyDueActions applies arm_engine: PRE_ACTIVE → ACTIVE + users.armed_at set', async () => {
    const userId = await makeUser('b@example.com');
    await db.insert(schema.engineStates).values({
      userId,
      state: 'pre_active',
      stateEnteredAt: new Date('2026-02-01T00:00:00Z'),
    });
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'arm_engine',
      status: 'pending',
      actionPayload: {},
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
    });

    const now = new Date('2026-02-09T00:00:00Z');
    const result = await applyDueActions({ db, audit, now }, 50);
    expect(result).toEqual({ processed: 1, applied: 1, cancelled: 0, failed: 0 });

    const state = (
      await db
        .select()
        .from(schema.engineStates)
        .where(eq(schema.engineStates.userId, userId))
    )[0];
    expect(state?.state).toBe('active');
    expect(state?.lastCheckInAt).not.toBeNull();
    expect(state?.nextActionAt).not.toBeNull();

    const user = (
      await db.select().from(schema.users).where(eq(schema.users.id, userId))
    )[0];
    expect(user?.armedAt).not.toBeNull();
    expect(user?.accountStatus).toBe('active');

    const action = (await db.select().from(schema.sensitiveActions))[0];
    expect(action?.status).toBe('applied');
    expect(action?.appliedAt).not.toBeNull();
    expect(action?.auditIdTerminal).not.toBeNull();

    expect(audit.appended.map((a) => a.eventType)).toEqual(['sensitive_action.applied']);
  });

  it('applyDueActions cancels arm_engine when engine is not in pre_active', async () => {
    const userId = await makeUser('c@example.com');
    await db.insert(schema.engineStates).values({
      userId,
      state: 'active', // already armed
      stateEnteredAt: new Date('2026-01-01T00:00:00Z'),
    });
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'arm_engine',
      status: 'pending',
      actionPayload: {},
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
    });

    const now = new Date('2026-02-09T00:00:00Z');
    const result = await applyDueActions({ db, audit, now }, 50);
    expect(result).toEqual({ processed: 1, applied: 0, cancelled: 1, failed: 0 });

    const action = (await db.select().from(schema.sensitiveActions))[0];
    expect(action?.status).toBe('cancelled');
    expect(action?.cancelledReason).toMatch(/engine_not_pre_active/);
  });

  it('applyDueActions applies change_inactivity_threshold', async () => {
    const userId = await makeUser('d@example.com');
    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: new Date('2026-01-01T00:00:00Z'),
      lastCheckInAt: new Date('2026-01-01T00:00:00Z'),
      inactivityThresholdDays: 30,
    });
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'change_inactivity_threshold',
      status: 'pending',
      actionPayload: { days: 60 },
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
    });

    const now = new Date('2026-02-09T00:00:00Z');
    await applyDueActions({ db, audit, now }, 50);

    const state = (
      await db
        .select()
        .from(schema.engineStates)
        .where(eq(schema.engineStates.userId, userId))
    )[0];
    expect(state?.inactivityThresholdDays).toBe(60);
    // next_action_at should be lastCheckInAt + 60 days, not 30.
    const expected = new Date('2026-01-01T00:00:00Z').getTime() + 60 * 24 * 60 * 60 * 1000;
    expect(state?.nextActionAt?.getTime()).toBe(expected);
  });

  it('AI-initiated threshold change applies when it still tightens at apply time', async () => {
    const userId = await makeUser('ai-tighten@example.com');
    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: new Date('2026-01-01T00:00:00Z'),
      lastCheckInAt: new Date('2026-01-01T00:00:00Z'),
      inactivityThresholdDays: 30,
    });
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'change_inactivity_threshold',
      status: 'pending',
      actionPayload: { days: 7 }, // the owner's floor — strictly below current 30
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
      initiatedBy: 'ai',
    });

    const now = new Date('2026-02-09T00:00:00Z');
    const result = await applyDueActions({ db, audit, now }, 50);
    expect(result).toEqual({ processed: 1, applied: 1, cancelled: 0, failed: 0 });

    const state = (
      await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, userId))
    )[0];
    expect(state?.inactivityThresholdDays).toBe(7);
  });

  it('AI-initiated threshold change is cancelled fail-closed when it would LOOSEN at apply time (enqueue→apply TOCTOU)', async () => {
    const userId = await makeUser('ai-toctou@example.com');
    // Enqueue-time picture: threshold was 30, AI enqueued days=7 (a tighten).
    // During the veto window the owner manually lowered the threshold to 3.
    // Applying 7 now would RAISE 3 → 7: an AI-initiated loosening. The handler
    // must re-check direction at apply time and cancel.
    await db.insert(schema.engineStates).values({
      userId,
      state: 'active',
      stateEnteredAt: new Date('2026-01-01T00:00:00Z'),
      lastCheckInAt: new Date('2026-01-01T00:00:00Z'),
      inactivityThresholdDays: 3, // owner's mid-window manual change
    });
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'change_inactivity_threshold',
      status: 'pending',
      actionPayload: { days: 7 },
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
      initiatedBy: 'ai',
    });

    const now = new Date('2026-02-09T00:00:00Z');
    const result = await applyDueActions({ db, audit, now }, 50);
    expect(result).toEqual({ processed: 1, applied: 0, cancelled: 1, failed: 0 });

    const state = (
      await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, userId))
    )[0];
    expect(state?.inactivityThresholdDays).toBe(3); // untouched — fail-closed

    const action = (
      await db
        .select()
        .from(schema.sensitiveActions)
        .where(eq(schema.sensitiveActions.userId, userId))
    )[0];
    expect(action?.status).toBe('cancelled');
    expect(action?.cancelledReason).toMatch(/ai_threshold_change_must_tighten/);
  });

  it('applyDueActions skips actions whose effective_at is in the future', async () => {
    const userId = await makeUser('e@example.com');
    await db.insert(schema.engineStates).values({
      userId,
      state: 'pre_active',
      stateEnteredAt: new Date('2026-02-01T00:00:00Z'),
    });
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'arm_engine',
      status: 'pending',
      actionPayload: {},
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
    });

    const now = new Date('2026-02-07T00:00:00Z');
    const result = await applyDueActions({ db, audit, now }, 50);
    expect(result.processed).toBe(0);
    const action = (await db.select().from(schema.sensitiveActions))[0];
    expect(action?.status).toBe('pending');
  });

  it('cancelSensitiveAction moves a pending row to cancelled and writes audit', async () => {
    const userId = await makeUser('f@example.com');
    const [row] = await db
      .insert(schema.sensitiveActions)
      .values({
        userId,
        actionType: 'change_inactivity_threshold',
        status: 'pending',
        actionPayload: { days: 45 },
        requestedAt: new Date('2026-02-01T00:00:00Z'),
        effectiveAt: new Date('2026-02-08T00:00:00Z'),
      })
      .returning({ id: schema.sensitiveActions.id });

    const ok = await cancelSensitiveAction(db, audit, {
      sensitiveActionId: row!.id,
      via: 'user-app',
      reason: 'user_changed_mind',
      now: new Date('2026-02-03T00:00:00Z'),
    });
    expect(ok).toBe(true);

    const after = (
      await db
        .select()
        .from(schema.sensitiveActions)
        .where(eq(schema.sensitiveActions.id, row!.id))
    )[0];
    expect(after?.status).toBe('cancelled');
    expect(after?.cancelledVia).toBe('user-app');
    expect(after?.auditIdTerminal).not.toBeNull();
    expect(audit.appended.map((a) => a.eventType)).toEqual(['sensitive_action.cancelled']);
  });

  it('cancelled actions are not processed', async () => {
    const userId = await makeUser('g@example.com');
    await db.insert(schema.sensitiveActions).values({
      userId,
      actionType: 'change_inactivity_threshold',
      status: 'cancelled',
      actionPayload: { days: 45 },
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
      cancelledAt: new Date('2026-02-03T00:00:00Z'),
    });

    const result = await applyDueActions(
      { db, audit, now: new Date('2026-02-09T00:00:00Z') },
      50,
    );
    expect(result.processed).toBe(0);
  });

  it('phase-deferred handlers still close out the action as applied (stub behaviour)', async () => {
    const userId = await makeUser('h@example.com');
    await db.insert(schema.sensitiveActions).values({
      userId,
      // change_tier_configuration is still a deferred-pending-design stub (3.4 §g-6).
      actionType: 'change_tier_configuration',
      status: 'pending',
      actionPayload: { wrappedKey: 'base64...' },
      requestedAt: new Date('2026-02-01T00:00:00Z'),
      effectiveAt: new Date('2026-02-08T00:00:00Z'),
    });

    const result = await applyDueActions(
      { db, audit, now: new Date('2026-02-09T00:00:00Z') },
      50,
    );
    expect(result.applied).toBe(1);
    const action = (await db.select().from(schema.sensitiveActions))[0];
    expect(action?.status).toBe('applied');
    expect((audit.appended[0]?.payload as { details?: { stub?: boolean } }).details?.stub).toBe(
      true,
    );
  });
});
