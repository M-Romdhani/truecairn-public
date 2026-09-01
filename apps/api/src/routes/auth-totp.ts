import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { requireStepUp } from '../auth/stepup.js';
import { base32Encode, buildOtpauthUri } from '../auth/totp.js';
import { confirmTotp, setupTotp } from '../auth/totp-store.js';
import type { ApiConfig } from '../config.js';
import { badRequest, unauthorized } from '../errors.js';

// TOTP enrolment. Setup is a step-up-gated factor enrolment (born gated);
// confirm only needs a session (it proves the user holds the just-issued
// secret). The secret is wrapped under the current versioned KEK by the store.
export function totpRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  app.post(
    '/v1/auth/totp/setup',
    {
      preHandler: [requireSession, requireStepUp('totp_setup')],
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['otpauthUri', 'secretBase32'],
            properties: {
              otpauthUri: { type: 'string' },
              secretBase32: { type: 'string' },
            },
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
      const now = new Date();
      let secret: Uint8Array | undefined;
      await db.transaction(async (tx) => {
        const tdb = tx as unknown as Database;
        secret = (await setupTotp(tdb, config.totpKeks, session.userId, now)).secret;
        await audit.append(tdb, session.userId as UserId, 'totp.setup', {
          stepUpChallengeId: stepUp.challengeId,
          stepUpSignature: Buffer.from(stepUp.signature).toString('base64url'),
        });
      });
      if (secret === undefined) throw new Error('totp setup produced no secret');

      const u = await db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, session.userId))
        .limit(1);
      const account = u[0]?.email ?? session.userId;
      return {
        otpauthUri: buildOtpauthUri(config.webauthnRpName, account, secret),
        secretBase32: base32Encode(secret),
      };
    },
  );

  app.post(
    '/v1/auth/totp/confirm',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code'],
          properties: { code: { type: 'string', minLength: 6, maxLength: 10 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['confirmed'],
            properties: { confirmed: { type: 'boolean', enum: [true] } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const body = request.body as { code: string };
      const ok = await confirmTotp(db, config.totpKeks, session.userId, body.code, new Date());
      if (!ok) throw badRequest('invalid confirmation code');
      return { confirmed: true as const };
    },
  );
}
