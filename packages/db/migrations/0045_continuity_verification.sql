-- 0045_continuity_verification.sql
-- Continuity Verification CV-0 foundations (docs/26). Three additive pieces:
--
-- 1. channel_preferences — the owner-defined channel matrix: which enrolled
--    channel participates in which purpose class. ABSENT ROW = ENABLED (today's
--    behaviour is the default; a row exists only to opt a channel out of a
--    class). This is also the org-compliance switch: disabling a class strips
--    that channel from it without removing the channel.
-- 2. continuity_reports — the FROZEN evidence snapshot attached to a release
--    ceremony at creation (payload jsonb, hash anchored in the audit chain by
--    the ceremony bridge). One per ceremony; never recomputed after creation.
-- 3. Cadence bookkeeping on notification_deliveries — cv_episode_at (the
--    engine state_entered_at of the episode being verified) + cv_wave. The
--    partial unique index is the fanout's idempotency guarantee: two workers
--    racing the same wave for the same channel cannot double-send, and wave
--    numbering restarts safely across episodes because the episode timestamp
--    is part of the key.

CREATE TYPE cv_purpose_class AS ENUM (
  'owner_verification',
  'owner_notices',
  'contact_notices'
);

CREATE TABLE channel_preferences (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  purpose_class cv_purpose_class NOT NULL,
  enabled       boolean NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, purpose_class)
);
CREATE INDEX channel_preferences_user ON channel_preferences (user_id);

-- payload is TEXT, not jsonb, deliberately: the audit chain anchors
-- sha256(payload) over these EXACT bytes, and jsonb normalises (re-orders
-- keys) on storage — which would make the anchored hash unverifiable against
-- what is served. The column holds the serialized ContinuityReportPayload.
CREATE TABLE continuity_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ceremony_id  uuid NOT NULL UNIQUE REFERENCES release_ceremonies (id) ON DELETE CASCADE,
  generated_at timestamptz NOT NULL,
  payload      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS cv_episode_at timestamptz,
  ADD COLUMN IF NOT EXISTS cv_wave integer;

CREATE UNIQUE INDEX notification_deliveries_cv_wave_uniq
  ON notification_deliveries (user_id, purpose, channel_id, cv_episode_at, cv_wave)
  WHERE cv_wave IS NOT NULL;
