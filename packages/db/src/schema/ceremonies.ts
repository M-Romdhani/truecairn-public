import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditLog } from './audit.js';
import { contacts } from './contacts.js';
import {
  affirmationStatusEnum,
  ceremonyStatusEnum,
  recipientReconstructionStatusEnum,
  vaultTierEnum,
} from './enums.js';
import { releaseShares } from './shares.js';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const releaseCeremonies = pgTable(
  'release_ceremonies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tier: vaultTierEnum('tier').notNull(),
    status: ceremonyStatusEnum('status').notNull().default('initiated'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    syncWindowExpiresAt: timestamp('sync_window_expires_at', { withTimezone: true }).notNull(),
    outerKeyReleasedAt: timestamp('outer_key_released_at', { withTimezone: true }),
    reconstructionStartedAt: timestamp('reconstruction_started_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    failureReason: text('failure_reason'),
    auditIdInitiated: uuid('audit_id_initiated').references(() => auditLog.id),
    auditIdTerminal: uuid('audit_id_terminal').references(() => auditLog.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    active: index('release_ceremonies_active').on(t.userId, t.status),
  }),
);

export const ceremonyAffirmations = pgTable(
  'ceremony_affirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ceremonyId: uuid('ceremony_id')
      .notNull()
      .references(() => releaseCeremonies.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    // Nullable: S1 affirmations reference no Shamir share (S1 is a full sealed
    // envelope in s1_tier_key_envelopes). Set for S2/S3. See migration 0030.
    shareId: uuid('share_id').references(() => releaseShares.id),
    status: affirmationStatusEnum('status').notNull().default('pending'),
    affirmedAt: timestamp('affirmed_at', { withTimezone: true }),
    revocationWindowExpiresAt: timestamp('revocation_window_expires_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Set the first time this contact disputes; the compare-and-swap target that
    // makes /dispute idempotent (migration 0057). NULL = has not disputed.
    disputedAt: timestamp('disputed_at', { withTimezone: true }),
    contactAffirmationSignature: bytea('contact_affirmation_signature'),
    auditIdAffirmed: uuid('audit_id_affirmed').references(() => auditLog.id),
    auditIdTerminal: uuid('audit_id_terminal').references(() => auditLog.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ceremonyContactUniq: uniqueIndex('ceremony_affirmations_ceremony_id_contact_id_key').on(
      t.ceremonyId,
      t.contactId,
    ),
    window: index('ceremony_affirmations_window').on(t.revocationWindowExpiresAt),
  }),
);

export const ceremonyRecipients = pgTable(
  'ceremony_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ceremonyId: uuid('ceremony_id')
      .notNull()
      .references(() => releaseCeremonies.id, { onDelete: 'cascade' }),
    recipientContactId: uuid('recipient_contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    ephemeralPubkey: bytea('ephemeral_pubkey'),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    status: recipientReconstructionStatusEnum('status').notNull().default('pending'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    auditId: uuid('audit_id').references(() => auditLog.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ceremonyContactUniq: uniqueIndex('ceremony_recipients_ceremony_id_recipient_contact_id_key').on(
      t.ceremonyId,
      t.recipientContactId,
    ),
    ceremony: index('ceremony_recipients_ceremony').on(t.ceremonyId),
  }),
);

export const ceremonyAffirmationShares = pgTable(
  'ceremony_affirmation_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    affirmationId: uuid('affirmation_id')
      .notNull()
      .references(() => ceremonyAffirmations.id, { onDelete: 'cascade' }),
    recipientContactId: uuid('recipient_contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    sealedShareCiphertext: bytea('sealed_share_ciphertext').notNull(),
    shareSignature: bytea('share_signature').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    affirmationRecipientUniq: uniqueIndex(
      'ceremony_affirmation_shares_affirmation_id_recipient_contact_id_key',
    ).on(t.affirmationId, t.recipientContactId),
    affirmation: index('ceremony_affirmation_shares_affirmation').on(t.affirmationId),
  }),
);

export type ReleaseCeremony = typeof releaseCeremonies.$inferSelect;
export type CeremonyAffirmation = typeof ceremonyAffirmations.$inferSelect;
export type CeremonyRecipient = typeof ceremonyRecipients.$inferSelect;
export type CeremonyAffirmationShare = typeof ceremonyAffirmationShares.$inferSelect;
