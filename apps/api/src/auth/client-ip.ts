import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config.js';

// ── Which address do we believe is the client's? (QA 2026-08-26 F1) ──────────
//
// Every per-IP control in this service — the login throttle, the passkey
// throttle, the step-up TOTP throttle (which has NO per-account lock by design,
// so this is its only application-layer brake), the AI rate ceilings, and the
// `ip.sustained_abuse` signal — hashes whatever this module returns. So this is
// a security primitive, not a logging nicety: if a client can choose the value,
// it can choose a fresh bucket per request and none of those controls bind.
//
// The old implementation took the LEFTMOST `X-Forwarded-For` entry. That entry
// is the one the CLIENT supplies. Cloudflare and Railway both APPEND the address
// they saw to the RIGHT of whatever arrived, so `X-Forwarded-For: 9.9.9.9`
// reached us as `9.9.9.9, <cf>, <railway>` and we returned `9.9.9.9`. Measured
// 2026-08-26 against real Fastify instances: the spoof won under BOTH
// `trustProxy: true` (where Fastify's own `request.ip` is equally leftmost-
// derived) and `trustProxy: false` (where `request.ip` was correct and this
// function overrode it anyway). `TRUST_PROXY` was never the bug; reading the
// header here was.
//
// The rule this module enforces: **only two sources are trustworthy** —
//
//   1. the socket peer address, which no header can influence, and
//   2. a header written by an edge WE control, and only while nobody can reach
//      the origin except through that edge.
//
// `CLIENT_IP_HEADER` names (2). In production that is `cf-connecting-ip`, which
// Cloudflare overwrites on every proxied request — a client cannot forge it
// THROUGH Cloudflare. It can still forge it by hitting the origin directly, so
// the header is only as good as the origin lock; see `origin-guard.ts`, and set
// both or neither.
//
// `X-Forwarded-For` is deliberately never consulted. Deriving a client from it
// needs an exact count of appending proxies, that count differs between the
// through-Cloudflare path and the direct-to-origin path, and a wrong count is
// the same class of bug we are fixing. A single authoritative header needs no
// counting.
//
// Resolution happens ONCE, in an onRequest hook, and the result is stashed on
// the request. That is deliberate: the policy cannot then be re-derived (or
// re-derived differently) by a future call site that forgets to apply it.

// Fallback when the peer address is unavailable (a synthetic request in a unit
// test, a closed socket). A constant, so such requests share one bucket rather
// than each inventing their own.
const UNKNOWN_IP = 'unknown';

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  // A DUPLICATED header is refused outright, not resolved to one of its halves.
  //
  // Found by this module's own test on 2026-08-27: Node does not always surface
  // duplicates as an array — for most headers it JOINS them, so a client that
  // also sends `cf-connecting-ip` produces the single string
  // `"<edge value>,<client value>"`. An earlier draft here took `[0]` of an
  // array and never saw that case, so the client's value became part of the
  // bucket key and the attacker could still pick a fresh bucket per request:
  // the very bypass this module exists to close.
  //
  // Picking a half would mean betting on which end the trusted edge writes, and
  // that differs by edge. A duplicate means the request is not well-formed by
  // our own edge's contract, so we discard the header and fall back to the
  // socket peer — coarse, but never attacker-chosen. A legitimate address can
  // never contain a comma, so this rejects nothing real.
  if (Array.isArray(raw)) return null;
  if (typeof raw !== 'string') return null;
  if (raw.includes(',')) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// The pure policy, exported for the tests that pin it.
export function resolveClientIp(request: FastifyRequest, config: ApiConfig): string {
  const header = config.clientIpHeader;
  if (header !== undefined) {
    const value = headerValue(request, header);
    if (value !== null) return value;
    // Configured but ABSENT on this request. Fall through to the socket peer —
    // never to X-Forwarded-For. A missing trusted header means the request did
    // not come through the trusted edge, which is exactly when a client-supplied
    // header is least believable.
  }
  return request.socket.remoteAddress ?? UNKNOWN_IP;
}

// Install the resolver. Runs in onRequest so every later hook, throttle and
// route sees the same decided value.
export function registerClientIp(app: FastifyInstance, config: ApiConfig): void {
  app.decorateRequest('trueClientIp', '');
  app.addHook('onRequest', (request, _reply, done) => {
    request.trueClientIp = resolveClientIp(request, config);
    done();
  });
}

// Whether this configuration can tell one client from another. False means every
// request behind the edge collapses into a single bucket: the per-IP controls
// still FAIL CLOSED (they throttle more, never less) but they stop being per-IP,
// so a handful of failures anywhere can throttle everyone. buildApp warns at boot
// rather than letting that be discovered in production.
export function clientIpIsDistinguishing(config: ApiConfig): boolean {
  return config.clientIpHeader !== undefined || !config.trustProxy;
}
