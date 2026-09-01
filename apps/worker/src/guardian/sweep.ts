import type { AiAuthority } from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { log } from '../log.js';
import type { GuardianConfig } from './config.js';
import {
  detectAffirmationVelocity,
  detectFailedAuthSpike,
  type DetectorId,
  type DetectorVerdict,
} from './detectors.js';
import { gatherFeatures } from './features.js';

// ── The Guardian sweep (plan docs/25 §7) ──────────────────────────────────────
//
// A worker sweep that watches for a release proceeding when it shouldn't and can
// ONLY slow it down. For each user whose engine is in a release-relevant state, it
// runs the deterministic detectors and — if one fires (respecting hysteresis) —
// emits the ONE fail-closed signal `review_required` THROUGH THE CHOKEPOINT (never
// importing the engine directly; the chokepoint holds the injected EngineReviewPort).
// The release ladder can be PAUSED by statistics, never advanced.
//
// Concurrency: each user is processed in its own transaction with FOR UPDATE SKIP
// LOCKED on the engine row, and a fired signal moves the user OUT of the
// release-relevant set (into review_required) — so two workers never double-signal.

// dispute_raised pauses these; full_release is a no-op and review_required is
// already paused, so both are excluded.
const RELEASE_RELEVANT = [
  'escalation_pending',
  'release_review',
  'limited_release',
  'staged_release',
] as const;

// Deterministic, metadata-only owner notices (the fail-soft baseline; an optional
// LLM rewrite for clarity is a documented follow-on and never changes the decision).
const NOTICE: Record<DetectorId, string> = {
  affirmation_velocity:
    'A release on your account was paused for review: unusually fast affirmations. Confirm you are safe, or dismiss.',
  failed_auth_during_release:
    'A release on your account was paused for review: repeated failed sign-in attempts. Confirm you are safe, or dismiss.',
};

export interface GuardianSweepConfig {
  aiEnabled: boolean;
  guardianEnabled: boolean;
  thresholds: GuardianConfig;
}

export interface GuardianContext {
  db: Database;
  // An AiAuthority wired with the EngineReviewPort — the ONLY door to the engine.
  authority: AiAuthority;
  config: GuardianSweepConfig;
  now: Date;
}

export async function runGuardianSweep(
  ctx: GuardianContext,
  batchSize: number,
): Promise<{ signalsEmitted: number }> {
  if (!ctx.config.aiEnabled || !ctx.config.guardianEnabled) return { signalsEmitted: 0 };

  const candidates = await ctx.db
    .select({ userId: schema.engineStates.userId })
    .from(schema.engineStates)
    .where(inArray(schema.engineStates.state, [...RELEASE_RELEVANT]))
    .limit(batchSize);

  let signalsEmitted = 0;
  for (const c of candidates) {
    try {
      if (await processUser(ctx, c.userId as UserId)) signalsEmitted += 1;
    } catch (err) {
      // Per-user isolation — one user's failure never stalls the batch.
      log.warn('worker.guardian_user_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { signalsEmitted };
}

async function processUser(ctx: GuardianContext, userId: UserId): Promise<boolean> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    // Re-lock the engine row; skip if another worker holds it or it left the release
    // window between the candidate query and now.
    const locked = await tx
      .select({ state: schema.engineStates.state })
      .from(schema.engineStates)
      .where(
        and(
          eq(schema.engineStates.userId, userId),
          inArray(schema.engineStates.state, [...RELEASE_RELEVANT]),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(1);
    if (locked[0] === undefined) return false;

    const features = await gatherFeatures(tx, userId, ctx.now);
    const fired = [
      detectAffirmationVelocity(features.affirmationCommitMs, ctx.config.thresholds),
      detectFailedAuthSpike(features.failedAuthMs, ctx.config.thresholds),
    ]
      .filter((v) => v.fired)
      .sort((a, b) => b.severity - a.severity);
    const top = fired[0];
    if (top === undefined) return false;

    // Hysteresis: a severity-2 (ceremony-time) detector bypasses the cooldown; a
    // severity-1 detector respects it (avoid flag-spam eroding trust).
    if (top.severity < 2 && (await inCooldown(tx, userId, ctx.now, ctx.config.thresholds.cooldownDays))) {
      return false;
    }

    // The ONE allowed engine signal, through the chokepoint: writes
    // ai_review_signal_emitted (actor='ai') AND applies dispute_raised → review_required,
    // atomically in this transaction.
    const result = await ctx.authority.emitEngineSignal(tx, userId, 'review_required', {
      detectorId: top.detectorId,
      payload: { severity: top.severity, ...top.features },
      now: ctx.now,
    });
    if (!result.changed) return false; // already terminal — nothing to pause

    await notifyOwner(tx, userId, top, ctx.now);
    return true;
  });
}

async function inCooldown(
  db: Database,
  userId: UserId,
  now: Date,
  cooldownDays: number,
): Promise<boolean> {
  const since = new Date(now.getTime() - cooldownDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, userId),
        eq(schema.auditLog.eventType, 'ai_review_signal_emitted'),
        gt(schema.auditLog.serverTimestamp, since),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

async function notifyOwner(
  db: Database,
  userId: UserId,
  verdict: DetectorVerdict,
  now: Date,
): Promise<void> {
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
      purpose: 'security_alert' as const,
      status: 'queued' as const,
      nextAttemptAt: now,
      payloadSummary: NOTICE[verdict.detectorId],
    })),
  );
}
