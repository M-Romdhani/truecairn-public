-- 0013_notification_channels.sql
-- destination_hash uses a per-user salt (not a global one) so the same email
-- across users hashes differently. Prevents a server-wide rainbow-friendly
-- index of recipient addresses while still giving us per-user dedup.

CREATE TABLE notification_channels (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_type         notification_channel_type NOT NULL,
  destination          text NOT NULL,
  destination_hash     bytea NOT NULL,
  verified             boolean NOT NULL DEFAULT false,
  verified_at          timestamptz,
  health               notification_channel_health NOT NULL DEFAULT 'healthy',
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  removed_at           timestamptz
);

CREATE INDEX notification_channels_user
  ON notification_channels (user_id)
  WHERE removed_at IS NULL;

CREATE UNIQUE INDEX notification_channels_user_dest_uniq
  ON notification_channels (user_id, channel_type, destination_hash)
  WHERE removed_at IS NULL;
