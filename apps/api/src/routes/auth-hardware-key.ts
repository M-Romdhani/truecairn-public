import type { Database } from '@truecairn/db';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { requireStepUp } from '../auth/stepup.js';
import { beginAddAuthenticator, finishRegistration } from '../auth/webauthn-flows.js';
import type { WebAuthnConfig, WebAuthnVerifier } from '../auth/webauthn.js';
import { unauthorized } from '../errors.js';

const beginResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['options', 'challengeId'],
  properties: {
    options: { type: 'object', additionalProperties: true },
    challengeId: { type: 'string' },
  },
} as const;

const webauthnResponseSchema = { type: 'object', additionalProperties: true } as const;

// Hardware-key registration (design note Flow 5): the same WebAuthn machinery
// with is_hardware_key=true, adding an authenticator to an EXISTING account. The
// options step needs only a session; the VERIFY step is step-up-gated from the
// start — it is the actual enrolment.
export function hardwareKeyRoutes(
  app: FastifyInstance,
  db: Database,
  verifier: WebAuthnVerifier,
  config: WebAuthnConfig,
): void {
  app.post(
    '/v1/auth/hardware-key/register/options',
    {
      preHandler: requireSession,
      schema: { response: { 200: beginResponseSchema } },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      return beginAddAuthenticator(db, config, { userId: session.userId, now: new Date() });
    },
  );

  app.post(
    '/v1/auth/hardware-key/register/verify',
    {
      preHandler: [requireSession, requireStepUp('register_hardware_key')],
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
      const session = request.session;
      const stepUp = request.stepUp;
      const audit = app.audit;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('step-up required');
      }
      const body = request.body as { challengeId: string; response: RegistrationResponseJSON };
      const result = await finishRegistration(db, verifier, {
        challengeId: body.challengeId,
        response: body.response,
        now: new Date(),
        isHardwareKey: true,
        // Audit written IN the credential-insert transaction; the step-up proof
        // is recorded in the payload (not as the chain user_signature — it signs
        // a different message; see stepup.ts).
        audit,
        auditEventType: 'hardware_key.registered',
        auditPayload: {
          stepUpChallengeId: stepUp.challengeId,
          stepUpSignature: Buffer.from(stepUp.signature).toString('base64url'),
        },
      });
      void reply.status(201);
      return result;
    },
  );
}
