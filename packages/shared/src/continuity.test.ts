import { describe, expect, it } from 'vitest';
import {
  CONTINUITY_OUTCOMES,
  CONTINUITY_REPORT_SCHEMA_VERSION,
  CV_PURPOSE_CLASSES,
  NOTIFICATION_PURPOSES,
  routineNoticeClass,
  type ContinuityOutcome,
  type ContinuityReportPayload,
} from './index.js';

// Shape-pinning test (docs/26 §5 task 0.3, mirrors the AI context-allowlist
// discipline): the report payload is a PUBLIC contract rendered to ceremony
// recipients and hash-anchored in the audit chain. Any key added or removed
// here must be reflected in docs/26 §9 in the same commit — this test failing
// is the reminder.

const payloadFixture: ContinuityReportPayload = {
  schemaVersion: CONTINUITY_REPORT_SCHEMA_VERSION,
  generatedAt: '2026-07-13T00:00:00.000Z',
  window: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-13T00:00:00.000Z' },
  heartbeat: {
    lastCheckInAt: null,
    inactivityThresholdDays: 30,
    checkInTimeoutDays: 7,
    escalationCooldownDays: 14,
    checkInRequestedAt: null,
    escalationStartedAt: null,
  },
  channels: [
    {
      channelId: '00000000-0000-0000-0000-000000000000',
      channelType: 'email',
      verified: true,
      health: 'healthy',
      attempts: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      failed: 0,
      lastAttemptAt: null,
      lastDeliveredAt: null,
    },
  ],
  recovery: { checkedInDuringWindow: false, recoveredAt: null },
  outcome: 'channels_unconfigured',
};

describe('continuity report — pinned public shape', () => {
  it('pins the top-level payload keys', () => {
    expect(Object.keys(payloadFixture).sort()).toEqual([
      'channels',
      'generatedAt',
      'heartbeat',
      'outcome',
      'recovery',
      'schemaVersion',
      'window',
    ]);
  });

  it('pins the per-channel evidence line keys — provider-proven facts only, no destinations', () => {
    expect(Object.keys(payloadFixture.channels[0]!).sort()).toEqual([
      'attempts',
      'bounced',
      'channelId',
      'channelType',
      'delivered',
      'failed',
      'health',
      'lastAttemptAt',
      'lastDeliveredAt',
      'sent',
      'verified',
    ]);
    // D2 enforced at the type level: no open/read-tracking fields may appear.
    const forbidden = ['opened', 'openedAt', 'read', 'readAt', 'seen'];
    for (const key of forbidden) {
      expect(Object.keys(payloadFixture.channels[0]!)).not.toContain(key);
    }
  });

  it('pins heartbeat and recovery keys', () => {
    expect(Object.keys(payloadFixture.heartbeat).sort()).toEqual([
      'checkInRequestedAt',
      'checkInTimeoutDays',
      'escalationCooldownDays',
      'escalationStartedAt',
      'inactivityThresholdDays',
      'lastCheckInAt',
    ]);
    expect(Object.keys(payloadFixture.recovery).sort()).toEqual([
      'checkedInDuringWindow',
      'recoveredAt',
    ]);
  });

  it('pins the outcome enum and the purpose classes', () => {
    expect([...CONTINUITY_OUTCOMES]).toEqual([
      'channels_unconfigured',
      'unreachable_all_channels',
      'partial_delivery_no_checkin',
      'delivered_no_checkin',
    ]);
    expect([...CV_PURPOSE_CLASSES]).toEqual([
      'owner_verification',
      'owner_notices',
      'contact_notices',
    ]);
    // Compiler-forced exhaustiveness: a new outcome value fails this switch.
    const describeOutcome = (o: ContinuityOutcome): string => {
      switch (o) {
        case 'channels_unconfigured':
          return 'no verified channel existed to attempt';
        case 'unreachable_all_channels':
          return 'every attempted channel provably failed';
        case 'partial_delivery_no_checkin':
          return 'mixed delivery evidence, no check-in';
        case 'delivered_no_checkin':
          return 'provably delivered, no check-in';
      }
    };
    for (const o of CONTINUITY_OUTCOMES) expect(describeOutcome(o)).toBeTruthy();
  });

  // The purpose→class map is a safety contract, pinned like the classes
  // themselves: which purposes the matrix may narrow at selection time, and —
  // more importantly — which it may NEVER touch. Moving a purpose between the
  // lists is a deliberate decision, not a drive-by.
  it('pins routineNoticeClass: matrix-governed purposes vs the exempt safety floor', () => {
    const expected: Record<string, string | null> = {
      // Safety floor — always delivered, the matrix cannot silence these.
      check_in_request: null,
      escalation_request: null,
      security_alert: null,
      // Operational round-trips — must reach the very channel being proven.
      channel_verification: null,
      welcome: null,
      health_probe: null,
      // Routine owner notices — the owner may opt a channel out.
      engine_state_change: 'owner_notices',
      sensitive_action_notice: 'owner_notices',
      plan_downgraded: 'owner_notices',
      // Contact-facing notices — the CONTACT's own matrix applies.
      ceremony_initiation: 'contact_notices',
      ceremony_affirmation_request: 'contact_notices',
      ceremony_revocation_window: 'contact_notices',
      contact_invitation: 'contact_notices',
    };
    for (const purpose of NOTIFICATION_PURPOSES) {
      expect(routineNoticeClass(purpose), purpose).toBe(expected[purpose]);
    }
    // Every purpose is classified — a new purpose fails here until it is
    // deliberately placed on one side or the other.
    expect(Object.keys(expected).sort()).toEqual([...NOTIFICATION_PURPOSES].sort());
  });
});
