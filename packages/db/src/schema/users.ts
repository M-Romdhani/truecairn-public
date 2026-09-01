import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accountStatusEnum } from './enums.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailLower: text('email_lower')
      .notNull()
      .generatedAlwaysAs(sql`lower(email)`),
    // Optional display name + honorific for the account menu (migration 0049).
    // Pure display metadata like the email — never used for auth/crypto/release.
    displayName: text('display_name'),
    title: text('title'),
    accountStatus: accountStatusEnum('account_status').notNull().default('pending'),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    armedAt: timestamp('armed_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    // Running total of stored attachment-blob bytes, checked + incremented under
    // SELECT ... FOR UPDATE at upload so concurrent uploads can't both overshoot
    // the per-user cap (PHASE3_3 Checkpoint C).
    storageBytesUsed: bigint('storage_bytes_used', { mode: 'number' }).notNull().default(0),
    // Per-user AI opt-out (migration 0037). When true, no LLM call ever includes
    // this user's context. Deterministic guardian detectors still run.
    aiOptOut: boolean('ai_opt_out').notNull().default(false),
    // Per-user AI autonomy opt-in (migration 0040). Default false — the AI may act
    // autonomously (nudges + schedule tightening) only after the owner opts in.
    aiAutonomyEnabled: boolean('ai_autonomy_enabled').notNull().default(false),
    // Floor below which the AI may NEVER autonomously tighten the check-in interval
    // (migration 0040). NULL ⇒ no autonomous tightening at all.
    aiCheckinFloorDays: integer('ai_checkin_floor_days'),
    // Preferred language (migration 0067). NULL ⇒ never expressed a preference,
    // NOT "chose English" — readers resolve it through DEFAULT_LOCALE. The
    // vocabulary is bounded by a CHECK matching LOCALES in @truecairn/shared;
    // locale-lockstep.test.ts keeps the two in step.
    //
    // Read by the server-side notification templates, which run in the worker
    // with no request and no Accept-Language header — a stored value is the only
    // thing available at that moment.
    locale: text('locale'),
    // When the one-time onboarding welcome email was enqueued (migration 0047).
    // Set in the same transaction as the enqueue, so the send is exactly-once
    // per user no matter how many email channels they later verify.
    welcomeEmailSentAt: timestamp('welcome_email_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailLowerUniq: uniqueIndex('users_email_lower_uniq').on(t.emailLower),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
