import { createHash } from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

// Rate limiting + lockout (PHASE3_1_AUTH_PROPOSAL §5; 3.1 tail). Postgres
// counters over auth_attempts (no Redis in V1 — same decision as challenges).
//
// Conservative V1 thresholds (reviewer-specified):
//   - 30 failures per IP in 5 min   -> throttle that IP (429), no account change
//   - 5 failures per account in 15min -> account_status='locked' for 1 hour
//
// The per-IP limit is the fast-probe-many-emails defense: it is checked BEFORE
// any DB credential lookup, so one IP hammering many emails is throttled
// regardless of which (existing or not) emails it targets. The per-account
// identifier is the lowercased email whether or not an account exists, so the
// throttle bucket is identical for unknown emails (enumeration discipline §e).

export const IP_WINDOW_MS = 5 * 60 * 1000;
export const IP_MAX_FAILURES = 30;
export const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
export const ACCOUNT_MAX_FAILURES = 5;
export const ACCOUNT_LOCK_MS = 60 * 60 * 1000;

// Sustained-abuse observability (purely a signal; the 429 is unchanged). When a
// throttled IP has also failed more than this in the trailing hour — a floor no
// legitimate NAT'd user reaches — we record one ip.sustained_abuse security
// event so ops can add an infra-layer block. Deduped so a hammering IP does not
// insert a row per request.
export const SUSTAINED_ABUSE_WINDOW_MS = 60 * 60 * 1000;
export const SUSTAINED_ABUSE_THRESHOLD = 200;
export const SUSTAINED_ABUSE_DEDUP_MS = 10 * 60 * 1000;

export type AuthScope = 'login' | 'totp' | 'recovery_code';

// ── AI-route rate limiting (plan docs/25 §4 task 0.1) ─────────────────────────
//
// A fixed-window counter reusing auth_attempts, extended with AI scopes. Unlike
// the auth limiter (which counts FAILURES to lock accounts), the AI limiter counts
// every ALLOWED model call (succeeded=true) per user AND per IP-hash within a
// window, and 429s once either ceiling is reached. Only AI code writes these
// scopes, so the failure-counting auth paths are unaffected.
export type AiRateScope = 'ai_assist' | 'ai_briefing' | 'ai_guardian_explain' | 'ai_narration';

export interface AiRateCeilings {
  perUser: number;
  perIp: number;
  windowMs: number;
}

// Count AI calls in the window for a scope, keyed by identifier (user id) OR ip
// hash. Counts ALL rows (AI rows are always succeeded=true), distinct from the
// auth countFailures which filters succeeded=false.
async function countAiCalls(
  db: Database,
  scope: AiRateScope,
  key: { identifier?: string; ipHash?: Uint8Array },
  since: Date,
): Promise<{ n: number; oldest: string | null }> {
  const conditions = [
    eq(schema.authAttempts.scope, scope),
    gt(schema.authAttempts.attemptedAt, since),
  ];
  if (key.identifier !== undefined)
    conditions.push(eq(schema.authAttempts.identifier, key.identifier));
  if (key.ipHash !== undefined) conditions.push(eq(schema.authAttempts.ipHash, key.ipHash));
  const rows = await db
    .select({
      n: sql<string>`count(*)`,
      oldest: sql<string | null>`min(${schema.authAttempts.attemptedAt})`,
    })
    .from(schema.authAttempts)
    .where(and(...conditions));
  return { n: Number(rows[0]?.n ?? '0'), oldest: rows[0]?.oldest ?? null };
}

// (checkAiRateLimit removed 2026-08-07 — it was the check half of a check-then-act
// pair. Replaced by reserveAiCall below, which inserts and counts atomically.
// Deliberately not kept alongside it: leaving a non-reserving variant in reach is
// how the race comes back.)

