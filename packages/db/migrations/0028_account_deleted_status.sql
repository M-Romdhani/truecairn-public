-- 0028_account_deleted_status.sql
-- delete_account (PHASE3_4 Checkpoint C) tombstones the users row rather than
-- deleting it (audit_log.user_id is ON DELETE RESTRICT — the append-only audit
-- log must survive so a compromised session that triggered deletion cannot erase
-- its own evidence). The terminal status gets its own value, distinct from
-- 'terminated' (platform action): 'deleted' = user-requested account deletion.
--
-- ADD VALUE runs in the migrator transaction as long as the value isn't used in
-- the same transaction (it isn't).
ALTER TYPE account_status ADD VALUE IF NOT EXISTS 'deleted';
