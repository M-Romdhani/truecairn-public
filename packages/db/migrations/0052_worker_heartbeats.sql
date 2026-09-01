-- Worker liveness, recorded in the database (2026-07-25).
--
-- WHY. The worker is the sole release driver (CLAUDE.md invariant 7). A worker
-- that stops ticking stops every release, every check-in escalation and every
-- ceremony — silently, because nothing else in the system notices. That is this
-- product's one unforgivable failure mode and until now the only detector was
-- HEARTBEAT_URL: an OUTBOUND push to an external service, which is optional, and
-- which therefore does not exist at all in a deployment that never configured it.
--
-- Recording the tick in the database instead means the existing uptime monitor
-- that already watches the public origin can also answer "is the engine alive?"
-- via GET /health/worker, with no extra service to configure and no way to
-- silently have no watchdog. The outbound push remains as the faster, dedicated
-- signal; this is the floor beneath it.
--
-- Single row per worker instance (workers can be scaled horizontally); the API
-- reads the freshest one, since one live worker is enough to drive releases.

CREATE TABLE worker_heartbeats (
  worker_id         text PRIMARY KEY,
  last_tick_at      timestamptz NOT NULL,
  -- Observability for the readiness endpoint: how long the tick took and
  -- whether it completed cleanly. A worker that ticks but errors every batch is
  -- alive-but-broken, which reads differently from dead.
  last_tick_ms      integer NOT NULL DEFAULT 0,
  consecutive_errors integer NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The API's staleness probe reads "the most recent tick across all workers".
CREATE INDEX worker_heartbeats_last_tick ON worker_heartbeats (last_tick_at DESC);
