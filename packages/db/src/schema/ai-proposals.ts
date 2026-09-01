import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sensitiveActions } from './sensitive-actions.js';
import { users } from './users.js';

// AI proposals (migration 0038, plan docs/25 §5). The AI proposes; a human decides.
// A proposal has ZERO execution authority — an executable one enters the existing
// sensitive-actions pipeline on approval, linked here via sensitive_action_id.
//
// ZERO-KNOWLEDGE / D6: payload holds only validated closed-schema data (counts,
// enums, bounded ints, capped display text); the prompt is NEVER stored — only its
// salted hash + template id + model id + output hash, for forensics.
export const aiProposals = pgTable(
  'ai_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    // proposed → approved | rejected | expired | executed. CHECK lives in the SQL.
    status: text('status').notNull().default('proposed'),
    // 'assist' (owner-surface) today; 'guardian' in Phase 3.
    source: text('source').notNull(),
    modelId: text('model_id'),
    promptTemplateId: text('prompt_template_id'),
    promptHash: text('prompt_hash'),
    outputHash: text('output_hash'),
    // Links an executed proposal to the sensitive action it enqueued (audit).
    sensitiveActionId: uuid('sensitive_action_id').references(() => sensitiveActions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    userStatus: index('ai_proposals_user_status').on(t.userId, t.status),
    expiry: index('ai_proposals_expiry').on(t.status, t.expiresAt),
  }),
);

export type AiProposalRow = typeof aiProposals.$inferSelect;
export type NewAiProposal = typeof aiProposals.$inferInsert;
