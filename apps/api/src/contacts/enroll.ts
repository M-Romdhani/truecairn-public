import {
  constantTimeEqual,
  ed25519Verify,
  randomBytes,
  sealedBoxEncrypt,
} from '@truecairn/crypto';
import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { claimChallenge, createChallenge } from '../auth/challenges.js';

const ENROLL_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const PROOF_NONCE_BYTES = 32;
const X25519_PUBKEY_BYTES = 32;
const ED25519_PUBKEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export type BeginEnrollResult =
  | {
      kind: 'ok';
      ed25519ChallengeId: string;
      ed25519Challenge: string; // base64url nonce the contact signs
      x25519ChallengeId: string;
      x25519SealedNonce: string; // base64url sealed box the contact opens
    }
  | { kind: 'reject' };

// Begin contact key enrolment. The contact's device has generated both
// keypairs; here it submits the PUBLIC halves. We stage them on the (still
// pending_keygen) contacts row — unverified, and unused by the ceremony until
// status flips to 'enrolled' — and issue two possession challenges:
//   - Ed25519: a nonce the contact signs with the affirmation private key.
//   - X25519: a nonce SEALED to the submitted X25519 pubkey; only the holder of
//     the matching secret key can open it. Re-requesting /options is always
//     allowed (it overwrites the staging + issues fresh challenges), so a
//     contact who lets a challenge expire is never permanently stuck.
export async function beginEnroll(
  db: Database,
  input: {
    contactId: string;
    contactUserId: UserId;
    x25519Pubkey: Uint8Array;
    ed25519Pubkey: Uint8Array;
    now: Date;
  },
): Promise<BeginEnrollResult> {
  if (
    input.x25519Pubkey.length !== X25519_PUBKEY_BYTES ||
    input.ed25519Pubkey.length !== ED25519_PUBKEY_BYTES
  ) {
    return { kind: 'reject' };
  }

  const rows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, input.contactId),
        eq(schema.contacts.contactUserId, input.contactUserId),
        eq(schema.contacts.status, 'pending_keygen'),
      ),
    )
    .limit(1);
  if (rows[0] === undefined) return { kind: 'reject' };

  await db
    .update(schema.contacts)
    .set({
      contactX25519Pubkey: input.x25519Pubkey,
      contactEd25519Pubkey: input.ed25519Pubkey,
      updatedAt: input.now,
    })
    .where(eq(schema.contacts.id, input.contactId));

  const expiresAt = new Date(input.now.getTime() + ENROLL_CHALLENGE_TTL_MS);
  const edNonce = randomBytes(PROOF_NONCE_BYTES);
  const xNonce = randomBytes(PROOF_NONCE_BYTES);
  const ed = await createChallenge(db, {
    userId: input.contactUserId,
    purpose: 'contact_ed25519_proof',
    challenge: edNonce,
    expiresAt,
    now: input.now,
  });
  const x = await createChallenge(db, {
    userId: input.contactUserId,
    purpose: 'contact_x25519_proof',
    challenge: xNonce,
    expiresAt,
    now: input.now,
  });
  const sealed = sealedBoxEncrypt({ recipientPublicKey: input.x25519Pubkey, plaintext: xNonce });

  return {
    kind: 'ok',
    ed25519ChallengeId: ed.id,
    ed25519Challenge: Buffer.from(edNonce).toString('base64url'),
    x25519ChallengeId: x.id,
    x25519SealedNonce: Buffer.from(sealed).toString('base64url'),
  };
}

export type FinishEnrollResult = { kind: 'ok' } | { kind: 'reject' };

// Verify both possession proofs against the staged pubkeys and, on success,
// mark the contact 'enrolled'. Both challenges are single-use (consumed
// atomically in this transaction with the status flip).
export async function finishEnroll(
  db: Database,
  audit: AuditLogPort,
  input: {
    contactId: string;
    contactUserId: UserId;
    ed25519ChallengeId: string;
    ed25519Signature: Uint8Array;
    x25519ChallengeId: string;
    x25519Nonce: Uint8Array;
    now: Date;
  },
): Promise<FinishEnrollResult> {
  return db.transaction(async (tx): Promise<FinishEnrollResult> => {
    const tdb = tx as unknown as Database;
    const rows = await tdb
      .select({
        ownerUserId: schema.contacts.ownerUserId,
        x25519: schema.contacts.contactX25519Pubkey,
        ed25519: schema.contacts.contactEd25519Pubkey,
      })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.id, input.contactId),
          eq(schema.contacts.contactUserId, input.contactUserId),
          eq(schema.contacts.status, 'pending_keygen'),
        ),
      )
      .limit(1);
    const c = rows[0];
    if (c === undefined || c.x25519 === null || c.ed25519 === null) return { kind: 'reject' };

    const edC = await claimChallenge(tdb, {
      id: input.ed25519ChallengeId,
      purpose: 'contact_ed25519_proof',
      now: input.now,
    });
    const xC = await claimChallenge(tdb, {
      id: input.x25519ChallengeId,
      purpose: 'contact_x25519_proof',
      now: input.now,
    });
    if (
      edC === null ||
      xC === null ||
      edC.userId !== input.contactUserId ||
      xC.userId !== input.contactUserId
    ) {
      return { kind: 'reject' };
    }

    // (1) Ed25519 possession: a valid signature over the issued nonce.
    if (input.ed25519Signature.length !== ED25519_SIGNATURE_BYTES) return { kind: 'reject' };
    if (!ed25519Verify(input.ed25519Signature, edC.challenge, c.ed25519)) return { kind: 'reject' };
    // (2) X25519 possession: the returned nonce equals the one we sealed to the
    // staged pubkey, so the contact must hold the matching secret key.
    if (input.x25519Nonce.length !== xC.challenge.length) return { kind: 'reject' };
    if (!constantTimeEqual(input.x25519Nonce, xC.challenge)) return { kind: 'reject' };

    await tdb
      .update(schema.contacts)
      .set({ status: 'enrolled', enrolledAt: input.now, updatedAt: input.now })
      .where(eq(schema.contacts.id, input.contactId));
    await audit.append(tdb, c.ownerUserId as UserId, 'contact.enrolled', {
      contactId: input.contactId,
    });
    return { kind: 'ok' };
  });
}
