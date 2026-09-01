import { schema, type Database } from '@truecairn/db';
import { eligibleChannels } from '@truecairn/notifications';
import type { NotificationPurpose, UserId } from '@truecairn/shared';
import { and, eq, inArray } from 'drizzle-orm';

// The Continuity Verification cadence sweep (docs/26 §3.2, CV-1). While an
// owner sits in check_in_pending / escalation_pending, this fans repeated
// verification waves out to every matrix-enabled VERIFIED channel — replacing
// nothing: the engine transition still fires its one-shot primary-channel
// notice on entry (wave 0); this sweep only ADDS waves after it. With
// CV_FANOUT_ENABLED off the sweep never runs and behaviour is exactly pre-CV.
//
// Correctness model, same as every processor here:
//   - FOR UPDATE SKIP LOCKED on the engine rows: two workers cannot process
//     the same owner concurrently.
//   - The partial unique index on (user, purpose, channel, cv_episode_at,
//     cv_wave) is the idempotency backstop: even a racing insert cannot
//     double-send a wave (onConflictDoNothing).
//   - cv_episode_at = the engine state_entered_at, so wave numbering restarts
//     safely when a later episode re-enters the same state.
//   - Bodies come from templates.ts via the existing purposes — the blitz
//     reuses the same bare check_in_request / escalation_request templates.
//
// Evidence, never authentication (docs/26 D4): nothing here reads replies or
// advances the engine — the deliveries only feed the Continuity Report.

export interface CvCadenceConfig {
  // Gap between waves on one channel. Wave 1 fires this long after the state
  // was entered (the entry one-shot covers time zero), wave N+1 this long
  // after wave N.
  attemptSpacingMs: number;
  // Sweep-issued waves per channel per episode (wave 0 not counted).
  maxAttemptsPerChannel: number;
}

export interface CvCadenceContext {
  db: Database;
  config: CvCadenceConfig;
  now: Date;
}

const CV_STATES = ['check_in_pending', 'escalation_pending'] as const;

export async function runCvCadence(
  ctx: CvCadenceContext,
  limit: number,
): Promise<{ owners: number; enqueued: number }> {
  let owners = 0;
  let enqueued = 0;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const rows = await tx
      .select({
        userId: schema.engineStates.userId,
        state: schema.engineStates.state,
        stateEnteredAt: schema.engineStates.stateEnteredAt,
      })
      .from(schema.engineStates)
      .where(inArray(schema.engineStates.state, [...CV_STATES]))
      .for('update', { skipLocked: true })
      .limit(limit);

    for (const row of rows) {
      owners += 1;
      // Per-owner error isolation: one bad row must not stall the batch.
      try {
        enqueued += await sweepOwner(tx, row, ctx);
      } catch {
        // Swallowed by design — the next tick retries; the unique index makes
        // a partially-applied owner safe to re-sweep.
      }
    }
  });
  return { owners, enqueued };
}

async function sweepOwner(
  tx: Database,
  row: { userId: string; state: string; stateEnteredAt: Date },
  ctx: CvCadenceContext,
): Promise<number> {
  const purpose: NotificationPurpose =
    row.state === 'check_in_pending' ? 'check_in_request' : 'escalation_request';
  const channels = await eligibleChannels(tx, row.userId as UserId, 'owner_verification');
  if (channels.length === 0) return 0;

  // Existing sweep waves for this episode, per channel.
  const existing = await tx
    .select({
      channelId: schema.notificationDeliveries.channelId,
      cvWave: schema.notificationDeliveries.cvWave,
      createdAt: schema.notificationDeliveries.createdAt,
    })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.userId, row.userId),
        eq(schema.notificationDeliveries.purpose, purpose),
        eq(schema.notificationDeliveries.cvEpisodeAt, row.stateEnteredAt),
      ),
    );

  let enqueued = 0;
  for (const ch of channels) {
    const waves = existing.filter((e) => e.channelId === ch.id);
    if (waves.length >= ctx.config.maxAttemptsPerChannel) continue;
    const lastAt = waves.reduce<Date | null>(
      (max, w) => (max === null || w.createdAt > max ? w.createdAt : max),
      null,
    );
    const dueAt = new Date(
      (lastAt ?? row.stateEnteredAt).getTime() + ctx.config.attemptSpacingMs,
    );
    if (ctx.now < dueAt) continue;
    const nextWave = waves.reduce((max, w) => Math.max(max, w.cvWave ?? 0), 0) + 1;
    const inserted = await tx
      .insert(schema.notificationDeliveries)
      .values({
        channelId: ch.id,
        userId: row.userId,
        purpose,
        status: 'queued',
        nextAttemptAt: ctx.now,
        // Stamped with the sweep's clock (not the DB default): the spacing of
        // the NEXT wave is measured from this value.
        createdAt: ctx.now,
        payloadSummary: `continuity verification wave ${nextWave}`,
        cvEpisodeAt: row.stateEnteredAt,
        cvWave: nextWave,
      })
      .onConflictDoNothing()
      .returning({ id: schema.notificationDeliveries.id });
    if (inserted.length > 0) enqueued += 1;
  }
  return enqueued;
}
