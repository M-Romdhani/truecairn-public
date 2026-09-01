-- 0016_server_signing_keys.sql
-- Registry of Ed25519 keys used by the server to sign audit_log entries.
-- The PRIVATE key never lives in this table; it is loaded from
-- SERVER_AUDIT_SIGNING_KEY (Phase 1 env) and will move to an HSM/KMS in
-- Phase 5. This table records the public key + a stable key_id so a
-- verifier reading audit_log knows which key to use per entry.

CREATE TABLE server_signing_keys (
  key_id      text PRIMARY KEY,
  public_key  bytea NOT NULL,
  algorithm   text NOT NULL DEFAULT 'ed25519',
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);

CREATE INDEX server_signing_keys_active
  ON server_signing_keys (created_at)
  WHERE retired_at IS NULL;