// Sentinel used to roll the reservation transaction back without surfacing an
// error to the caller — drizzle rolls back on throw, and there is no other way to
// abandon a transaction whose only purpose was to hold a row.
class ReservationRejected extends Error {
  constructor(readonly block: RateLimitBlock) {
    super('ai rate reservation rejected');
  }
}

// RESERVE one AI model call: insert the accounting row and then count INCLUDING
// it, both inside one transaction, rolling back when the ceiling is passed.
//
// 2026-08-07 audit, finding 5. This replaces a check-then-act pair — a count(*)
// in checkAiRateLimit followed later by a separate insert — under which N
// concurrent requests all read the same sub-ceiling total and all proceeded. The
// ceiling bounded nothing under concurrency, which for a metered model API is
// spend, and AI_DAILY_TOKEN_BUDGET is undefined (unbounded) by default, so on a
// stock config there was no second layer beneath it.
//
// Inserting first is what makes it correct: the row exists before the decision,
// so simultaneous callers count each other instead of racing a stale total. Note
// the comparison is `>` rather than `>=` precisely because our own row is now
// part of the count. This is the same ordering recordAttempt already uses for the
// account-lock counter, which is why THAT path never had this bug.
export async function reserveAiCall(
  db: Database,
  scope: AiRateScope,
  userId: string,
  ipHash: Uint8Array | null,
  ceilings: AiRateCeilings,
  now: Date,
): Promise<RateLimitBlock | null> {
  const since = new Date(now.getTime() - ceilings.windowMs);
  try {
    return await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      // SERIALIZE first. Inserting before counting is necessary but NOT
      // sufficient: under READ COMMITTED (Postgres' default, and what this
      // codebase runs) a transaction cannot see another's uncommitted row, so ten
      // simultaneous reservations still each counted only themselves. A test with
      // ten concurrent calls against a ceiling of 3 let 7 through until these
      // locks went in.
      //
      // Transaction-scoped advisory locks: released automatically at commit or
      // rollback, so no path can leak one. Always taken user-then-IP, a fixed
      // order, so two users sharing an IP cannot deadlock against each other.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${scope}:u:${userId}`}, 0))`);
      if (ipHash !== null) {
        const ipKey = Buffer.from(ipHash).toString('hex');
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai:${scope}:ip:${ipKey}`}, 0))`);
      }
      await tx.insert(schema.authAttempts).values({
        scope,
        identifier: userId,
        ipHash,
        succeeded: true,
        attemptedAt: now,
      });
      const user = await countAiCalls(tx, scope, { identifier: userId }, since);
      if (user.n > ceilings.perUser) {
        throw new ReservationRejected({
          scope: 'account',
          retryAfterSeconds: retryAfter(user.oldest, ceilings.windowMs, now),
        });
      }
      if (ipHash !== null) {
        const ip = await countAiCalls(tx, scope, { ipHash }, since);
        if (ip.n > ceilings.perIp) {
          throw new ReservationRejected({
            scope: 'ip',
            retryAfterSeconds: retryAfter(ip.oldest, ceilings.windowMs, now),
          });
        }
      }
      return null;
    });
  } catch (err) {
    if (err instanceof ReservationRejected) return err.block;
    throw err;
  }
}

// A salted hash of the client IP — never the raw IP (same discipline as
// device_registrations.last_ip_hash). The salt is the server's TOTP-lane secret
// space; for V1 we hash with a fixed app pepper passed in by the caller so the
// value is stable within a deployment but not a plaintext IP at rest.
export function hashIp(ip: string, pepper: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(pepper).update(ip).digest());
}

export interface RateLimitBlock {
  scope: 'ip' | 'account';
  retryAfterSeconds: number;
}

