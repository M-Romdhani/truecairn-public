import type { EngineState, NotificationPurpose, UserId } from '@truecairn/shared';

// Mutable subset of engine_states that drives transitions. The applier maps
// this to/from the Drizzle row. Kept narrow so pure functions don't get
// access to anything they shouldn't.
export interface EngineStateRow {
  userId: UserId;
  state: EngineState;
  previousState: EngineState | null;
  stateEnteredAt: Date;
  snoozeUntil: Date | null;
  lastCheckInAt: Date | null;
  nextScheduledCheckInAt: Date | null;
  inactivityThresholdDays: number;
  checkInTimeoutDays: number;
  escalationCooldownDays: number;
  s1ToS2TimerDays: number;
  s2ToS3TimerDays: number;
  returningGraceDays: number;
  notificationStallMaxDays: number;
}

// Health snapshot the worker fetches before computing CHECK_IN_PENDING
// → NOTIFICATION_STALLED. Per docs/02 §3, the engine stalls when every
// channel is hard-failing.
export interface ChannelHealthSummary {
  totalChannels: number;
  failingChannels: number;
}

export interface TransitionContext {
  now: Date;
  channelHealth?: ChannelHealthSummary;
  // True when the owner's account is under an account lock that is still in
  // force (2026-08-07 security audit, finding 1). A locked owner is one the
  // system itself is preventing from responding, which makes their silence
  // uninformative — see the stall in transitions.ts. Absent/false means not
  // locked, so a caller that does not supply it keeps today's behaviour.
  ownerLocked?: boolean;
}

export type TransitionReason =
  // Time-driven
  | 'inactivity_threshold_exceeded'
  | 'check_in_timeout_expired'
  | 'all_channels_failing'
  | 'channels_recovered'
  | 'notification_stall_exhausted'
  | 'escalation_cooldown_expired'
  | 's1_to_s2_timer_expired'
  | 's2_to_s3_timer_expired'
  | 'returning_grace_expired'
  // User-driven
  | 'user_confirmed_active'
  | 'user_snoozed'
  | 'user_manual_trigger'
  | 'user_returned_during_release'
  | 'user_passphrase_confirmed_return'
  | 'owner_resolved_review'
  // Contact-driven
  | 'contact_attested_alive'
  | 'release_review_verification_passed'
  | 'release_review_verification_failed'
  | 'dispute_raised'
  // System-driven
  | 'engine_armed'
  | 'pre_registered_absence_expired';

export type Effect =
  | {
      kind: 'enqueue_notification';
      purpose: NotificationPurpose;
      relatedEntityType: string | null;
      relatedEntityId: string | null;
      payloadSummary: string;
    }
  | {
      kind: 'audit_event';
      eventType: string;
      payload: Record<string, unknown>;
    };

export type TransitionResult =
  | { kind: 'no_change' }
  | {
      kind: 'transition';
      toState: EngineState;
      reason: TransitionReason;
      nextActionAt: Date | null;
      snoozeUntil?: Date | null;
      lastCheckInAt?: Date | null;
      nextScheduledCheckInAt?: Date | null;
      previousStateOverride?: EngineState | null;
      effects: Effect[];
    };

// User and contact events the API will hand to applyEvent().
export type EngineEvent =
  | { kind: 'user_confirms_active' }
  | { kind: 'user_snoozes'; snoozeDays: number }
  | { kind: 'user_manual_trigger' }
  | { kind: 'user_authenticated_during_release' }
  | { kind: 'user_passphrase_confirm_return' }
  | { kind: 'owner_resolves_review' }
  | { kind: 'contact_attests_alive' }
  | { kind: 'release_review_verification_passed' }
  | { kind: 'release_review_verification_failed' }
  | { kind: 'dispute_raised' }
  | { kind: 'engine_armed' }
  | { kind: 'pre_registered_absence_expired' };
