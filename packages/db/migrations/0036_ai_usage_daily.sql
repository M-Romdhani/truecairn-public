-- 0036_ai_usage_daily.sql
-- AI cost circuit-breaker accounting (plan docs/25 §4 task 0.2).
--
-- A per-day token/call counter feeding the breaker: when a day's global total or a
-- user's daily total exceeds its configured budget, advisory AI surfaces go
-- 'unavailable' and the guardian falls back to a deterministic template — WITHOUT
-- touching the vault, engine, ceremonies, or auth. Metadata-only accounting: token
-- counts and call counts, never a prompt or any user content.
--
-- One row per (day, user_id). user_id NULL is the GLOBAL rollup for the day. The
-- unique index is NULLS NOT DISTINCT (Postgres 15+) so the global row upserts on
-- (day, NULL) like any other — a single ON CONFLICT (day, user_id) target serves
-- both the per-user and the global bump.
CREATE TABLE ai_usage_daily (
  day        date NOT NULL,
  user_id    uuid REFERENCES users (id) ON DELETE CASCADE,
  tokens_in  bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  calls      bigint NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX ai_usage_daily_day_user_key
  ON ai_usage_daily (day, user_id) NULLS NOT DISTINCT;
