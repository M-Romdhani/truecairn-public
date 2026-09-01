import { schema, type Database } from '@truecairn/db';
import { RELEASE_SHARE_INDEX_S2, RELEASE_SHARE_INDEX_S3 } from '@truecairn/keys';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import { CONTACT_ROLES, type ContactRole } from '@truecairn/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireSession } from '../auth/session.js';
import { requireStepUp, type StepUpContext } from '../auth/stepup.js';
import { ApiError, badRequest, unauthorized } from '../errors.js';

const CONTACT_NOT_ENROLLED_TYPE = 'https://truecairn.app/problems/contact-not-enrolled';

// The step-up proof to record in the action's audit payload (PHASE3_1 §c) —
// the same forensic linkage every 3.1 step-up route writes. The signature is
// over the canonical step-up payload, never the audit entry_hash, so it lives
// in the payload, not audit_log.user_signature.
function stepUpLinkage(stepUp: StepUpContext): { challengeId: string; signature: string } {
  return { challengeId: stepUp.challengeId, signature: Buffer.from(stepUp.signature).toString('base64url') };
}

// Contact release-capability management (PHASE3_2 Checkpoint B). Each of these
// is a SENSITIVE action: requireStepUp (fresh second factor + passphrase
// signature over the request body, which carries contactId) then a 7-day
// delay + all-channel notice. The endpoint only ENQUEUES; the contact-domain
// handlers (sensitive-actions/handlers.ts) APPLY after the cooldown. contactId
// lives in the BODY so the step-up signature binds it (the path doesn't).
const uuidStr = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const;
const b64 = { type: 'string', minLength: 1, maxLength: 8192 } as const;
const b64Key = { type: 'string', minLength: 1, maxLength: 128 } as const;
const enqueuedResponse = {
  202: {
    type: 'object',
    additionalProperties: false,
    required: ['sensitiveActionId', 'effectiveAt'],
    properties: { sensitiveActionId: { type: 'string' }, effectiveAt: { type: 'string' } },
  },
} as const;

// Fail-fast precondition for share assignment: the target must be an enrolled
// contact of the caller. Runs BEFORE requireStepUp so a doomed request doesn't
// pay the step-up cost. (The add_contact handler re-checks at apply time too —
// 7 days is long enough for the contact to have changed.)
function requireContactEnrolled(db: Database) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { contactId } = request.body as { contactId: string };
    const rows = await db
      .select({ status: schema.contacts.status })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, session.userId)))
      .limit(1);
    const c = rows[0];
    if (c === undefined || c.status !== 'enrolled') {
      throw new ApiError(
        409,
        'Contact Not Enrolled',
        'the contact must complete key enrolment before a share can be assigned',
        CONTACT_NOT_ENROLLED_TYPE,
      );
    }
  };
}

// Like requireContactEnrolled, but accepts an already-active contact too — a
// holder of one tier can also be named a beneficiary of another. Fails fast
// before the step-up cost; the handler re-checks at apply.
function requireContactDesignatable(db: Database) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { contactId } = request.body as { contactId: string };
    const rows = await db
      .select({ status: schema.contacts.status })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, session.userId)))
      .limit(1);
    const c = rows[0];
    if (c === undefined || (c.status !== 'enrolled' && c.status !== 'active')) {
      throw new ApiError(
        409,
        'Contact Not Enrolled',
        'the contact must complete key enrolment before they can be a beneficiary',
        CONTACT_NOT_ENROLLED_TYPE,
      );
    }
  };
}

