-- 0047_welcome_email.sql
-- Onboarding welcome email (CV-brand pass): a one-time branded email when a
-- user verifies their FIRST email channel. Additive only.
--
-- The new purpose rides the same delivery pipeline as every other notice; the
-- users column makes the send exactly-once per user (set in the same
-- transaction that enqueues it, so a retry or a second verified email never
-- double-sends). ADD VALUE runs in the migrator transaction as long as the
-- value isn't used in the same file (it isn't) — same pattern as 0044/0046.
ALTER TYPE notification_purpose ADD VALUE IF NOT EXISTS 'welcome';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz;
