import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  cvPurposeClassEnum,
  deliveryStatusEnum,
  notificationChannelHealthEnum,
  notificationChannelTypeEnum,
  notificationPurposeEnum,
} from './enums.js';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelType: notificationChannelTypeEnum('channel_type').notNull(),
    destination: text('destination').notNull(),
    destinationHash: bytea('destination_hash').notNull(),
    verified: boolean('verified').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    // Channel-enrolment code round-trip (CV-0.0, migration 0044). The code is
    // hashed at rest; attempts are bounded and the code expires, so a leaked
    // hash or a guessing session is time- and count-boxed.
    verificationCodeHash: bytea('verification_code_hash'),
    verificationExpiresAt: timestamp('verification_expires_at', { withTimezone: true }),
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    health: notificationChannelHealthEnum('health').notNull().default('healthy'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    user: index('notification_channels_user').on(t.userId),
    userDestUniq: uniqueIndex('notification_channels_user_dest_uniq').on(
      t.userId,
      t.channelType,
      t.destinationHash,
    ),
  }),
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    purpose: notificationPurposeEnum('purpose').notNull(),
    relatedEntityType: text('related_entity_type'),
    relatedEntityId: uuid('related_entity_id'),
    status: deliveryStatusEnum('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    lastError: text('last_error'),
    payloadSummary: text('payload_summary'),
    // Per-delivery template parameters (CV-0.0). Only the channel-enrolment
    // route writes it, only renderTemplate('channel_verification') reads it,
    // and the processor nulls it once the provider accepts the send.
    payloadParams: jsonb('payload_params').$type<Record<string, string>>(),
    // Set by the delivery worker on a send: which provider accepted it + the
    // provider's message id, so an async delivered/bounced webhook can correlate
    // back to this row (PHASE3_5). The row id is the idempotency key, not these.
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    // Continuity Verification cadence bookkeeping (docs/26, migration 0045):
    // the engine episode being verified (its state_entered_at) + the wave
    // number. Set ONLY by the cv-cadence sweep; the partial unique index over
    // (user, purpose, channel, episode, wave) is its idempotency guarantee.
    cvEpisodeAt: timestamp('cv_episode_at', { withTimezone: true }),
    cvWave: integer('cv_wave'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    due: index('notification_deliveries_due').on(t.nextAttemptAt),
    user: index('notification_deliveries_user').on(t.userId, t.createdAt),
  }),
);

// The owner-defined channel matrix (docs/26 §3.1). ABSENT ROW = ENABLED: a row
// exists only to opt a channel out of a purpose class, so pre-CV accounts (and
// owners who never touch the matrix) keep today's behaviour exactly.
export const channelPreferences = pgTable(
  'channel_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    purposeClass: cvPurposeClassEnum('purpose_class').notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('channel_preferences_pk').on(t.channelId, t.purposeClass),
    user: index('channel_preferences_user').on(t.userId),
  }),
);

export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type ChannelPreference = typeof channelPreferences.$inferSelect;
