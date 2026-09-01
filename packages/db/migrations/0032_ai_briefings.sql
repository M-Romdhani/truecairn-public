-- 0032_ai_briefings.sql
-- AI continuity-readiness briefing (Build with Gemini XPRIZE AI-native feature).
--
-- Caches the latest Gemini-generated readiness briefing per user and doubles as
-- "product running" evidence (generated_at + model per user). The briefing is
-- generated from METADATA ONLY (engine state + vault/contact counts) — never
-- vault content, contact labels, or any secret — so storing the text here does
-- not cross the zero-knowledge boundary. One row per user: GET /v1/briefing
-- reuses it while inputs_hash is unchanged and within TTL, else regenerates.
CREATE TABLE ai_briefings (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  inputs_hash   text NOT NULL,
  briefing_text text NOT NULL,
  model         text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
