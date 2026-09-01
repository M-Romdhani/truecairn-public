import {
  customType,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { RecipientType } from '@truecairn/shared';
import { contactKeyTypeEnum, contactRoleEnum, contactStatusEnum } from './enums.js';
import { users } from './users.js';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactUserId: uuid('contact_user_id').references(() => users.id),
    role: contactRoleEnum('role').notNull(),
    // The docs/03 recipient type (migration 0066). A SECOND axis over `role`,
    // never a replacement: `role` is the collusion bar that `diverseRoleSatisfied`
    // reads, and two professional types deliberately collapse to one role. Two
    // CHECKs back this — one bounding the vocabulary, one forcing the type to
    // agree with the role, so even a hand-edit cannot change what diversity means
    // for a contact. Nullable so a contact whose owner has not answered the
    // question yet reads as "not chosen" rather than claiming a backfilled guess.
    recipientType: text('recipient_type').$type<RecipientType>(),
    status: contactStatusEnum('status').notNull().default('invited'),
    displayLabelCiphertext: bytea('display_label_ciphertext').notNull(),
    displayLabelNonce: bytea('display_label_nonce').notNull(),
    inviteTokenHash: bytea('invite_token_hash'),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    // ── COLUMN CONTRACT (PHASE3_2) ─────────────────────────────────────────────
    // contact_x25519_pubkey / contact_ed25519_pubkey may hold UNVERIFIED public
    // keys while status='pending_keygen': the contact's device stages its
    // candidate keys here at /enroll/options BEFORE proving possession, and they
    // are only PROVEN (sealed-box nonce round-trip for X25519, signature for
    // Ed25519) at /enroll/verify, which flips status to 'enrolled'. Therefore any
    // reader that treats these as trusted keys — wrapping a share to X25519,
    // verifying an affirmation against Ed25519 — MUST filter on
    // status='enrolled' (or 'active'); reading them at status='pending_keygen'
    // means trusting an unproven key. The share-assignment endpoint enforces this
    // (409 contact-not-enrolled) and the add_contact handler re-checks at apply.
    contactX25519Pubkey: bytea('contact_x25519_pubkey'),
    contactEd25519Pubkey: bytea('contact_ed25519_pubkey'),
    // ── The owner's out-of-band confirmation of the two keys above (0061) ─────
    // "Proven" in the contract above means proven TO THE SERVER: the possession
    // proof is issued and verified by the same party that stores the result, so
    // it says nothing to the owner about whose key this is. These columns carry
    // the owner's own answer to that question — the confirmed key bytes sealed
    // under their S1 tier key, AAD-bound to (owner, contact). The server cannot
    // forge one and cannot move one between rows; deleting one fails closed to
    // "unverified", which blocks sealing rather than allowing it.
    keyPinCiphertext: bytea('key_pin_ciphertext'),
    keyPinNonce: bytea('key_pin_nonce'),
    keyPinConfirmedAt: timestamp('key_pin_confirmed_at', { withTimezone: true }),

    // Which key the label and the pin above are encrypted under (migration 0068).
    // 1 = the S1 tier key (the form that leaked to the S1 beneficiary),
    // 2 = the master-derived 'tc-cmeta' key. Readers accept both; writers emit 2.
    contactPinVersion: smallint('contact_pin_version').notNull().default(1),
    affirmationKeyType: contactKeyTypeEnum('affirmation_key_type').notNull().default('ed25519'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerStatus: index('contacts_owner_status').on(t.ownerUserId, t.status),
    inviteTokenUniq: uniqueIndex('contacts_invite_token_uniq').on(t.inviteTokenHash),
    ownerContactUniq: uniqueIndex('contacts_owner_contact_uniq').on(t.ownerUserId, t.contactUserId),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
