-- 0051_continuity_narration.sql
-- AI narration of the Continuity Report (Gap plan G-1, docs/26). Narration
-- lives BESIDE the sealed evidence, never inside it: the `payload` TEXT and
-- the audit-anchored sha256 over its exact bytes are untouched — the
-- snapshot-immutability guarantee survives byte-for-byte. All four columns
-- nullable: NULL means "no narration yet" and the UI renders the
-- deterministic template; a fill-only-NULL update gives generate-once
-- semantics. Narration failure can never block a report or a release.
ALTER TABLE continuity_reports
  ADD COLUMN narration_text text,
  ADD COLUMN narration_model_id text,
  ADD COLUMN narration_template_id text,
  ADD COLUMN narration_generated_at timestamptz;
