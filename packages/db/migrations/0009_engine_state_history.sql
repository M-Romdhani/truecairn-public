-- 0009_engine_state_history.sql
-- Structured transition log. Separate from audit_log so the engine can do
-- fast indexed queries without JSONB introspection. Each row links back to
-- its corresponding immutable audit_log entry.

CREATE TABLE engine_state_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  from_state        engine_state,
  to_state          engine_state NOT NULL,
  reason            text NOT NULL,
  related_audit_id  uuid REFERENCES audit_log (id),
  occurred_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engine_state_history_user_time
  ON engine_state_history (user_id, occurred_at);
