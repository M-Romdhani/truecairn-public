import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';

// Feature-gathering for the guardian detectors. Reads ONLY server-visible metadata
// (affirmation commit times, failed-auth timestamps) — never content, never a
// contact identity beyond what the release path already holds. Lives in the fenced
// guardian dir and imports only @truecairn/db (no engine/ceremony/sensitive-actions).

// One lookback covers both detector windows (affirmation 5m, failed-auth 15m by
// default); an hour is comfortably wide without pulling unbounded history.
const LOOKBACK_MS = 60 * 60 * 1000;

const ACTIVE_CEREMONY_STATUSES = [
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
] as const;

export interface GuardianFeatures {
  // Commit timestamps (ms) of committed affirmations on the user's active
  // ceremony(ies) — the affirmation_velocity input.
  affirmationCommitMs: number[];
  // Timestamps (ms) of failed auth attempts for the user — the failed_auth input.
  failedAuthMs: number[];
}

export async function gatherFeatures(
  db: Database,
  userId: UserId,
  now: Date,
): Promise<GuardianFeatures> {
  const since = new Date(now.getTime() - LOOKBACK_MS);

  const ceremonies = await db
    .select({ id: schema.releaseCeremonies.id })
    .from(schema.releaseCeremonies)
    .where(
      and(
        eq(schema.releaseCeremonies.userId, userId),
        inArray(schema.releaseCeremonies.status, [...ACTIVE_CEREMONY_STATUSES]),
      ),
    );

  let affirmationCommitMs: number[] = [];
  if (ceremonies.length > 0) {
    const rows = await db
      .select({ committedAt: schema.ceremonyAffirmations.committedAt })
      .from(schema.ceremonyAffirmations)
      .where(
        and(
          inArray(
            schema.ceremonyAffirmations.ceremonyId,
            ceremonies.map((c) => c.id),
          ),
          eq(schema.ceremonyAffirmations.status, 'committed'),
          isNotNull(schema.ceremonyAffirmations.committedAt),
          gt(schema.ceremonyAffirmations.committedAt, since),
        ),
      );
    affirmationCommitMs = rows
      .map((r) => r.committedAt?.getTime())
      .filter((t): t is number => t !== undefined);
  }

  // Failed auth attempts are keyed by the lowercased email (auth_attempts.identifier).
  const [user] = await db
    .select({ emailLower: schema.users.emailLower })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  let failedAuthMs: number[] = [];
  if (user !== undefined) {
    const rows = await db
      .select({ at: schema.authAttempts.attemptedAt })
      .from(schema.authAttempts)
      .where(
        and(
          eq(schema.authAttempts.identifier, user.emailLower),
          eq(schema.authAttempts.succeeded, false),
          gt(schema.authAttempts.attemptedAt, since),
        ),
      );
    failedAuthMs = rows.map((r) => r.at.getTime());
  }

  return { affirmationCommitMs, failedAuthMs };
}
