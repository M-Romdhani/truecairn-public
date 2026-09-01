-- 0050_remove_channel_plan_downgraded.sql
-- Two additive enum values (docs/26 §4 follow-ons + docs/28 downgrade notice).
--
-- remove_channel: removing a VERIFIED notification channel becomes a sensitive
-- action (step-up + cooldown). A stolen session silencing the owner's check-in
-- reminders was the accepted-risk noted in docs/26 §4; this closes it. Per
-- docs/10-threat-5.2 the channel being removed still receives the notice
-- during the delay. Unverified channels (never selected for notices) keep
-- immediate removal.
--
-- plan_downgraded: the one-time owner notice on the entitled→not-entitled
-- billing edge while paid channels (SMS/WhatsApp) remain enrolled. The
-- channels keep delivering — the notice says so; nothing is re-gated.
ALTER TYPE sensitive_action_type ADD VALUE IF NOT EXISTS 'remove_channel';
ALTER TYPE notification_purpose ADD VALUE IF NOT EXISTS 'plan_downgraded';
