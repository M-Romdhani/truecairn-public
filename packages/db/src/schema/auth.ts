import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { deviceRegistrations } from './devices.js';
import { users } from './users.js';

// Drizzle's typed view of the Phase 3.1 auth tables (migration 0019). The raw
// SQL migration is the source of truth for the DB; these definitions are the
// typed query layer. Partial-index WHERE clauses live in the migration, not
// here (same convention as device_registrations).

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

// A SESSION = API access via a login credential. Validity is computed, never
// stored as a status. The server holds only SHA-256(token), never the token.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    deviceRegistrationId: uuid('device_registration_id').references(() => deviceRegistrations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    lastStepupAt: timestamp('last_stepup_at', { withTimezone: true }),
    createdIpHash: bytea('created_ip_hash'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => ({
    tokenHashUniq: uniqueIndex('sessions_token_hash_uniq').on(t.tokenHash),
    userActive: index('sessions_user_active').on(t.userId),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

// The account owner's WebAuthn authenticators: passkeys (login) and roaming
// hardware keys (is_hardware_key = true, the step-up tap).
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: bytea('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array(),
    aaguid: bytea('aaguid'),
    isHardwareKey: boolean('is_hardware_key').notNull().default(false),
    nickname: text('nickname'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    credentialIdUniq: uniqueIndex('webauthn_credentials_credential_id_uniq').on(t.credentialId),
    user: index('webauthn_credentials_user').on(t.userId),
  }),
);

export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert;

// Optional fallback factor. The login password is Argon2id-hashed and is NOT
// the master passphrase; it unlocks no keys and is never accepted standalone.
export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  argon2Phc: text('argon2_phc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PasswordCredential = typeof passwordCredentials.$inferSelect;
export type NewPasswordCredential = typeof passwordCredentials.$inferInsert;

// TOTP secret encrypted under a server KEK. Session-auth factor only.
export const totpCredentials = pgTable('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  secretNonce: bytea('secret_nonce').notNull(),
  // Id of the server KEK that wrapped secret_ciphertext (KEK versioning).
  kekId: text('kek_id').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TotpCredential = typeof totpCredentials.$inferSelect;
export type NewTotpCredential = typeof totpCredentials.$inferInsert;

// Single-use, short-lived, server-issued challenges for WebAuthn ceremonies and
// the step-up signature. Consumed atomically on verification.
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    challenge: bytea('challenge').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    lookup: index('auth_challenges_lookup').on(t.userId, t.purpose),
  }),
);

export type AuthChallenge = typeof authChallenges.$inferSelect;
export type NewAuthChallenge = typeof authChallenges.$inferInsert;

// Rate-limit / lockout accounting over a sliding window.
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    identifier: text('identifier').notNull(),
    ipHash: bytea('ip_hash'),
    succeeded: boolean('succeeded').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    window: index('auth_attempts_window').on(t.scope, t.identifier, t.attemptedAt),
    ipWindow: index('auth_attempts_ip_window').on(t.scope, t.ipHash, t.attemptedAt),
  }),
);

export type AuthAttempt = typeof authAttempts.$inferSelect;
export type NewAuthAttempt = typeof authAttempts.$inferInsert;

// Non-user-scoped security/ops signals (e.g. ip.sustained_abuse). NOT the
// per-user hash-chained audit_log — see migration 0022.
export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    ipHash: bytea('ip_hash'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeTime: index('security_events_type_time').on(t.eventType, t.createdAt),
  }),
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;
