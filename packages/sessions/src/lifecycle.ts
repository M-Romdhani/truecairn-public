import { schema, type Database } from '@truecairn/db';
import type { DeviceRegistrationId, SessionId, UserId } from '@truecairn/shared';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { generateSessionToken, hashPresentedToken } from './token.js';
import {
  DEFAULT_ABSOLUTE_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_STEPUP_FRESHNESS_MS,
  type SessionContext,
} from './types.js';

export interface CreateSessionInput {
  userId: UserId;
  now: Date;
  deviceRegistrationId?: DeviceRegistrationId;
  userAgent?: string;
  createdIpHash?: Uint8Array;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
}

export interface CreatedSession {
  id: SessionId;
  // The raw token, returned ONCE for the caller to set as the cookie. The
  // server never stores it — only its SHA-256 hash.
  token: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

// Creates a session and returns the raw token. The caller (a login route) sets
// it as an HttpOnly+Secure+SameSite cookie (transport per Q3).
export async function createSession(
  db: Database,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const idleTtl = input.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const absoluteTtl = input.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
  const idleExpiresAt = new Date(input.now.getTime() + idleTtl);
  const absoluteExpiresAt = new Date(input.now.getTime() + absoluteTtl);
  const { token, tokenHash } = generateSessionToken();

  const [row] = await db
    .insert(schema.sessions)
    .values({
      userId: input.userId,
      tokenHash,
      deviceRegistrationId: input.deviceRegistrationId ?? null,
      createdAt: input.now,
      lastSeenAt: input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      userAgent: input.userAgent ?? null,
      createdIpHash: input.createdIpHash ?? null,
    })
    .returning({ id: schema.sessions.id });
  if (!row) throw new Error('sessions insert returned no row');

  return { id: row.id as SessionId, token, idleExpiresAt, absoluteExpiresAt };
}

// Validates a presented cookie token and, if valid, slides the idle window and
// bumps last_seen_at — all in ONE guarded UPDATE, so an expired or revoked
// session is never touched (the WHERE re-checks validity atomically). The idle
// window never slides past the absolute cap. Returns the safe SessionContext,
// or null if the token is malformed, unknown, revoked, or expired.
export async function resolveSession(
  db: Database,
  token: string,
  now: Date,
  idleTtlMs: number = DEFAULT_IDLE_TTL_MS,
): Promise<SessionContext | null> {
  const tokenHash = hashPresentedToken(token);
  if (!tokenHash) return null;

  const newIdleExpiry = new Date(now.getTime() + idleTtlMs);

  const rows = await db
    .update(schema.sessions)
    .set({
      lastSeenAt: now,
      // A bare Date interpolated into a raw `sql` fragment has no column-type
      // context for the driver to serialise it; pass an ISO string and cast.
      idleExpiresAt: sql`LEAST(${newIdleExpiry.toISOString()}::timestamptz, ${schema.sessions.absoluteExpiresAt})`,
    })
    .where(
      and(
        eq(schema.sessions.tokenHash, tokenHash),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.idleExpiresAt, now),
        gt(schema.sessions.absoluteExpiresAt, now),
      ),
    )
    .returning();

  const row = rows[0];
  if (!row) return null;
  return toContext(row);
}

// Revokes one session (explicit logout / per-device revoke). Idempotent: a
// second call on an already-revoked row returns false.
export async function revokeSession(
  db: Database,
  sessionId: SessionId,
  reason: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(schema.sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)))
    .returning({ id: schema.sessions.id });
  return rows.length > 0;
}

// Revokes every active session for a user. Used by "sign out everywhere" and —
// forced — on master-passphrase rotation / recovery-code use. `exceptSessionId`
// lets a "sign out my OTHER sessions" call keep the current one. Returns the
// number revoked. This NEVER cancels pending sensitive actions (§"(f)").
export async function revokeAllUserSessions(
  db: Database,
  userId: UserId,
  reason: string,
  now: Date,
  exceptSessionId?: SessionId,
): Promise<number> {
  const conditions = [eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)];
  if (exceptSessionId !== undefined) conditions.push(ne(schema.sessions.id, exceptSessionId));

  const rows = await db
    .update(schema.sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(...conditions))
    .returning({ id: schema.sessions.id });
  return rows.length;
}

// Stamp a fresh second-factor proof onto the session (sets last_stepup_at).
// Called by the step-up second-factor sub-step after a TOTP/WebAuthn check; the
// tier-2 gate then reads last_stepup_at for the freshness predicate.
export async function stampStepUp(db: Database, sessionId: SessionId, now: Date): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ lastStepupAt: now })
    .where(eq(schema.sessions.id, sessionId));
}

// Whether a session has a fresh-enough second-factor proof for a step-up. Pure;
// the tier-2 gate (later) combines this with the passphrase signature check.
export function isStepUpFresh(
  ctx: SessionContext,
  now: Date,
  freshnessMs: number = DEFAULT_STEPUP_FRESHNESS_MS,
): boolean {
  if (ctx.lastStepupAt === null) return false;
  return now.getTime() - ctx.lastStepupAt.getTime() < freshnessMs;
}

function toContext(row: typeof schema.sessions.$inferSelect): SessionContext {
  return {
    id: row.id as SessionId,
    userId: row.userId as UserId,
    deviceRegistrationId: (row.deviceRegistrationId as DeviceRegistrationId | null) ?? null,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    lastStepupAt: row.lastStepupAt,
  };
}
