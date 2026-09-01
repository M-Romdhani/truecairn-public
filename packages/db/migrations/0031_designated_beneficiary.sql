-- 0031_designated_beneficiary.sql
-- Backlog #2 — designated (non-affirming) beneficiary, S2/S3 first.
--
-- Today a release recipient must be an affirming share-holder (the "B decision":
-- recipient = affirming contact). A designated beneficiary breaks that coupling:
-- a contact the owner names to RECEIVE a tier's release while holding no Shamir
-- share and never affirming. Consensus is unchanged — the affirming holders still
-- open the gate; the beneficiary is enrolled as a ceremony_recipient so those
-- holders re-seal their shares to it, and it reconstructs the threshold subset.
--
-- Designating/removing who inherits the vault is a SENSITIVE action (step-up +
-- 7-day delay), so two new action types join the enum. ADD VALUE is safe in this
-- migration's transaction because the new values are not USED here (the table
-- below does not reference sensitive_action_type).
ALTER TYPE sensitive_action_type ADD VALUE IF NOT EXISTS 'designate_beneficiary';
ALTER TYPE sensitive_action_type ADD VALUE IF NOT EXISTS 'remove_beneficiary';

-- The designation itself. Append-only-with-revocation (matches release_shares):
-- remove_beneficiary sets revoked_at rather than deleting, preserving history and
-- keeping the active partial-unique index honest. S2/S3 only (S1's per-holder
-- sealed envelope has no re-seal-to-beneficiary path yet — a documented follow-on).
CREATE TABLE release_beneficiaries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tier        vault_tier NOT NULL,
  contact_id  uuid NOT NULL REFERENCES contacts (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CHECK (tier IN ('s2', 's3'))
);

-- At most one active designation per (user, tier, contact); a tier may have
-- several distinct beneficiaries.
CREATE UNIQUE INDEX release_beneficiaries_active
  ON release_beneficiaries (user_id, tier, contact_id)
  WHERE revoked_at IS NULL;

-- The bridge enumerates a tier's active beneficiaries when a ceremony opens.
CREATE INDEX release_beneficiaries_user_tier
  ON release_beneficiaries (user_id, tier)
  WHERE revoked_at IS NULL;
