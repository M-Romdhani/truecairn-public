-- Persist AI call FAILURES so a silent model outage becomes observable
-- (fix plan Part A, and the 2026-08-08 re-audit's N-8).
--
-- THE GAP. ai_usage_daily records successes only: recordAiUsage is called after
-- a successful generate(), and its bump() increments tokens_in/tokens_out/calls
-- together. A failure writes NOTHING anywhere — logAiError goes to stderr and
-- stops there. So there is no query that can distinguish "the model is broken"
-- from "nobody used the app today", and the shapes are identical: no rows.
--
-- (An earlier note in this project claimed `calls > 0 AND tokens = 0` was already
-- a usable signal. It is not, and the confusion is worth naming: guard.recordCall
-- writes to auth_attempts for RATE LIMITING, while ai_usage_daily.calls is bumped
-- only inside recordAiUsage on the success path. Two different counters.)
--
-- WHY IT MATTERS ON A CLOCK. Every AI call site is fail-soft by design — the
-- readiness score keeps its deterministic gaps, narration falls back to no prose,
-- assist returns unavailable — so a dead model degrades four surfaces to their
-- templates and nothing pages anyone. GEMINI_MODEL, left empty, resolves to the
-- auto-updating `gemini-2.5-flash` alias, and the 2.5 family retires 2026-10-16.
-- Without this column that retirement is a silent degradation discovered by a
-- user; with it, it is a degraded tile on /admin/system.
--
-- Backfilled 0 for existing rows, which is honest: we did not record failures
-- before, so claiming any number would be inventing history. The ops check reads
-- TODAY's row, so yesterday's zeros never make a broken model look healthy.

ALTER TABLE ai_usage_daily
  ADD COLUMN failures bigint NOT NULL DEFAULT 0;
