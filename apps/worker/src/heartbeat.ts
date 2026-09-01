import { schema, type Database } from '@truecairn/db';
import { sql } from 'drizzle-orm';

// DB-backed worker liveness (migration 0052). See the migration for WHY; the
// short version is that the worker is the sole release driver, a dead worker is
// invisible to every other probe, and the pre-existing detector (an outbound
// HEARTBEAT_URL push) is optional and therefore absent in any deployment that
// never configured one.
//
// Written AFTER a tick completes, so it records work actually done rather than
// a process that merely started. Best-effort by design: a failure to record
// liveness must never take down the loop whose liveness it records.

export interface HeartbeatInput {
  db: Database;
  workerId: string;
  now: Date;
  tickMs: number;
  // Number of batches that threw this tick. A worker that ticks but errors on
  // every batch is alive-but-broken — a different alert from dead.
  errors: number;
  version: string;
  // Last completed audit-chain sweep, when one has completed since boot. Carried
  // on the heartbeat so the ops dashboard can report chain integrity as STATUS
  // rather than making an operator grep log history for the alert.
  auditVerify?: { at: Date; checked: number; broken: number };
}

export async function recordHeartbeat(input: HeartbeatInput): Promise<void> {
  const { db, workerId, now, tickMs, errors } = input;
  await db
    .insert(schema.workerHeartbeats)
    .values({
      workerId,
      lastTickAt: now,
      lastTickMs: tickMs,
      consecutiveErrors: errors,
      workerVersion: input.version,
      ...(input.auditVerify
        ? {
            lastAuditVerifyAt: input.auditVerify.at,
            lastAuditVerifyChecked: input.auditVerify.checked,
            lastAuditVerifyBroken: input.auditVerify.broken,
          }
        : {}),
      startedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.workerId,
      set: {
        lastTickAt: now,
        lastTickMs: tickMs,
        // Accumulate across ticks so a persistently failing worker is
        // distinguishable from one that had a single bad batch; a clean tick
        // resets it to zero.
        consecutiveErrors:
          errors === 0
            ? 0
            : sql`${schema.workerHeartbeats.consecutiveErrors} + ${errors}`,
        workerVersion: input.version,
        // Only overwrite the sweep result when this tick actually ran one —
        // otherwise every heartbeat would blank it back to "unknown".
        ...(input.auditVerify
          ? {
              lastAuditVerifyAt: input.auditVerify.at,
              lastAuditVerifyChecked: input.auditVerify.checked,
              lastAuditVerifyBroken: input.auditVerify.broken,
            }
          : {}),
        updatedAt: now,
      },
    });
}
