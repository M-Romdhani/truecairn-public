import {
  bigint,
  customType,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { VaultCategory } from '@truecairn/shared';
import { vaultTierEnum } from './enums.js';
import { outerLayerKeys } from './keys.js';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const vaultItems = pgTable(
  'vault_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: vaultTierEnum('tier').notNull(),
    // Bounded by CHECK `vault_items_category_vocabulary` (migration 0065) to the
    // eight rows of docs/03's release-policy matrix, not by a pgEnum — adding a
    // ninth category is then one ALTER rather than a type migration. `$type` is
    // what makes the vocabulary visible to TypeScript; the constraint is what
    // makes it true.
    category: text('category').$type<VaultCategory>().notNull(),
    // ── At-rest form: the server-applied outer temporal-gate envelope (§c/Q1).
    // The inner bundle (content ciphertext + wrapped-per-item-key) is sealed
    // inside outer_ciphertext via packages/keys applyOuterLayerWrap; it exists
    // un-enveloped ONLY in transit (request/response). outer_kek_id +
    // outer_generation are denormalised from the outer_layer_keys row used, so
    // the wrap AAD (buildOuterLayerAad: user_id, tier, kek_id, generation) can be
    // rebuilt on fetch without a join.
    outerCiphertext: bytea('outer_ciphertext').notNull(),
    outerNonce: bytea('outer_nonce').notNull(),
    outerLayerKeyId: uuid('outer_layer_key_id')
      .notNull()
      .references(() => outerLayerKeys.id),
    outerKekId: text('outer_kek_id').notNull(),
    outerGeneration: integer('outer_generation').notNull(),
    contentSizeBytes: integer('content_size_bytes').notNull(),
    titleCiphertext: bytea('title_ciphertext').notNull(),
    titleNonce: bytea('title_nonce').notNull(),
    // Which AAD construction the per-item key and the title were sealed with
    // (migration 0062). 1 = tier-only key AAD + no title AAD; 2 = both bound to
    // this row's id. Writers only ever emit 2. The server supplies this to the
    // client, and getting it wrong makes the AEAD fail rather than weakening the
    // binding — it can deny, not downgrade.
    aadVersion: smallint('aad_version').notNull().default(1),
    clientOrdinal: integer('client_ordinal'),
    // One-version, seed-once-per-window content backup (PHASE3_3 Q4). The first
    // content overwrite after the slot is empty/expired copies the displaced
    // envelope here + stamps backup_at; later overwrites within 7 days don't
    // touch it, so a double-overwrite can't destroy the pre-burst version. Same
    // outer key as the live envelope (a content PATCH keeps the tier). Cleared on
    // revert and on a tier move (whose envelope is keyed to a different tier).
    backupOuterCiphertext: bytea('backup_outer_ciphertext'),
    backupOuterNonce: bytea('backup_outer_nonce'),
    backupContentSizeBytes: integer('backup_content_size_bytes'),
    backupAt: timestamp('backup_at', { withTimezone: true }),
    // Set when a delete_vault_item is queued; the item is still visible (flagged)
    // during the 7-day cooldown, cleared on cancel, and the handler sets
    // deleted_at when it applies.
    pendingDeleteAt: timestamp('pending_delete_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userTier: index('vault_items_user_tier').on(t.userId, t.tier),
    userCategory: index('vault_items_user_category').on(t.userId, t.category),
  }),
);

export type VaultItem = typeof vaultItems.$inferSelect;
export type NewVaultItem = typeof vaultItems.$inferInsert;

// Write-only captures from a phone (docs/34), awaiting the owner's filing.
//
// A DIFFERENT table from vaultItems on purpose (D3): a vaultItems row is
// unwrappable from its tier key, which is the property a release ceremony
// depends on. A capture is sealed to a master-derived key no ceremony
// reconstructs, so it can only ever be opened by the owner in a browser. Keeping
// the two apart means the release path cannot pick up something it will not be
// able to read — and D4's honest consequence (an unfiled capture is outside the
// release ladder) is enforced by the schema, not by a query remembering to
// filter.
export const vaultCaptures = pgTable(
  'vault_captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: vaultTierEnum('tier').notNull(),
    sealedCaptureKey: bytea('sealed_capture_key').notNull(),
    payloadNonce: bytea('payload_nonce').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storagePath: text('storage_path').notNull(),
    status: text('status').notNull().default('pending_upload'),
    // See attachments.uploadClaim (migration 0059) — the identity of the
    // in-flight upload holding the 'uploading' slot.
    uploadClaim: uuid('upload_claim'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user: index('vault_captures_user').on(t.userId),
    userStatus: index('vault_captures_user_status').on(t.userId, t.status, t.createdAt),
  }),
);

export type VaultCapture = typeof vaultCaptures.$inferSelect;
