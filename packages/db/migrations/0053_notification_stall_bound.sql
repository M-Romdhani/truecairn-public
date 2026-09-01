-- Bound the NOTIFICATION_STALLED state (2026-07-25).
--
-- THE BUG. NOTIFICATION_STALLED is entered when EVERY one of the owner's
-- channels is failing, and until now it exited only when one recovered. No
-- timeout, no escalation, no path onward. It was fail-safe against a wrongful
-- release and, in exchange, it guaranteed a wrongful NON-release: if the owner
-- genuinely dies and their channels then fail — a dead person's email starts
-- bouncing, their number gets recycled, push subscriptions expire, all of which
-- are CORRELATED with dying — the engine parks here permanently and the vault is
-- never delivered. The product silently failing at the one thing it exists to
-- do, with nobody alive to notice.
--
-- THE FIX (owner-ratified 2026-07-25). After notification_stall_max_days of
-- total unreachability the engine resumes the ladder at ESCALATION_PENDING
-- rather than stalling forever. This is deliberately NOT a shortcut to release:
--   * escalation_pending is in CHECKIN_STATES, so a recovered channel still lets
--     the owner stop everything with one tap;
--   * it burns the full escalation cooldown before release_review;
--   * and the actual protection against a false release was never the
--     notification — it is the ceremony consensus, where contacts must affirm
--     above threshold with role diversity and can dispute at any point.
--
-- Default 30 days: long enough that a provider outage or an expired push
-- subscription cannot trip it, short enough that a vault is not lost forever.
-- Per-user because the whole ladder is per-user tunable.

ALTER TABLE engine_states
  ADD COLUMN notification_stall_max_days integer NOT NULL DEFAULT 30;
