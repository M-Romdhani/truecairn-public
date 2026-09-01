import type { AiAuthority } from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import { planLimits, type BillingPlan, type UserId } from '@truecairn/shared';
// (BillingPlan/planLimits serve both the gate and the edge — the two must never
// be computed from different numbers; see maybeEmitBreakerEdge.)
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config.js';

// ── AI cost circuit breaker (plan docs/25 §4 task 0.2) ────────────────────────
//
// Token/call accounting + a budget breaker over ai_usage_daily. When a day's
// GLOBAL total or a USER's daily total crosses its configured budget, advisory AI
// surfaces go 'unavailable' and the guardian falls back to a deterministic
// template — the vault, engine, ceremonies, and auth are untouched. Metadata-only:
// counts, never prompts or content.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DailyTotals {
  userTotal: number;
  globalTotal: number;
}

export type BreakerState = { tripped: false } | { tripped: true; scope: 'global' | 'user' };

function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function startOfUtcDay(now: Date): Date {
  return new Date(`${isoDay(now)}T00:00:00.000Z`);
}

// Record one model call's usage into the per-user AND global daily counters, and
// return the post-bump totals so the caller can detect a budget-crossing edge.
export async function recordAiUsage(
  db: Database,
  userId: UserId,
  usage: TokenUsage,
  now: Date,
): Promise<DailyTotals> {
  const day = isoDay(now);
  const userTotal = await bump(db, day, userId, usage);
  const globalTotal = await bump(db, day, null, usage);
  return { userTotal, globalTotal };
}

// Record one FAILED model call (migration 0058). The counterpart to
// recordAiUsage: together they make "the model is broken" distinguishable from
// "nobody used the app today", which is the whole point — before this, a failure
// wrote nothing anywhere and both cases looked like an absent row.
//
// Costs no tokens, so it bumps only `failures`. Best-effort by contract: every
// caller is a `catch` block on a fail-soft path, and accounting must never turn a
// degraded surface into a broken one, so this swallows its own errors exactly as
// AiCallGuard.recordUsage does.
export async function recordAiFailure(db: Database, userId: UserId, now: Date): Promise<void> {
  const day = isoDay(now);
  try {
    await bumpFailure(db, day, userId);
    await bumpFailure(db, day, null);
  } catch {
    // Deliberately silent: the user-facing path has already failed soft.
  }
}

async function bumpFailure(db: Database, day: string, userId: UserId | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO ai_usage_daily (day, user_id, tokens_in, tokens_out, calls, failures)
    VALUES (${day}, ${userId}, 0, 0, 0, 1)
    ON CONFLICT (day, user_id) DO UPDATE SET failures = ai_usage_daily.failures + 1
  `);
}

// Upsert a (day, user_id) counter. The NULLS NOT DISTINCT unique index lets the
// global row (user_id NULL) upsert on the same ON CONFLICT target. Returns the
// row's new token total (tokens_in + tokens_out).
async function bump(
  db: Database,
  day: string,
  userId: UserId | null,
  usage: TokenUsage,
): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    INSERT INTO ai_usage_daily (day, user_id, tokens_in, tokens_out, calls)
    VALUES (${day}, ${userId}, ${usage.inputTokens}, ${usage.outputTokens}, 1)
    ON CONFLICT (day, user_id) DO UPDATE SET
      tokens_in = ai_usage_daily.tokens_in + EXCLUDED.tokens_in,
      tokens_out = ai_usage_daily.tokens_out + EXCLUDED.tokens_out,
      calls = ai_usage_daily.calls + 1
    RETURNING (tokens_in + tokens_out) AS total
  `);
  // postgres-js returns the rows directly; drizzle's execute returns an array-like.
  const row = (rows as unknown as { total: number | string }[])[0];
  return Number(row?.total ?? 0);
}

async function dailyTotal(db: Database, day: string, userId: UserId | null): Promise<number> {
  const cond =
    userId === null
      ? isNull(schema.aiUsageDaily.userId)
      : eq(schema.aiUsageDaily.userId, userId);
  const [row] = await db
    .select({ t: sql<string>`coalesce(${schema.aiUsageDaily.tokensIn} + ${schema.aiUsageDaily.tokensOut}, 0)` })
    .from(schema.aiUsageDaily)
    .where(and(eq(schema.aiUsageDaily.day, day), cond));
  return Number(row?.t ?? '0');
}

