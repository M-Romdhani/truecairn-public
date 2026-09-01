-- 0048_billing_subscriptions.sql
-- Billing (LemonSqueezy). A user's paid entitlement is a single subscription
-- row; ABSENCE of an entitled row = the free plan (no denormalized flag on
-- users to drift out of sync). The webhook upserts this from LemonSqueezy's
-- subscription lifecycle events, keyed by the LS subscription id.
--
-- Entitlement (computed, not stored): pro = status in
-- ('active','on_trial','past_due') OR (status='cancelled' AND ends_at > now) —
-- a cancelled subscription keeps its access until the period ends.
--
-- No plaintext payment data ever lands here: no card, no address, no amount —
-- only the LS identifiers + lifecycle status. Money lives in LemonSqueezy.
CREATE TABLE billing_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  ls_subscription_id  text NOT NULL UNIQUE,
  ls_customer_id      text,
  ls_variant_id       text,
  status              text NOT NULL,
  renews_at           timestamptz,
  ends_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_subscriptions_status ON billing_subscriptions (status);
