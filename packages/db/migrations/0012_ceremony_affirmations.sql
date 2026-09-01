-- 0012_ceremony_affirmations.sql
-- Per-contact affirmations within a ceremony. Tentative shares are re-wrapped
-- to the ceremony's ephemeral pubkey; commitment after the 48h revocation window.

CREATE TABLE ceremony_affirmations (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ceremony_id                   uuid NOT NULL REFERENCES release_ceremonies (id) ON DELETE CASCADE,
  contact_id                    uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  share_id                      uuid NOT NULL REFERENCES release_shares (id),
  status                        affirmation_status NOT NULL DEFAULT 'pending',
  affirmed_at                   timestamptz,
  revocation_window_expires_at  timestamptz,
  committed_at                  timestamptz,
  revoked_at                    timestamptz,
  tentative_share_ciphertext    bytea,
  tentative_share_nonce         bytea,
  contact_affirmation_signature bytea,
  audit_id_affirmed             uuid REFERENCES audit_log (id),
  audit_id_terminal             uuid REFERENCES audit_log (id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ceremony_id, contact_id)
);

CREATE INDEX ceremony_affirmations_window
  ON ceremony_affirmations (revocation_window_expires_at)
  WHERE status = 'tentative';
