import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Cache + production-evidence for the AI continuity-readiness briefing (Build with
// Gemini XPRIZE AI-native feature). One row per user — the latest briefing. The
// GET /v1/briefing route reuses it while inputs_hash is unchanged and the row is
// within its TTL, and regenerates (overwrites) otherwise.
//
// ZERO-KNOWLEDGE: the text is produced from METADATA ONLY (engine state + vault/
// contact counts) — never vault content, contact labels, emails, or any secret —
// so storing it at rest here does not cross the boundary (CLAUDE.md invariant #1).
// It is still kept out of logs by construction.
export const aiBriefings = pgTable('ai_briefings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  inputsHash: text('inputs_hash').notNull(),
  briefingText: text('briefing_text').notNull(),
  model: text('model').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AiBriefingRow = typeof aiBriefings.$inferSelect;
