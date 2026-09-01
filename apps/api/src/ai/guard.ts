import { AiAuthority } from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import type { BillingPlan, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { getEntitlement } from '../billing/entitlement.js';
import { reserveAiCall, type AiRateCeilings, type AiRateScope } from '../auth/rate-limit.js';
import { clientIp } from '../auth/rate-limit-route.js';
import type { ApiConfig } from '../config.js';
import { hashIp } from '../auth/rate-limit.js';
import { tooManyRequests } from '../errors.js';
import {
  checkBreaker,
  maybeEmitBreakerEdge,
  recordAiFailure,
  recordAiUsage,
  type TokenUsage,
} from './breaker.js';

// ── The AI call guard (plan docs/25 §4 tasks 0.1–0.3) ─────────────────────────
//
// The single pre/post gate every server-side model call passes through, layering
// the Phase 0 guardrails IN ORDER:
//   1. opt-out  — the user turned AI off: no prompt is ever built (fail-soft off).
//   2. breaker  — daily token budget exceeded: fail-soft 'unavailable'.
//   3. rate     — per-user + per-IP fixed-window ceiling: over ⇒ 429 (throws).
// The kill switch (AI_ENABLED) is handled one level up by nulling the generator.
//
// The rate slot is RESERVED, not checked-then-recorded (2026-08-07 audit): the
// accounting row is inserted and counted in one transaction, so concurrent
// callers count each other. It runs last of the three because it is the only one
// that writes — a call rejected by opt-out or the breaker leaves no row behind.
//
// evaluate()/precheck() therefore both reserve; the caller invokes the model and
// calls recordUsage() with the token counts so the breaker sees the spend.

export type AiGuardDecision = { proceed: true } | { proceed: false; reason: 'disabled' | 'unavailable' };

// The richer internal decision. 'rate_limited' is a 429 for throwing callers
// (assist) but just "skip the LLM, keep the deterministic result" for soft callers
// (readiness). 'disabled' = opted out / off; 'unavailable' = breaker tripped.
export type AiEvaluation =
  | { proceed: true }
  | { proceed: false; reason: 'disabled' | 'unavailable' | 'rate_limited'; retryAfterSeconds?: number };

// Resolve the peppered client-IP hash for a request, or null when unavailable.
export function requestIpHash(request: FastifyRequest, config: ApiConfig): Uint8Array | null {
  try {
    return hashIp(clientIp(request), config.ipHashPepper);
  } catch {
    return null;
  }
}

const CEILINGS: Record<AiRateScope, (c: ApiConfig) => AiRateCeilings> = {
  ai_assist: (c) => ({
    perUser: c.ai.rateLimits.assistPerUser,
    perIp: c.ai.rateLimits.assistPerIp,
    windowMs: c.ai.rateLimits.windowMs,
  }),
  ai_briefing: (c) => ({
    perUser: c.ai.rateLimits.briefingPerUser,
    perIp: c.ai.rateLimits.briefingPerIp,
    windowMs: c.ai.rateLimits.windowMs,
  }),
  ai_guardian_explain: (c) => ({
    perUser: c.ai.rateLimits.guardianExplainPerUser,
    perIp: c.ai.rateLimits.guardianExplainPerIp,
    windowMs: c.ai.rateLimits.windowMs,
  }),
  ai_narration: (c) => ({
    perUser: c.ai.rateLimits.narrationPerUser,
    perIp: c.ai.rateLimits.narrationPerIp,
    windowMs: c.ai.rateLimits.windowMs,
  }),
};

export class AiCallGuard {
  private readonly authority: AiAuthority;

  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    // The audit port (app.audit) so a per-user breaker edge rides the chain with
    // actor='ai'. Null in DB-less contexts; the breaker edge is then skipped.
    audit: ConstructorParameters<typeof AiAuthority>[0]['audit'] | null,
  ) {
    // A minimal chokepoint: only the AI-audit surface is needed here. If no audit
    // port is available, a no-op stand-in keeps recordUsage total-only.
    this.authority = new AiAuthority({ audit: audit ?? noopAudit });
  }

  // The user's billing plan, for the AI budget split. Fails CLOSED to 'free':
  // entitlement is derived from a subscription row, and if that read throws we
  // must not treat the account as paid — the tighter budget and the shared
  // ceiling are the safe answer, and the cost of being wrong is one degraded AI
  // call, never a wrongly-granted guarantee.
  private async planOf(userId: UserId, now: Date): Promise<BillingPlan> {
    try {
      return (await getEntitlement(this.db, userId, now)).plan;
    } catch {
      return 'free';
    }
  }

  // Is this user opted out of AI? Reads the durable per-user flag.
  private async optedOut(userId: UserId): Promise<boolean> {
    const [u] = await this.db
      .select({ optOut: schema.users.aiOptOut })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return u?.optOut === true;
  }

  // Non-throwing check: opt-out → breaker → RESERVE a rate slot. Used by soft
  // callers (readiness, narration) that keep their deterministic result when the
  // LLM is unavailable for ANY reason, including rate limiting.
  //
  // The rate slot is reserved rather than merely checked (2026-08-07 audit,
  // finding 5): this used to check the ceiling and leave the caller to record the
  // call afterwards, so N concurrent requests all read the same sub-ceiling count
  // and all proceeded. Cheaper checks run first so a rejected call never writes an
  // accounting row: opt-out and the breaker cost nothing to undo, the reservation
  // costs a transaction.
  //
  // Every caller reserves immediately before spending the model call — no path
  // evaluates and then decides not to call (a null generator is checked earlier),
  // so a reservation is never orphaned.
  async evaluate(
    scope: AiRateScope,
    userId: UserId,
    ipHash: Uint8Array | null,
    now: Date,
  ): Promise<AiEvaluation> {
    if (await this.optedOut(userId)) return { proceed: false, reason: 'disabled' };
    // The plan decides both halves of the budget: the per-account multiplier and
    // whether the deployment-wide ceiling applies at all (the two-pool split).
    // A failed lookup resolves to 'free' — the tighter side — so an entitlement
    // outage can never hand out guaranteed capacity.
    const plan = await this.planOf(userId, now);
    const breaker = await checkBreaker(this.db, this.config, userId, now, plan);
    if (breaker.tripped) return { proceed: false, reason: 'unavailable' };
    const block = await reserveAiCall(this.db, scope, userId, ipHash, CEILINGS[scope](this.config), now);
    if (block !== null) {
      return { proceed: false, reason: 'rate_limited', retryAfterSeconds: block.retryAfterSeconds };
    }
    return { proceed: true };
  }

  // Throwing check for callers whose whole purpose is the model answer (assist):
  // opt-out/breaker fail soft (disabled/unavailable), but a rate-limit is a real
  // 429 (with Retry-After) — NOT an account lock. On proceed it records the call.
  async precheck(
    scope: AiRateScope,
    userId: UserId,
    ipHash: Uint8Array | null,
    reply: { header(name: string, value: string): unknown },
    now: Date,
  ): Promise<AiGuardDecision> {
    const e = await this.evaluate(scope, userId, ipHash, now);
    if (!e.proceed) {
      if (e.reason === 'rate_limited') {
        const retry = e.retryAfterSeconds ?? 60;
        reply.header('retry-after', String(retry));
        throw tooManyRequests(retry, 'AI rate limit reached; try again later');
      }
      return { proceed: false, reason: e.reason };
    }
    // No separate record step: evaluate() has already reserved the slot.
    return { proceed: true };
  }

  // Post-call, failure side: count a model call that threw. The counterpart to
  // recordUsage, and the only thing that makes a dead model observable — every AI
  // call site is fail-soft, so without this a provider outage degrades four
  // surfaces to their templates with nothing recorded anywhere but stderr.
  // Best-effort by contract (recordAiFailure swallows its own errors).
  async recordFailure(userId: UserId, now: Date): Promise<void> {
    await recordAiFailure(this.db, userId, now);
  }

  // Post-call: fold token usage into the daily counters and emit an edge-triggered
  // ai_breaker_tripped if this call crossed a budget. Best-effort; never throws
  // into the caller's fail-soft path.
  async recordUsage(userId: UserId, usage: TokenUsage, now: Date): Promise<void> {
    try {
      const totals = await recordAiUsage(this.db, userId, usage, now);
      // Resolve the plan HERE too. recordUsage is a separate entry point from
      // evaluate(), so it cannot inherit the plan that gating used — and an edge
      // computed against a different budget than the gate is exactly the defect
      // QA found (a trip logged at 1x that never happened, silence at the real 3x).
      const plan = await this.planOf(userId, now);
      await maybeEmitBreakerEdge(this.db, this.authority, this.config, userId, usage, totals, now, plan);
    } catch {
      // Accounting must not break the user-facing AI response.
    }
  }
}

// A no-op audit port for DB-less / audit-less contexts. The breaker edge simply
// isn't recorded; the breaker itself still gates via checkBreaker.
const noopAudit: ConstructorParameters<typeof AiAuthority>[0]['audit'] = {
  async append() {
    return { id: '', seq: 0n, entryHash: new Uint8Array() };
  },
};
