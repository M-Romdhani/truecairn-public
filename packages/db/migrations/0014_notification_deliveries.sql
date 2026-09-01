-- 0014_notification_deliveries.sql

CREATE TABLE notification_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id          uuid NOT NULL REFERENCES notification_channels (id) ON DELETE RESTRICT,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  purpose             notification_purpose NOT NULL,
  related_entity_type text,
  related_entity_id   uuid,
  status              delivery_status NOT NULL DEFAULT 'queued',
  attempt_count       integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  confirmed_at        timestamptz,
  bounced_at          timestamptz,
  last_error          text,
  payload_summary     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_deliveries_due
  ON notification_deliveries (next_attempt_at)
  WHERE status IN ('queued', 'sending');

CREATE INDEX notification_deliveries_user
  ON notification_deliveries (user_id, created_at DESC);
