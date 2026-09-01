import type { Database } from '@truecairn/db';
import { DEFAULT_ABSOLUTE_TTL_MS } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { passwordLogin } from '../auth/password-login.js';
import { checkAccountLock, checkIpThrottle, hashIp, recordAttempt } from '../auth/rate-limit.js';
import { blockIp, clientIp, throwRateLimit } from '../auth/rate-limit-route.js';
import { SESSION_COOKIE } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { ApiError, unauthorized } from '../errors.js';

const PASSKEY_BLOCK_TYPE = 'https://truecairn.app/problems/password-blocked-by-passkey';

// Password + TOTP fallback login. Setup of the password and TOTP factors is a
// step-up-gated enrollment action and lands with requireStepUp (Checkpoint B);
// this route only authenticates existing factors. Rate-limited per §5: per-IP
// throttle BEFORE any credential work, per-account lock after N failures.
export function passwordLoginRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  app.post(
    '/v1/auth/login/password',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password', 'totp'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            totp: { type: 'string', minLength: 6, maxLength: 10 },
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
      const body = request.body as { email: string; password: string; totp: string };
      const userAgent = request.headers['user-agent'];
      const now = new Date();
      const ipHash = hashIp(clientIp(request), config.ipHashPepper);

      // (1) Per-IP throttle FIRST — before any DB credential lookup — so a single
      // IP probing many emails is bounded regardless of which it targets.
      const ipBlock = await checkIpThrottle(db, 'login', ipHash, now);
      if (ipBlock !== null) await blockIp(request, reply, db, ipHash, ipBlock);

      // (2) Per-account lock (auto-clears an elapsed lock). Keyed on the email
      // whether or not it exists, so the bucket is identical for unknown emails.
      const lockBlock = await checkAccountLock(db, body.email, now);
      if (lockBlock !== null) throwRateLimit(reply, lockBlock);

      const result = await passwordLogin(db, {
        email: body.email,
        password: body.password,
        totp: body.totp,
        now,
        totpKeks: config.totpKeks,
        ...(userAgent !== undefined ? { userAgent } : {}),
      });

      // Record the attempt. A failure may push the account over the threshold;
      // if so, recordAttempt flips account_status='locked' and returns the block.
      const succeeded = result.kind === 'ok';
      const lockTriggered = await recordAttempt(db, {
        scope: 'login',
        accountEmail: body.email,
        identifier: body.email.toLowerCase(),
        ipHash,
        succeeded,
        now,
      });

      if (result.kind === 'reject') {
        if (lockTriggered !== null) throwRateLimit(reply, lockTriggered);
        // Identical generic 401 for unknown email / wrong password / wrong TOTP.
        throw unauthorized('authentication failed');
      }
      if (result.kind === 'blocked_by_passkey') {
        // Reachable only after password+TOTP verified, so a blind attacker never
        // sees this distinct type. Q9: refuse — do not downgrade to a session.
        throw new ApiError(
          401,
          'Password Login Blocked',
          'this account uses a passkey; sign in with your passkey',
          PASSKEY_BLOCK_TYPE,
        );
      }

      void reply.setCookie(SESSION_COOKIE, result.session.token, {
        httpOnly: true,
        secure: config.webauthnOrigin.startsWith('https://'),
        sameSite: 'strict',
        path: '/',
        maxAge: Math.floor(DEFAULT_ABSOLUTE_TTL_MS / 1000),
      });
      return { userId: result.userId };
    },
  );
}
