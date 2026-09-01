import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// A user's paid entitlement (LemonSqueezy). One row per user (unique) — its
// presence-with-an-entitled-status IS the "pro" signal; absence = free. The
// billing webhook is the only writer. No payment PII here: LS identifiers +
// lifecycle status + period boundaries only (migration 0048).
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lsSubscriptionId: text('ls_subscription_id').notNull(),
    lsCustomerId: text('ls_customer_id'),
    lsVariantId: text('ls_variant_id'),
    // LemonSqueezy status: on_trial | active | paused | past_due | unpaid |
    // cancelled | expired. Entitlement is derived from it — see isPro().
    status: text('status').notNull(),
    renewsAt: timestamp('renews_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUniq: uniqueIndex('billing_subscriptions_user_uniq').on(t.userId),
    subUniq: uniqueIndex('billing_subscriptions_ls_sub_uniq').on(t.lsSubscriptionId),
    status: index('billing_subscriptions_status').on(t.status),
  }),
);

export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
