-- Ops telemetry on the worker heartbeat (2026-07-25).
--
-- The audit-chain sweep already runs hourly and logs worker.audit_chain_broken at
-- ERROR, which is the right ALERT but a poor STATUS: a dashboard cannot answer
-- "is the audit chain currently verifying?" by reading log history. Persist the
-- last sweep result next to the liveness row so /v1/ops/system can show it.
--
-- The worker version travels the same way. The API knows its own version from its
-- build; it has no other way to learn the worker's, and API/worker version skew
-- is exactly the kind of thing that produces a confusing incident (a deploy that
-- half-succeeded, one service restarted and the other not).

ALTER TABLE worker_heartbeats
  ADD COLUMN worker_version text,
  -- Last completed audit-chain sweep: when, how many chains it walked, and how
  -- many failed to verify. NULL = no sweep has completed since this worker
  -- started, which the dashboard must render as "unknown", never as "healthy".
  ADD COLUMN last_audit_verify_at timestamptz,
  ADD COLUMN last_audit_verify_checked integer,
  ADD COLUMN last_audit_verify_broken integer;
