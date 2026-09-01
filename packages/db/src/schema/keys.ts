import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { contacts } from './contacts.js';
import { vaultTierEnum } from './enums.js';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const userKeyMaterial = pgTable('user_key_material', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  masterPassphraseSalt: bytea('master_passphrase_salt').notNull(),
  masterKeyWrappedByPassphrase: bytea('master_key_wrapped_by_passphrase').notNull(),
  masterKeyPassphraseNonce: bytea('master_key_passphrase_nonce').notNull(),
  recoveryCodeSalt: bytea('recovery_code_salt').notNull(),
  masterKeyWrappedByRecovery: bytea('master_key_wrapped_by_recovery').notNull(),
  masterKeyRecoveryNonce: bytea('master_key_recovery_nonce').notNull(),
  releasePassphraseSalt: bytea('release_passphrase_salt').notNull(),
  auditSigningPubkey: bytea('audit_signing_pubkey').notNull(),
  // The owner's write-only capture PUBLIC key (docs/34). Nullable: accounts
  // enrolled before capture existed have none until the next web unlock derives
  // and publishes it. A phone may hold this value; holding it grants the ability
  // to seal a new item and nothing else.
  vaultCapturePubkey: bytea('vault_capture_pubkey'),
  generation: integer('generation').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outerLayerKeys = pgTable(
  'outer_layer_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tier: vaultTierEnum('tier').notNull(),
    kekId: text('kek_id').notNull(),
    outerKeyEncrypted: bytea('outer_key_encrypted').notNull(),
    outerKeyNonce: bytea('outer_key_nonce').notNull(),
    outerKeyEncryptionAad: bytea('outer_key_encryption_aad').notNull(),
    generation: integer('generation').notNull().default(1),
    releasedToCeremonyId: uuid('released_to_ceremony_id'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Partial UNIQUE in SQL (WHERE released_at IS NULL AND rotated_at IS NULL):
    // at most one active outer key per (user, tier), so lazy provisioning on
    // first store can't race two in. Drizzle can't express the predicate; the
    // raw migration (0024) is authoritative.
    userTierActive: uniqueIndex('outer_layer_keys_user_tier_active').on(t.userId, t.tier),
  }),
);

export const userTierKeys = pgTable(
  'user_tier_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: vaultTierEnum('tier').notNull(),
    tierKeyWrappedByMaster: bytea('tier_key_wrapped_by_master').notNull(),
    tierKeyMasterNonce: bytea('tier_key_master_nonce').notNull(),
    outerLayerKeyId: uuid('outer_layer_key_id')
      .notNull()
      .references(() => outerLayerKeys.id),
    shamirThreshold: smallint('shamir_threshold'),
    shamirShareCount: smallint('shamir_share_count'),
    generation: integer('generation').notNull().default(1),
    tierKeyCheckPlaintext: bytea('tier_key_check_plaintext').notNull(),
    tierKeyCheckCiphertext: bytea('tier_key_check_ciphertext').notNull(),
    tierKeyCheckNonce: bytea('tier_key_check_nonce').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.tier] }),
  }),
);

export const s1TierKeyEnvelopes = pgTable(
  's1_tier_key_envelopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    sealedBoxCiphertext: bytea('sealed_box_ciphertext').notNull(),
    generation: integer('generation').notNull().default(1),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => s1TierKeyEnvelopes.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    active: uniqueIndex('s1_tier_key_envelopes_active').on(t.userId, t.contactId),
    user: index('s1_tier_key_envelopes_user').on(t.userId),
  }),
);

export type UserKeyMaterial = typeof userKeyMaterial.$inferSelect;
export type OuterLayerKey = typeof outerLayerKeys.$inferSelect;
export type UserTierKey = typeof userTierKeys.$inferSelect;
export type S1TierKeyEnvelope = typeof s1TierKeyEnvelopes.$inferSelect;
