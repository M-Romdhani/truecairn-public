// The Continuity Report payload (docs/26 §3.3). This shape IS the public
// contract: it is snapshotted frozen into continuity_reports at ceremony
// creation, its hash is anchored in the audit chain, and recipients render it
// verbatim. The shape test (continuity.test.ts) pins every key — adding a
// field fails the test until docs/26 §9 is updated in the same commit, the
// same discipline as the AI context allowlist.
//
// Content rules (docs/26 D2/D3): provider-proven facts only. No destinations,
// no open/read signals, no free text, no scores — the one judgement-shaped
// field is `outcome`, a closed enum computed by rule.

import type {
  ContinuityOutcome,
  NotificationChannelHealth,
  NotificationChannelType,
} from './enums.js';

export const CONTINUITY_REPORT_SCHEMA_VERSION = 1 as const;

// One enrolled channel's evidence line. Counts are per-delivery-attempt within
// the verification window; `delivered`/`bounced` are provider-webhook-proven,
// `sent` is provider-accepted-but-unconfirmed, `failed` is dead-lettered.
export interface ContinuityReportChannelLine {
  channelId: string;
  channelType: NotificationChannelType;
  verified: boolean;
  health: NotificationChannelHealth;
  attempts: number;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  lastAttemptAt: string | null;
  lastDeliveredAt: string | null;
}

// The heartbeat facts: what the engine knew and when the silence started.
export interface ContinuityReportHeartbeat {
  lastCheckInAt: string | null;
  inactivityThresholdDays: number;
  checkInTimeoutDays: number;
  escalationCooldownDays: number;
  checkInRequestedAt: string | null;
  escalationStartedAt: string | null;
}

// Evidence of recovery: an authenticated return-to-active during the window.
// Frozen ceremony reports will show false (a recovery cancels the ceremony
// before a report is attached); the owner's LIVE view uses it.
export interface ContinuityReportRecovery {
  checkedInDuringWindow: boolean;
  recoveredAt: string | null;
}

export interface ContinuityReportPayload {
  schemaVersion: typeof CONTINUITY_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  window: { from: string; to: string };
  heartbeat: ContinuityReportHeartbeat;
  channels: ContinuityReportChannelLine[];
  recovery: ContinuityReportRecovery;
  outcome: ContinuityOutcome;
}
