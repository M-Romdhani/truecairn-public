import {
  bigint,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    eventType: text('event_type').notNull(),
    eventPayload: jsonb('event_payload').notNull(),
    prevEntryHash: bytea('prev_entry_hash'),
    entryHash: bytea('entry_hash').notNull(),
    serverSignature: bytea('server_signature').notNull(),
    serverKeyId: text('server_key_id').notNull(),
    userSignature: bytea('user_signature'),
    serverTimestamp: timestamp('server_timestamp', { withTimezone: true }).notNull().defaultNow(),
    clientTimestamp: timestamp('client_timestamp', { withTimezone: true }),
    // WHO caused this entry (migration 0035): 'owner' | 'worker' | 'ai'. Forensic
    // metadata, NOT part of the signed canonical hash — the verifier ignores it.
    // Only the ai-authority chokepoint ever writes 'ai'.
    actor: text('actor').notNull().default('owner'),
  },
  (t) => ({
    userSeqUniq: uniqueIndex('audit_log_user_id_seq_key').on(t.userId, t.seq),
    userTime: index('audit_log_user_time').on(t.userId, t.serverTimestamp),
  }),
);

export const auditLogLocks = pgTable('audit_log_locks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
});

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
