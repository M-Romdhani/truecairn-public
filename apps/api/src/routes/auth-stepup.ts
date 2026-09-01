import { stampStepUp } from '@truecairn/sessions';
import type { Database } from '@truecairn/db';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { checkIpThrottle, hashIp, recordAttempt } from '../auth/rate-limit.js';
import { blockIp, clientIp } from '../auth/rate-limit-route.js';
import { requireSession } from '../auth/session.js';
import { verifyUserTotp } from '../auth/totp-store.js';
import { beginStepUpAssertion, verifyStepUpAssertion } from '../auth/webauthn-flows.js';
import type { WebAuthnConfig, WebAuthnVerifier } from '../auth/webauthn.js';
import type { ApiConfig } from '../config.js';
import { badRequest, unauthorized } from '../errors.js';

// The step-up SECOND-FACTOR sub-step (design note §c; WebAuthn method added in
// PHASE4 C5A). Proves a fresh second factor and stamps sessions.last_stepup_at;
// the tier-2 gate (requireStepUp) then needs only the passphrase signature.
//
// Two methods, symmetric end state (a stamped last_stepup_at):
//   • TOTP   — a stateless code, verified directly.
//   • WebAuthn — a re-tap of the passkey the user ALREADY holds. This is the
//     bootstrap method: a fresh passkey-only user has no TOTP (and TOTP setup is
//     itself step-up-gated), so without this NO step-up action is reachable in a
//     browser. WebAuthn is challenge-response, so it needs the options sub-endpoint
//     to issue a session-scoped challenge first; TOTP needed none.
export function stepUpSecondFactorRoutes(
  app: FastifyInstance,
  db: Database,
  config: ApiConfig,
  verifier: WebAuthnVerifier,
  webauthnConfig: WebAuthnConfig,
): void {
  // Issue a session-scoped assertion challenge (allowCredentials = this user's
  // passkeys). Session-gated only — no step-up: this is how you PROVE the factor,
  // it cannot itself require one (that was the deadlock).
  app.post(
    '/v1/auth/step-up/webauthn/options',
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['options', 'challengeId'],
            properties: {
              options: { type: 'object', additionalProperties: true },
              challengeId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      return beginStepUpAssertion(db, webauthnConfig, { userId: session.userId, now: new Date() });
    },
  );

  app.post(
    '/v1/auth/step-up/second-factor',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['method'],
          properties: {
            method: { type: 'string', enum: ['totp', 'webauthn'] },
            code: { type: 'string', minLength: 6, maxLength: 10 },
            challengeId: { type: 'string', minLength: 1, maxLength: 64 },
            response: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: { ok: { type: 'boolean', enum: [true] } },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const body = request.body as
        | { method: 'totp'; code?: string }
        | { method: 'webauthn'; challengeId?: string; response?: AuthenticationResponseJSON };
      const now = new Date();

      if (body.method === 'totp') {
        if (body.code === undefined) throw badRequest('totp requires code');
        // Throttle BEFORE verifying: a stolen session must not be able to
        // brute-force the 6-digit space to forge a fresh-second-factor stamp
        // (the gate on cancel-release and half of every step-up). Per-IP only —
        // no account lock from here, so an attacker holding a session cannot
        // lock the real owner out of their other devices' protective actions.
        const ipHash = hashIp(clientIp(request), config.ipHashPepper);
        const ipBlock = await checkIpThrottle(db, 'totp', ipHash, now);
        if (ipBlock !== null) await blockIp(request, reply, db, ipHash, ipBlock);
        const ok = await verifyUserTotp(db, config.totpKeks, session.userId, body.code, now);
        await recordAttempt(db, {
          scope: 'totp',
          identifier: session.userId,
          ipHash,
          succeeded: ok,
          now,
        });
        if (!ok) throw unauthorized('second factor verification failed');
        await stampStepUp(db, session.id, now);
        return { ok: true as const };
      }

      // method === 'webauthn'
      if (body.challengeId === undefined || body.response === undefined) {
        throw badRequest('webauthn requires challengeId and response');
      }
      const result = await verifyStepUpAssertion(db, verifier, {
        userId: session.userId,
        sessionId: session.id,
        challengeId: body.challengeId,
        response: body.response,
        now,
      });
      // Same generic failure as TOTP — the client learns nothing about which check
      // failed. On success the assertion already stamped last_stepup_at.
      if (result.kind === 'reject') throw unauthorized('second factor verification failed');
      return { ok: true as const };
    },
  );
}
