-- 0003_keys_and_outer_layer.sql
-- Wrapped master key, per-tier wraps, and the platform-held outer-layer keys.

CREATE TABLE user_key_material (
  user_id                          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  master_passphrase_salt           bytea NOT NULL,
  master_key_wrapped_by_passphrase bytea NOT NULL,
  master_key_passphrase_nonce      bytea NOT NULL,
  recovery_code_salt               bytea NOT NULL,
  master_key_wrapped_by_recovery   bytea NOT NULL,
  master_key_recovery_nonce        bytea NOT NULL,
  release_passphrase_salt          bytea NOT NULL,
  audit_signing_pubkey             bytea NOT NULL,
  generation                       integer NOT NULL DEFAULT 1,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outer_layer_keys (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  tier                     vault_tier NOT NULL,
  kek_id                   text NOT NULL,
  outer_key_encrypted      bytea NOT NULL,
  outer_key_encryption_aad bytea NOT NULL,
  released_to_ceremony_id  uuid,
  released_at              timestamptz,
  rotated_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outer_layer_keys_user_tier_active
  ON outer_layer_keys (user_id, tier)
  WHERE released_at IS NULL AND rotated_at IS NULL;

CREATE TABLE user_tier_keys (
  user_id                    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tier                       vault_tier NOT NULL,
  tier_key_wrapped_by_master bytea NOT NULL,
  tier_key_master_nonce      bytea NOT NULL,
  outer_layer_key_id         uuid NOT NULL REFERENCES outer_layer_keys (id),
  shamir_threshold           smallint,
  shamir_share_count         smallint,
  generation                 integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tier),
  CHECK (
    (tier = 's1' AND shamir_threshold IS NULL AND shamir_share_count IS NULL)
    OR (tier = 's2' AND shamir_threshold = 2 AND shamir_share_count = 3)
    OR (tier = 's3' AND shamir_threshold = 3 AND shamir_share_count = 4)
  )
);
