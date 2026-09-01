-- 0035_audit_actor.sql
-- AI Guardian forensic discriminator (plan docs/25 §3.4 / D1).
--
-- Records WHO caused each audit_log entry: 'owner' (an account-holder action via
-- the API), 'worker' (the engine/ceremony/sensitive-action worker), or 'ai' (the
-- ai-authority chokepoint — the ONLY writer permitted to use 'ai'). This makes the
-- chain able to prove, forensically, that no `ai` actor ever emitted a forward
-- engine event: the asymmetry invariant test asserts every actor='ai' row carries
-- an allowlisted AI event type.
--
-- DELIBERATELY NOT part of the signed canonical entry (packages/audit/canonical.ts):
-- the entry hash covers seq, user, event_type, payload, prev_hash, timestamps, and
-- key id. Adding a field to that hash would change every existing entry's recomputed
-- hash and break verifyChain for all history. `actor` is therefore defence-in-depth
-- metadata written in the SAME transaction as the row it labels — not a signature-
-- bound field. That is sufficient: an attacker who could forge audit rows already
-- defeats the server signature; `actor` guards against a benign-looking AI code path
-- being wired to a forward event, which the invariant test + this column catch.
--
-- Backfill: every existing row predates the AI subsystem, so 'owner' is the correct
-- default (no 'ai' row can exist yet). New writes set the column explicitly.
ALTER TABLE audit_log
  ADD COLUMN actor text NOT NULL DEFAULT 'owner'
  CHECK (actor IN ('owner', 'worker', 'ai'));
