-- 0056_vault_captures.sql
-- Write-only vault capture from the phone (docs/34).
--
-- Two additions, both inert until VAULT_CAPTURE_ENABLED is on.
--
-- 1. user_key_material.vault_capture_pubkey — the owner's X25519 PUBLIC key,
--    derived from the master key (KDF context 'tc-vcapt'). Nullable because
--    every account enrolled before today has none; the web publishes it on the
--    next unlock, where the master key already is. It is a public key, so
--    storing it adds nothing the server could decrypt with.
--
-- 2. vault_captures — sealed items awaiting the owner's filing. Deliberately
--    NOT rows in vault_items (docs/34 D3): every vault_items row is unwrappable
--    from its tier key, which is what makes a release ceremony able to open it.
--    A capture is sealed to a MASTER-derived key that no ceremony reconstructs,
--    so parking one in that table would manufacture an item a successful release
--    hands over and then cannot read. The separate table makes that impossible
--    rather than merely unlikely.
ALTER TABLE user_key_material
  ADD COLUMN vault_capture_pubkey bytea;

CREATE TABLE vault_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Plaintext because the plan cap and the filing queue need it, and because
  -- the ciphertext is AAD-bound to it (docs/34 §4): relabeling this column
  -- breaks authentication instead of silently filing into the wrong tier.
  tier vault_tier NOT NULL,
  -- The per-capture XChaCha20-Poly1305 key, sealed to vault_capture_pubkey.
  -- 80 bytes: 32 ephemeral pubkey + 32 key + 16 tag.
  sealed_capture_key bytea NOT NULL,
  payload_nonce bytea NOT NULL,
  -- Declared at create, verified against Content-Length at upload. The bytes
  -- themselves go to the blob store, never to a column: a 16 MiB bytea would
  -- ride every incidental SELECT on this table.
  size_bytes bigint NOT NULL,
  storage_path text NOT NULL,
  -- 'pending_upload' -> 'stored'. A capture with no bytes is not a capture;
  -- the filing queue only ever shows 'stored'.
  status text NOT NULL DEFAULT 'pending_upload',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vault_captures_user ON vault_captures (user_id);
-- The filing queue reads (user_id, status) ordered oldest-first.
CREATE INDEX vault_captures_user_status ON vault_captures (user_id, status, created_at);
