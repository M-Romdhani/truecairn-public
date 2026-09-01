import { schema } from '@truecairn/db';
import { resolveSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { accountLocked, forbidden, unauthorized } from '../errors.js';
import { clearAccountLock } from './rate-limit.js';

// The cookie carrying the opaque session token. Transport per Q3:
// HttpOnly+Secure+SameSite, set by the (later) login route and read here.
export const SESSION_COOKIE = 'tc_session';

// tier-1 gate (PHASE3_1_AUTH_PROPOSAL §3): a valid session plus an
// account_status check. On success it sets request.session. It fails CLOSED:
//   - DB unavailable / no cookie / invalid|expired|revoked session -> 401
//   - account locked                                               -> 403 (Account Locked)
//   - account terminated                                           -> 403
// pending/active/recovery pass requireSession; recovery's sensitive-action
// restriction is enforced later at the tier-2 step-up gate, not here.
export async function requireSession(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await resolve(request, { allowLocked: false });
}

// Same gate, except a LOCKED account is admitted. Mount this only on the
// liveness surface (2026-08-07 security audit, finding 1).
//
// Why the carve-out is safe: the account lock exists to slow credential
// GUESSING, and every route behind this variant accepts no credentials, reveals
// no vault content and changes no configuration. Admitting them costs the
// brute-force defence nothing.
//
// Why it is necessary: this product releases a vault when its owner goes
// silent, and check-in is the owner's only way to say otherwise. The lock is
// keyed on an attacker-supplied email over an unauthenticated route, so leaving
// check-in behind it let anyone who knew an address deny the owner their
// liveness signal and drive the release ladder forward — simulating the owner's
// death from outside. Locking someone out of their vault is correct; locking
// them out of being alive is not.
//
// Everything else — vault, contacts, settings, sensitive actions — stays behind
// requireSession. The negative half is as much the point as the positive half.
export async function requireSessionAllowingLocked(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await resolve(request, { allowLocked: true });
}

async function resolve(
  request: FastifyRequest,
  opts: { allowLocked: boolean },
): Promise<void> {
  const db = request.server.db;
  if (db === null) throw unauthorized('session backend unavailable');

  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined || token === '') throw unauthorized('no session');

  const ctx = await resolveSession(db, token, new Date());
  if (ctx === null) throw unauthorized('invalid or expired session');

  const [user] = await db
    .select({
      accountStatus: schema.users.accountStatus,
      lockedUntil: schema.users.lockedUntil,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId));
  // A valid session always has a user (FK is ON DELETE CASCADE); defensive.
  if (user === undefined) throw unauthorized('invalid or expired session');

  // Terminated is final and has no expiry — never carved out, never self-heals.
  if (user.accountStatus === 'terminated') throw forbidden('account is not active');

  if (user.accountStatus === 'locked') {
    const now = new Date();
    const until = user.lockedUntil;
    if (until === null) {
      // No expiry recorded, so nothing here can prove the lock has run out.
      // recordAttempt always writes locked_until alongside the status, so this
      // is only reachable by a hand-set row — treat it as a deliberate
      // indefinite lock and fail CLOSED rather than clearing it. Bare forbidden,
      // not accountLocked: there is no retry time to honestly report.
      throw forbidden('account is not active');
    }
    if (until.getTime() <= now.getTime()) {
      // An ELAPSED lock self-heals here. checkAccountLock does the same thing,
      // but only the password login route calls it — so a passkey-only owner
      // stayed locked long past the hour, because nothing they could reach ever
      // ran the expiry. Clearing on any authenticated request closes that, and
      // it is safe: the lock's own deadline has passed.
      await clearAccountLock(db, ctx.userId, now);
    } else if (!opts.allowLocked) {
      // accountLocked, not a bare forbidden: a DISTINCT problem type carrying
      // the unlock time, so the client can say "locked, back in N minutes"
      // instead of an unexplained 403. The helper already existed for exactly
      // this and was only ever used from the login route.
      const retryAfterSeconds = Math.ceil((until.getTime() - now.getTime()) / 1000);
      throw accountLocked(retryAfterSeconds, 'account is temporarily locked');
    }
  }

  request.session = ctx;
}
