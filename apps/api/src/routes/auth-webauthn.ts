import type { Database } from '@truecairn/db';
import { DEFAULT_ABSOLUTE_TTL_MS } from '@truecairn/sessions';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { checkIpThrottle, clearAccountLock, hashIp, recordAttempt } from '../auth/rate-limit.js';
import { blockIp, clientIp } from '../auth/rate-limit-route.js';
import { SESSION_COOKIE } from '../auth/session.js';
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
} from '../auth/webauthn-flows.js';
import type { WebAuthnConfig, WebAuthnVerifier } from '../auth/webauthn.js';
import { badRequest, unauthorized } from '../errors.js';

// The WebAuthn response object is large and validated by @simplewebauthn, not by
// us — accept it as an opaque object rather than re-describing the spec shape.
const webauthnResponseSchema = { type: 'object', additionalProperties: true } as const;

// Reserved synthetic domains. delete_account tombstones a deleted user's email to
// <id>@deleted.truecairn.local; registration must refuse this domain so an attacker
// can't register a colliding tombstone address (PHASE3_4 §f / Q8).
const RESERVED_EMAIL_DOMAINS = ['deleted.truecairn.local'];
function isReservedEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return RESERVED_EMAIL_DOMAINS.includes(email.slice(at + 1).toLowerCase());
}

const beginResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['options', 'challengeId'],
  properties: {
    options: { type: 'object', additionalProperties: true },
    challengeId: { type: 'string' },
  },
} as const;

// The account owner's passkey register + authenticate endpoints (PHASE3_1
// Flows 1-2). Hardware-key registration, password+TOTP, and the step-up
// handshake are later deliverables. `db` and `verifier` are bound at
// registration; `app.audit` is read at request time (set during onReady).
export function webauthnRoutes(
  app: FastifyInstance,
  db: Database,
  verifier: WebAuthnVerifier,
  config: WebAuthnConfig,
  ipHashPepper: Uint8Array,
): void {
  app.post(
    '/v1/auth/register/options',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email'],
          properties: { email: { type: 'string', minLength: 3, maxLength: 320 } },
        },
        response: { 200: beginResponseSchema },
      },
    },
    async (request) => {
      const { email } = request.body as { email: string };
      if (isReservedEmail(email)) throw badRequest('that email domain is reserved');
      return beginRegistration(db, config, { email, now: new Date() });
    },
  );

  app.post(
    '/v1/auth/register/verify',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['challengeId', 'response'],
          properties: {
            challengeId: { type: 'string', minLength: 1 },
            response: webauthnResponseSchema,
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['credentialId'],
            properties: { credentialId: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { challengeId: string; response: RegistrationResponseJSON };
      const result = await finishRegistration(db, verifier, {
        challengeId: body.challengeId,
        response: body.response,
        now: new Date(),
        isHardwareKey: false,
      });
      void reply.status(201);
      return result;
    },
  );

  app.post(
    '/v1/auth/login/options',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { email: { type: 'string', minLength: 3, maxLength: 320 } },
        },
        response: { 200: beginResponseSchema },
      },
    },
    async (request) => {
      const { email } = request.body as { email?: string };
      return beginAuthentication(db, config, { email, now: new Date() });
    },
  );

  app.post(
    '/v1/auth/login/verify',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['challengeId', 'response'],
          properties: {
            challengeId: { type: 'string', minLength: 1 },
            response: webauthnResponseSchema,
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['userId'],
            properties: { userId: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { challengeId: string; response: AuthenticationResponseJSON };
      const audit = app.audit;
      if (audit === null) throw unauthorized('auth backend unavailable');
      const now = new Date();
      const ipHash = hashIp(clientIp(request), ipHashPepper);

      // Per-IP throttle before verification — bounds assertion-grinding. Passkey
      // login is not email-keyed, so there is no per-account lock here; the IP
      // bucket ('login') is shared with password login on purpose.
      const ipBlock = await checkIpThrottle(db, 'login', ipHash, now);
      if (ipBlock !== null) await blockIp(request, reply, db, ipHash, ipBlock);

      const userAgent = request.headers['user-agent'];
      let result;
      try {
        result = await finishAuthentication(db, verifier, audit, {
          challengeId: body.challengeId,
          response: body.response,
          now,
          ...(userAgent !== undefined ? { userAgent } : {}),
        });
      } catch (err) {
        // A failed assertion counts toward the per-IP bucket. No accountEmail:
        // passkey login is not email-keyed, so it never locks an account.
        await recordAttempt(db, {
          scope: 'login',
          identifier: body.response.id,
          ipHash,
          succeeded: false,
          now,
        });
        throw err;
      }
      await recordAttempt(db, {
        scope: 'login',
        identifier: body.response.id,
        ipHash,
        succeeded: true,
        now,
      });
      // A verified assertion releases any account lock (2026-08-07 audit,
      // finding 1). The lock exists to slow credential guessing; a valid passkey
      // signature is cryptographic proof of possession, so the holder is by
      // definition not the guesser it was raised against. Clearing it here is
      // also the only route out for a passkey-only owner: the lock is set by the
      // PASSWORD route (a no-password account still reaches recordAttempt via
      // the reject path) and, until now, could only be cleared by that same
      // route — which such an owner never calls.
      await clearAccountLock(db, result.userId, now);
      void reply.setCookie(SESSION_COOKIE, result.session.token, {
        httpOnly: true,
        secure: config.origin.startsWith('https://'),
        sameSite: 'strict',
        path: '/',
        maxAge: Math.floor(DEFAULT_ABSOLUTE_TTL_MS / 1000),
      });
      return { userId: result.userId };
    },
  );
}
