-- 0024_vault_crud.sql
-- Vault CRUD storage reshape (PHASE3_3_VAULT_PROPOSAL §c / Q1). Wires the
-- outer-layer temporal gate (docs/01 Decision 3; packages/keys applyOuterLayerWrap)
-- into storage: a vault item is persisted as the OUTER-WRAPPED envelope, not the
-- inner client form. The server applies the wrap on store and removes it on fetch
-- during ACTIVE — it holds the KEK, but the outer key is NOT a confidentiality
-- key (the inner wraps still require the master passphrase the server never sees).
-- Keeping the gate in front of the ciphertext AT REST means a DB exfiltration plus
-- a reconstructed tier key still cannot decrypt without the platform releasing the
-- outer key — which is the entire value of the temporal gate.
--
-- The vault sensitive-action enum values (set_vault_item_tier, delete_vault_item,
-- purge_attachment) ship with their handlers in the next migration, so nothing
-- here adds an enum value it does not yet use.

-- outer_layer_keys gains the two columns a populated row needs but the Phase 1
-- table lacked: the nonce of the KEK-wrap (wrapOuterLayerKey returns ciphertext +
-- nonce + aad), and the generation the AAD binds (buildOuterLayerAad needs
-- user_id, tier, kek_id, generation). The active key per (user, tier) becomes
-- UNIQUE so lazy provisioning on first store cannot race two active keys in.
ALTER TABLE outer_layer_keys
  ADD COLUMN outer_key_nonce bytea NOT NULL,
  ADD COLUMN generation integer NOT NULL DEFAULT 1;

DROP INDEX outer_layer_keys_user_tier_active;
CREATE UNIQUE INDEX outer_layer_keys_user_tier_active
  ON outer_layer_keys (user_id, tier)
  WHERE released_at IS NULL AND rotated_at IS NULL;

-- vault_items moves from the inner four-column form to the single outer envelope
-- plus the columns needed to rebuild the wrap AAD without a join. The inner
-- bundle (content ciphertext + wrapped-per-item-key) now lives ONLY in transit;
-- at rest it is sealed inside outer_ciphertext. The table was empty (no vault
-- CRUD existed before 3.3), so the NOT NULL adds are safe.
ALTER TABLE vault_items
  DROP COLUMN content_ciphertext,
  DROP COLUMN content_nonce,
  DROP COLUMN wrapped_per_item_key,
  DROP COLUMN wrapped_per_item_key_nonce,
  ADD COLUMN outer_ciphertext bytea NOT NULL,
  ADD COLUMN outer_nonce bytea NOT NULL,
  ADD COLUMN outer_layer_key_id uuid NOT NULL REFERENCES outer_layer_keys (id),
  ADD COLUMN outer_kek_id text NOT NULL,
  ADD COLUMN outer_generation integer NOT NULL;