// Per-IP precheck. Runs BEFORE any credential lookup. Returns a block (with the
// seconds until the oldest in-window failure ages out) or null to proceed.
export async function checkIpThrottle(
  db: Database,
  scope: AuthScope,
  ipHash: Uint8Array,
  now: Date,
): Promise<RateLimitBlock | null> {
  const since = new Date(now.getTime() - IP_WINDOW_MS);
  const rows = await db
    .select({
      n: sql<string>`count(*)`,
      oldest: sql<string | null>`min(${schema.authAttempts.attemptedAt})`,
    })
    .from(schema.authAttempts)
    .where(
      and(
        eq(schema.authAttempts.scope, scope),
        eq(schema.authAttempts.ipHash, ipHash),
        eq(schema.authAttempts.succeeded, false),
        gt(schema.authAttempts.attemptedAt, since),
      ),
    );
  if (Number(rows[0]?.n ?? '0') < IP_MAX_FAILURES) return null;
  return { scope: 'ip', retryAfterSeconds: retryAfter(rows[0]?.oldest, IP_WINDOW_MS, now) };
}

// Per-account precheck. If a lock is in force, returns a block; if a lock has
// elapsed, auto-clears it and proceeds. Identifier is the lowercased email.
export async function checkAccountLock(
  db: Database,
  email: string,
  now: Date,
): Promise<RateLimitBlock | null> {
  const emailLower = email.toLowerCase();
  const rows = await db
    .select({ id: schema.users.id, lockedUntil: schema.users.lockedUntil })
    .from(schema.users)
    .where(eq(schema.users.emailLower, emailLower))
    .limit(1);
  const user = rows[0];
  if (user === undefined || user.lockedUntil === null) return null;

  if (user.lockedUntil.getTime() > now.getTime()) {
    return {
      scope: 'account',
      retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000),
    };
  }
  await clearAccountLock(db, user.id, now);
  return null;
}

// Release an account lock by user id. Only flips status back from 'locked',
// never from 'recovery'/'terminated', which are not this mechanism's to clear.
//
// Keyed on the USER, not the email, because the two callers that matter do not
// have an email in hand: passkey login (which authenticates a credential, not an
// address) and requireSession (which resolves a session to a user id). Before
// this existed, the ONLY caller of checkAccountLock in the repo was the password
// login route — so the one-hour expiry never fired for a passkey-only owner, who
// stayed locked in the database indefinitely because nothing they could reach
// ever cleared it.
export async function clearAccountLock(db: Database, userId: string, now: Date): Promise<void> {
  await db
    .update(schema.users)
    .set({
      lockedUntil: null,
      accountStatus: sql`CASE WHEN ${schema.users.accountStatus} = 'locked' THEN 'active'::account_status ELSE ${schema.users.accountStatus} END`,
      updatedAt: now,
    })
    .where(eq(schema.users.id, userId));
}

// Record an attempt. When `accountEmail` is given (password login), a failure
// that pushes the per-account failure count to the threshold flips
// account_status='locked' + sets locked_until and returns the block. When it is
// undefined (passkey login, which is not email-keyed), only the per-IP bucket is
// fed and no account is ever locked. The stored identifier is the lowercased
// email or, for passkey login, the credential id (informational; IP is the key).
export async function recordAttempt(
  db: Database,
  input: {
    scope: AuthScope;
    accountEmail?: string;
    identifier: string;
    ipHash: Uint8Array | null;
    succeeded: boolean;
    now: Date;
  },
): Promise<RateLimitBlock | null> {
  await db.insert(schema.authAttempts).values({
    scope: input.scope,
    identifier: input.identifier,
    ipHash: input.ipHash,
    succeeded: input.succeeded,
    attemptedAt: input.now,
  });
  if (input.succeeded || input.accountEmail === undefined) return null;

  const emailLower = input.accountEmail.toLowerCase();
  const since = new Date(input.now.getTime() - ACCOUNT_WINDOW_MS);
  const failures = await countFailures(db, input.scope, { identifier: emailLower }, since);
  if (failures < ACCOUNT_MAX_FAILURES) return null;

  // Threshold reached. Lock the account if it exists (an unknown email has no
  // row to lock — the per-IP limit is what bounds probing of unknown emails).
  const lockedUntil = new Date(input.now.getTime() + ACCOUNT_LOCK_MS);
  const [locked] = await db
    .update(schema.users)
    .set({ accountStatus: 'locked', lockedUntil, updatedAt: input.now })
    .where(eq(schema.users.emailLower, emailLower))
    .returning({ id: schema.users.id });
  // Notify the real owner (PHASE3_5 §e — the deferred 3.1 anomaly notice): enqueue
  // a security_alert to every verified channel so the user finds out via at least
  // one channel an attacker doesn't hold. The delivery worker sends it; the
  // template content is disciplined (no IP, no attempt count).
  if (locked) await enqueueSecurityAlert(db, locked.id, input.now);
  return { scope: 'account', retryAfterSeconds: Math.ceil(ACCOUNT_LOCK_MS / 1000) };
}

