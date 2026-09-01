-- 0017_release_ceremony_protocol.sql
-- Schema for the release ceremony protocol (Phase 2 deliverable 3).
-- Implements the design rulings in CEREMONY_PROPOSAL.md:
--   Q1  per-recipient reconstruction (not single reconstructing contact)
--   Q3  per-user random tier-key check sentinel
--   + the per-recipient reconstruction-status tracking requirement
--   + S1 per-contact sealed-envelope (Q3 option C from the schema-proposal phase)

-- ───────────────────────────────────────────────────────────────────────────
-- 1. S1 tier key envelopes (S1 has no Shamir; the tier key is sealed in full
--    to each S1-authorised contact's X25519 pubkey — docs/02 "any-one-contact",
--    threat 5.4.6 "5.4 alone reaches S1 worst-case"). A dedicated table rather
--    than relaxing the release_shares tier CHECK: S1 has no share_index /
--    threshold / polynomial, so it does not fit the Shamir-shares table.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE s1_tier_key_envelopes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_id            uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  sealed_box_ciphertext bytea NOT NULL,   -- crypto_box_seal(S1 tier key, contact_x25519_pubkey)
  generation            integer NOT NULL DEFAULT 1,
  superseded_by_id      uuid REFERENCES s1_tier_key_envelopes (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);

CREATE UNIQUE INDEX s1_tier_key_envelopes_active
  ON s1_tier_key_envelopes (user_id, contact_id)
  WHERE revoked_at IS NULL;

CREATE INDEX s1_tier_key_envelopes_user
  ON s1_tier_key_envelopes (user_id)
  WHERE revoked_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Per-recipient reconstruction.
--
--    Consolidation note: CEREMONY_PROPOSAL.md named two tables
--    (ceremony_recipient_ephemerals + ceremony_recipient_status) keyed
--    identically by (ceremony_id, recipient_contact_id) with a 1:1 lifecycle.
--    They are merged here into ONE ceremony_recipients table: the
--    ephemeral_pubkey is nullable (NULL = enumerated from the release-policy
--    matrix but not yet engaged), set when the recipient registers their
--    ceremony-specific ephemeral key. Flagged for review.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TYPE recipient_reconstruction_status AS ENUM (
  'pending',         -- enumerated from the release-policy matrix; not engaged
  'reconstructing',  -- ephemeral key registered; pulling/combining shares
  'released',        -- this recipient reconstructed + decrypted their content
  'failed'           -- this recipient's reconstruction failed
);

CREATE TABLE ceremony_recipients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ceremony_id          uuid NOT NULL REFERENCES release_ceremonies (id) ON DELETE CASCADE,
  recipient_contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  ephemeral_pubkey     bytea,                  -- X25519; NULL until the recipient registers
  registered_at        timestamptz,
  status               recipient_reconstruction_status NOT NULL DEFAULT 'pending',
  completed_at         timestamptz,
  failure_reason       text,
  audit_id             uuid REFERENCES audit_log (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ceremony_id, recipient_contact_id)
);

CREATE INDEX ceremony_recipients_ceremony ON ceremony_recipients (ceremony_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Per-(affirmation, recipient) re-wrapped shares.
--    Each affirming contact re-wraps their unwrapped share to EACH recipient's
--    ceremony ephemeral pubkey (crypto_box_seal). Replaces the single
--    tentative_share_ciphertext column on ceremony_affirmations.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE ceremony_affirmation_shares (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affirmation_id          uuid NOT NULL REFERENCES ceremony_affirmations (id) ON DELETE CASCADE,
  recipient_contact_id    uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
  sealed_share_ciphertext bytea NOT NULL,  -- crypto_box_seal(share, recipient ceremony ephemeral pubkey)
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (affirmation_id, recipient_contact_id)
);

CREATE INDEX ceremony_affirmation_shares_affirmation
  ON ceremony_affirmation_shares (affirmation_id);

-- crypto_box_seal output carries its own ephemeral pubkey; there is no
-- separate nonce. The single-share columns are superseded by the per-recipient
-- table above.
ALTER TABLE ceremony_affirmations DROP COLUMN tentative_share_ciphertext;
ALTER TABLE ceremony_affirmations DROP COLUMN tentative_share_nonce;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The single ceremony ephemeral pubkey is replaced by per-recipient
--    ephemerals in ceremony_recipients. Drop it from release_ceremonies.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE release_ceremonies DROP COLUMN ceremony_ephemeral_pubkey;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Tier-key check sentinel (per-user random; not a fixed known plaintext).
--    At enrollment: 16 random bytes + their encryption under the tier key
--    (AAD-bound, same discipline as the tier-key wrap). At reconstruction the
--    client decrypts the ciphertext with the reconstructed key and compares
--    to the plaintext — a cheap correctness check that also supports
--    k-subset retry over committed shares.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE user_tier_keys ADD COLUMN tier_key_check_plaintext  bytea NOT NULL;
ALTER TABLE user_tier_keys ADD COLUMN tier_key_check_ciphertext bytea NOT NULL;
ALTER TABLE user_tier_keys ADD COLUMN tier_key_check_nonce      bytea NOT NULL;
