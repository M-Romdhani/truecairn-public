-- Give the upload claim an identity (2026-08-08 re-audit, finding N-2).
--
-- THE BUG, and it is one I introduced in the 2026-08-07 fix for finding 2. That
-- fix claims the upload slot with a status-guarded UPDATE to 'uploading' and then
-- re-asserts the claim on the terminal write:
--
--     UPDATE attachments SET status='stored' WHERE id=$1 AND status='uploading'
--
-- The comment above it says this is belt-and-braces against a claim that was
-- taken over mid-flight. It is not. 'uploading' is what the original claim wrote
-- AND what a takeover writes, so the predicate cannot tell the two apart. A
-- writer whose slot was stolen still matches, still flips the row to 'stored',
-- and publishes ITS bytes under the NEW holder's reservation — with the new
-- holder still streaming into the same blob key. Verbatim the same defect on the
-- sibling capture route.
--
-- A claim needs an identity, not just a state. upload_claim is a fresh uuid
-- minted by whoever wins the status-guarded UPDATE and carried in a local for the
-- life of the request. The terminal write and BOTH rollback paths then predicate
-- on `upload_claim = $token`, so every one of them can only ever affect the slot
-- this request actually holds. A loser gets zero rows and the existing 409 +
-- release-reservation path, which was already correct.
--
-- The rollbacks matter as much as the terminal write: releaseUserStorage,
-- store.delete and the status reset were all unguarded, so a writer that lost its
-- claim and then errored would delete the HOLDER's blob and refund the HOLDER's
-- bytes.
--
-- Nullable, and NULL means "no upload in flight" — the correct reading for every
-- existing row, none of which can be mid-upload across a deploy. Cleared on the
-- terminal write so a stored row carries no stale token.

ALTER TABLE attachments
  ADD COLUMN upload_claim uuid;

ALTER TABLE vault_captures
  ADD COLUMN upload_claim uuid;
