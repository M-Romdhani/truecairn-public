-- 0063_channel_destination_hash_check.sql
-- notification_channels.destination_hash must actually be the hash of the
-- destination (QA 2026-08-10, from a production drill transcript).
--
-- THE GAP. destination_hash is the DEDUPLICATION KEY: the unique index
-- notification_channels_user_dest_uniq is on (user_id, channel_type,
-- destination_hash), and the enrolment route's "is this already enrolled?"
-- lookup selects on it too. The route always writes
-- sha256('<channel_type>:<destination>') (apps/api/src/routes/channels.ts,
-- hashDestination). Nothing ever checked that the column holds that.
--
-- So a row whose hash does not match its destination is invisible to both
-- mechanisms that depend on it:
--   * the same destination can be enrolled twice, because the two rows differ
--     in the column the unique index actually covers;
--   * the "already enrolled and verified" conflict never fires for it, because
--     the lookup searches by a hash the row does not carry.
-- A verified row like that is selectable for delivery and every send to it
-- fails, which dead-letters — and deadLettered > 0 is the sole trigger for
-- `notifications` reading "degraded" on the PUBLIC /status page.
--
-- This is not hypothetical. The 2026-08 drill inserted, directly into
-- production:
--     destination = '+15550001111', destination_hash = '\x71612d736d73'
-- which is the ASCII string 'qa-sms' — six bytes where the route writes
-- thirty-two — marked verified = true. It got in without complaint.
--
-- WHY `NOT VALID`, AND WHAT THAT MEANS. The constraint is enforced on every
-- INSERT and UPDATE from the moment this migration commits; NOT VALID only
-- skips the scan of pre-existing rows. That is deliberate:
--
--   * migrations run as a Railway PRE-DEPLOY step, so a validating constraint
--     that met one bad row would abort the deploy rather than report the row.
--     Refusing to ship the whole application because a drill fixture is in the
--     table is a worse outcome than the fixture;
--   * the known-bad rows are drill residue whose removal is an owner action
--     (`scripts/ceremony-drill.ts clean <email> --confirm`), not something a
--     migration should do silently — deleting a user's notification channel is
--     exactly the class of write that should never happen as a side effect.
--
-- The door is shut either way: nothing NEW can be written malformed. Once the
-- residue is cleared, promote it with
--     ALTER TABLE notification_channels VALIDATE CONSTRAINT notification_channels_destination_hash_ck;
-- which takes only a SHARE UPDATE EXCLUSIVE lock and does not block reads or
-- writes. To find what is still outstanding first:
--     SELECT id, user_id, channel_type, destination, verified
--       FROM notification_channels
--      WHERE destination_hash IS DISTINCT FROM
--            sha256(convert_to(channel_type::text || ':' || destination, 'UTF8'));
--
-- sha256() is a Postgres 11+ builtin over bytea — no pgcrypto needed. The
-- expression must stay byte-identical to hashDestination(); channels.test.ts
-- pins the two together so neither can drift alone.

ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_destination_hash_ck
  CHECK (
    destination_hash = sha256(convert_to(channel_type::text || ':' || destination, 'UTF8'))
  )
  NOT VALID;
