-- 0025_vault_sensitive_actions.sql
-- Vault sensitive-action types + the prior-version content backup slot
-- (PHASE3_3 Checkpoint B). The enum values ship WITH their handlers:
-- set_vault_item_tier + delete_vault_item land here; purge_attachment's handler
-- arrives in Checkpoint C with attachments (the value is added now so the enum is
-- stable). Adding an enum value is transactional in PG 12+ as long as the value is
-- not USED in the same transaction — none of these are used here.

ALTER TYPE sensitive_action_type ADD VALUE IF NOT EXISTS 'set_vault_item_tier';
ALTER TYPE sensitive_action_type ADD VALUE IF NOT EXISTS 'delete_vault_item';
ALTER TYPE sensitive_action_type ADD VALUE IF NOT EXISTS 'purge_attachment';

-- The one-version, seed-once-per-window content backup (Q4). On the FIRST content
-- overwrite after the slot is empty/expired, the displaced envelope is copied here
-- and backup_at is stamped; later overwrites within the 7-day window do NOT touch
-- it — so a malicious double-overwrite cannot destroy the pre-burst version. A
-- content PATCH keeps the tier, so the backup shares the live envelope's outer key
-- (no extra key columns). pending_delete_at marks an item queued for soft-delete
-- during its 7-day delete cooldown (cleared on cancel; the handler sets deleted_at).
ALTER TABLE vault_items
  ADD COLUMN backup_outer_ciphertext bytea,
  ADD COLUMN backup_outer_nonce bytea,
  ADD COLUMN backup_content_size_bytes integer,
  ADD COLUMN backup_at timestamptz,
  ADD COLUMN pending_delete_at timestamptz;
