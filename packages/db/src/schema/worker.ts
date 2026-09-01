import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Worker liveness (migration 0052). The worker is the sole release driver, so a
// silently dead worker is a total, invisible product failure: nothing releases,
// nothing escalates, and every other health probe stays green because the API
// and database are fine. Recording each completed tick here lets the API answer
// "is the engine alive?" on GET /health/worker, so ordinary uptime monitoring on
// the public origin covers the worker too — rather than depending on an optional
// outbound HEARTBEAT_URL push that a deployment may simply never have set.
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    workerId: text('worker_id').primaryKey(),
    lastTickAt: timestamp('last_tick_at', { withTimezone: true }).notNull(),
    lastTickMs: integer('last_tick_ms').notNull().default(0),
    // A worker that ticks but errors every batch is alive-but-broken, which is a
    // different alert from dead. Surfaced so the probe can say which.
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    // API/worker version skew is a classic confusing-incident source (a deploy
    // that half-succeeded). The API knows its own build; this is how it learns
    // the worker's. Migration 0054.
    workerVersion: text('worker_version'),
    // Last completed audit-chain sweep. NULL = none since this worker started,
    // which a dashboard must render as "unknown", never as "healthy".
    lastAuditVerifyAt: timestamp('last_audit_verify_at', { withTimezone: true }),
    lastAuditVerifyChecked: integer('last_audit_verify_checked'),
    lastAuditVerifyBroken: integer('last_audit_verify_broken'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lastTick: index('worker_heartbeats_last_tick').on(t.lastTickAt),
  }),
);

export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect;
