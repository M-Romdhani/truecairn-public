-- 0011_release_ceremonies.sql
-- The three-phase release protocol. Adds the deferred FK from engine_states.

CREATE TABLE release_ceremonies (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  tier                       vault_tier NOT NULL,
  status                     ceremony_status NOT NULL DEFAULT 'initiated',
  initiated_at               timestamptz NOT NULL DEFAULT now(),
  sync_window_expires_at     timestamptz NOT NULL,
  outer_key_released_at      timestamptz,
  reconstruction_started_at  timestamptz,
  released_at                timestamptz,
  cancelled_at               timestamptz,
  cancellation_reason        text,
  failure_reason             text,
  ceremony_ephemeral_pubkey  bytea NOT NULL,
  audit_id_initiated         uuid REFERENCES audit_log (id),
  audit_id_terminal          uuid REFERENCES audit_log (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX release_ceremonies_active
  ON release_ceremonies (user_id, status)
  WHERE released_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE engine_states
  ADD CONSTRAINT engine_states_current_ceremony_fk
  FOREIGN KEY (current_ceremony_id) REFERENCES release_ceremonies (id);

ALTER TABLE outer_layer_keys
  ADD CONSTRAINT outer_layer_keys_released_to_ceremony_fk
  FOREIGN KEY (released_to_ceremony_id) REFERENCES release_ceremonies (id);
