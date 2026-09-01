import { buildStepUpSigningInput, verifyUserSignature } from '@truecairn/audit';
import { randomBytes } from '@truecairn/crypto';
import { schema } from '@truecairn/db';
import { DEFAULT_STEPUP_FRESHNESS_MS } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, unauthorized } from '../errors.js';
import { claimChallenge, createChallenge } from './challenges.js';

const STEPUP_REQUIRED_TYPE = 'https://truecairn.app/problems/step-up-required';
const STEPUP_INVALID_TYPE = 'https://truecairn.app/problems/step-up-invalid';
const SECOND_FACTOR_REQUIRED_TYPE = 'https://truecairn.app/problems/second-factor-required';
const CHALLENGE_HEADER = 'x-truecairn-stepup-challenge';
const SIGNATURE_HEADER = 'x-truecairn-stepup-signature';
const STEPUP_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ED25519_SIGNATURE_BYTES = 64;

// The canonical step-up signing input now lives in @truecairn/audit/canonical so
// the browser client and this server share ONE byte-identical builder (PHASE4 C2
// — a client/server drift here would fail every step-up). Re-exported so existing
// importers of '../auth/stepup.js' are unchanged.
export { buildStepUpSigningInput } from '@truecairn/audit';

// What the route handler receives once step-up passes. The signature signs the
// step-up payload (NOT the audit entry_hash, which the client cannot know in
// advance) — so it is recorded in the action's audit PAYLOAD for forensic
// linkage, not stored as audit_log.user_signature (that would break verifyChain).
export interface StepUpContext {
  actionType: string;
  challengeId: string;
  signature: Uint8Array;
}

class StepUpRequiredError extends ApiError {
  constructor(stepUp: Record<string, unknown>) {
    super(
      403,
      'Step-up authentication required',
      'this action requires a fresh passphrase signature and a recent second factor',
      STEPUP_REQUIRED_TYPE,
      { stepUp },
    );
  }
}

function stepUpInvalid(detail: string): ApiError {
  return new ApiError(403, 'Step-up invalid', detail, STEPUP_INVALID_TYPE);
}

// tier-2 gate (design note §3/§c). MUST run after requireSession (it reads
// request.session). BOTH predicates must hold: (a) the session carries a fresh
// second factor (last_stepup_at within the window) AND (b) a valid passphrase
// signature, in the X-Truecairn-StepUp-* headers, over the canonical payload for
// THIS action. Missing/stale -> 403 step-up-required (issues a challenge);
// present-but-bad -> 403 step-up-invalid. Fail-closed throughout. On success it
// sets request.stepUp for the handler to record in the action's audit entry.
export function requireStepUp(actionType: string) {
  return async function stepUpPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const db = request.server.db;
    if (db === null) throw unauthorized('auth backend unavailable');
    const session = request.session;
    if (session === null) throw unauthorized('no session');

    const now = new Date();
    const fresh =
      session.lastStepupAt !== null &&
      now.getTime() - session.lastStepupAt.getTime() < DEFAULT_STEPUP_FRESHNESS_MS;

    const challengeId = headerValue(request.headers[CHALLENGE_HEADER]);
    const signatureRaw = headerValue(request.headers[SIGNATURE_HEADER]);

    // R1 (or stale second factor): issue a fresh challenge and tell the client
    // what is still required. Nothing is consumed here.
    if (challengeId === undefined || signatureRaw === undefined || !fresh) {
      const challenge = randomBytes(32);
      const expiresAt = new Date(now.getTime() + STEPUP_CHALLENGE_TTL_MS);
      const created = await createChallenge(db, {
        userId: session.userId,
        purpose: 'stepup_signature',
        challenge,
        expiresAt,
        now,
      });
      throw new StepUpRequiredError({
        challengeId: created.id,
        challenge: Buffer.from(challenge).toString('base64url'),
        actionType,
        secondFactor: {
          satisfiedBySession: fresh,
          accepted: ['totp', 'webauthn'],
          freshnessWindowSeconds: Math.floor(DEFAULT_STEPUP_FRESHNESS_MS / 1000),
        },
        expiresAt: expiresAt.toISOString(),
      });
    }

    // R2: fresh second factor + both headers present. Claim the challenge and
    // verify the signature over the canonical payload for this action + body.
    const claimed = await claimChallenge(db, {
      id: challengeId,
      purpose: 'stepup_signature',
      now,
    });
    if (claimed === null || claimed.userId !== session.userId) {
      throw stepUpInvalid('step-up challenge invalid or expired');
    }
    const signature = decodeSignature(signatureRaw);
    if (signature === null) throw stepUpInvalid('malformed step-up signature');

    const km = await db
      .select({ pubkey: schema.userKeyMaterial.auditSigningPubkey })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, session.userId))
      .limit(1);
    const pubkey = km[0]?.pubkey;
    if (pubkey === undefined) throw stepUpInvalid('no signing key enrolled');

    const payload = buildStepUpSigningInput(
      session.userId,
      actionType,
      claimed.challenge,
      request.body ?? {},
    );
    if (!verifyUserSignature(pubkey, payload, signature)) {
      throw stepUpInvalid('step-up signature verification failed');
    }

    request.stepUp = { actionType, challengeId, signature };
  };
}

// Lighter than requireStepUp: verifies the session carries a FRESH second factor
// (last_stepup_at within the window) but requires NO passphrase signature and
// issues NO challenge. The gate for user-PROTECTIVE state changes — cancel-release
// (PHASE3_4 §c) — where the asymmetry principle wants one tap, not a passphrase.
// A bare stolen cookie is rejected (no fresh factor); a present owner who has
// tapped TOTP/passkey within the window passes. Stale ⇒ 403 telling the client to
// prove a second factor via /v1/auth/step-up/second-factor, then retry. Plain
// preHandler (no actionType — it binds no action, only proves presence). MUST run
// after requireSession.
export async function requireFreshSecondFactor(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const session = request.session;
  if (session === null) throw unauthorized('no session');
  const fresh =
    session.lastStepupAt !== null &&
    Date.now() - session.lastStepupAt.getTime() < DEFAULT_STEPUP_FRESHNESS_MS;
  if (!fresh) {
    throw new ApiError(
      403,
      'Second factor required',
      'this action requires a recent second factor; prove one via /v1/auth/step-up/second-factor and retry',
      SECOND_FACTOR_REQUIRED_TYPE,
      {
        secondFactor: {
          accepted: ['totp', 'webauthn'],
          freshnessWindowSeconds: Math.floor(DEFAULT_STEPUP_FRESHNESS_MS / 1000),
        },
      },
    );
  }
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (h === undefined) return undefined;
  return Array.isArray(h) ? h[0] : h;
}

function decodeSignature(s: string): Uint8Array | null {
  const b = Buffer.from(s, 'base64url');
  return b.length === ED25519_SIGNATURE_BYTES ? new Uint8Array(b) : null;
}
