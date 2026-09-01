import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';

// ── The origin lock ──────────────────────────────────────────────────────────
//
// `client-ip.ts` trusts one header written by the edge. That is only sound while
// the edge is the ONLY way in, and any hostname that reaches this service
// directly breaks it: every header can then be set by hand. Removing such a
// hostname does not close it on its own either, because an edge that routes by
// Host/SNI still delivers a request carrying the right Host to this service.
//
// What does close it is a shared secret the edge injects on every request and we
// require. Anything arriving without it did not come through the edge and is
// refused before it reaches a route.
//
// Deliberately INERT unless `ORIGIN_GUARD_SECRET` is set, and it must not be set
// until the edge is injecting the header — otherwise this locks out every real
// visitor. Order: add the injection, confirm traffic carries it, then set the
// variable.
//
// The response is a bare 403 with no body: a prober learns only that the origin
// is closed, not why, and not what header would open it.

export const ORIGIN_GUARD_HEADER = 'x-truecairn-origin-guard';

// Paths the platform reaches DIRECTLY, never through the edge. Railway's
// container healthcheck hits `/ready` on the internal address, so guarding it
// would fail the healthcheck, restart the container, and — because
// `scripts/start-railway.sh` binds the API and the release worker to one
// lifecycle — restart the release worker in a loop. `/health` is exempt for the
// same reason. Neither discloses anything: both are already public today.
const EXEMPT_PATHS = new Set(['/health', '/ready']);

function headerMatches(received: string | string[] | undefined, expected: Buffer): boolean {
  const single = Array.isArray(received) ? received[0] : received;
  if (typeof single !== 'string') return false;
  const got = Buffer.from(single, 'utf8');
  // Length must match before timingSafeEqual, which throws on a length mismatch.
  // Comparing lengths first leaks only the length, which is not the secret.
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function registerOriginGuard(app: FastifyInstance, config: ApiConfig): void {
  const secret = config.originGuardSecret;
  if (secret === undefined) return;
  const expected = Buffer.from(secret, 'utf8');

  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?')[0] ?? '';
    if (EXEMPT_PATHS.has(path)) {
      done();
      return;
    }
    if (headerMatches(request.headers[ORIGIN_GUARD_HEADER], expected)) {
      done();
      return;
    }
    // Not through the edge. Log at warn — a sustained stream here means someone
    // found the origin, which is worth seeing. No header values are logged.
    request.log.warn({ path }, 'origin_guard.rejected');
    void reply.code(403).send();
  });
}
