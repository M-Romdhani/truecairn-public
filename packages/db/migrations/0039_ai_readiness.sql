-- 0039_ai_readiness.sql
-- Cache for the AI continuity-readiness report (plan docs/25 §5 / 1.2b).
--
-- The SCORE + GAPS are deterministic (packages-free logic in apps/api/src/ai/
-- readiness.ts); this table caches the friendly LLM EXPLANATION so the dashboard
-- doesn't regenerate prose on every load — reused while inputs_hash is unchanged
-- and within TTL, exactly like ai_briefings. One row per user.
--
-- ZERO-KNOWLEDGE: gaps are closed-enum codes + numbers, explanation is metadata-
-- derived prose (no titles, no content); storing them here crosses no boundary.
CREATE TABLE ai_readiness (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  inputs_hash  text NOT NULL,
  score        integer NOT NULL,
  gaps         jsonb NOT NULL,
  explanation  text NOT NULL,
  -- Whether `explanation` was written by the model or the deterministic template
  -- fallback (breaker/opt-out/disabled) — surfaced for honesty, never hidden.
  llm_written  boolean NOT NULL DEFAULT false,
  model        text,
  generated_at timestamptz NOT NULL DEFAULT now()
);
