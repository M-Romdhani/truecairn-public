import { createHash, randomBytes } from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { ContactRole, RecipientType, UserId } from '@truecairn/shared';
import { and, eq, gt, ne } from 'drizzle-orm';

// An invite is good for a week — long enough to reach a busy contact, short
// enough to bound a leaked link.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TOKEN_BYTES = 32;

export interface InviteResult {
  contactId: string;
  // The raw invite token, returned ONCE so the owner can deliver it OUT OF BAND;
  // the server stores only SHA-256(token). The token is a capability, so it is
  // never emailed — invites are owner-delivered by design (there is deliberately
  // no contact_invitation producer; see packages/notifications/src/templates.ts).
  inviteToken: string;
}

// Owner invites a contact. NOT a sensitive action (PHASE3_2 §a Q1): the
// relationship grants no release capability — that is the share assignment,
// which is the gated step.
export async function inviteContact(
  db: Database,
  audit: AuditLogPort,
  input: {
    ownerUserId: UserId;
    role: ContactRole;
    // docs/03 recipient type (0066). Optional: a client that has not been updated
    // still invites successfully, and the row reads "not chosen yet" rather than
    // claiming a type the owner never picked. The route rejects a type that
    // disagrees with `role`, so this can never reach the DB inconsistent.
    recipientType?: RecipientType | undefined;
    displayLabelCiphertext: Uint8Array;
    displayLabelNonce: Uint8Array;
    // Which key the label was encrypted under (0068). Optional: an un-updated
    // client omits it and the column default (1) is the correct reading, because
    // such a client is still writing under the S1 tier key.
    contactPinVersion?: number | undefined;
    now: Date;
  },
): Promise<InviteResult> {
  const raw = randomBytes(INVITE_TOKEN_BYTES);
  const token = raw.toString('base64url');
  const tokenHash = sha256(raw);
  const expiresAt = new Date(input.now.getTime() + INVITE_TTL_MS);

  const contactId = await db.transaction(async (tx) => {
    const tdb = tx as unknown as Database;
    const [row] = await tdb
      .insert(schema.contacts)
      .values({
        ownerUserId: input.ownerUserId,
        role: input.role,
        ...(input.recipientType !== undefined ? { recipientType: input.recipientType } : {}),
        status: 'invited',
        displayLabelCiphertext: input.displayLabelCiphertext,
        displayLabelNonce: input.displayLabelNonce,
        ...(input.contactPinVersion !== undefined
          ? { contactPinVersion: input.contactPinVersion }
          : {}),
        inviteTokenHash: tokenHash,
        inviteExpiresAt: expiresAt,
        invitedAt: input.now,
      })
      .returning({ id: schema.contacts.id });
    if (!row) throw new Error('contacts insert returned no row');
    await audit.append(tdb, input.ownerUserId, 'contact.invited', {
      contactId: row.id,
      role: input.role,
      // Metadata only — an enum, never a name or a label. Recorded because "which
      // KIND of recipient was added" is exactly the sort of thing a disputed
      // release is adjudicated on, and the label itself is ciphertext we cannot read.
      ...(input.recipientType !== undefined ? { recipientType: input.recipientType } : {}),
    });
    return row.id;
  });
  return { contactId, inviteToken: token };
}

export type AcceptResult = { kind: 'ok'; contactId: string } | { kind: 'reject' };

// The contact (authenticated via 3.1) accepts. Atomically claims an unexpired,
// still-'invited' row, binds contact_user_id, burns the token, moves to
// pending_keygen. Self-invites (owner == contact) are refused.
export async function acceptInvite(
  db: Database,
  audit: AuditLogPort,
  input: { contactUserId: UserId; inviteToken: string; now: Date },
): Promise<AcceptResult> {
  const tokenHash = hashPresentedToken(input.inviteToken);
  if (tokenHash === null) return { kind: 'reject' };

  try {
    return await db.transaction(async (tx): Promise<AcceptResult> => {
      const tdb = tx as unknown as Database;
      const rows = await tdb
        .update(schema.contacts)
        .set({
          contactUserId: input.contactUserId,
          status: 'pending_keygen',
          acceptedAt: input.now,
          inviteTokenHash: null, // single-use
          updatedAt: input.now,
        })
        .where(
          and(
            eq(schema.contacts.inviteTokenHash, tokenHash),
            eq(schema.contacts.status, 'invited'),
            gt(schema.contacts.inviteExpiresAt, input.now),
            ne(schema.contacts.ownerUserId, input.contactUserId),
          ),
        )
        .returning({ id: schema.contacts.id, ownerUserId: schema.contacts.ownerUserId });
      const row = rows[0];
      if (row === undefined) return { kind: 'reject' };
      await audit.append(tdb, row.ownerUserId as UserId, 'contact.accepted', { contactId: row.id });
      return { kind: 'ok', contactId: row.id };
    });
  } catch (err) {
    // Accepting a second invite from the same owner would violate the
    // (owner, contact) active-uniqueness index — treat as a clean reject.
    if (isUniqueViolation(err)) return { kind: 'reject' };
    throw err;
  }
}

function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

function hashPresentedToken(token: string): Uint8Array | null {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== INVITE_TOKEN_BYTES) return null;
  return sha256(raw);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
