-- Status samples: the series a public availability figure can be computed from
-- (2026-07-30).
--
-- WHY A NEW TABLE. worker_heartbeats is a CURRENT-STATE upsert — one row per
-- worker, overwritten every tick. It answers "is the engine alive right now?"
-- perfectly and "was it alive last Tuesday?" not at all. Nothing else in the
-- schema is a health time series either: engine_state_history and the audit log
-- only get rows when something HAPPENS, so a total outage writes nothing and
-- would read back as a flawless period. Publishing an uptime number computed
-- from those would be exactly the invented figure /status refuses to show.
--
-- THE ONE RULE THIS TABLE EXISTS TO ENFORCE. A missing bucket is NOT healthy.
-- The reader (packages/ops/src/samples.ts) divides observed-ok buckets by the
-- number of buckets the window SHOULD have contained, so a dead worker — which
-- writes nothing at all — scores as unavailable rather than as a gap that
-- silently rounds in our favour. That inverts the usual failure mode of a
-- self-reported status page, and it is the whole reason the composite is stored
-- here rather than recomputed from events after the fact.
--
-- BUCKETED, NOT APPENDED. The primary key is the minute, not a serial, so N
-- workers sampling concurrently converge on one row instead of N — the series
-- stays a single timeline whatever the deployment's worker count. On conflict
-- the WORSE severity wins (see the partial-update guard in samples.ts): two
-- workers disagreeing means at least one observed a problem, and this table
-- never lets an optimistic observer overwrite a pessimistic one.

CREATE TABLE status_samples (
  -- Truncated to the minute. Sole PK: concurrent workers coalesce here.
  bucket_at timestamptz PRIMARY KEY,

  -- The composite over release-critical checks: 'ok' | 'degraded' | 'down' |
  -- 'unknown'. Deliberately text rather than an enum — this mirrors CheckState
  -- in packages/ops, and a new state must not require a migration to record.
  release_path text NOT NULL,

  -- Rank of release_path: 0 ok, 1 unknown, 2 degraded, 3 down. Mirrors ORDER in
  -- packages/ops/src/system-status.ts. Stored rather than derived so the
  -- worst-wins upsert is a plain comparison, and so the reader never has to
  -- encode the ranking in SQL. Note 'unknown' outranks 'ok': not knowing whether
  -- a release could complete is itself a problem, never a healthy sample.
  severity smallint NOT NULL,

  -- Which release-critical check drove a non-ok composite ('worker', 'database',
  -- 'outer_layer_kek', …), or NULL when the composite was ok. A check ID from a
  -- fixed set — never an error string, which is how operational detail would
  -- leak into a table read by a PUBLIC endpoint.
  worst_check text,

  -- Wall clock of the write, for debugging clock skew against bucket_at. Never
  -- published.
  sampled_at timestamptz NOT NULL DEFAULT now()
);

-- The reader always scans a trailing window and takes min(bucket_at) to find how
-- far back the evidence actually goes.
CREATE INDEX status_samples_bucket ON status_samples (bucket_at DESC);
