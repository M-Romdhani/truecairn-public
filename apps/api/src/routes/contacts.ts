import { schema, type Database } from '@truecairn/db';
import {
  CONTACT_ROLES,
  RECIPIENT_TYPES,
  RECIPIENT_TYPE_ROLE,
  type ContactRole,
  type RecipientType,
} from '@truecairn/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { assertCanAddContact } from '../billing/limits.js';
import { requireSession } from '../auth/session.js';
import { beginEnroll, finishEnroll } from '../contacts/enroll.js';
import { acceptInvite, inviteContact } from '../contacts/invite.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';

const b64 = { type: 'string', minLength: 1, maxLength: 4096 } as const;
const b64Key = { type: 'string', minLength: 1, maxLength: 128 } as const;
const uuidStr = { type: 'string', minLength: 1, maxLength: 64 } as const;

// Contact lifecycle (PHASE3_2 Checkpoint A): invite -> accept -> enrol with both
// possession proofs. The share-assignment endpoint + the four contact-domain
// sensitive-action handlers are Checkpoint B. None of these are sensitive
// actions: the relationship grants no release capability (§a Q1).
export function contactRoutes(app: FastifyInstance, db: Database): void {
  // ── List the owner's contacts (PHASE4 C4 — the owner-side read 3.2 lacked) ──
  // Session-gated only: listing your OWN contacts' status + public keys is a read
  // of public/own data, not a sensitive action. The X25519 pubkey is returned
  // ONLY for an enrolled/active contact — a pending_keygen contact's keys are
  // staged-but-unverified, and the owner must never seal a share to an unverified
  // key (the 3.2 status-gate). So the share-assignment UI can't even offer it.
  app.get('/v1/contacts', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const rows = await db
      .select({
        id: schema.contacts.id,
        role: schema.contacts.role,
        status: schema.contacts.status,
        displayLabelCiphertext: schema.contacts.displayLabelCiphertext,
        displayLabelNonce: schema.contacts.displayLabelNonce,
        x25519Pubkey: schema.contacts.contactX25519Pubkey,
        // Ed25519 travels with X25519 because the safety number covers BOTH.
        // Showing a number over the sealing key alone would let a substitution
        // pair a genuine Ed25519 with a swapped X25519 — invisible in the half
        // the owner reads out. It is a public key; serving it reveals nothing.
        ed25519Pubkey: schema.contacts.contactEd25519Pubkey,
        keyPinCiphertext: schema.contacts.keyPinCiphertext,
        keyPinNonce: schema.contacts.keyPinNonce,
        keyPinConfirmedAt: schema.contacts.keyPinConfirmedAt,
        contactPinVersion: schema.contacts.contactPinVersion,
      })
      .from(schema.contacts)
      .where(
        and(eq(schema.contacts.ownerUserId, session.userId), isNull(schema.contacts.removedAt)),
      );
    return {
      contacts: rows.map((r) => ({
        contactId: r.id,
        role: r.role,
        status: r.status,
        displayLabelCiphertext: encode(r.displayLabelCiphertext),
        displayLabelNonce: encode(r.displayLabelNonce),
        x25519Pubkey:
          (r.status === 'enrolled' || r.status === 'active') && r.x25519Pubkey !== null
            ? encode(r.x25519Pubkey)
            : null,
        ed25519Pubkey:
          (r.status === 'enrolled' || r.status === 'active') && r.ed25519Pubkey !== null
            ? encode(r.ed25519Pubkey)
            : null,
        // The owner's pin, returned as stored. Only the owner's unlocked client
        // can open it, and only it can decide whether the keys above still match
        // — the comparison deliberately happens nowhere near this process.
        keyPinCiphertext: r.keyPinCiphertext !== null ? encode(r.keyPinCiphertext) : null,
        keyPinNonce: r.keyPinNonce !== null ? encode(r.keyPinNonce) : null,
        keyPinConfirmedAt: r.keyPinConfirmedAt?.toISOString() ?? null,
        // MUST be returned on every path that returns a label or a pin. The
        // aadVersion incident (P0-2) is the precedent: the list route shipped
        // without it and every vault row read "Title unavailable" in production
        // until #171, because the client had the ciphertext and no way to know
        // which key opened it.
        contactPinVersion: r.contactPinVersion,
      })),
    };
  });

  app.post(
    '/v1/contacts',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'displayLabelCiphertext', 'displayLabelNonce'],
          properties: {
            role: { type: 'string', enum: [...CONTACT_ROLES] },
            // docs/03 recipient type (0066). OPTIONAL: `role` remains the required
            // security input, and a client that has not been updated keeps working.
            recipientType: { type: 'string', enum: [...RECIPIENT_TYPES] },
            displayLabelCiphertext: b64,
            displayLabelNonce: b64,
            // Which key the label was encrypted under (0068). Optional and
            // defaulted to 1 so an un-updated client keeps working; the column's
            // CHECK constraint is what actually bounds it.
            contactPinVersion: { type: 'integer', enum: [1, 2] },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['contactId', 'inviteToken'],
            properties: { contactId: { type: 'string' }, inviteToken: { type: 'string' } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as {
        role: ContactRole;
        recipientType?: RecipientType;
        displayLabelCiphertext: string;
        contactPinVersion?: number;
        displayLabelNonce: string;
      };
      // The pair must agree. Deriving `role` silently from the type would hide a
      // client bug; rejecting it surfaces one. And the disagreement matters more
      // than a mislabel: `role` is what diverseRoleSatisfied reads, so a
      // professional type filed under a personal role would count toward the wrong
      // side of a release threshold while the owner believes otherwise. The DB has
      // the same rule (contacts_recipient_type_matches_role) — this is the layer
      // that explains it.
      if (
        body.recipientType !== undefined &&
        RECIPIENT_TYPE_ROLE[body.recipientType] !== body.role
      ) {
        throw badRequest(
          `recipientType '${body.recipientType}' belongs to role '${RECIPIENT_TYPE_ROLE[body.recipientType]}', not '${body.role}'`,
        );
      }
      // Free-tier contact cap (docs/28): fail closed with 402 before creating.
      await assertCanAddContact(db, session.userId, new Date());
      return inviteContact(db, audit, {
        ownerUserId: session.userId,
        role: body.role,
        recipientType: body.recipientType,
        displayLabelCiphertext: decode(body.displayLabelCiphertext),
        displayLabelNonce: decode(body.displayLabelNonce),
        contactPinVersion: body.contactPinVersion,
        now: new Date(),
      });
    },
  );

  app.post(
    '/v1/contacts/accept',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['inviteToken'],
          properties: { inviteToken: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['contactId'],
            properties: { contactId: { type: 'string' } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as { inviteToken: string };
      const result = await acceptInvite(db, audit, {
        contactUserId: session.userId,
        inviteToken: body.inviteToken,
        now: new Date(),
      });
      if (result.kind === 'reject') throw badRequest('invalid or expired invite');
      return { contactId: result.contactId };
    },
  );

  app.post(
    '/v1/contacts/enroll/options',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'x25519Pubkey', 'ed25519Pubkey'],
          properties: { contactId: uuidStr, x25519Pubkey: b64Key, ed25519Pubkey: b64Key },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['ed25519ChallengeId', 'ed25519Challenge', 'x25519ChallengeId', 'x25519SealedNonce'],
            properties: {
              ed25519ChallengeId: { type: 'string' },
              ed25519Challenge: { type: 'string' },
              x25519ChallengeId: { type: 'string' },
              x25519SealedNonce: { type: 'string' },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const body = request.body as { contactId: string; x25519Pubkey: string; ed25519Pubkey: string };
      const result = await beginEnroll(db, {
        contactId: body.contactId,
        contactUserId: session.userId,
        x25519Pubkey: decode(body.x25519Pubkey),
        ed25519Pubkey: decode(body.ed25519Pubkey),
        now: new Date(),
      });
      if (result.kind === 'reject') throw badRequest('contact is not awaiting key enrolment');
      return {
        ed25519ChallengeId: result.ed25519ChallengeId,
        ed25519Challenge: result.ed25519Challenge,
        x25519ChallengeId: result.x25519ChallengeId,
        x25519SealedNonce: result.x25519SealedNonce,
      };
    },
  );

  app.post(
    '/v1/contacts/enroll/verify',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'contactId',
            'ed25519ChallengeId',
            'ed25519Signature',
            'x25519ChallengeId',
            'x25519Nonce',
          ],
          properties: {
            contactId: uuidStr,
            ed25519ChallengeId: uuidStr,
            ed25519Signature: b64Key,
            x25519ChallengeId: uuidStr,
            x25519Nonce: b64Key,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['enrolled'],
            properties: { enrolled: { type: 'boolean', enum: [true] } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as {
        contactId: string;
        ed25519ChallengeId: string;
        ed25519Signature: string;
        x25519ChallengeId: string;
        x25519Nonce: string;
      };
      const result = await finishEnroll(db, audit, {
        contactId: body.contactId,
        contactUserId: session.userId,
        ed25519ChallengeId: body.ed25519ChallengeId,
        ed25519Signature: decode(body.ed25519Signature),
        x25519ChallengeId: body.x25519ChallengeId,
        x25519Nonce: decode(body.x25519Nonce),
        now: new Date(),
      });
      if (result.kind === 'reject') throw badRequest('enrolment verification failed');
      return { enrolled: true as const };
    },
  );

  // ── Cancel a not-yet-enrolled invite (session-only — the inverse of invite) ──
  // Removing an ENROLLED contact is a sensitive action — release capability is at
  // stake — and goes through POST /v1/contacts/remove (step-up + cooldown). But an
  // invited/pending_keygen contact has no proven keys and no shares, so cancelling
  // it is symmetric with the (non-sensitive, session-only) invite above. Hard-gated
  // to never-enrolled statuses: this path can NEVER drop a contact that holds a
  // share — that removal stays behind step-up.
  app.post(
    '/v1/contacts/cancel-invite',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId'],
          properties: { contactId: uuidStr },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['cancelled'],
            properties: { cancelled: { type: 'boolean', enum: [true] } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { contactId } = request.body as { contactId: string };
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [c] = await tx
          .select({ status: schema.contacts.status })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.id, contactId),
              eq(schema.contacts.ownerUserId, session.userId),
              isNull(schema.contacts.removedAt),
            ),
          )
          .limit(1);
        if (c === undefined) throw notFound('contact not found');
        // Never-enrolled only. An enrolled/active contact may hold a release share,
        // so it must be removed via the step-up sensitive action, not cancelled here.
        if (c.status !== 'invited' && c.status !== 'pending_keygen') {
          throw conflict('an enrolled contact must be removed via step-up, not cancelled');
        }
        await tx
          .update(schema.contacts)
          .set({ status: 'removed', removedAt: now, updatedAt: now })
          .where(eq(schema.contacts.id, contactId));
        // Audit rides the same transaction as the state change (invariant #5).
        await audit.append(tx, session.userId, 'contact.invite_cancelled', {
          contactId,
          previousStatus: c.status,
        });
        return { cancelled: true as const };
      });
    },
  );

  // ── Record the owner's out-of-band confirmation of a contact's keys (0061) ──
  // The owner compared the safety number with the contact over a channel we do
  // not carry, and is storing the keys they confirmed. The body is opaque: the
  // pin is sealed under the owner's S1 tier key, so this handler stores bytes it
  // cannot read and could not have produced. That asymmetry IS the mitigation —
  // see the migration for what it does and does not buy.
  //
  // Session-gated, not step-up. A hijacked session cannot forge a pin (no tier
  // key without an unlocked vault), and requiring step-up here would push owners
  // away from verifying at all, which costs more than it protects. Replacement
  // is allowed but audited distinctly: a re-pin is exactly what an attacker who
  // has substituted a key needs the owner to do, so it must never be the quiet
  // path. Note this route cannot tell a first confirmation from a replacement
  // being coerced — only the owner comparing digits can. It records which
  // happened so the tamper-evident log shows it.
  app.post(
    '/v1/contacts/key-pin',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'keyPinCiphertext', 'keyPinNonce'],
          // Deliberately NO contactPinVersion here. The version is a property of
          // the ROW and covers the label as well as the pin, and this route
          // writes only the pin — so accepting one would let a pin confirmation
          // flip the row to v2 while the label was still encrypted under v1,
          // making the label unreadable. The client seals the pin under whatever
          // version the row already carries; a row moves to v2 only when BOTH
          // fields are rewritten together.
          properties: { contactId: uuidStr, keyPinCiphertext: b64, keyPinNonce: b64 },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['confirmed', 'replaced'],
            properties: {
              confirmed: { type: 'boolean', enum: [true] },
              replaced: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as {
        contactId: string;
        keyPinCiphertext: string;
        keyPinNonce: string;
      };
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [c] = await tx
          .select({
            status: schema.contacts.status,
            existingPin: schema.contacts.keyPinCiphertext,
          })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.id, body.contactId),
              eq(schema.contacts.ownerUserId, session.userId),
              isNull(schema.contacts.removedAt),
            ),
          )
          .limit(1);
        if (c === undefined) throw notFound('contact not found');
        // Only keys that have been through enrolment exist to be confirmed. A
        // pending_keygen contact's keys are staged and can still change, so a
        // pin taken now would go stale the moment enrolment finishes.
        if (c.status !== 'enrolled' && c.status !== 'active') {
          throw conflict('only an enrolled contact has keys to confirm');
        }
        const replaced = c.existingPin !== null;
        await tx
          .update(schema.contacts)
          .set({
            keyPinCiphertext: decode(body.keyPinCiphertext),
            keyPinNonce: decode(body.keyPinNonce),
            keyPinConfirmedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.contacts.id, body.contactId));
        // Audit rides the same transaction as the state change (invariant #5).
        // Ciphertext is NOT in the payload: it is opaque here, but an audit row
        // is a log line, and invariant #1 says keep the boundary by construction.
        await audit.append(
          tx,
          session.userId,
          replaced ? 'contact.key_pin_replaced' : 'contact.key_pin_confirmed',
          { contactId: body.contactId },
        );
        return { confirmed: true as const, replaced };
      });
    },
  );

  // ── Re-key contact metadata off the S1 tier key (F1+F2 backfill) ───────────
  //
  // Migration 0068 moved labels and pins to a master-derived key, but only for
  // rows written after it. Rows created before are still v1 and still readable
  // by an S1 beneficiary — the fix was forward-only, and this is the other half.
  //
  // The client does the work, because only it can: reading a v1 row needs the S1
  // TIER key and writing v2 needs the MASTER key, and the server has neither. It
  // sends back re-encrypted bytes it cannot itself have produced.
  //
  // FOUR PROPERTIES, each of which is a way this could go wrong:
  //
  // 1. ONE DIRECTION ONLY. The update is gated on `contact_pin_version = 1` in
  //    the WHERE clause, so a v2 row is untouched and nothing can move data back
  //    onto the S1 tier key. A replayed request is a no-op rather than a
  //    downgrade.
  // 2. LABEL AND PIN MOVE TOGETHER. One column versions both, so rewriting one
  //    without the other leaves a row whose version is a lie about half its
  //    contents. A row that HAS a pin must send one; a row that has none must
  //    not invent one. Both mismatches are 400s, not silent repairs.
  // 3. NO FORCED RE-CONFIRMATION. `keyPinConfirmedAt` is deliberately NOT
  //    written. The owner's out-of-band comparison remains valid evidence about
  //    those key bytes — only the storage key changes — and re-asking would
  //    train owners to click through `tampered`, the one state that has to keep
  //    meaning something (PLAN-v1-launch.md §1.2).
  // 4. ALL OR NOTHING. One transaction for the batch, with the audit append
  //    inside it (invariant 5). A partial apply would leave some rows claiming a
  //    version their ciphertext does not match.
  //
  // Not a sensitive action: it grants no capability and changes no relationship.
  // It re-encrypts data the caller already holds, under a key only they have.
  app.post(
    '/v1/contacts/metadata-rekey',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contacts'],
          properties: {
            contacts: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['contactId', 'displayLabelCiphertext', 'displayLabelNonce'],
                properties: {
                  contactId: uuidStr,
                  displayLabelCiphertext: b64,
                  displayLabelNonce: b64,
                  keyPinCiphertext: b64,
                  keyPinNonce: b64,
                },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['rekeyed'],
            properties: { rekeyed: { type: 'integer' } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as {
        contacts: Array<{
          contactId: string;
          displayLabelCiphertext: string;
          displayLabelNonce: string;
          keyPinCiphertext?: string;
          keyPinNonce?: string;
        }>;
      };

      const ids = body.contacts.map((c) => c.contactId);
      if (new Set(ids).size !== ids.length) {
        throw badRequest('duplicate contactId in batch');
      }

      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        let rekeyed = 0;
        for (const c of body.contacts) {
          const [row] = await tx
            .select({
              id: schema.contacts.id,
              version: schema.contacts.contactPinVersion,
              pin: schema.contacts.keyPinCiphertext,
            })
            .from(schema.contacts)
            .where(
              and(
                eq(schema.contacts.id, c.contactId),
                eq(schema.contacts.ownerUserId, session.userId),
                isNull(schema.contacts.removedAt),
              ),
            );
          // Scoped to the caller's own contacts: an id belonging to someone else
          // reads as absent, so this cannot be used to probe for existence.
          if (row === undefined) throw notFound('contact not found');
          // Already v2 (or a version this client does not understand): skip
          // rather than fail, so a re-run after a partial network failure is
          // idempotent instead of an error the user cannot act on.
          if (row.version !== 1) continue;

          const rowHasPin = row.pin !== null;
          const bodyHasPin = c.keyPinCiphertext !== undefined && c.keyPinNonce !== undefined;
          if (rowHasPin !== bodyHasPin) {
            // Property 2. Applying either half would produce a row whose version
            // does not describe its own contents.
            throw badRequest('pin presence must match the stored row');
          }

          await tx
            .update(schema.contacts)
            .set({
              displayLabelCiphertext: decode(c.displayLabelCiphertext),
              displayLabelNonce: decode(c.displayLabelNonce),
              ...(bodyHasPin
                ? {
                    keyPinCiphertext: decode(c.keyPinCiphertext!),
                    keyPinNonce: decode(c.keyPinNonce!),
                  }
                : {}),
              // keyPinConfirmedAt is NOT set — property 3.
              contactPinVersion: 2,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.contacts.id, c.contactId),
                eq(schema.contacts.ownerUserId, session.userId),
                // Property 1, enforced in SQL rather than by the read above, so a
                // concurrent rekey cannot slip between the SELECT and the UPDATE.
                eq(schema.contacts.contactPinVersion, 1),
              ),
            );
          rekeyed += 1;
        }

        if (rekeyed > 0) {
          // Counts only — never a label, a pin or any ciphertext (invariant 1).
          await audit.append(tx, session.userId, 'contact.metadata_rekeyed', {
            count: rekeyed,
            toVersion: 2,
          });
        }
        return { rekeyed };
      });
    },
  );
}

function decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function encode(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
