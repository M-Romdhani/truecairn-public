-- 0033_s3_nested_threshold.sql
-- S3 nested release scheme (docs/24): the release passphrase becomes a MANDATORY
-- XOR mask over the S3 tier key and the contacts hold a 2-of-3 Shamir split of
-- the MASKED key. So S3's contact-share metadata moves from the flat 3-of-4 to
-- 2-of-3 — the passphrase is the mask, NOT a counted Shamir share. This is
-- informational metadata on the row (gating lives in the worker/processor), but
-- the CHECK constraint pins it, so it must move with the scheme.
--
-- Existing s3 rows carry the old (3,4) presets from enrollment. The nested scheme
-- supersedes the flat one (the collusion gap docs/24 closes was never shipped to
-- production), so rewrite them to (2,3) before re-tightening the constraint.

ALTER TABLE user_tier_keys DROP CONSTRAINT IF EXISTS user_tier_keys_check;

UPDATE user_tier_keys
  SET shamir_threshold = 2, shamir_share_count = 3
  WHERE tier = 's3' AND shamir_threshold = 3 AND shamir_share_count = 4;

ALTER TABLE user_tier_keys ADD CONSTRAINT user_tier_keys_shamir_check CHECK (
  (tier = 's1' AND shamir_threshold IS NULL AND shamir_share_count IS NULL)
  OR (tier = 's2' AND shamir_threshold = 2 AND shamir_share_count = 3)
  OR (tier = 's3' AND shamir_threshold = 2 AND shamir_share_count = 3)
);
