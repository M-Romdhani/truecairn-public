import { schema, type Database } from '@truecairn/db';
import { routineNoticeClass, type NotificationPurpose, type UserId } from '@truecairn/shared';
import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import type { NotificationChannelLookup } from './applier.js';

// Real channel lookup backed by notification_channels. Lives in the engine
// package (next to the NotificationChannelLookup interface it implements) so
// every process that applies engine transitions — the worker's time ticks and
// the API's event emissions (e.g. user_authenticated_during_release on a vault
// fetch during release) — shares one implementation.
export class DbChannelLookup implements NotificationChannelLookup {
  constructor(private readonly db: Database) {}

  async pickPrimaryChannel(userId: UserId, purpose?: NotificationPurpose): Promise<string | null> {
    // Matrix enforcement for routine notice classes (docs/26 §3.1): when the
    // purpose maps to a class, skip channels the owner opted out of that class
    // (absent preference row = enabled — the load-bearing default). Exempt
    // purposes (check-in/escalation safety floor, security alerts, operational
    // round-trips) map to null and see every verified channel, so the matrix
    // narrows where routine updates land but can never silence a check-in.
    const purposeClass = purpose === undefined ? null : routineNoticeClass(purpose);
    const conditions = [
      eq(schema.notificationChannels.userId, userId),
      eq(schema.notificationChannels.verified, true),
      isNull(schema.notificationChannels.removedAt),
    ];
    if (purposeClass !== null) {
      conditions.push(
        notExists(
          this.db
            .select({ one: sql`1` })
            .from(schema.channelPreferences)
            .where(
              and(
                eq(schema.channelPreferences.channelId, schema.notificationChannels.id),
                eq(schema.channelPreferences.purposeClass, purposeClass),
                eq(schema.channelPreferences.enabled, false),
              ),
            ),
        ),
      );
    }
    const rows = await this.db
      .select({ id: schema.notificationChannels.id })
      .from(schema.notificationChannels)
      .where(and(...conditions))
      .orderBy(schema.notificationChannels.createdAt)
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async summarizeHealth(
    userId: UserId,
  ): Promise<{ totalChannels: number; failingChannels: number }> {
    const result = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        failing: sql<number>`sum(case when ${schema.notificationChannels.health} = 'failing' then 1 else 0 end)::int`,
      })
      .from(schema.notificationChannels)
      .where(
        and(
          eq(schema.notificationChannels.userId, userId),
          isNull(schema.notificationChannels.removedAt),
        ),
      );
    const row = result[0];
    return {
      totalChannels: row?.total ?? 0,
      failingChannels: row?.failing ?? 0,
    };
  }
}
