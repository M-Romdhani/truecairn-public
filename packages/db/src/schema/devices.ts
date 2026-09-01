import { customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const deviceRegistrations = pgTable(
  'device_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    userAgent: text('user_agent'),
    deviceBindingPubkey: bytea('device_binding_pubkey').notNull(),
    lastIpHash: bytea('last_ip_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => ({
    user: index('device_registrations_user').on(t.userId),
  }),
);

export type DeviceRegistration = typeof deviceRegistrations.$inferSelect;
