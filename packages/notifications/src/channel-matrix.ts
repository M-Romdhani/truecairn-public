import { schema, type Database } from '@truecairn/db';
import type { CvPurposeClass, NotificationChannelType, UserId } from '@truecairn/shared';
import { and, eq, isNull } from 'drizzle-orm';

// The owner-defined channel matrix (docs/26 §3.1), resolved. The rule is one
// line and it is load-bearing: ABSENT PREFERENCE = ENABLED. Owners who never
// open the matrix get today's behaviour; a preference row exists only to opt a
// channel OUT of a purpose class. Selection everywhere remains verified-and-
// live-only — the matrix can only narrow that set, never widen it.

export interface EligibleChannel {
  id: string;
  channelType: NotificationChannelType;
}

// Pure default rule, unit-testable without a DB: is (channelId, class) enabled
// given the user's preference rows?
export function isChannelEnabled(
  preferences: ReadonlyArray<{ channelId: string; purposeClass: CvPurposeClass; enabled: boolean }>,
  channelId: string,
  purposeClass: CvPurposeClass,
): boolean {
  const row = preferences.find(
    (p) => p.channelId === channelId && p.purposeClass === purposeClass,
  );
  return row?.enabled ?? true;
}

// The verified, live, matrix-enabled channels for a purpose class — what the
// CV cadence fans out to, and what any future class-aware selection consumes.
export async function eligibleChannels(
  db: Database,
  userId: UserId,
  purposeClass: CvPurposeClass,
): Promise<EligibleChannel[]> {
  const channels = await db
    .select({
      id: schema.notificationChannels.id,
      channelType: schema.notificationChannels.channelType,
    })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
      ),
    )
    .orderBy(schema.notificationChannels.createdAt);
  if (channels.length === 0) return [];
  const preferences = await db
    .select({
      channelId: schema.channelPreferences.channelId,
      purposeClass: schema.channelPreferences.purposeClass,
      enabled: schema.channelPreferences.enabled,
    })
    .from(schema.channelPreferences)
    .where(eq(schema.channelPreferences.userId, userId));
  return channels.filter((c) => isChannelEnabled(preferences, c.id, purposeClass));
}
