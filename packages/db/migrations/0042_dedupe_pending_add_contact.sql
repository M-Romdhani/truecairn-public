-- 0042_dedupe_pending_add_contact.sql
-- One-time backfill for QA Pass 3 Finding A.
--
-- Before the /v1/contacts/shares idempotency guard shipped, a client retry
-- (e.g. after a stalled passkey prompt left it unsure whether the first attempt
-- landed) could stack SEVERAL pending add_contact actions for the same
-- contact+tier. The guard stops new duplicates; this migration repairs accounts
-- that hit the bug before it: for each (user, contactId, tier) group, KEEP the
-- earliest pending action and cancel the rest.
--
-- Safety direction: cancelling a duplicate only removes a redundant scheduled
-- copy of a grant the surviving row still applies — it can never widen access or
-- advance anything. The cancellation is recorded on the row itself
-- (cancelled_via/cancelled_reason); no audit-chain entry is written because
-- migrations run without the server's signing key — the row-level record is the
-- forensic trail for this one-time repair.
UPDATE sensitive_actions sa
SET status = 'cancelled',
    cancelled_at = now(),
    cancelled_via = 'migration',
    cancelled_reason = 'duplicate_pending_backfill',
    updated_at = now()
WHERE sa.status = 'pending'
  AND sa.action_type = 'add_contact'
  AND EXISTS (
    SELECT 1
    FROM sensitive_actions keep
    WHERE keep.user_id = sa.user_id
      AND keep.action_type = 'add_contact'
      AND keep.status = 'pending'
      AND keep.action_payload ->> 'contactId' = sa.action_payload ->> 'contactId'
      AND keep.action_payload ->> 'tier' = sa.action_payload ->> 'tier'
      AND (
        keep.requested_at < sa.requested_at
        OR (keep.requested_at = sa.requested_at AND keep.id < sa.id)
      )
  );
