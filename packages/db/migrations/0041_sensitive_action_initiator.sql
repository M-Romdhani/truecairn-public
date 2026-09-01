-- 0041_sensitive_action_initiator.sql
-- WHO initiated a sensitive action (plan docs/25 §6 / D4).
--
-- 'owner' (the account-holder, via a step-up-gated API route) or 'ai' (the
-- autonomy sweep, via the SAME requestSensitiveAction path — no new mutation
-- machinery). This lets the pending-actions UI name the AI as initiator, lets the
-- per-kind frequency caps count only AI-initiated actions, and gives the audit a
-- forensic marker. Every existing row predates AI autonomy, so 'owner' is correct.
--
-- NOT a step-up bypass: an AI-initiated action carries NO step-up signature and is
-- still fully vetoable during its delay window (the owner cancels it like any other
-- pending action). The delay + veto IS the control for autonomy, exactly as the
-- step-up + delay is the control for an owner-initiated sensitive action.
ALTER TABLE sensitive_actions
  ADD COLUMN initiated_by text NOT NULL DEFAULT 'owner'
  CHECK (initiated_by IN ('owner', 'ai'));
