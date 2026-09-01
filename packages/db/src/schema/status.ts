import { index, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

// Health time series (migration 0055). See the migration for WHY; the short
// version is that worker_heartbeats is a current-state upsert and every other
// candidate table only gets rows when something goes WRONG — so a total outage
// writes nothing and reads back as a perfect period. A public availability
// figure needs positive evidence of health, sampled on a clock.
//
// One row per minute, whatever the worker count: the bucket is the primary key
// and the worse severity wins a collision (packages/ops/src/samples.ts).
export const statusSamples = pgTable(
  'status_samples',
  {
    bucketAt: timestamp('bucket_at', { withTimezone: true }).primaryKey(),
    releasePath: text('release_path').notNull(),
    // 0 ok, 1 unknown, 2 degraded, 3 down — mirrors ORDER in system-status.ts.
    severity: smallint('severity').notNull(),
    // A check ID, never an error string: this table is read by a PUBLIC route.
    worstCheck: text('worst_check'),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bucket: index('status_samples_bucket').on(t.bucketAt),
  }),
);

export type StatusSample = typeof statusSamples.$inferSelect;
