import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditLog } from './audit.js';
import { engineStateEnum } from './enums.js';
import { users } from './users.js';

export const engineStates = pgTable(
  'engine_states',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: engineStateEnum('state').notNull().default('pre_active'),
    previousState: engineStateEnum('previous_state'),
    stateEnteredAt: timestamp('state_entered_at', { withTimezone: true }).notNull().defaultNow(),
    stateExpiresAt: timestamp('state_expires_at', { withTimezone: true }),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    snoozeUntil: timestamp('snooze_until', { withTimezone: true }),
    currentCeremonyId: uuid('current_ceremony_id'),
    lastCheckInAt: timestamp('last_check_in_at', { withTimezone: true }),
    nextScheduledCheckInAt: timestamp('next_scheduled_check_in_at', { withTimezone: true }),
    inactivityThresholdDays: integer('inactivity_threshold_days').notNull().default(30),
    checkInTimeoutDays: integer('check_in_timeout_days').notNull().default(7),
    escalationCooldownDays: integer('escalation_cooldown_days').notNull().default(14),
    s1ToS2TimerDays: integer('s1_to_s2_timer_days').notNull().default(7),
    s2ToS3TimerDays: integer('s2_to_s3_timer_days').notNull().default(14),
    returningGraceDays: integer('returning_grace_days').notNull().default(7),
    // How long the engine may sit in NOTIFICATION_STALLED (every channel failing)
    // before resuming the ladder anyway. Without a bound, a correlated channel
    // failure after the owner dies parks the engine forever and the vault is
    // never delivered — see migration 0053.
    notificationStallMaxDays: integer('notification_stall_max_days').notNull().default(30),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nextAction: index('engine_states_next_action').on(t.nextActionAt),
  }),
);

export const engineStateHistory = pgTable(
  'engine_state_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    fromState: engineStateEnum('from_state'),
    toState: engineStateEnum('to_state').notNull(),
    reason: text('reason').notNull(),
    relatedAuditId: uuid('related_audit_id').references(() => auditLog.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTime: index('engine_state_history_user_time').on(t.userId, t.occurredAt),
  }),
);

export type EngineStateRow = typeof engineStates.$inferSelect;
export type EngineStateHistoryRow = typeof engineStateHistory.$inferSelect;
