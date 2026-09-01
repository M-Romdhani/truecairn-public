import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/password.js';
import { requireSession } from '../auth/session.js';
import { requireStepUp } from '../auth/stepup.js';
import { unauthorized } from '../errors.js';

// Set or change the fallback login password — a step-up-gated factor enrolment,
// born gated. The login path (auth-password.ts) carries the rehash-on-verify
// upgrade for any hash written here under older Argon2id parameters.
export function passwordSetupRoutes(app: FastifyInstance, db: Database): void {
  app.post(
    '/v1/auth/password/set',
    {
      preHandler: [requireSession, requireStepUp('password_set')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['password'],
          properties: { password: { type: 'string', minLength: 8, maxLength: 1024 } },
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
    async (request) => {
      const session = request.session;
      const stepUp = request.stepUp;
      const audit = app.audit;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('step-up required');
      }
      const body = request.body as { password: string };
      const phc = hashPassword(body.password);
      const now = new Date();
      await db.transaction(async (tx) => {
        const tdb = tx as unknown as Database;
        await tdb
          .insert(schema.passwordCredentials)
          .values({ userId: session.userId, argon2Phc: phc, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: schema.passwordCredentials.userId,
            set: { argon2Phc: phc, updatedAt: now },
          });
        await audit.append(tdb, session.userId as UserId, 'password.set', {
          stepUpChallengeId: stepUp.challengeId,
          stepUpSignature: Buffer.from(stepUp.signature).toString('base64url'),
        });
      });
      return { ok: true as const };
    },
  );
}
