-- 0006_vault_items.sql
-- The encrypted user blobs. category is plaintext (policy key, not content);
-- titles are encrypted to preserve zero-knowledge.

CREATE TABLE vault_items (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tier                       vault_tier NOT NULL,
  category                   text NOT NULL,
  content_ciphertext         bytea NOT NULL,
  content_nonce              bytea NOT NULL,
  content_size_bytes         integer NOT NULL,
  wrapped_per_item_key       bytea NOT NULL,
  wrapped_per_item_key_nonce bytea NOT NULL,
  title_ciphertext           bytea NOT NULL,
  title_nonce                bytea NOT NULL,
  client_ordinal             integer,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  deleted_at                 timestamptz
);

CREATE INDEX vault_items_user_tier ON vault_items (user_id, tier) WHERE deleted_at IS NULL;
CREATE INDEX vault_items_user_category ON vault_items (user_id, category) WHERE deleted_at IS NULL;
