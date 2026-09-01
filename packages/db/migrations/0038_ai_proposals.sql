-- 0038_ai_proposals.sql
-- AI proposals (plan docs/25 §5 / Phase 1). The AI reads allowlisted metadata,
-- produces a STRUCTURED proposal, and a human decides — the AI has zero execution
-- authority here. A proposal whose execution is a sensitive action enters the
-- EXISTING sensitive-actions pipeline on approval (never a bespoke mutation path).
--
-- ZERO-KNOWLEDGE / D6: payload holds only validated, closed-schema proposal data
-- (counts, enums, bounded ints, capped display text) — never a raw prompt. The
-- prompt/output HASHES + template id + model id are enough for forensics without a
-- second copy of metadata. No ciphertext, key, or secret is ever stored here.
CREATE TABLE ai_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind               text NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed', 'approved', 'rejected', 'expired', 'executed')),
  -- Which AI surface produced it (assist today; guardian in Phase 3).
  source             text NOT NULL CHECK (source IN ('assist', 'guardian')),
  model_id           text,
  prompt_template_id text,
  prompt_hash        text,
  output_hash        text,
  -- Set when a decision executes a sensitive action, so the proposal links to the
  -- enqueued action for audit. Nullable (informational proposals execute nothing).
  sensitive_action_id uuid REFERENCES sensitive_actions (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  expires_at         timestamptz NOT NULL
);

-- The decision surface lists a user's proposals by status; the expiry sweep scans
-- proposed rows past expires_at.
CREATE INDEX ai_proposals_user_status ON ai_proposals (user_id, status);
CREATE INDEX ai_proposals_expiry ON ai_proposals (status, expires_at);
