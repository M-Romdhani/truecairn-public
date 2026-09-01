-- 0068_contact_pin_version.sql
-- Contact labels and pins move off the S1 tier key (audit findings F1 + F2,
-- PLAN-v1-launch.md §1.2).
--
-- THE GAP. `display_label_ciphertext` and `key_pin_ciphertext` were encrypted
-- under the S1 TIER key. That key is not the owner's alone: sealS1EnvelopeToContact
-- seals it directly to the S1 beneficiary's X25519 pubkey, and reconstructS1Item
-- unseals it into their browser. So the moment an S1 release completes, that one
-- recipient can decrypt the owner's private label and pin for EVERY contact —
-- including contacts who exist only in S2/S3 and have no part in S1. Labels are
-- the larger half: every contact has one, only confirmed contacts have a pin.
--
-- v2 encrypts both under a master-derived key ('tc-cmeta'). No ceremony ever
-- reconstructs the master key — a release reconstructs TIER keys — so this closes
-- the path rather than narrowing it.
--
-- WHY A v1 READER, WHERE 0062 DELIBERATELY HAD NONE. 0062 let pre-existing items
-- become unreadable, correctly: it was pre-launch test data and a permanent
-- doubled test matrix was the more expensive mistake. The same trade does NOT
-- hold here, for a reason specific to what these columns are:
--
--   * an unreadable PIN reads as "this contact is not confirmed", so dropping v1
--     silently forces every owner to redo the out-of-band comparison. §1.2 forbids
--     exactly that — it trains owners to click through `tampered`, which is the
--     one state that has to stay meaningful. The owner's comparison remains valid
--     evidence about those key bytes; only the storage key is changing;
--   * an unreadable LABEL is the P0-2 shape again — every contact row rendering
--     "Label unavailable" in production.
--
-- So: readers accept 1 and 2, writers always emit 2, and a v1 row is re-encrypted
-- opportunistically on unlock, when the client holds BOTH the S1 tier key (to
-- read it) and the master key (to rewrite it). No forced re-confirmation, and the
-- version column retires itself once every row has been touched.
--
-- ONE column for labels and pins together, because they move under the same key
-- in the same pass and there is no state where they legitimately differ.
-- Deliberately NOT the CONTACT_KEY_VERSION_* pair in packages/keys/src/types.ts:
-- that versions the contact's KEYPAIR DERIVATION (v1 global vs v2
-- per-relationship, 'tc-cbind') and is an independent migration with independent
-- preconditions. Two crypto migrations sharing one column means neither can move
-- without the other.

ALTER TABLE contacts
  ADD COLUMN contact_pin_version smallint NOT NULL DEFAULT 1;

-- Existing rows are v1 by definition: they were written under the S1 tier key.
-- The default carries that without a backfill. New rows are written as 2 by the
-- client and the route validates the range.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_contact_pin_version_ck
  CHECK (contact_pin_version IN (1, 2));
