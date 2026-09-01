-- 0005_release_shares.sql
-- Shamir shares for S2/S3. Append-only-with-supersession: rotation inserts a
-- new row + sets the old row's revoked_at. S1 has no rows here (S1 release
-- is mediated only by the temporal gate + any-one-contact affirmation).

CREATE TABLE release_shares (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tier                     vault_tier NOT NULL,
  share_index              smallint NOT NULL,
  share_type               share_type NOT NULL,
  contact_id               uuid REFERENCES contacts (id),
  wrapped_share_ciphertext bytea,
  passphrase_salt          bytea,
  hardware_key_id          uuid,
  generation               integer NOT NULL DEFAULT 1,
  superseded_by_id         uuid REFERENCES release_shares (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  CHECK (tier IN ('s2', 's3')),
  CHECK (
    (share_type IN ('contact', 'second_professional_contact')
      AND contact_id IS NOT NULL
      AND wrapped_share_ciphertext IS NOT NULL)
    OR (share_type = 'release_passphrase'
      AND passphrase_salt IS NOT NULL
      AND contact_id IS NULL
      AND wrapped_share_ciphertext IS NULL)
    OR (share_type = 'hardware_key'
      AND wrapped_share_ciphertext IS NOT NULL
      AND contact_id IS NULL)
  )
);

CREATE UNIQUE INDEX release_shares_active_index
  ON release_shares (user_id, tier, share_index)
  WHERE revoked_at IS NULL;
