-- 0044_channel_enrollment.sql
-- Continuity Verification CV-0.0 (docs/26): owners enrol and verify their own
-- notification channels. Until now no production path created a
-- notification_channels row at all — pickPrimaryChannel found nothing and owner
-- notices were silently skipped. Verification is a code round-trip: the code is
-- HASHED at rest on the channel row; the plaintext travels once in the
-- delivery's payload_params and is cleared the moment the send succeeds.
--
-- ADD VALUE runs in the migrator transaction as long as the value isn't used in
-- the same transaction (it isn't) — same pattern as 0028.
ALTER TYPE notification_purpose ADD VALUE IF NOT EXISTS 'channel_verification';

ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS verification_code_hash bytea,
  ADD COLUMN IF NOT EXISTS verification_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0;

-- Per-delivery template parameters. Content discipline: the ONLY producer is
-- the channel-enrolment route and the ONLY key is the verification code
-- (server-generated randomness — never vault content, titles, or names);
-- renderTemplate injects it for the channel_verification purpose alone, and the
-- delivery processor nulls it once the provider accepts the send.
ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS payload_params jsonb;
