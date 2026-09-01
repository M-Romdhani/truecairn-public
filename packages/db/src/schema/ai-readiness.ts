import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Cache for the AI continuity-readiness report (migration 0039). The score + gaps
// are deterministic; this caches the LLM-written explanation (with a template
// fallback) so the dashboard doesn't regenerate prose every load. Mirrors
// ai_briefings: reused while inputs_hash is unchanged + within TTL.
export const aiReadiness = pgTable('ai_readiness', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  inputsHash: text('inputs_hash').notNull(),
  score: integer('score').notNull(),
  gaps: jsonb('gaps').notNull(),
  explanation: text('explanation').notNull(),
  llmWritten: boolean('llm_written').notNull().default(false),
  model: text('model'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AiReadinessRow = typeof aiReadiness.$inferSelect;