// Is the breaker tripped for this user right now? Checks the user budget first,
// then the global budget. Unset budgets are unbounded — with neither set the
// breaker can never trip (the common default).
//
// PLAN-AWARE (the two-pool split, `PLAN_LIMITS.ai*`). The per-account budget is
// scaled by the plan's multiplier, and the deployment-wide budget gates only the
// plans marked as sharing it. Paid capacity is therefore guaranteed: nothing
// another account spends can trip a paying customer.
//
// `plan` defaults to 'free' — the conservative side. A caller that cannot resolve
// an entitlement gets the tighter limits and the shared ceiling, never the
// guaranteed pool, so a lookup failure can never hand out paid capacity.
//
// NOTE what is deliberately NOT changed: what the GLOBAL usage row counts. It
// still accumulates every account's tokens, because `packages/ops` reads that
// same row (`user_id IS NULL`) as the AI subsystem's health time series — the
// only evidence that the model answered today. Making it count free traffic only
// would blind that tile precisely as the paid base grew. The split lives in the
// COMPARISON, not in the accounting.
export async function checkBreaker(
  db: Database,
  config: ApiConfig,
  userId: UserId,
  now: Date,
  plan: BillingPlan = 'free',
): Promise<BreakerState> {
  const { dailyTokenBudget, userDailyTokenBudget } = config.ai;
  if (dailyTokenBudget === undefined && userDailyTokenBudget === undefined) {
    return { tripped: false };
  }
  const limits = planLimits(plan);
  const day = isoDay(now);
  if (userDailyTokenBudget !== undefined) {
    const budget = userDailyTokenBudget * limits.aiTokenBudgetMultiplier;
    if ((await dailyTotal(db, day, userId)) >= budget) {
      return { tripped: true, scope: 'user' };
    }
  }
  if (dailyTokenBudget !== undefined && limits.aiGatedByGlobalBudget) {
    if ((await dailyTotal(db, day, null)) >= dailyTokenBudget) {
      return { tripped: true, scope: 'global' };
    }
  }
  return { tripped: false };
}

// After recording usage, emit ai_breaker_tripped ONCE if this call is what pushed a
// total across its budget (edge-triggered). The per-user trip rides the audit chain
// via the chokepoint (actor='ai'); the global trip is a non-user security_events
// signal. Both are deduped so a busy day records at most one of each. Best-effort:
// a failure here never breaks the request (the breaker still gates via checkBreaker).
// PLAN-AWARE, and it must stay that way (QA 2026-08-12 Bug 1). The edge is
// computed against the SAME numbers `checkBreaker` gates on — the per-account
// budget multiplied by the plan, and the global budget only for plans it gates.
// When this drifted from the gate, a pro account got both halves wrong at once:
// a trip was written at 1x that never happened, and no trip was written at the
// real 3x cut-off where service was actually withdrawn. That event rides the
// tamper-evident chain with actor='ai', so it is an audit-integrity defect, not
// an observability nicety.
//
// `plan` defaults to 'free' for the same reason as checkBreaker: unresolvable
// entitlement takes the tighter side.
export async function maybeEmitBreakerEdge(
  db: Database,
  authority: AiAuthority,
  config: ApiConfig,
  userId: UserId,
  usage: TokenUsage,
  totals: DailyTotals,
  now: Date,
  plan: BillingPlan = 'free',
): Promise<void> {
  const call = usage.inputTokens + usage.outputTokens;
  const day = isoDay(now);
  const { dailyTokenBudget, userDailyTokenBudget } = config.ai;
  const limits = planLimits(plan);

  const userBudget =
    userDailyTokenBudget === undefined
      ? undefined
      : userDailyTokenBudget * limits.aiTokenBudgetMultiplier;
  const userEdge =
    userBudget !== undefined &&
    totals.userTotal >= userBudget &&
    totals.userTotal - call < userBudget;
  if (userEdge) {
    await emitUserBreakerOnce(db, authority, userId, day, now);
  }

  // Only plans the deployment-wide ceiling actually gates can cross it. Emitting
  // for an exempt account would report a withdrawal that never happens to them.
  const globalEdge =
    dailyTokenBudget !== undefined &&
    limits.aiGatedByGlobalBudget &&
    totals.globalTotal >= dailyTokenBudget &&
    totals.globalTotal - call < dailyTokenBudget;
  if (globalEdge) {
    await emitGlobalBreakerOnce(db, day, now);
  }
}

async function emitUserBreakerOnce(
  db: Database,
  authority: AiAuthority,
  userId: UserId,
  day: string,
  now: Date,
): Promise<void> {
  const dayStart = startOfUtcDay(now);
  const existing = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, userId),
        eq(schema.auditLog.eventType, 'ai_breaker_tripped'),
        gt(schema.auditLog.serverTimestamp, dayStart),
      ),
    )
    .orderBy(desc(schema.auditLog.seq))
    .limit(1);
  if (existing[0] !== undefined) return;
  await authority.appendAiAudit(db, userId, 'ai_breaker_tripped', { scope: 'user', day });
}

async function emitGlobalBreakerOnce(db: Database, day: string, now: Date): Promise<void> {
  const dayStart = startOfUtcDay(now);
  const existing = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.eventType, 'ai_breaker_tripped'),
        gt(schema.securityEvents.createdAt, dayStart),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) return;
  await db.insert(schema.securityEvents).values({
    eventType: 'ai_breaker_tripped',
    ipHash: null,
    payload: { scope: 'global', day },
  });
}
