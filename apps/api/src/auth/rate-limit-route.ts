import type { Database } from '@truecairn/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { accountLocked, tooManyRequests } from '../errors.js';
import { recordSustainedAbuseIfNeeded, type RateLimitBlock } from './rate-limit.js';

// The client IP for rate-limiting. Hashed before storage by the caller — the raw
// value never leaves this request.
//
// The decision itself lives in `client-ip.ts` and is made ONCE per request, in an
// onRequest hook, so this is a read rather than a derivation. That matters: this
// function used to trust the leftmost `X-Forwarded-For` entry, which is the value
// the CLIENT supplies (QA 2026-08-26 F1), and centralising the policy is what
// stops a future call site from reintroducing that by reading a header again.
export function clientIp(request: FastifyRequest): string {
  const resolved = request.trueClientIp;
  if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  // The hook is not installed — a unit test standing up a bare Fastify. Fall back
  // to the socket peer, NEVER to `request.ip` (leftmost-XFF under trustProxy) and
  // never to a header, so the invariant holds even off the app's own path.
  return request.socket.remoteAddress ?? 'unknown';
}

// Translate a RateLimitBlock into the §e wire response: set the Retry-After
// header (transport) and throw the matching RFC 7807 problem (body carries
// retryAfterSeconds). A per-account lock is a DISTINCT 403 type from a per-IP
// 429 so the client can tell "back off" from "your account is locked".
export function throwRateLimit(reply: FastifyReply, block: RateLimitBlock): never {
  void reply.header('retry-after', String(block.retryAfterSeconds));
  if (block.scope === 'account') {
    throw accountLocked(block.retryAfterSeconds, 'too many failed attempts; account locked');
  }
  throw tooManyRequests(block.retryAfterSeconds, 'too many attempts; try again later');
}

// The per-IP block path: record the sustained-abuse observability signal (best
// effort — never blocks the response) then throw the 429. Used by both login
// routes; account locks go through throwRateLimit directly.
export async function blockIp(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database,
  ipHash: Uint8Array,
  block: RateLimitBlock,
): Promise<never> {
  try {
    await recordSustainedAbuseIfNeeded(db, ipHash, new Date());
  } catch (err) {
    request.log.warn({ err }, 'security_event.record_failed');
  }
  throwRateLimit(reply, block);
}
