-- 0023_contact_key_type.sql
-- Affirmation key-type seam (PHASE3_2_CONTACTS_PROPOSAL §d / Q5). A contact's
-- affirmation signature is Ed25519 in V1. Tagging the key type now makes future
-- hardware-key contact affirmation (e.g. WebAuthn / ES256) an ADDITIVE enum
-- value + a new verification branch, rather than a refactor across the ceremony,
-- audit, and signing code — same algorithm-upgrade discipline as 3.1's `v1$`
-- password-hash prefix.
--
-- release_shares needs no such seam: shares are SEALED to a contact's X25519
-- public key (anonymous sealed box), not SIGNED by it — only the affirmation
-- path uses this tag. To add hardware-key support later: add an enum value here,
-- a per-contact authenticator table, and a verification branch in the ceremony.

CREATE TYPE contact_key_type AS ENUM ('ed25519');

ALTER TABLE contacts
  ADD COLUMN affirmation_key_type contact_key_type NOT NULL DEFAULT 'ed25519';
