-- 0010_sensitive_actions.sql
-- The 7-day delay queue. All channels get a notice on requested_at;
-- re-notified at effective_at - 24h. Worker scans by effective_at.

CREATE TABLE sensitive_actions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action_type             sensitive_action_type NOT NULL,
  status                  sensitive_action_status NOT NULL DEFAULT 'pending',
  action_payload          jsonb NOT NULL,
  requested_by_session_id uuid,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  effective_at            timestamptz NOT NULL,
  applied_at              timestamptz,
  cancelled_at            timestamptz,
  cancelled_via           text,
  cancelled_reason        text,
  audit_id_request        uuid REFERENCES audit_log (id),
  audit_id_terminal       uuid REFERENCES audit_log (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sensitive_actions_due
  ON sensitive_actions (effective_at)
  WHERE status = 'pending';

CREATE INDEX sensitive_actions_user_status
  ON sensitive_actions (user_id, status);
