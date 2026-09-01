import { revokeAllUserSessions, revokeSession } from '@truecairn/sessions';
import type { Database } from '@truecairn/db';
import type { SessionId } from '@truecairn/shared';
import type { FastifyInstance } from 'fastify';
import { requireFreshSecondFactor } from '../auth/stepup.js';
import { requireSession, SESSION_COOKIE } from '../auth/session.js';
import { unauthorized } from '../errors.js';

// Session lifecycle routes (security-hardening follow-up to the posture review).
// The platform's whole protective model assumes an owner can REACT to a
// suspected compromise — which needs server-side revocation, not just waiting
// out the idle/absolute TTLs.
export function logoutRoutes(app: FastifyInstance, db: Database): void {
  // ── Sign out THIS session ───────────────────────────────────────────────────
  // Session-only: ending your own session is always safe.
  app.post('/v1/auth/logout', { preHandler: requireSession }, async (request, reply) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    await revokeSession(db, session.id as SessionId, 'user_logout', new Date());
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true as const };
  });

  // ── Sign out EVERYWHERE ELSE ────────────────────────────────────────────────
  // The "I think a session was stolen" response: revokes every OTHER session,
  // keeping this one so the owner stays in control. Gated on a fresh second
  // factor (same bar as cancel-release) so a stolen session cannot use it to
  // evict the real owner.
  app.post(
    '/v1/auth/sessions/revoke-others',
    { preHandler: [requireSession, requireFreshSecondFactor] },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const revoked = await revokeAllUserSessions(
        db,
        session.userId,
        'user_revoke_others',
        new Date(),
        session.id as SessionId,
      );
      return { revoked };
    },
  );
}
