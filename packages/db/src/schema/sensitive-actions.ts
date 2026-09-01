import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditLog } from './audit.js';
import { sessions } from './auth.js';
import { sensitiveActionStatusEnum, sensitiveActionTypeEnum } from './enums.js';
import { users } from './users.js';

export const sensitiveActions = pgTable(
  'sensitive_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actionType: sensitiveActionTypeEnum('action_type').notNull(),
    status: sensitiveActionStatusEnum('status').notNull().default('pending'),
    // WHO initiated it (migration 0041): 'owner' (step-up-gated route) or 'ai'
    // (autonomy sweep, same pipeline, no step-up, still fully vetoable).
    initiatedBy: text('initiated_by').notNull().default('owner'),
    actionPayload: jsonb('action_payload').notNull(),
    requestedBySessionId: uuid('requested_by_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledVia: text('cancelled_via'),
    cancelledReason: text('cancelled_reason'),
    auditIdRequest: uuid('audit_id_request').references(() => auditLog.id),
    auditIdTerminal: uuid('audit_id_terminal').references(() => auditLog.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    due: index('sensitive_actions_due').on(t.effectiveAt),
    userStatus: index('sensitive_actions_user_status').on(t.userId, t.status),
  }),
);

export type SensitiveAction = typeof sensitiveActions.$inferSelect;
export type NewSensitiveAction = typeof sensitiveActions.$inferInsert;
