import type { EngineState, NotificationPurpose } from '@truecairn/shared';
import { addDays, computeNextActionAt } from './next-action.js';
import type {
  EngineEvent,
  EngineStateRow,
  Effect,
  TransitionContext,
  TransitionResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Time-driven transitions. Pure function: the worker passes the current row
// + clock + (for CHECK_IN_PENDING) the user's channel health summary, and
// receives back either "no change" or a full description of the transition.
// ---------------------------------------------------------------------------

export function computeTimeTransition(
  row: EngineStateRow,
  ctx: TransitionContext,
): TransitionResult {
  switch (row.state) {
    case 'pre_active':
      return noChange();

    case 'active': {
      const lastSeen = row.lastCheckInAt ?? row.stateEnteredAt;
      const deadline = addDays(lastSeen, row.inactivityThresholdDays);
      if (ctx.now < deadline) return noChange();
      if (lockStall(row, ctx, deadline)) return noChange();
      return toCheckInPending(row, ctx.now, 'inactivity_threshold_exceeded');
    }

    case 'check_in_pending': {
      // Unreachable = every channel failing, OR no channel at all (2026-08-01
      // audit, LB-1). The `totalChannels > 0` guard that used to live here made
      // protection non-monotonic in reachability: one broken channel stalled the
      // ladder, while ZERO channels — the most unreachable an account can be —
      // read as "nothing is failing" and advanced. That inverted the whole point
      // of this state, and it inverted it for the account least able to notice.
      // Zero channels IS a total notification failure, which is exactly what
      // docs/11 says to stall on; the 30-day bound below still resumes the
      // ladder, so this buys the owner time rather than blocking release forever.
      const ch = ctx.channelHealth;
      const unreachable =
        ch !== undefined && (ch.totalChannels === 0 || ch.failingChannels === ch.totalChannels);
      if (unreachable) {
        return toNotificationStalled(row, ctx.now);
      }
      const base = row.snoozeUntil ?? row.stateEnteredAt;
      const deadline = addDays(base, row.checkInTimeoutDays);
      if (ctx.now < deadline) return noChange();
      if (lockStall(row, ctx, deadline)) return noChange();
      return toEscalationPending(row, ctx.now);
    }

    case 'notification_stalled': {
      // Auto-clear (PHASE3_5 §c, docs/11): the stall lifts the moment ANY channel
      // is reachable again. A successful delivery flips a channel to healthy; the
      // next tick sees not-all-failing and RESUMES the check-in, re-arming the full
      // window from now (a user unreachable for days gets the whole window, not an
      // instantly-expired deadline). Absent health info -> stay stalled.
      const ch = ctx.channelHealth;
      if (ch !== undefined && ch.totalChannels > 0 && ch.failingChannels < ch.totalChannels) {
        return toCheckInPending(row, ctx.now, 'channels_recovered');
      }
      // Bounded stall (2026-07-25, owner-ratified). Waiting here FOREVER was
      // fail-safe against a wrongful release and, in exchange, guaranteed a
      // wrongful NON-release: channels failing is CORRELATED with the owner
      // dying (a dead person's mailbox starts bouncing, their number is
      // recycled, push subscriptions expire), so the exact case this product
      // exists for was the case in which it silently did nothing forever.
      //
      // Sustained total unreachability is itself evidence, so resume the ladder
      // at ESCALATION_PENDING. Deliberately not a shortcut to release: that
      // state is still in CHECKIN_STATES (a recovered channel lets the owner
      // stop everything with one tap), it burns the full escalation cooldown
      // before release_review, and the real gate against a false release was
      // never the notification — it is the ceremony consensus, which still
      // needs a diverse above-threshold affirmation and can be disputed.
      const stallDeadline = addDays(row.stateEnteredAt, row.notificationStallMaxDays);
      if (ctx.now >= stallDeadline) {
        return {
          kind: 'transition',
          toState: 'escalation_pending',
          reason: 'notification_stall_exhausted',
          nextActionAt: addDays(ctx.now, row.escalationCooldownDays),
          previousStateOverride: row.state,
          effects: [
            auditEvent('engine.notification_stall_exhausted', {
              stalledDays: row.notificationStallMaxDays,
            }),
            // Enqueued even though every channel is currently failing: a channel
            // may recover before delivery, and the attempt itself is the record
            // that we tried. escalation_request is exempt from the channel
            // matrix (the safety floor), so nothing narrows it away.
            notification('escalation_request', null, null, 'Unreachable — escalating'),
          ],
        };
      }
      return noChange();
    }

    case 'escalation_pending': {
      const deadline = addDays(row.stateEnteredAt, row.escalationCooldownDays);
      if (ctx.now < deadline) return noChange();
      return toReleaseReview(row, ctx.now);
    }

    case 'release_review':
      return noChange();

    case 'limited_release': {
      const deadline = addDays(row.stateEnteredAt, row.s1ToS2TimerDays);
      if (ctx.now < deadline) return noChange();
      return advanceRelease(row, ctx.now, 'staged_release', 's1_to_s2_timer_expired');
    }

    case 'staged_release': {
      const deadline = addDays(row.stateEnteredAt, row.s2ToS3TimerDays);
      if (ctx.now < deadline) return noChange();
      return advanceRelease(row, ctx.now, 'full_release', 's2_to_s3_timer_expired');
    }

    case 'full_release':
      return noChange();

    case 'returning': {
      const deadline = addDays(row.stateEnteredAt, row.returningGraceDays);
      if (ctx.now < deadline) return noChange();
      const resume: EngineState = row.previousState ?? 'limited_release';
      return {
        kind: 'transition',
        toState: resume,
        reason: 'returning_grace_expired',
        nextActionAt: computeNextActionAt(resume, { ...row, state: resume }),
        previousStateOverride: null,
        effects: [
          auditEvent('engine.returning_grace_expired', {
            resumed: resume,
            previous: row.previousState,
          }),
          notification('engine_state_change', null, null, `Resumed ${resume}`),
        ],
      };
    }

    case 'review_required':
      return noChange();
  }
}

// ---------------------------------------------------------------------------
// Event-driven transitions. Called from the API surface (Phase 3) when a
// user, contact, or system action arrives. The asymmetry principle from
// docs/02 — cancellation is always easier than progression — means most of
// these collapse straight back to ACTIVE.
// ---------------------------------------------------------------------------

export function computeEventTransition(
  row: EngineStateRow,
  event: EngineEvent,
  ctx: TransitionContext,
): TransitionResult {
  switch (event.kind) {
    case 'user_confirms_active':
      return userConfirmsActive(row, ctx.now);

    case 'user_snoozes':
      return userSnoozes(row, ctx.now, event.snoozeDays);

    case 'user_manual_trigger':
      if (row.state !== 'active') return noChange();
      return toCheckInPending(row, ctx.now, 'user_manual_trigger');

    case 'user_authenticated_during_release':
      if (
        row.state !== 'limited_release' &&
        row.state !== 'staged_release' &&
        row.state !== 'release_review'
      ) {
        return noChange();
      }
      return {
        kind: 'transition',
        toState: 'returning',
        reason: 'user_returned_during_release',
        nextActionAt: addDays(ctx.now, row.returningGraceDays),
        previousStateOverride: row.state,
        effects: [
          auditEvent('engine.entered_returning', { from: row.state }),
          notification('engine_state_change', null, null, 'Confirm you are back'),
        ],
      };

    case 'owner_resolves_review':
      // The QA-2026-07-21 dead end: a failed ceremony parked the engine in
      // REVIEW_REQUIRED with no owner exit. The owner — present, authenticated,
      // and holding a FRESH second factor (the route gates on it; deliberately
      // stronger than the one-tap check-in, so a bare stolen cookie still can't
      // clear a review) — resolves the review back to ACTIVE. Protective
      // direction only: this moves AWAY from release; the ceremony that
      // triggered the review stays terminal and audited.
      if (row.state !== 'review_required') return noChange();
      return {
        kind: 'transition',
        toState: 'active',
        reason: 'owner_resolved_review',
        nextActionAt: addDays(ctx.now, row.inactivityThresholdDays),
        previousStateOverride: null,
        lastCheckInAt: ctx.now,
        nextScheduledCheckInAt: addDays(ctx.now, row.inactivityThresholdDays),
        snoozeUntil: null,
        effects: [
          auditEvent('engine.review_resolved_by_owner', { from: row.state }),
          notification('engine_state_change', null, null, 'Review resolved; engine re-armed'),
        ],
      };

    case 'user_passphrase_confirm_return':
      if (row.state !== 'returning') return noChange();
      return {
        kind: 'transition',
        toState: 'active',
        reason: 'user_passphrase_confirmed_return',
        nextActionAt: addDays(ctx.now, row.inactivityThresholdDays),
        previousStateOverride: null,
        lastCheckInAt: ctx.now,
        nextScheduledCheckInAt: addDays(ctx.now, row.inactivityThresholdDays),
        effects: [
          auditEvent('engine.returned_to_active', { via: 'passphrase' }),
          notification('engine_state_change', null, null, 'Welcome back; engine resumed'),
        ],
      };

    case 'contact_attests_alive':
      if (
        row.state !== 'escalation_pending' &&
        row.state !== 'notification_stalled' &&
        row.state !== 'check_in_pending'
      ) {
        return noChange();
      }
      return {
        kind: 'transition',
        toState: 'active',
        reason: 'contact_attested_alive',
        nextActionAt: addDays(ctx.now, row.inactivityThresholdDays),
        previousStateOverride: null,
        lastCheckInAt: ctx.now,
        nextScheduledCheckInAt: addDays(ctx.now, row.inactivityThresholdDays),
        effects: [
          auditEvent('engine.contact_attestation', { from: row.state }),
          notification('engine_state_change', null, null, 'Contact attested you are active'),
        ],
      };

    case 'release_review_verification_passed':
      if (row.state !== 'release_review') return noChange();
      return {
        kind: 'transition',
        toState: 'limited_release',
        reason: 'release_review_verification_passed',
        nextActionAt: addDays(ctx.now, row.s1ToS2TimerDays),
        previousStateOverride: row.state,
        effects: [
          auditEvent('engine.release_review_passed', {}),
          notification('engine_state_change', null, null, 'S1 release authorised'),
        ],
      };

    case 'release_review_verification_failed':
      if (row.state !== 'release_review') return noChange();
      return {
        kind: 'transition',
        toState: 'review_required',
        reason: 'release_review_verification_failed',
        nextActionAt: null,
        previousStateOverride: row.state,
        effects: [auditEvent('engine.release_review_failed', {})],
      };

    case 'dispute_raised':
      if (row.state === 'full_release' || row.state === 'review_required') return noChange();
      return {
        kind: 'transition',
        toState: 'review_required',
        reason: 'dispute_raised',
        nextActionAt: null,
        previousStateOverride: row.state,
        effects: [auditEvent('engine.dispute_raised', { from: row.state })],
      };

    case 'engine_armed':
      if (row.state !== 'pre_active') return noChange();
      return {
        kind: 'transition',
        toState: 'active',
        reason: 'engine_armed',
        nextActionAt: addDays(ctx.now, row.inactivityThresholdDays),
        previousStateOverride: null,
        lastCheckInAt: ctx.now,
        nextScheduledCheckInAt: addDays(ctx.now, row.inactivityThresholdDays),
        effects: [
          auditEvent('engine.armed', {}),
          notification('engine_state_change', null, null, 'Engine armed and active'),
        ],
      };

    case 'pre_registered_absence_expired':
      if (row.state !== 'active') return noChange();
      return toCheckInPending(row, ctx.now, 'pre_registered_absence_expired');
  }
}

// ---------------------------------------------------------------------------
// Local helpers. These keep the switch arms above readable and ensure every
// transition emits a consistent set of effects (state change + audit + at
// least one user-visible notification when appropriate).
// ---------------------------------------------------------------------------

function noChange(): TransitionResult {
  return { kind: 'no_change' };
}

// Hold the ladder while the OWNER IS LOCKED OUT (2026-08-07 security audit,
// finding 1). Silence only means something if the owner could have broken it;
// while an account lock is in force the system is itself preventing them from
// answering, so advancing on that silence would convert an authentication
// problem into a release.
//
// This is the same reasoning as the notification_stalled arm above — "we cannot
// reach the owner" and "the owner cannot reach us" are the same fact from
// opposite ends — and it is bounded the same way, for the same reason: an
// unbounded hold is fail-safe against a wrongful release only by guaranteeing a
// wrongful NON-release, and the lockout case is worse than the unreachable one
// because it is ATTACKER-CONTROLLABLE. A lock is set over an unauthenticated
// route keyed on an email, so an unbounded stall would hand anyone who knew an
// address a permanent veto on that owner's release. After
// notificationStallMaxDays past the deadline the ladder resumes regardless.
//
// Deliberately NOT a new engine state: this is a hold measured off the deadline
// the row already carries, so it needs no column, no migration, and no new
// terminal path to reason about. The primary defence is in the auth layer
// (check-in is exempt from the lock, and a passkey assertion clears it); this is
// depth, and it covers any future mechanism that stops an owner responding.
function lockStall(row: EngineStateRow, ctx: TransitionContext, deadline: Date): boolean {
  if (ctx.ownerLocked !== true) return false;
  return ctx.now < addDays(deadline, row.notificationStallMaxDays);
}

function userConfirmsActive(row: EngineStateRow, now: Date): TransitionResult {
  // FULL_RELEASE is terminal — no cancel path per docs/02 §"Cancel paths".
  if (row.state === 'full_release') return noChange();
  // ACTIVE confirming "I'm still here" just refreshes the inactivity timer.
  if (row.state === 'active') {
    return {
      kind: 'transition',
      toState: 'active',
      reason: 'user_confirmed_active',
      nextActionAt: addDays(now, row.inactivityThresholdDays),
      lastCheckInAt: now,
      nextScheduledCheckInAt: addDays(now, row.inactivityThresholdDays),
      snoozeUntil: null,
      previousStateOverride: row.state,
      effects: [auditEvent('engine.user_confirmed_active', { from: 'active' })],
    };
  }
  // From any monitoring or releasing state, one confirmation flips back to ACTIVE.
  if (
    row.state === 'check_in_pending' ||
    row.state === 'notification_stalled' ||
    row.state === 'escalation_pending' ||
    row.state === 'release_review' ||
    row.state === 'limited_release' ||
    row.state === 'staged_release'
  ) {
    return {
      kind: 'transition',
      toState: 'active',
      reason: 'user_confirmed_active',
      nextActionAt: addDays(now, row.inactivityThresholdDays),
      lastCheckInAt: now,
      nextScheduledCheckInAt: addDays(now, row.inactivityThresholdDays),
      snoozeUntil: null,
      previousStateOverride: null,
      effects: [
        auditEvent('engine.user_confirmed_active', { from: row.state }),
        notification('engine_state_change', null, null, 'You are confirmed active'),
      ],
    };
  }
  return noChange();
}

function userSnoozes(row: EngineStateRow, now: Date, snoozeDays: number): TransitionResult {
  // Per docs/02 §2: snooze from CHECK_IN_PENDING → ACTIVE with shortened next check-in.
  if (row.state !== 'check_in_pending') return noChange();
  if (snoozeDays <= 0 || snoozeDays > row.inactivityThresholdDays) return noChange();
  const next = addDays(now, snoozeDays);
  return {
    kind: 'transition',
    toState: 'active',
    reason: 'user_snoozed',
    nextActionAt: next,
    lastCheckInAt: now,
    nextScheduledCheckInAt: next,
    snoozeUntil: null,
    previousStateOverride: row.state,
    effects: [
      auditEvent('engine.user_snoozed', { snoozeDays }),
      notification('engine_state_change', null, null, `Snoozed ${snoozeDays} day(s)`),
    ],
  };
}

function toCheckInPending(
  _row: EngineStateRow,
  now: Date,
  reason:
    | 'inactivity_threshold_exceeded'
    | 'user_manual_trigger'
    | 'pre_registered_absence_expired'
    | 'channels_recovered',
): TransitionResult {
  return {
    kind: 'transition',
    toState: 'check_in_pending',
    reason,
    nextActionAt: addDays(now, _row.checkInTimeoutDays),
    previousStateOverride: _row.state,
    snoozeUntil: null,
    effects: [
      auditEvent('engine.entered_check_in_pending', { reason }),
      notification('check_in_request', null, null, 'Please confirm you are active'),
    ],
  };
}

function toNotificationStalled(row: EngineStateRow, now: Date): TransitionResult {
  return {
    kind: 'transition',
    toState: 'notification_stalled',
    reason: 'all_channels_failing',
    // Re-checkable each tick (NOT null) so the engine resumes promptly when a
    // channel recovers (PHASE3_5 §c) — claimDueRows requires a non-null due time.
    nextActionAt: now,
    previousStateOverride: row.state,
    effects: [
      auditEvent('engine.entered_notification_stalled', { from: row.state }),
      // No user-facing notification — we can't reach them, that's the point.
    ],
  };
}

function toEscalationPending(row: EngineStateRow, now: Date): TransitionResult {
  return {
    kind: 'transition',
    toState: 'escalation_pending',
    reason: 'check_in_timeout_expired',
    nextActionAt: addDays(now, row.escalationCooldownDays),
    previousStateOverride: row.state,
    effects: [
      auditEvent('engine.entered_escalation_pending', {}),
      // escalation_request goes to the OWNER (pickPrimaryChannel attaches the
      // delivery to their channel) — the summary must say so. Contacts are not
      // approached until release_review opens ceremonies.
      notification('escalation_request', null, null, 'Urging the owner to check in'),
    ],
  };
}

function toReleaseReview(row: EngineStateRow, _now: Date): TransitionResult {
  return {
    kind: 'transition',
    toState: 'release_review',
    reason: 'escalation_cooldown_expired',
    nextActionAt: null,
    previousStateOverride: row.state,
    effects: [
      auditEvent('engine.entered_release_review', {}),
      notification('engine_state_change', null, null, 'Release review requested'),
    ],
  };
}

function advanceRelease(
  row: EngineStateRow,
  now: Date,
  toState: 'staged_release' | 'full_release',
  reason: 's1_to_s2_timer_expired' | 's2_to_s3_timer_expired',
): TransitionResult {
  const next =
    toState === 'staged_release' ? addDays(now, row.s2ToS3TimerDays) : null;
  return {
    kind: 'transition',
    toState,
    reason,
    nextActionAt: next,
    previousStateOverride: row.state,
    effects: [
      auditEvent('engine.release_advanced', { from: row.state, to: toState }),
      notification('engine_state_change', null, null, `Advanced to ${toState}`),
    ],
  };
}

function auditEvent(eventType: string, payload: Record<string, unknown>): Effect {
  return { kind: 'audit_event', eventType, payload };
}

function notification(
  purpose: NotificationPurpose,
  relatedEntityType: string | null,
  relatedEntityId: string | null,
  summary: string,
): Effect {
  return {
    kind: 'enqueue_notification',
    purpose,
    relatedEntityType,
    relatedEntityId,
    payloadSummary: summary,
  };
}
