-- 0064_ai_proposal_superseded.sql
-- A proposal whose gap the owner has already FIXED must leave the inbox
-- (QA 2026-08-11, §4).
--
-- THE GAP. `generateProposals` is idempotent in one direction only: it creates a
-- proposal per blocker gap and dedupes against open rows with the same output
-- hash. Nothing ever removed one. So a proposal outlived the condition that
-- justified it — QA fixed three gaps and all three were still listed, each with a
-- live Accept button, alongside the three that were genuinely open. The
-- continuity-checkups list beside it prunes correctly, which makes the inbox look
-- broken rather than stale.
--
-- It compounds with the new `no_verified_channel` blocker: the sweep raises one
-- proposal per blocker, so every existing armed account with no verified channel
-- gets one — and before this, it would still be sitting there after they fixed it,
-- until the 14-day expiry swept it. "A new proposal" was the intended production
-- effect; "a new proposal that never goes away" was not.
--
-- WHY A NEW STATUS RATHER THAN REUSING 'expired'. `expired` means the owner let it
-- lapse; this means the owner RESOLVED it. Recording the second as the first is a
-- false statement in a record that rides the tamper-evident audit chain, and it is
-- the same conflation this repo refuses elsewhere — a WhatsApp `sent` is not a
-- delivery, an `unknown` status is not an `open` one. The two also want opposite
-- follow-ups: an expiry may deserve a nudge, a resolution deserves silence.
--
-- Additive and reversible: widening a CHECK cannot invalidate an existing row.
-- No backfill — rows already swept to 'expired' stay as they are, because
-- rewriting history to a status that did not exist when they were written would be
-- the same lie in the other direction.

ALTER TABLE ai_proposals DROP CONSTRAINT IF EXISTS ai_proposals_status_check;

ALTER TABLE ai_proposals
  ADD CONSTRAINT ai_proposals_status_check
  CHECK (status IN ('proposed', 'approved', 'rejected', 'expired', 'executed', 'superseded'));
