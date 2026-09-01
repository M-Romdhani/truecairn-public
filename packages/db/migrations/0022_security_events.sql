-- 0022_security_events.sql
-- Non-user-scoped security / ops signals. DISTINCT from audit_log, which is a
-- per-USER hash-chained tamper-evident log (user_id NOT NULL, seq chained per
-- user, verifiable with the user's own key). An IP-level abuse signal has no
-- user — a sustained prober mostly targets unknown emails — so it cannot live in
-- audit_log without a fake user, and would not be user tamper-evidence anyway.
-- This is the queryable ops record used to add infra-layer IP blocks.

CREATE TABLE security_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  ip_hash    bytea,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX security_events_type_time ON security_events (event_type, created_at);
