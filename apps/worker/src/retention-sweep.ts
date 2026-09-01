import { schema, type Database } from '@truecairn/db';
import { inArray, lt } from 'drizzle-orm';

// ── Retention sweeps for high-churn operational tables ───────────────────────
//
// Two tables that grow forever and nothing was reaping (2026-08-07 audit,
// findings 6 and 11). Both are pure operational churn: nothing here is evidence
// anyone relies on beyond a short window, and both are read on hot paths.
//
// ── auth_attempts (finding 6) ─────────────────────────────────────────────────
//
// This table had no retention at all, while its sibling status_samples has had a
// 90-day prune since the day it was introduced. Retention was implemented once
// and not generalised.
//
// It matters more than it did when the table only held logins: the AI rate
// limiter later reused auth_attempts as its counter store, so there is now a row
// per MODEL CALL on top of every login and TOTP attempt. A single abusive IP can
// add ~8,640 rows/day while staying inside the throttle, and AI usage adds rows
// in proportion to product usage — unbounded growth on a table read in the hot
// path of every login.
//
// Scan cost is not the problem: auth_attempts_window and auth_attempts_ip_window
// both lead with (scope, …, attempted_at) and serve the limiters' predicates as
// range scans. Storage and autovacuum pressure are.

// Every window this table serves is short — per-IP 5 min, per-account 15 min, the
// AI rate window ~1h — so a week is generous for the limiters while leaving
// recent auth history readable during an incident. Deliberately not derived from
// those constants: shortening a limiter window should not silently shorten
// forensic retention.
export const AUTH_ATTEMPT_RETENTION_DAYS = 7;

// One bounded batch; returns rows deleted so the caller can loop until drained
// without ever holding a long transaction. A first run against a table that has
// been growing since launch would otherwise be one very large delete.
export async function pruneAuthAttempts(
  db: Database,
  now: Date,
  opts: { retentionDays?: number; limit?: number } = {},
): Promise<number> {
  const retentionDays = opts.retentionDays ?? AUTH_ATTEMPT_RETENTION_DAYS;
  const limit = opts.limit ?? 5_000;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const doomed = await db
    .select({ id: schema.authAttempts.id })
    .from(schema.authAttempts)
    .where(lt(schema.authAttempts.attemptedAt, cutoff))
    .limit(limit);
  if (doomed.length === 0) return 0;

  // Delete by the ids just selected: the plan stays trivial and the statement
  // size stays bounded, rather than re-evaluating the predicate over the table.
  await db.delete(schema.authAttempts).where(
    inArray(
      schema.authAttempts.id,
      doomed.map((r) => r.id),
    ),
  );
  return doomed.length;
}

// ── auth_challenges (finding 11) ──────────────────────────────────────────────
//
// The step-up gate mints a challenge row BEFORE any verification: a request
// missing the challenge/signature headers gets one issued and then throws
// StepUpRequiredError. That is the correct shape — the client needs the challenge
// in order to sign — but it means any authenticated caller can insert rows at one
// per request simply by hitting a step-up-gated route in a loop, and nothing ever
// removed them. The 10-minute TTL bounded a challenge's USEFULNESS, not its
// lifetime on disk.
//
// Pruning is the whole fix. The audit also suggested reusing an unexpired
// challenge per (user, purpose, action) instead of minting a new one; that is a
// behaviour change on an auth path — it makes a challenge replayable within its
// window — and a reaper makes the growth argument moot without touching the
// security property. Not doing it is the deliberate choice.

// Expired challenges are dead weight the moment they lapse; a day of slack keeps
// a recently-expired row visible while debugging a failed step-up.
export const AUTH_CHALLENGE_RETENTION_DAYS = 1;

export async function pruneAuthChallenges(
  db: Database,
  now: Date,
  opts: { retentionDays?: number; limit?: number } = {},
): Promise<number> {
  const retentionDays = opts.retentionDays ?? AUTH_CHALLENGE_RETENTION_DAYS;
  const limit = opts.limit ?? 5_000;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Keyed on expires_at, not created_at: a challenge is only ever a liability
  // after it lapses, and this way a longer-lived purpose is never cut short.
  const doomed = await db
    .select({ id: schema.authChallenges.id })
    .from(schema.authChallenges)
    .where(lt(schema.authChallenges.expiresAt, cutoff))
    .limit(limit);
  if (doomed.length === 0) return 0;

  await db.delete(schema.authChallenges).where(
    inArray(
      schema.authChallenges.id,
      doomed.map((r) => r.id),
    ),
  );
  return doomed.length;
}
