import { AiAuthority } from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { log } from './log.js';

// ── Bounded-autonomy sweep (plan docs/25 §6 / Phase 2) ────────────────────────
//
// A periodic worker sweep that lets the AI enqueue a SMALL set of reversible,
// safety-neutral-or-closed actions on a user's behalf — each through the EXISTING
// sensitive-actions / notification machinery (no new execution path) and each fully
// vetoable during its delay window. Deterministic-first: the DECISIONS here are
// rule-based, not model output, so there is no prompt-injection surface.
//
// Suppressed by EVERY gate: the master kill switch (AI_ENABLED=false), the global
// autonomy flag (AI_AUTONOMY_ENABLED=false), the per-user opt-out, the per-user
// opt-IN (autonomy is off per account until the owner enables it), and the cost
// breaker. Anything touching tiers, contacts, thresholds beyond the owner's floor,
// ceremonies, or key material is NOT an autonomous kind — those stay Tier-1 proposals.

// A check-in within this window (or overdue) makes a miss "look likely" → nudge.
const NUDGE_LEAD_DAYS = 3;
// Per-kind frequency caps (plan §6): at most one of each per user per window.
const NUDGE_CAP_DAYS = 7;
const TIGHTEN_CAP_DAYS = 30;
// The veto/delay window for an autonomous tighten (a sensitive action).
const TIGHTEN_COOLDOWN_DAYS = 7;

const CHECKIN_STATES = new Set(['active', 'check_in_pending', 'escalation_pending']);

export interface AutonomyConfig {
  aiEnabled: boolean;
  autonomyEnabled: boolean;
  dailyTokenBudget?: number | undefined;
}

export interface AutonomyContext {
  db: Database;
  audit: AuditLogPort;
  config: AutonomyConfig;
  now: Date;
}

export async function runAutonomySweep(
  ctx: AutonomyContext,
  batchSize: number,
): Promise<{ nudges: number; tightens: number }> {
  // Global gates first — cheapest suppression.
  if (!ctx.config.aiEnabled || !ctx.config.autonomyEnabled) return { nudges: 0, tightens: 0 };
  if (await breakerTripped(ctx)) return { nudges: 0, tightens: 0 };

  // Eligible users: opted IN to autonomy, NOT opted out of AI, and active.
  const users = await ctx.db
    .select({
      id: schema.users.id,
      floorDays: schema.users.aiCheckinFloorDays,
    })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.aiAutonomyEnabled, true),
        eq(schema.users.aiOptOut, false),
        eq(schema.users.accountStatus, 'active'),
      ),
    )
    .limit(batchSize);

  const authority = new AiAuthority({ audit: ctx.audit });
  let nudges = 0;
  let tightens = 0;
  for (const u of users) {
    const userId = u.id as UserId;
    try {
      if (await maybeNudge(ctx, authority, userId)) nudges += 1;
      if (await maybeTighten(ctx, authority, userId, u.floorDays)) tightens += 1;
    } catch (err) {
      // Per-user isolation — one user's failure never stalls the batch.
      log.warn('worker.ai_autonomy_user_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { nudges, tightens };
}

// send_reminder_nudge (neutral): an extra check-in reminder when a miss looks
// likely. Notification-only — nothing to apply, nothing to veto beyond ignoring it.
async function maybeNudge(
  ctx: AutonomyContext,
  authority: AiAuthority,
  userId: UserId,
): Promise<boolean> {
  const [es] = await ctx.db
    .select({
      state: schema.engineStates.state,
      nextCheckIn: schema.engineStates.nextScheduledCheckInAt,
    })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);
  if (es === undefined || !CHECKIN_STATES.has(es.state)) return false;
  if (es.nextCheckIn === null) return false;
  // A miss looks likely: the check-in is within NUDGE_LEAD_DAYS or already overdue.
  const leadMs = NUDGE_LEAD_DAYS * 24 * 60 * 60 * 1000;
  if (es.nextCheckIn.getTime() - ctx.now.getTime() > leadMs) return false;
  // Frequency cap.
  if (await recentAutonomous(ctx, userId, 'send_reminder_nudge', NUDGE_CAP_DAYS)) return false;

  await authority.enqueueAutonomous(
    ctx.db,
    userId,
    'send_reminder_nudge',
    { reason: 'checkin_miss_likely' },
    async (tx) => {
      await insertNudgeNotices(tx, userId, ctx.now);
      return { reference: null };
    },
  );
  return true;
}

// tighten_checkin_schedule (closed): shorten the inactivity interval toward the
// owner's floor. Enters the sensitive-actions pipeline (delay + veto). ONLY when the
// owner set a floor AND the current interval is above it AND no AI tighten recently
// AND no tighten is already pending. Shorten-only, never below the floor.
async function maybeTighten(
  ctx: AutonomyContext,
  authority: AiAuthority,
  userId: UserId,
  floorDays: number | null,
): Promise<boolean> {
  if (floorDays === null) return false; // owner has not authorised autonomous tightening
  const [es] = await ctx.db
    .select({ days: schema.engineStates.inactivityThresholdDays })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);
  if (es === undefined || es.days <= floorDays) return false; // already at/below the floor
  if (await recentAutonomous(ctx, userId, 'tighten_checkin_schedule', TIGHTEN_CAP_DAYS)) return false;
  // Don't stack on an already-pending threshold change (owner- or AI-initiated).
  const pending = await ctx.db
    .select({ id: schema.sensitiveActions.id })
    .from(schema.sensitiveActions)
    .where(
      and(
        eq(schema.sensitiveActions.userId, userId),
        eq(schema.sensitiveActions.actionType, 'change_inactivity_threshold'),
        eq(schema.sensitiveActions.status, 'pending'),
      ),
    )
    .limit(1);
  if (pending[0] !== undefined) return false;

  const proposedDays = floorDays; // the owner's stated acceptable floor
  await authority.enqueueAutonomous(
    ctx.db,
    userId,
    'tighten_checkin_schedule',
    { currentDays: es.days, proposedDays },
    async (tx) => {
      const res = await requestSensitiveAction(tx, ctx.audit, {
        userId,
        actionType: 'change_inactivity_threshold',
        payload: { days: proposedDays },
        now: ctx.now,
        cooldownDays: TIGHTEN_COOLDOWN_DAYS,
        initiatedBy: 'ai',
      });
      return { reference: res.id };
    },
  );
  return true;
}

