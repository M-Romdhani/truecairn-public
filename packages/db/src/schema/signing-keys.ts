import { customType, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const serverSigningKeys = pgTable(
  'server_signing_keys',
  {
    keyId: text('key_id').primaryKey(),
    publicKey: bytea('public_key').notNull(),
    algorithm: text('algorithm').notNull().default('ed25519'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    active: index('server_signing_keys_active').on(t.createdAt),
  }),
);

export type ServerSigningKey = typeof serverSigningKeys.$inferSelect;
