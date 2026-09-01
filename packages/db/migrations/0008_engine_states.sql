-- 0008_engine_states.sql
-- Current engine state per user (1:1). Worker polls next_action_at.
-- Defaults match docs/02-state-machine.md §"Numbers committed in this document".
-- current_ceremony_id FK is added in 0011 once release_ceremonies exists.

CREATE TABLE engine_states (
  user_id                    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  state                      engine_state NOT NULL DEFAULT 'pre_active',
  previous_state             engine_state,
  state_entered_at           timestamptz NOT NULL DEFAULT now(),
  state_expires_at           timestamptz,
  next_action_at             timestamptz,
  snooze_until               timestamptz,
  current_ceremony_id        uuid,
  last_check_in_at           timestamptz,
  next_scheduled_check_in_at timestamptz,
  inactivity_threshold_days  integer NOT NULL DEFAULT 30,
  check_in_timeout_days      integer NOT NULL DEFAULT 7,
  escalation_cooldown_days   integer NOT NULL DEFAULT 14,
  s1_to_s2_timer_days        integer NOT NULL DEFAULT 7,
  s2_to_s3_timer_days        integer NOT NULL DEFAULT 14,
  returning_grace_days       integer NOT NULL DEFAULT 7,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engine_states_next_action
  ON engine_states (next_action_at)
  WHERE next_action_at IS NOT NULL;
