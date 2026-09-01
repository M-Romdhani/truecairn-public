-- Bound the bound (2026-08-08 re-audit, finding N-9).
--
-- Migration 0053 added notification_stall_max_days as a plain `integer NOT NULL
-- DEFAULT 30` with no constraint. Nothing writes it today — it is per-user
-- because the whole ladder is per-user tunable, but no route exposes it yet — so
-- this is defence in depth against a future writer or a hand-edit, not a live
-- bug.
--
-- It is worth doing NOW because the column got more load-bearing last week.
-- 0053's own reasoning covers ONE reader: NOTIFICATION_STALLED, where an
-- unbounded stall guarantees a wrongful non-release. The 2026-08-07 account-lock
-- fix added a second reader — lockStall() in packages/engine/src/transitions.ts,
-- which pauses the ladder while an owner's account is locked and uses this same
-- column as its bound. Both directions now fail badly:
--
--   * a NEGATIVE value makes `now < deadline + days` false immediately, so the
--     lock stall never engages at all. A fail-open on the exact defence added to
--     stop an attacker faking an owner's death by holding their account locked.
--   * an ABSURD value re-creates the unbounded stall 0053 exists to prevent, and
--     hands an attacker a permanent release-blocker: keep the account locked,
--     keep the ladder paused, forever.
--
-- 0 is allowed deliberately: "resume immediately, never stall" is a coherent
-- operator choice. 3650 days (10 years) is not a meaningful continuity window for
-- a product whose whole premise is that the owner may not come back — anything
-- past it is a typo or an attack, and both should be refused by the database
-- rather than discovered by an engine tick years later.
--
-- Same shape as the precedent in 0040_ai_autonomy_optin.sql.

ALTER TABLE engine_states
  ADD CONSTRAINT engine_states_stall_bound
  CHECK (notification_stall_max_days BETWEEN 0 AND 3650);
