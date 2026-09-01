-- 0037_user_ai_opt_out.sql
-- Per-user AI opt-out (plan docs/25 §4 task 0.3 / D5).
--
-- When true, NO LLM call ever includes this user's context: the AI guard short-
-- circuits before building any prompt. Deterministic (non-LLM) guardian detectors
-- still run and are documented as such (they are statistics over metadata, not AI).
-- Default false preserves today's assist/briefing for existing users.
ALTER TABLE users
  ADD COLUMN ai_opt_out boolean NOT NULL DEFAULT false;