export function contactManagementRoutes(app: FastifyInstance, db: Database): void {
  // ── Assign a release share (add_contact) ───────────────────────────────────
  app.post(
    '/v1/contacts/shares',
    {
      preHandler: [requireSession, requireContactEnrolled(db), requireStepUp('add_contact')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'tier'],
          properties: {
            contactId: uuidStr,
            tier: { type: 'string', enum: ['s1', 's2', 's3'] },
            shareIndex: { type: 'integer', minimum: 1, maximum: 16 },
            wrappedShareCiphertext: b64,
            s1EnvelopeCiphertext: b64,
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const body = request.body as {
        contactId: string;
        tier: 's1' | 's2' | 's3';
        shareIndex?: number;
        wrappedShareCiphertext?: string;
        s1EnvelopeCiphertext?: string;
      };
      const invalid = validateShareAssignment(body);
      if (invalid !== null) throw badRequest(invalid);

      const payload: Record<string, unknown> = { contactId: body.contactId, tier: body.tier };
      if (body.shareIndex !== undefined) payload['shareIndex'] = body.shareIndex;
      if (body.wrappedShareCiphertext !== undefined)
        payload['wrappedShareCiphertext'] = body.wrappedShareCiphertext;
      if (body.s1EnvelopeCiphertext !== undefined)
        payload['s1EnvelopeCiphertext'] = body.s1EnvelopeCiphertext;

      // Idempotency guard (QA Pass 2 Finding B): a retried/repeated submission
      // must not stack a second pending add_contact for the same contact+tier —
      // duplicates read as phantom pending work on the Engine page and would
      // double-apply after the cooldown. Answer the retry with the EXISTING
      // pending action (202, same shape) so a client that lost the first
      // response still ends up consistent.
      const dupRows = await db
        .select({ id: schema.sensitiveActions.id, effectiveAt: schema.sensitiveActions.effectiveAt })
        .from(schema.sensitiveActions)
        .where(
          and(
            eq(schema.sensitiveActions.userId, session.userId),
            eq(schema.sensitiveActions.actionType, 'add_contact'),
            eq(schema.sensitiveActions.status, 'pending'),
            sql`${schema.sensitiveActions.actionPayload} ->> 'contactId' = ${body.contactId}`,
            sql`${schema.sensitiveActions.actionPayload} ->> 'tier' = ${body.tier}`,
          ),
        )
        .limit(1);
      const dup = dupRows[0];
      if (dup !== undefined) {
        void reply.status(202);
        return { sensitiveActionId: dup.id, effectiveAt: dup.effectiveAt.toISOString() };
      }

      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'add_contact',
        payload,
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Remove a contact (remove_contact) ──────────────────────────────────────
  app.post(
    '/v1/contacts/remove',
    {
      preHandler: [requireSession, requireStepUp('remove_contact')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId'],
          properties: { contactId: uuidStr },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const { contactId } = request.body as { contactId: string };
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'remove_contact',
        payload: { contactId },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Change a contact's role (change_contact_role) ──────────────────────────
  app.post(
    '/v1/contacts/role',
    {
      preHandler: [requireSession, requireStepUp('change_contact_role')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'newRole'],
          properties: { contactId: uuidStr, newRole: { type: 'string', enum: [...CONTACT_ROLES] } },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const { contactId, newRole } = request.body as { contactId: string; newRole: ContactRole };
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'change_contact_role',
        payload: { contactId, newRole },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Rotate a contact's keys (rotate_contact) ───────────────────────────────
  app.post(
    '/v1/contacts/rotate',
    {
      preHandler: [requireSession, requireStepUp('rotate_contact')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'newX25519Pubkey', 'newEd25519Pubkey'],
          properties: {
            contactId: uuidStr,
            newX25519Pubkey: b64Key,
            newEd25519Pubkey: b64Key,
            shares: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['tier', 'shareIndex', 'wrappedShareCiphertext'],
                properties: {
                  tier: { type: 'string', enum: ['s2', 's3'] },
                  shareIndex: { type: 'integer', minimum: 1, maximum: 16 },
                  wrappedShareCiphertext: b64,
                },
              },
            },
            s1Envelopes: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['ciphertext'],
                properties: { ciphertext: b64 },
              },
            },
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const body = request.body as Record<string, unknown>;
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'rotate_contact',
        payload: body,
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Designate a beneficiary (designate_beneficiary) ─────────────────────────
  // S2/S3 re-seal shares to the beneficiary at ceremony time; S1 has no shares, so
  // an S1 beneficiary receives an owner-sealed envelope of the S1 tier key
  // (s1EnvelopeCiphertext, required for s1). contactId + tier (+ the S1 envelope)
  // live in the body so the step-up signature binds all of them.
  app.post(
    '/v1/contacts/beneficiary',
    {
      preHandler: [requireSession, requireContactDesignatable(db), requireStepUp('designate_beneficiary')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'tier'],
          properties: {
            contactId: uuidStr,
            tier: { type: 'string', enum: ['s1', 's2', 's3'] },
            s1EnvelopeCiphertext: b64,
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const { contactId, tier, s1EnvelopeCiphertext } = request.body as {
        contactId: string;
        tier: 's1' | 's2' | 's3';
        s1EnvelopeCiphertext?: string;
      };
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'designate_beneficiary',
        payload: {
          contactId,
          tier,
          ...(s1EnvelopeCiphertext !== undefined ? { s1EnvelopeCiphertext } : {}),
        },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Remove a beneficiary designation (remove_beneficiary) ───────────────────
  app.post(
    '/v1/contacts/beneficiary/remove',
    {
      preHandler: [requireSession, requireStepUp('remove_beneficiary')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contactId', 'tier'],
          properties: { contactId: uuidStr, tier: { type: 'string', enum: ['s1', 's2', 's3'] } },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const { contactId, tier } = request.body as { contactId: string; tier: 's1' | 's2' | 's3' };
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'remove_beneficiary',
        payload: { contactId, tier },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );
}

// The release index (RELEASE_SHARE_INDEX_S2=3, S3=4) is the passphrase
// derivative, not a contact share — so contact shares are 1..(N-1). S1 carries a
// full sealed envelope, not a Shamir share. Exactly one ciphertext, matching tier.
function validateShareAssignment(body: {
  tier: 's1' | 's2' | 's3';
  shareIndex?: number;
  wrappedShareCiphertext?: string;
  s1EnvelopeCiphertext?: string;
}): string | null {
  if (body.tier === 's1') {
    if (body.s1EnvelopeCiphertext === undefined) return 's1 requires s1EnvelopeCiphertext';
    if (body.wrappedShareCiphertext !== undefined || body.shareIndex !== undefined) {
      return 's1 takes no Shamir share';
    }
    return null;
  }
  if (body.s1EnvelopeCiphertext !== undefined) return 's2/s3 takes no s1 envelope';
  if (body.wrappedShareCiphertext === undefined || body.shareIndex === undefined) {
    return 's2/s3 requires shareIndex + wrappedShareCiphertext';
  }
  const releaseIndex = body.tier === 's2' ? RELEASE_SHARE_INDEX_S2 : RELEASE_SHARE_INDEX_S3;
  if (body.shareIndex < 1 || body.shareIndex >= releaseIndex) {
    return `shareIndex must be 1..${releaseIndex - 1} for ${body.tier} (index ${releaseIndex} is the release-passphrase share)`;
  }
  return null;
}
