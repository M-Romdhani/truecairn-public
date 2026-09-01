-- 0026_attachments.sql
-- Vault attachments (PHASE3_3 Checkpoint C). An attachment is an OPAQUE
-- client-encrypted blob stored on local disk; the server does zero crypto on it.
-- The gate is transitive: the per-attachment key lives in the parent vault item's
-- outer-wrapped content, so withholding the item's outer unwrap withholds the
-- attachment key (Q5a). The server therefore stores only the bytes + metadata.
--
-- The purge_attachment enum value already shipped in 0025 (added with the other
-- vault sensitive actions to keep the enum stable), so it is NOT re-added here.

-- Per-user storage budget, enforced atomically (SELECT ... FOR UPDATE) at upload
-- so two concurrent uploads can't both overshoot the cap. Counts stored blob bytes.
ALTER TABLE users
  ADD COLUMN storage_bytes_used bigint NOT NULL DEFAULT 0;

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_item_id   uuid NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  size_bytes      bigint NOT NULL,
  -- pending_upload (metadata created, bytes not yet streamed), stored (bytes on
  -- disk, budget reserved), failed (stream aborted / size mismatch — budget released).
  status          text NOT NULL DEFAULT 'pending_upload',
  storage_path    text NOT NULL,
  -- Soft-delete window: pending_delete_at is set when a purge is queued (the blob
  -- stays on disk during the 7-day cooldown); the purge_attachment handler hard-
  -- deletes the row + the file at apply. deleted_at is unused for attachments (the
  -- handler deletes the row outright) but kept for symmetry with vault_items.
  pending_delete_at timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_item ON attachments (vault_item_id);
CREATE INDEX attachments_user ON attachments (user_id);
