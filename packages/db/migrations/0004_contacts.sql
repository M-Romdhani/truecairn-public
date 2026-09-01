-- 0004_contacts.sql
-- Owner-user → trusted-contact relationships. Display labels are encrypted
-- ("my divorce lawyer", "ex-cofounder" leaks too much in plaintext).

CREATE TABLE contacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_user_id           uuid REFERENCES users (id),
  role                      contact_role NOT NULL,
  status                    contact_status NOT NULL DEFAULT 'invited',
  display_label_ciphertext  bytea NOT NULL,
  display_label_nonce       bytea NOT NULL,
  invite_email              text,
  invite_token_hash         bytea,
  invite_expires_at         timestamptz,
  invited_at                timestamptz,
  accepted_at               timestamptz,
  enrolled_at               timestamptz,
  removed_at                timestamptz,
  contact_x25519_pubkey     bytea,
  contact_ed25519_pubkey    bytea,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contacts_owner_status ON contacts (owner_user_id, status);

CREATE UNIQUE INDEX contacts_invite_token_uniq
  ON contacts (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

CREATE UNIQUE INDEX contacts_owner_contact_uniq
  ON contacts (owner_user_id, contact_user_id)
  WHERE contact_user_id IS NOT NULL AND removed_at IS NULL;
