-- 0029_notification_delivery_provider.sql
-- Notification routing (PHASE3_5 Checkpoint A). Adds the columns the delivery
-- worker records on a send and the purpose for the deferred 3.1 anomaly notice.
--
-- provider / provider_message_id correlate an async provider webhook (delivered /
-- bounced) back to the row. The delivery row's id is already the stable idempotency
-- key handed to the provider, so no column is needed for the KEY itself.
ALTER TABLE notification_deliveries
  ADD COLUMN provider text,
  ADD COLUMN provider_message_id text;

-- security_alert: the user-facing notice for the 3.1 account-lock anomaly (the
-- account-lock -> notify wiring lands in Checkpoint B). ADD VALUE runs in the
-- migrator transaction as long as the value isn't used in the same transaction.
ALTER TYPE notification_purpose ADD VALUE IF NOT EXISTS 'security_alert';
