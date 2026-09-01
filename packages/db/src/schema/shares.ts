import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  customType,
  index,
  integer,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { contacts } from './contacts.js';
import { shareTypeEnum, vaultTierEnum } from './enums.js';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const releaseShares = pgTable(
  'release_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: vaultTierEnum('tier').notNull(),
    shareIndex: smallint('share_index').notNull(),
    shareType: shareTypeEnum('share_type').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id),
    wrappedShareCiphertext: bytea('wrapped_share_ciphertext'),
    passphraseSalt: bytea('passphrase_salt'),
    hardwareKeyId: uuid('hardware_key_id'),
    generation: integer('generation').notNull().default(1),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => releaseShares.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    activeIndex: uniqueIndex('release_shares_active_index').on(t.userId, t.tier, t.shareIndex),
  }),
);

export type ReleaseShare = typeof releaseShares.$inferSelect;
export type NewReleaseShare = typeof releaseShares.$inferInsert;

// Designated beneficiaries (backlog #2): a contact named to RECEIVE an S2/S3
// release without holding a share or affirming. Append-only-with-revocation,
// like release_shares. See migration 0031.
export const releaseBeneficiaries = pgTable(
  'release_beneficiaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: vaultTierEnum('tier').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    active: uniqueIndex('release_beneficiaries_active').on(t.userId, t.tier, t.contactId),
    userTier: index('release_beneficiaries_user_tier').on(t.userId, t.tier),
  }),
);

export type ReleaseBeneficiary = typeof releaseBeneficiaries.$inferSelect;
export type NewReleaseBeneficiary = typeof releaseBeneficiaries.$inferInsert;