// Has the AI already enqueued this kind for this user within `days`? Uses the
// ai_autonomous_enqueued audit trail (actor='ai') as the single cap source of truth
// for BOTH kinds.
async function recentAutonomous(
  ctx: AutonomyContext,
  userId: UserId,
  kind: string,
  days: number,
): Promise<boolean> {
  const since = new Date(ctx.now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await ctx.db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, userId),
        eq(schema.auditLog.eventType, 'ai_autonomous_enqueued'),
        sql`${schema.auditLog.eventPayload} ->> 'kind' = ${kind}`,
        gt(schema.auditLog.serverTimestamp, since),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

async function insertNudgeNotices(db: Database, userId: UserId, now: Date): Promise<void> {
  const channels = await db
    .select({ id: schema.notificationChannels.id })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
      ),
    );
  if (channels.length === 0) return;
  await db.insert(schema.notificationDeliveries).values(
    channels.map((c) => ({
      channelId: c.id,
      userId,
      purpose: 'check_in_request' as const,
      status: 'queued' as const,
      nextAttemptAt: now,
      payloadSummary: 'A friendly reminder to check in (suggested by AI)',
    })),
  );
}

async function breakerTripped(ctx: AutonomyContext): Promise<boolean> {
  const budget = ctx.config.dailyTokenBudget;
  if (budget === undefined) return false;
  const day = ctx.now.toISOString().slice(0, 10);
  const [row] = await ctx.db
    .select({
      total: sql<string>`coalesce(${schema.aiUsageDaily.tokensIn} + ${schema.aiUsageDaily.tokensOut}, 0)`,
    })
    .from(schema.aiUsageDaily)
    .where(and(eq(schema.aiUsageDaily.day, day), isNull(schema.aiUsageDaily.userId)));
  return Number(row?.total ?? '0') >= budget;
}
