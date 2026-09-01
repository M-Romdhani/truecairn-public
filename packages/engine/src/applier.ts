import { schema, type Database } from '@truecairn/db';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { NotificationPurpose, UserId } from '@truecairn/shared';
import { computeTimeTransition, computeEventTransition } from './transitions.js';
import type {
  EngineEvent,
  EngineStateRow,
  Effect,
  TransitionContext,
  TransitionResult,
} from './types.js';

// Audit-log writes go through this port. The port receives the active
// transaction database so the audit append is committed atomically with the
// state transition that triggered it (or both roll back together). Returns
// the inserted entry's id/seq/hash so callers that need to link other rows
// to this audit entry (e.g. sensitive_actions.audit_id_terminal) can do so.
export interface AppendedAuditEntry {
  id: string;
  seq: bigint;
  entryHash: Uint8Array;
}

export interface AuditLogPort {
  append(
    db: Database,
    userId: UserId,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<AppendedAuditEntry>;
}

export interface NotificationChannelLookup {
  // Returns a channel id to attach an enqueued delivery row to. Returns null
  // if the user has no verified channels (the delivery is skipped — the row
  // can't be inserted without a channel_id and we don't want to crash the tx).
  //
  // `purpose`, when given, lets the lookup honour the owner's channel matrix
  // for routine notice classes (docs/26 §3.1): a purpose that
  // routineNoticeClass() maps to a class skips channels the owner opted out.
  // Purposes the map exempts — the check-in/escalation safety floor, security
  // alerts, operational round-trips — are unaffected, so the matrix can narrow
  // where an update lands but never silence "are you alive?".
  pickPrimaryChannel(userId: UserId, purpose?: NotificationPurpose): Promise<string | null>;
  summarizeHealth(userId: UserId): Promise<{ totalChannels: number; failingChannels: number }>;
}

export interface ApplyContext {
  db: Database;
  audit: AuditLogPort;
  channels: NotificationChannelLookup;
  now: Date;
}

// Claim engine_states rows whose next_action_at is due. Uses
// FOR UPDATE SKIP LOCKED so multiple workers can poll concurrently without
// stepping on each other.
export async function claimDueRows(
  db: Database,
  now: Date,
  limit: number,
): Promise<EngineStateRow[]> {
  const rows = await db
    .select()
    .from(schema.engineStates)
    .where(
      and(
        isNotNull(schema.engineStates.nextActionAt),
        lte(schema.engineStates.nextActionAt, now),
      ),
    )
    .for('update', { skipLocked: true })
    .limit(limit);
  return rows.map(toEngineStateRow);
}

export async function loadRow(db: Database, userId: UserId): Promise<EngineStateRow | null> {
  const rows = await db
    .select()
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .for('update');
  const row = rows[0];
  return row ? toEngineStateRow(row) : null;
}

// Run one time-driven tick for a single user. Assumes the caller has already
// locked the row (e.g. via claimDueRows). Idempotent: if no transition is due,
// it returns 'no_change' and writes nothing.
export async function tickOne(row: EngineStateRow, ctx: ApplyContext): Promise<TransitionResult> {
  const health = await ctx.channels.summarizeHealth(row.userId);
  const ownerLocked = await isOwnerLocked(ctx.db, row.userId, ctx.now);
  const txnCtx: TransitionContext = { now: ctx.now, channelHealth: health, ownerLocked };
  const result = computeTimeTransition(row, txnCtx);
  if (result.kind === 'transition') {
    await persistTransition(row, result, ctx);
  }
  return result;
}

// Is the owner currently locked OUT of their own account? Read only by the
// time-driven tick (2026-08-07 security audit, finding 1): an account lock stops
// the owner answering, so their silence during one is not evidence of anything.
//
// An ELAPSED lock is not a lock. `locked_until` is cleared lazily — historically
// only by the password login route — so a row can sit at status='locked' long
// after the hour ran out. Treating that as locked would stall the ladder on a
// stale flag, which is the wrongful-non-release failure this whole area is
// trying to avoid, so the expiry is checked here rather than trusting the enum.
//
// Deliberately NOT consulted by applyEvent: that path carries user and contact
// events (a dispute, a contact's affirmation), and those must keep working
// regardless of the owner's auth state.
async function isOwnerLocked(db: Database, userId: UserId, now: Date): Promise<boolean> {
  const rows = await db
    .select({ status: schema.users.accountStatus, lockedUntil: schema.users.lockedUntil })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const user = rows[0];
  if (user === undefined || user.status !== 'locked') return false;
  return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
}

// Apply a user/contact/system event. The caller (API in Phase 3) is responsible
// for locking the row via loadRow within the same transaction.
export async function applyEvent(
  row: EngineStateRow,
  event: EngineEvent,
  ctx: ApplyContext,
): Promise<TransitionResult> {
  const health = await ctx.channels.summarizeHealth(row.userId);
  const result = computeEventTransition(row, event, { now: ctx.now, channelHealth: health });
  if (result.kind === 'transition') {
    await persistTransition(row, result, ctx);
  }
  return result;
}

async function persistTransition(
  row: EngineStateRow,
  result: Extract<TransitionResult, { kind: 'transition' }>,
  ctx: ApplyContext,
): Promise<void> {
  const update: Record<string, unknown> = {
    state: result.toState,
    stateEnteredAt: ctx.now,
    nextActionAt: result.nextActionAt,
    updatedAt: ctx.now,
  };
  if (result.previousStateOverride !== undefined) {
    update['previousState'] = result.previousStateOverride;
  }
  if (result.snoozeUntil !== undefined) {
    update['snoozeUntil'] = result.snoozeUntil;
  }
  if (result.lastCheckInAt !== undefined) {
    update['lastCheckInAt'] = result.lastCheckInAt;
  }
  if (result.nextScheduledCheckInAt !== undefined) {
    update['nextScheduledCheckInAt'] = result.nextScheduledCheckInAt;
  }
  // Concurrency guard: only update if the state hasn't changed from under us.
  const updated = await ctx.db
    .update(schema.engineStates)
    .set(update)
    .where(
      and(
        eq(schema.engineStates.userId, row.userId),
        eq(schema.engineStates.state, row.state),
      ),
    )
    .returning({ userId: schema.engineStates.userId });
  if (updated.length === 0) {
    // Another worker won the race. Bail out — we'll pick it up on the next tick.
    return;
  }

  // The audit events for this transition are appended FIRST so the history row
  // can carry the link (`related_audit_id`). The column has existed since the
  // engine shipped and nothing wrote it, so correlating "this transition" to
  // "that chain entry" meant matching on user id plus a timestamp, by hand, on
  // the one artifact a contested release is adjudicated on. The evidence is in
  // the chain either way — this is the join, not the evidence.
  //
  // Ordering is safe and the reason is invariant 5: the append and the state
  // change already ride the same transaction, so nothing here can commit an
  // audit entry for a transition that then rolls back. Ordering WITHIN that
  // transaction is free.
  //
  // A transition normally emits exactly one audit_event. If it emits several,
  // the first is the one the history row points at — it is the event describing
  // the transition itself, and the rest are consequences of it.
  let relatedAuditId: string | null = null;
  const deferred: Effect[] = [];
  for (const effect of result.effects) {
    if (effect.kind === 'audit_event') {
      const entry = await ctx.audit.append(ctx.db, row.userId, effect.eventType, effect.payload);
      relatedAuditId ??= entry.id;
    } else {
      deferred.push(effect);
    }
  }

  await ctx.db.insert(schema.engineStateHistory).values({
    userId: row.userId,
    fromState: row.state,
    toState: result.toState,
    reason: result.reason,
    relatedAuditId,
    occurredAt: ctx.now,
  });

  for (const effect of deferred) {
    await applyEffect(row, effect, ctx);
  }
}

async function applyEffect(
  row: EngineStateRow,
  effect: Effect,
  ctx: ApplyContext,
): Promise<void> {
  switch (effect.kind) {
    case 'audit_event':
      // Not reached from persistTransition, which hoists audit events so the
      // history row can link to the first one. Kept correct rather than deleted:
      // the branch is the right behaviour for any other caller, and a switch
      // that silently dropped an effect kind would be a worse failure than a
      // redundant one.
      await ctx.audit.append(ctx.db, row.userId, effect.eventType, effect.payload);
      return;
    case 'enqueue_notification': {
      // The purpose rides along so the lookup can honour the owner's channel
      // matrix for routine classes (engine_state_change) while the check-in /
      // escalation safety floor stays exempt (routineNoticeClass → null).
      const channelId = await ctx.channels.pickPrimaryChannel(row.userId, effect.purpose);
      if (!channelId) return;
      await ctx.db.insert(schema.notificationDeliveries).values({
        channelId,
        userId: row.userId,
        purpose: effect.purpose,
        relatedEntityType: effect.relatedEntityType,
        relatedEntityId: effect.relatedEntityId,
        status: 'queued',
        attemptCount: 0,
        nextAttemptAt: ctx.now,
        payloadSummary: effect.payloadSummary,
      });
      return;
    }
  }
}

// Maps a Drizzle row to the engine's narrow EngineStateRow view.
function toEngineStateRow(r: typeof schema.engineStates.$inferSelect): EngineStateRow {
  return {
    userId: r.userId as UserId,
    state: r.state,
    previousState: r.previousState,
    stateEnteredAt: r.stateEnteredAt,
    snoozeUntil: r.snoozeUntil,
    lastCheckInAt: r.lastCheckInAt,
    nextScheduledCheckInAt: r.nextScheduledCheckInAt,
    inactivityThresholdDays: r.inactivityThresholdDays,
    checkInTimeoutDays: r.checkInTimeoutDays,
    escalationCooldownDays: r.escalationCooldownDays,
    s1ToS2TimerDays: r.s1ToS2TimerDays,
    s2ToS3TimerDays: r.s2ToS3TimerDays,
    returningGraceDays: r.returningGraceDays,
    notificationStallMaxDays: r.notificationStallMaxDays,
  };
}

// Standalone helper for the worker loop: discover and tick all due rows in a
// single transaction batch. Returns the number of rows processed (transitioned
// or no-op).
export async function tickBatch(ctx: ApplyContext, limit: number): Promise<number> {
  let processed = 0;
  await ctx.db.transaction(async (tx) => {
    const txCtx: ApplyContext = { ...ctx, db: tx as unknown as Database };
    const rows = await claimDueRows(txCtx.db, ctx.now, limit);
    for (const row of rows) {
      await tickOne(row, txCtx);
      processed += 1;
    }
  });
  return processed;
}

// Silence unused-import warnings when sql isn't needed in the active build.
void sql;
