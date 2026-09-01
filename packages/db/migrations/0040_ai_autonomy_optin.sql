-- 0040_ai_autonomy_optin.sql
-- Per-user AI autonomy opt-in (plan docs/25 §6 / Phase 2; owner-ratified 2026-07-04:
-- autonomous STATE CHANGES stay off per account until the owner opts in + sets a
-- floor).
--
-- ai_autonomy_enabled: the per-user master switch for ANY autonomous AI action
-- (nudges + schedule tightening). Default false — autonomy is opt-in, not opt-out.
-- ai_checkin_floor_days: the floor below which the AI may NEVER autonomously tighten
-- the check-in interval. NULL ⇒ no autonomous tightening at all (nudges still allowed
-- when autonomy is enabled). The AI may only ever SHORTEN toward this floor, never
-- below it and never lengthen (the closed safety direction).
ALTER TABLE users
  ADD COLUMN ai_autonomy_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_checkin_floor_days integer
    CHECK (ai_checkin_floor_days IS NULL OR ai_checkin_floor_days >= 1);
