-- 0018_ceremony_affirmation_share_signature.sql
-- Adds the per-share Ed25519 signature to ceremony_affirmation_shares
-- (CEREMONY_PROPOSAL.md follow-up): each affirming contact signs a payload
-- binding affirmation_id + recipient_contact_id + recipient_ephemeral_pubkey +
-- blake2b256(sealed_share_ciphertext), giving per-re-wrap non-repudiation.
--
-- This lands as its own numbered migration (NOT an edit to 0017) because 0017
-- has already been applied. Editing an applied migration leaves DBs that ran
-- the old 0017 silently missing the column while the tracking table reports it
-- as applied. See docs/19 §"Migration discipline".
--
-- Add-with-default then drop-default: there is no production data, but a
-- carry-over dev DB may hold ceremony_affirmation_shares rows. The transient
-- default backfills any such rows with a 1-byte placeholder; dropping the
-- default then forces every NEW insert to supply a real 64-byte signature.

ALTER TABLE ceremony_affirmation_shares
  ADD COLUMN share_signature bytea NOT NULL DEFAULT '\x00'::bytea;

ALTER TABLE ceremony_affirmation_shares
  ALTER COLUMN share_signature DROP DEFAULT;