async function enqueueSecurityAlert(db: Database, userId: string, now: Date): Promise<void> {
  const channels = await db
    .select({ id: schema.notificationChannels.id })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
      ),
    );
  if (channels.length === 0) return;
  await db.insert(schema.notificationDeliveries).values(
    channels.map((c) => ({
      channelId: c.id,
      userId,
      purpose: 'security_alert' as const,
      status: 'queued' as const,
      nextAttemptAt: now,
      payloadSummary: 'account locked: unusual login activity',
    })),
  );
}

// Observability only (the 429 is unchanged). When a throttled IP has also failed
// more than SUSTAINED_ABUSE_THRESHOLD times in the trailing hour — a floor no
// legitimate NAT'd user reaches — record ONE ip.sustained_abuse security event
// (not in audit_log, which is per-user hash-chained; this IP signal has no user
// — see migration 0022). Deduped per IP within SUSTAINED_ABUSE_DEDUP_MS so a
// hammering IP records at most a handful of rows per hour.
export async function recordSustainedAbuseIfNeeded(
  db: Database,
  ipHash: Uint8Array,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - SUSTAINED_ABUSE_WINDOW_MS);
  const hourFailureCount = await countFailures(db, 'login', { ipHash }, since);
  if (hourFailureCount < SUSTAINED_ABUSE_THRESHOLD) return;

  const dedupSince = new Date(now.getTime() - SUSTAINED_ABUSE_DEDUP_MS);
  const recent = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.eventType, 'ip.sustained_abuse'),
        eq(schema.securityEvents.ipHash, ipHash),
        gt(schema.securityEvents.createdAt, dedupSince),
      ),
    )
    .limit(1);
  if (recent[0] !== undefined) return;

  await db.insert(schema.securityEvents).values({
    eventType: 'ip.sustained_abuse',
    ipHash,
    payload: {
      ipHash: Buffer.from(ipHash).toString('base64url'),
      hourFailureCount,
      action: 'log_only',
    },
  });
}

async function countFailures(
  db: Database,
  scope: AuthScope,
  key: { ipHash?: Uint8Array; identifier?: string },
  since: Date,
): Promise<number> {
  const conditions = [
    eq(schema.authAttempts.scope, scope),
    eq(schema.authAttempts.succeeded, false),
    gt(schema.authAttempts.attemptedAt, since),
  ];
  if (key.ipHash !== undefined) conditions.push(eq(schema.authAttempts.ipHash, key.ipHash));
  if (key.identifier !== undefined)
    conditions.push(eq(schema.authAttempts.identifier, key.identifier));
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(schema.authAttempts)
    .where(and(...conditions));
  return Number(rows[0]?.n ?? '0');
}

function retryAfter(oldestIso: string | null | undefined, windowMs: number, now: Date): number {
  if (oldestIso === null || oldestIso === undefined) return Math.ceil(windowMs / 1000);
  const oldest = new Date(oldestIso).getTime();
  const until = oldest + windowMs - now.getTime();
  return Math.max(1, Math.ceil(until / 1000));
}
