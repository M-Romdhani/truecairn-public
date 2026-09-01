import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { vaultItems } from './vault.js';

// An attachment is an OPAQUE client-encrypted blob on local disk (PHASE3_3 §d,
// Q5). The server does no crypto on it: the per-attachment key lives in the
// parent vault item's outer-wrapped content, so the temporal gate is inherited.
// This row holds only the bytes' location + size + lifecycle status.
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultItemId: uuid('vault_item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    // 'pending_upload' → 'uploading' (slot claimed) → 'stored' (budget reserved,
    // bytes on disk) | 'failed'. 'failed' is claimable again, so a rolled-back
    // upload can be retried.
    status: text('status').notNull().default('pending_upload'),
    // Identity of the in-flight upload holding the 'uploading' slot (migration
    // 0059). Status alone cannot distinguish the original claim from a takeover,
    // so the terminal write and both rollbacks predicate on this token. NULL =
    // no upload in flight.
    uploadClaim: uuid('upload_claim'),
    storagePath: text('storage_path').notNull(),
    pendingDeleteAt: timestamp('pending_delete_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    item: index('attachments_item').on(t.vaultItemId),
    user: index('attachments_user').on(t.userId),
  }),
);

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
