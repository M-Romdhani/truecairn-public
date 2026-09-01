import { bigint, date, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Per-day AI token/call accounting for the cost circuit-breaker (migration 0036).
// One row per (day, user_id); user_id NULL is the GLOBAL rollup for that day. The
// unique index is NULLS NOT DISTINCT so the global row upserts like any other.
//
// ZERO-KNOWLEDGE: counts only — never a prompt, a response, or any user content.
export const aiUsageDaily = pgTable(
  'ai_usage_daily',
  {
    day: date('day').notNull(),
    // NULL = global rollup for the day.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    // Successful model calls only — bumped by recordAiUsage on the success path.
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    // Calls that threw (migration 0058). The pair (calls, failures) is what lets
    // an ops check tell "the model is broken" from "nobody used the app today";
    // before it existed both looked identical, because a failure wrote nothing.
    failures: bigint('failures', { mode: 'number' }).notNull().default(0),
  },
  (t) => ({
    dayUser: uniqueIndex('ai_usage_daily_day_user_key').on(t.day, t.userId),
  }),
);

export type AiUsageDailyRow = typeof aiUsageDaily.$inferSelect;
