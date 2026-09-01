-- 0030_release_ceremony_create_once.sql
-- Ceremony-completion Checkpoint A, Bridge 1 (create-once). The engine→ceremony
-- creation hook runs when a user enters release_review; this partial unique index
-- is the hard idempotency guard, so even under a worker re-tick or a race exactly
-- ONE live ceremony exists per (user, tier). Terminal ceremonies (released/
-- cancelled/failed) are excluded so a later release episode can open a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS release_ceremonies_one_live_per_tier
  ON release_ceremonies (user_id, tier)
  WHERE status NOT IN ('released', 'cancelled', 'failed');

-- S1 carries no Shamir share — its key is a full sealed envelope in
-- s1_tier_key_envelopes, not a release_shares row. So an S1 affirmation has no
-- share_id to reference; make the column nullable (it stays set for S2/S3 Shamir
-- shares). Without this, an S1 ceremony could not enrol affirmations at all.
ALTER TABLE ceremony_affirmations ALTER COLUMN share_id DROP NOT NULL;
