-- 0034_s1_beneficiary.sql
-- S1 designated beneficiary (backlog #4). release_beneficiaries originally
-- restricted tier to S2/S3 (the Shamir re-seal path). S1 now supports a
-- designated beneficiary too: it has no Shamir shares, so the beneficiary
-- receives their OWN owner-sealed envelope of the S1 tier key (an
-- s1_tier_key_envelopes row), enrolled as a non-affirming recipient. Widen the
-- tier CHECK to admit s1.

ALTER TABLE release_beneficiaries DROP CONSTRAINT IF EXISTS release_beneficiaries_tier_check;

ALTER TABLE release_beneficiaries
  ADD CONSTRAINT release_beneficiaries_tier_check CHECK (tier IN ('s1', 's2', 's3'));
