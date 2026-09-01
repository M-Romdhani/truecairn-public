-- 0015_device_registrations.sql
-- The device-binding private key never leaves the device; we store only pubkeys
-- and a salted hash of last-seen IP (never the raw IP).

CREATE TABLE device_registrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label                 text,
  user_agent            text,
  device_binding_pubkey bytea NOT NULL,
  last_ip_hash          bytea,
  last_seen_at          timestamptz,
  registered_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoked_reason        text
);

CREATE INDEX device_registrations_user
  ON device_registrations (user_id)
  WHERE revoked_at IS NULL;
