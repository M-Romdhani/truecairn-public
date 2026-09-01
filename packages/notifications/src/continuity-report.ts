import { schema, type Database } from '@truecairn/db';
import {
  CONTINUITY_REPORT_SCHEMA_VERSION,
  type ContinuityOutcome,
  type ContinuityReportChannelLine,
  type ContinuityReportPayload,
  type UserId,
} from '@truecairn/shared';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';

// The Continuity Report builder (docs/26 §3.3). A DERIVATION over data the
// system already writes — deliveries, channel health, engine state + history —
// never a new source of truth. Deterministic (docs/26 D3): the same rows
// produce the same payload; `outcome` is computed by rule in computeOutcome.
// The clock is the caller's `now` so tests inject fixtures and time freely.
//
// Two callers: the ceremony-creation bridge snapshots it FROZEN into
// continuity_reports (Phase C), and the owner's live-status route serves it
// on demand. Content discipline: provider-proven facts only — no destinations,
// no open/read signals (D2), nothing a recipient shouldn't see.

// The purposes that constitute "trying to reach the owner" during the
// verification window. The CV cadence reuses these purposes (bare templates,
// unchanged), so wave deliveries and the transition's own one-shot both count.
const VERIFICATION_PURPOSES = ['check_in_request', 'escalation_request'] as const;

export async function buildContinuityReport(
  db: Database,
  userId: UserId,
  now: Date,
): Promise<ContinuityReportPayload> {
  const [engine] = await db
    .select()
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId));

  // The window opens when the silence did: the last authenticated check-in,
  // else the engine's current-state entry, else (no engine) the trailing 90
  // days — a defensive fallback that keeps the builder total.
  const fallbackFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const from = engine?.lastCheckInAt ?? engine?.stateEnteredAt ?? fallbackFrom;

  // Heartbeat milestones from the state history: the latest entries into
  // check_in_pending / escalation_pending within the window.
  const history = await db
    .select({
      toState: schema.engineStateHistory.toState,
      reason: schema.engineStateHistory.reason,
      occurredAt: schema.engineStateHistory.occurredAt,
    })
    .from(schema.engineStateHistory)
    .where(
      and(
        eq(schema.engineStateHistory.userId, userId),
        gte(schema.engineStateHistory.occurredAt, from),
      ),
    )
    .orderBy(desc(schema.engineStateHistory.occurredAt));
  const latestEntry = (state: 'check_in_pending' | 'escalation_pending'): Date | null =>
    history.find((h) => h.toState === state)?.occurredAt ?? null;
  // Recovery evidence: an authenticated return to ACTIVE inside the window
  // (owner check-in or a contact's attestation) — visible in the owner's live
  // view; a frozen ceremony report will not have one (recovery cancels first).
  const recovered = history.find(
    (h) =>
      h.toState === 'active' &&
      (h.reason === 'user_confirmed_active' ||
        h.reason === 'user_snoozed' ||
        h.reason === 'contact_attested_alive' ||
        h.reason === 'user_passphrase_confirmed_return'),
  );

  // Channels: every live channel, plus per-channel delivery aggregates over
  // the verification purposes within the window.
  const channels = await db
    .select()
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        isNull(schema.notificationChannels.removedAt),
      ),
    )
    .orderBy(schema.notificationChannels.createdAt);
  const deliveries = await db
    .select({
      channelId: schema.notificationDeliveries.channelId,
      status: schema.notificationDeliveries.status,
      createdAt: schema.notificationDeliveries.createdAt,
      sentAt: schema.notificationDeliveries.sentAt,
      deliveredAt: schema.notificationDeliveries.deliveredAt,
    })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.userId, userId),
        inArray(schema.notificationDeliveries.purpose, [...VERIFICATION_PURPOSES]),
        gte(schema.notificationDeliveries.createdAt, from),
      ),
    );

  const lines: ContinuityReportChannelLine[] = channels.map((ch) => {
    const mine = deliveries.filter((d) => d.channelId === ch.id);
    const delivered = mine.filter((d) => d.status === 'delivered' || d.status === 'confirmed');
    const bounced = mine.filter((d) => d.status === 'bounced');
    const failed = mine.filter((d) => d.status === 'failed');
    const sent = mine.filter((d) => d.status === 'sent');
    const lastAttempt = maxDate(mine.map((d) => d.sentAt ?? d.createdAt));
    const lastDelivered = maxDate(delivered.map((d) => d.deliveredAt));
    return {
      channelId: ch.id,
      channelType: ch.channelType,
      verified: ch.verified,
      health: ch.health,
      attempts: mine.length,
      sent: sent.length,
      delivered: delivered.length,
      bounced: bounced.length,
      failed: failed.length,
      lastAttemptAt: lastAttempt?.toISOString() ?? null,
      lastDeliveredAt: lastDelivered?.toISOString() ?? null,
    };
  });

  return {
    schemaVersion: CONTINUITY_REPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    window: { from: from.toISOString(), to: now.toISOString() },
    heartbeat: {
      lastCheckInAt: engine?.lastCheckInAt?.toISOString() ?? null,
      inactivityThresholdDays: engine?.inactivityThresholdDays ?? 0,
      checkInTimeoutDays: engine?.checkInTimeoutDays ?? 0,
      escalationCooldownDays: engine?.escalationCooldownDays ?? 0,
      checkInRequestedAt: latestEntry('check_in_pending')?.toISOString() ?? null,
      escalationStartedAt: latestEntry('escalation_pending')?.toISOString() ?? null,
    },
    channels: lines,
    recovery: {
      checkedInDuringWindow: recovered !== undefined,
      recoveredAt: recovered?.occurredAt.toISOString() ?? null,
    },
    outcome: computeOutcome(lines),
  };
}

// The deterministic outcome rule (docs/26 D3) — a pure function over the
// evidence lines so tests pin it directly. Definitions live with the enum in
// @truecairn/shared; in short: proven facts only, and 'sent' without webhook
// confirmation is indeterminate — honest middle, never counted as delivered
// OR as unreachable.
export function computeOutcome(lines: ContinuityReportChannelLine[]): ContinuityOutcome {
  const usable = lines.filter((l) => l.verified);
  if (usable.length === 0) return 'channels_unconfigured';
  const attempted = usable.filter((l) => l.attempts > 0);
  if (attempted.length === 0) return 'channels_unconfigured';
  const anyDelivered = attempted.some((l) => l.delivered > 0);
  const unreachable = (l: ContinuityReportChannelLine): boolean =>
    l.delivered === 0 && l.attempts > 0 && l.bounced + l.failed === l.attempts;
  const allUnreachable = attempted.every(unreachable);
  if (allUnreachable) return 'unreachable_all_channels';
  if (anyDelivered && attempted.every((l) => l.delivered > 0 || !unreachable(l))) {
    // Every attempted channel either provably delivered or is merely
    // unconfirmed — but at least one proven delivery exists.
    return attempted.every((l) => l.delivered > 0)
      ? 'delivered_no_checkin'
      : 'partial_delivery_no_checkin';
  }
  return 'partial_delivery_no_checkin';
}

function maxDate(dates: Array<Date | null>): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (d !== null && (max === null || d > max)) max = d;
  }
  return max;
}
