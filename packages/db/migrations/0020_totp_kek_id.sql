-- 0020_totp_kek_id.sql
-- TOTP KEK versioning (PHASE3_1 review follow-up). Each encrypted TOTP secret
-- records the id of the server KEK that wrapped it, so a KEK rotation becomes a
-- background re-encrypt-on-verify migration (decrypt with old, re-encrypt with
-- new on the next successful verify) instead of a forced TOTP re-enrolment —
-- which matters precisely in the incident-response scenario where you rotate.
--
-- totp_credentials has no rows yet (no setup endpoint shipped before this), so
-- the add-default-then-drop only future-proofs a carry-over dev row; new inserts
-- (the Checkpoint B setup endpoint) must supply a real kek_id.

ALTER TABLE totp_credentials ADD COLUMN kek_id text NOT NULL DEFAULT '';
ALTER TABLE totp_credentials ALTER COLUMN kek_id DROP DEFAULT;
