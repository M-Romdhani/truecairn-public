-- 0046_whatsapp_channel_type.sql
-- Continuity Verification CV-3 (docs/26 §4): WhatsApp joins the channel-type
-- enum. Additive only — same ADD VALUE pattern as 0028/0044 (runs in the
-- migrator transaction as long as the value isn't used in the same file).
-- The transport is the Twilio Messages API with whatsapp:-prefixed addresses;
-- production business-initiated sends additionally wait on Meta template
-- approval (the external clock), which is an ops step, not a schema one.
ALTER TYPE notification_channel_type ADD VALUE IF NOT EXISTS 'whatsapp';
