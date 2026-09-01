import { describe, expect, it } from 'vitest';
import type { EngineState, UserId } from '@truecairn/shared';
import { addDays } from './next-action.js';
import { computeEventTransition, computeTimeTransition } from './transitions.js';
import type { EngineEvent, EngineStateRow, TransitionContext } from './types.js';

const USER = '00000000-0000-0000-0000-000000000001' as UserId;
const T0 = new Date('2026-01-01T00:00:00Z');

function row(state: EngineState, overrides: Partial<EngineStateRow> = {}): EngineStateRow {
  return {
    userId: USER,
    state,
    previousState: null,
    stateEnteredAt: T0,
    snoozeUntil: null,
    lastCheckInAt: T0,
    nextScheduledCheckInAt: null,
    inactivityThresholdDays: 30,
    checkInTimeoutDays: 7,
    escalationCooldownDays: 14,
    s1ToS2TimerDays: 7,
    s2ToS3TimerDays: 14,
    returningGraceDays: 7,
    notificationStallMaxDays: 30,
    ...overrides,
  };
}

function ctx(now: Date, overrides: Partial<TransitionContext> = {}): TransitionContext {
  return { now, ...overrides };
}

// ---------------------------------------------------------------------------
// Time-driven transitions
// ---------------------------------------------------------------------------

describe('computeTimeTransition', () => {
  it('ACTIVE: no transition before inactivity threshold', () => {
    const r = row('active', { lastCheckInAt: T0 });
    const result = computeTimeTransition(r, ctx(addDays(T0, 29)));
    expect(result.kind).toBe('no_change');
  });

  it('ACTIVE: transitions to CHECK_IN_PENDING when inactivity threshold exceeded', () => {
    const r = row('active', { lastCheckInAt: T0 });
    const result = computeTimeTransition(r, ctx(addDays(T0, 31)));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'check_in_pending',
      reason: 'inactivity_threshold_exceeded',
      previousStateOverride: 'active',
    });
  });

  it('ACTIVE: uses stateEnteredAt when lastCheckInAt is null', () => {
    const r = row('active', { lastCheckInAt: null, stateEnteredAt: T0 });
    const before = computeTimeTransition(r, ctx(addDays(T0, 29)));
    const after = computeTimeTransition(r, ctx(addDays(T0, 31)));
    expect(before.kind).toBe('no_change');
    expect(after.kind).toBe('transition');
  });

  it('PRE_ACTIVE: never time-transitions (waits for arm_engine sensitive action)', () => {
    const r = row('pre_active');
    const result = computeTimeTransition(r, ctx(addDays(T0, 365)));
    expect(result.kind).toBe('no_change');
  });

  it('CHECK_IN_PENDING: no transition before timeout', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    expect(computeTimeTransition(r, ctx(addDays(T0, 6))).kind).toBe('no_change');
  });

  it('CHECK_IN_PENDING: transitions to ESCALATION_PENDING when timeout expires', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    const result = computeTimeTransition(r, ctx(addDays(T0, 8)));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'escalation_pending',
      reason: 'check_in_timeout_expired',
    });
  });

  it('CHECK_IN_PENDING: snooze extends the timeout', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0, snoozeUntil: addDays(T0, 30) });
    // Even at day 31 (would be past stateEnteredAt+timeout), snooze pushes the deadline.
    const result = computeTimeTransition(r, ctx(addDays(T0, 31)));
    expect(result.kind).toBe('no_change');
  });

  it('CHECK_IN_PENDING: routes to NOTIFICATION_STALLED when all channels fail', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    const result = computeTimeTransition(
      r,
      ctx(addDays(T0, 1), { channelHealth: { totalChannels: 3, failingChannels: 3 } }),
    );
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'notification_stalled',
      reason: 'all_channels_failing',
    });
  });

  it('CHECK_IN_PENDING: ignores partial failures', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    const result = computeTimeTransition(
      r,
      ctx(addDays(T0, 1), { channelHealth: { totalChannels: 3, failingChannels: 2 } }),
    );
    expect(result.kind).toBe('no_change');
  });

  // REVERSED 2026-08-01 (audit LB-1). This test used to assert the opposite —
  // that zero channels does NOT stall — and that assertion was correct when it
  // was written (2026-07-13): NOTIFICATION_STALLED was unbounded then, so
  // stalling an account with no channels meant stalling it FOREVER, i.e. a
  // guaranteed wrongful non-release. The 30-day bound (2026-07-25, d092ada)
  // removed that reason, but the guard outlived it and left protection
  // non-monotonic in reachability: one broken channel paused the ladder while
  // zero channels — strictly more unreachable — advanced it.
  it('CHECK_IN_PENDING: zero channels stalls, exactly like every channel failing', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    const result = computeTimeTransition(
      r,
      ctx(addDays(T0, 1), { channelHealth: { totalChannels: 0, failingChannels: 0 } }),
    );
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'notification_stalled',
      reason: 'all_channels_failing',
    });
  });

  it('CHECK_IN_PENDING: protection is monotonic in reachability — fewer working channels is never less protected', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    const at = addDays(T0, 1);
    const stalls = (totalChannels: number, failingChannels: number): boolean =>
      computeTimeTransition(r, ctx(at, { channelHealth: { totalChannels, failingChannels } }))
        .kind === 'transition';

    // Unreachable in every shape -> stalls.
    expect(stalls(0, 0)).toBe(true); // no channels at all
    expect(stalls(1, 1)).toBe(true);
    expect(stalls(3, 3)).toBe(true);
    // Any working channel -> the ordinary check-in deadline governs, no stall.
    expect(stalls(1, 0)).toBe(false);
    expect(stalls(3, 2)).toBe(false);
  });

  it('CHECK_IN_PENDING: a zero-channel stall is still BOUNDED — it delays the ladder, never blocks it', () => {
    // The 2026-07-13 guard existed because an unbounded stall would strand a
    // zero-channel account forever. Prove that reason is genuinely spent: the
    // stall bound fires for a zero-channel account exactly as it does for an
    // all-failing one, so the ladder resumes rather than halting.
    const stalled = row('notification_stalled', {
      stateEnteredAt: T0,
      notificationStallMaxDays: 30,
    });
    const noChannels = { channelHealth: { totalChannels: 0, failingChannels: 0 } };
    expect(computeTimeTransition(stalled, ctx(addDays(T0, 29), noChannels)).kind).toBe('no_change');
    expect(computeTimeTransition(stalled, ctx(addDays(T0, 30), noChannels))).toMatchObject({
      kind: 'transition',
      toState: 'escalation_pending',
      reason: 'notification_stall_exhausted',
    });
  });

  it('NOTIFICATION_STALLED: stays while all channels fail, resumes on recovery (re-armed)', () => {
    const r = row('notification_stalled', { checkInTimeoutDays: 7, notificationStallMaxDays: 30 });
    const at = addDays(T0, 10); // inside the stall bound
    // No health info -> stay stalled.
    expect(computeTimeTransition(r, ctx(at)).kind).toBe('no_change');
    // Still all failing -> stay stalled.
    expect(
      computeTimeTransition(r, ctx(at, { channelHealth: { totalChannels: 3, failingChannels: 3 } })).kind,
    ).toBe('no_change');
    // A channel recovered -> resume to check_in_pending, deadline re-armed from now.
    const resumed = computeTimeTransition(r, ctx(at, { channelHealth: { totalChannels: 3, failingChannels: 2 } }));
    expect(resumed).toMatchObject({ kind: 'transition', toState: 'check_in_pending', reason: 'channels_recovered' });
    if (resumed.kind === 'transition') {
      expect(resumed.nextActionAt).toEqual(addDays(at, 7)); // now + checkInTimeoutDays, NOT a stale deadline
    }
  });

  // ── The bounded stall (2026-07-25, owner-ratified) ─────────────────────────
  //
  // This REPLACES an earlier assertion that the engine stays in
  // NOTIFICATION_STALLED indefinitely. That behaviour was fail-safe against a
  // wrongful release and, in exchange, guaranteed a wrongful NON-release:
  // channels failing is CORRELATED with the owner dying (a dead person's mailbox
  // bounces, their number is recycled, push subscriptions expire), so the exact
  // scenario the product exists for was the one in which it silently did nothing
  // forever, with nobody alive to notice.
  //
  // The change is deliberate, not a negative test being flipped: it moves the
  // engine ONE rung, to a state the owner can still cancel from with one tap,
  // and the real gate against a false release (diverse above-threshold ceremony
  // consensus, disputable at any point) is untouched.
  it('NOTIFICATION_STALLED: resumes the ladder once the stall bound is exhausted', () => {
    const r = row('notification_stalled', {
      notificationStallMaxDays: 30,
      escalationCooldownDays: 14,
    });
    const allFailing = { channelHealth: { totalChannels: 3, failingChannels: 3 } };

    // One day short of the bound: still stalled.
    expect(computeTimeTransition(r, ctx(addDays(T0, 29), allFailing)).kind).toBe('no_change');

    // At the bound: resume at ESCALATION_PENDING — NOT a shortcut to release.
    const out = computeTimeTransition(r, ctx(addDays(T0, 30), allFailing));
    expect(out).toMatchObject({
      kind: 'transition',
      toState: 'escalation_pending',
      reason: 'notification_stall_exhausted',
    });
    if (out.kind === 'transition') {
      // The full escalation cooldown still has to burn before release_review.
      expect(out.nextActionAt).toEqual(addDays(addDays(T0, 30), 14));
      expect(out.effects.some((e) => e.kind === 'audit_event')).toBe(true);
    }
  });

  it('NOTIFICATION_STALLED: recovery BEATS the stall bound (protective direction wins)', () => {
    const r = row('notification_stalled', { notificationStallMaxDays: 30, checkInTimeoutDays: 7 });
    // Past the bound AND a channel just came back. The owner being reachable
    // again must take precedence over advancing the ladder — otherwise a channel
    // recovering at the wrong moment would push a live owner one rung closer to
    // release instead of handing them their check-in back.
    const at = addDays(T0, 60);
    const out = computeTimeTransition(r, ctx(at, { channelHealth: { totalChannels: 3, failingChannels: 2 } }));
    expect(out).toMatchObject({
      kind: 'transition',
      toState: 'check_in_pending',
      reason: 'channels_recovered',
    });
  });

  it('NOTIFICATION_STALLED: the bound is per-user configurable', () => {
    const patient = row('notification_stalled', { notificationStallMaxDays: 90 });
    const allFailing = { channelHealth: { totalChannels: 2, failingChannels: 2 } };
    expect(computeTimeTransition(patient, ctx(addDays(T0, 60), allFailing)).kind).toBe('no_change');
    expect(computeTimeTransition(patient, ctx(addDays(T0, 90), allFailing)).kind).toBe('transition');
  });

  it('ESCALATION_PENDING: transitions to RELEASE_REVIEW when cooldown expires', () => {
    const r = row('escalation_pending', { stateEnteredAt: T0 });
    const result = computeTimeTransition(r, ctx(addDays(T0, 15)));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'release_review',
      reason: 'escalation_cooldown_expired',
      nextActionAt: null,
    });
  });

  it('RELEASE_REVIEW: never auto-transitions (requires contact action)', () => {
    const r = row('release_review');
    expect(computeTimeTransition(r, ctx(addDays(T0, 365))).kind).toBe('no_change');
  });

  it('LIMITED_RELEASE: transitions to STAGED_RELEASE when S1→S2 timer expires', () => {
    const r = row('limited_release', { stateEnteredAt: T0 });
    expect(computeTimeTransition(r, ctx(addDays(T0, 6))).kind).toBe('no_change');
    const result = computeTimeTransition(r, ctx(addDays(T0, 8)));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'staged_release',
      reason: 's1_to_s2_timer_expired',
    });
  });

  it('STAGED_RELEASE: transitions to FULL_RELEASE when S2→S3 timer expires', () => {
    const r = row('staged_release', { stateEnteredAt: T0 });
    const result = computeTimeTransition(r, ctx(addDays(T0, 15)));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'full_release',
      reason: 's2_to_s3_timer_expired',
      nextActionAt: null,
    });
  });

  it('FULL_RELEASE: terminal — never transitions', () => {
    const r = row('full_release');
    expect(computeTimeTransition(r, ctx(addDays(T0, 365))).kind).toBe('no_change');
  });

  it('RETURNING: no transition before grace expires', () => {
    const r = row('returning', { stateEnteredAt: T0, previousState: 'limited_release' });
    expect(computeTimeTransition(r, ctx(addDays(T0, 6))).kind).toBe('no_change');
  });

  it('RETURNING: resumes previous state when grace expires', () => {
    const r = row('returning', { stateEnteredAt: T0, previousState: 'staged_release' });
    const result = computeTimeTransition(r, ctx(addDays(T0, 8)));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'staged_release',
      reason: 'returning_grace_expired',
      previousStateOverride: null,
    });
  });

  it('REVIEW_REQUIRED: never auto-transitions', () => {
    const r = row('review_required');
    expect(computeTimeTransition(r, ctx(addDays(T0, 365))).kind).toBe('no_change');
  });

  // 2026-08-07 security audit, finding 1. An account lock is set over an
  // unauthenticated route keyed on an email, so without this the ladder advanced
  // on silence the system itself was enforcing — anyone who knew an address could
  // drive a stranger's vault toward release.
  describe('owner locked out', () => {
    it('ACTIVE: holds at the inactivity deadline instead of advancing', () => {
      const r = row('active', { lastCheckInAt: T0 });
      const at = addDays(T0, 31); // past the 30-day threshold
      expect(computeTimeTransition(r, ctx(at)).kind).toBe('transition');
      expect(computeTimeTransition(r, ctx(at, { ownerLocked: true })).kind).toBe('no_change');
    });

    it('CHECK_IN_PENDING: holds at the timeout instead of escalating', () => {
      const r = row('check_in_pending', { stateEnteredAt: T0 });
      const at = addDays(T0, 8); // past the 7-day check-in timeout
      expect(computeTimeTransition(r, ctx(at)).kind).toBe('transition');
      expect(computeTimeTransition(r, ctx(at, { ownerLocked: true })).kind).toBe('no_change');
    });

    it('the hold is BOUNDED — a sustained lock delays a release, never blocks it', () => {
      // The load-bearing half. A lock is attacker-controllable and renewable, so
      // an unbounded hold would hand anyone who knew an email a permanent veto on
      // that owner's release — trading a wrongful release for a guaranteed
      // wrongful NON-release, which is the same trade the notification stall was
      // bounded to avoid.
      const r = row('active', { lastCheckInAt: T0 });
      const deadline = addDays(T0, 30);
      const justInside = addDays(deadline, 29);
      const past = addDays(deadline, 31); // notificationStallMaxDays = 30

      expect(computeTimeTransition(r, ctx(justInside, { ownerLocked: true })).kind).toBe(
        'no_change',
      );
      expect(computeTimeTransition(r, ctx(past, { ownerLocked: true })).kind).toBe('transition');
    });

    it('changes nothing before the deadline, and nothing when not locked', () => {
      const r = row('active', { lastCheckInAt: T0 });
      // Locked but not yet due: still no_change, for the ordinary reason.
      expect(computeTimeTransition(r, ctx(addDays(T0, 29), { ownerLocked: true })).kind).toBe(
        'no_change',
      );
      // Explicitly false behaves exactly as absent — no caller is required to
      // supply it, so every existing tick keeps today's behaviour.
      const at = addDays(T0, 31);
      expect(computeTimeTransition(r, ctx(at, { ownerLocked: false }))).toEqual(
        computeTimeTransition(r, ctx(at)),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Event-driven transitions — the cancel-path asymmetry principle
// ---------------------------------------------------------------------------

describe('computeEventTransition: user_confirms_active (asymmetry principle)', () => {
  const states: EngineState[] = [
    'check_in_pending',
    'notification_stalled',
    'escalation_pending',
    'release_review',
    'limited_release',
    'staged_release',
  ];
  it.each(states)('cancels %s back to ACTIVE', (s) => {
    const r = row(s, { stateEnteredAt: addDays(T0, -10) });
    const result = computeEventTransition(r, { kind: 'user_confirms_active' }, ctx(T0));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'active',
      reason: 'user_confirmed_active',
      lastCheckInAt: T0,
    });
  });

  it('FULL_RELEASE has NO cancel path (terminal per docs/02 §Cancel paths)', () => {
    const r = row('full_release');
    const result = computeEventTransition(r, { kind: 'user_confirms_active' }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });

  it('REVIEW_REQUIRED: user_confirms_active is a no-op (needs human review)', () => {
    const r = row('review_required');
    const result = computeEventTransition(r, { kind: 'user_confirms_active' }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });

  it('REVIEW_REQUIRED: owner_resolves_review (fresh-second-factor lane) returns to ACTIVE', () => {
    const r = row('review_required');
    const result = computeEventTransition(r, { kind: 'owner_resolves_review' }, ctx(T0));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'active',
      reason: 'owner_resolved_review',
      lastCheckInAt: T0,
      previousStateOverride: null,
    });
  });

  it.each([
    'active',
    'pre_active',
    'check_in_pending',
    'escalation_pending',
    'release_review',
    'limited_release',
    'staged_release',
    'full_release',
    'returning',
  ] as EngineState[])('owner_resolves_review is a no-op from %s (review-only exit)', (s) => {
    const r = row(s);
    const result = computeEventTransition(r, { kind: 'owner_resolves_review' }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });

  it('PRE_ACTIVE: user_confirms_active is a no-op (need arm_engine instead)', () => {
    const r = row('pre_active');
    const result = computeEventTransition(r, { kind: 'user_confirms_active' }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });

  it('ACTIVE confirming "I am here" refreshes the timer', () => {
    const past = addDays(T0, -10);
    const r = row('active', { lastCheckInAt: past });
    const result = computeEventTransition(r, { kind: 'user_confirms_active' }, ctx(T0));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'active',
      lastCheckInAt: T0,
    });
  });
});

describe('computeEventTransition: user_snoozes', () => {
  it('CHECK_IN_PENDING snooze → ACTIVE with shortened next check-in', () => {
    const r = row('check_in_pending', { stateEnteredAt: T0 });
    const result = computeEventTransition(r, { kind: 'user_snoozes', snoozeDays: 3 }, ctx(T0));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'active',
      reason: 'user_snoozed',
      lastCheckInAt: T0,
      nextScheduledCheckInAt: addDays(T0, 3),
    });
  });

  it('rejects snoozeDays > inactivityThresholdDays (no infinite snooze)', () => {
    const r = row('check_in_pending', { inactivityThresholdDays: 30 });
    const result = computeEventTransition(r, { kind: 'user_snoozes', snoozeDays: 60 }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });

  it('rejects non-positive snoozeDays', () => {
    const r = row('check_in_pending');
    const result = computeEventTransition(r, { kind: 'user_snoozes', snoozeDays: 0 }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });

  it('snooze from ACTIVE is a no-op (snooze is only a CHECK_IN_PENDING affordance)', () => {
    const r = row('active');
    const result = computeEventTransition(r, { kind: 'user_snoozes', snoozeDays: 3 }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });
});

describe('computeEventTransition: contact_attests_alive', () => {
  it.each(['check_in_pending', 'notification_stalled', 'escalation_pending'] as const)(
    'attestation from %s → ACTIVE',
    (s) => {
      const r = row(s);
      const result = computeEventTransition(r, { kind: 'contact_attests_alive' }, ctx(T0));
      expect(result).toMatchObject({
        kind: 'transition',
        toState: 'active',
        reason: 'contact_attested_alive',
      });
    },
  );

  it('attestation during RELEASE_REVIEW or later does NOT cancel (must be user themselves)', () => {
    for (const s of ['release_review', 'limited_release', 'staged_release', 'full_release'] as const) {
      const r = row(s);
      const result = computeEventTransition(r, { kind: 'contact_attests_alive' }, ctx(T0));
      expect(result.kind).toBe('no_change');
    }
  });
});

describe('computeEventTransition: user_authenticated_during_release → RETURNING', () => {
  it.each(['release_review', 'limited_release', 'staged_release'] as const)(
    'from %s captures previous state',
    (s) => {
      const r = row(s);
      const result = computeEventTransition(
        r,
        { kind: 'user_authenticated_during_release' },
        ctx(T0),
      );
      expect(result).toMatchObject({
        kind: 'transition',
        toState: 'returning',
        previousStateOverride: s,
      });
    },
  );

  it('from ACTIVE is a no-op', () => {
    const r = row('active');
    const result = computeEventTransition(
      r,
      { kind: 'user_authenticated_during_release' },
      ctx(T0),
    );
    expect(result.kind).toBe('no_change');
  });
});

describe('computeEventTransition: user_passphrase_confirm_return', () => {
  it('RETURNING + passphrase confirm → ACTIVE (full revert)', () => {
    const r = row('returning', { previousState: 'limited_release' });
    const result = computeEventTransition(
      r,
      { kind: 'user_passphrase_confirm_return' },
      ctx(T0),
    );
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'active',
      reason: 'user_passphrase_confirmed_return',
      lastCheckInAt: T0,
      previousStateOverride: null,
    });
  });

  it('passphrase confirm outside RETURNING is a no-op', () => {
    const r = row('active');
    const result = computeEventTransition(
      r,
      { kind: 'user_passphrase_confirm_return' },
      ctx(T0),
    );
    expect(result.kind).toBe('no_change');
  });
});

describe('computeEventTransition: release_review verification', () => {
  it('passed → LIMITED_RELEASE', () => {
    const r = row('release_review');
    const result = computeEventTransition(
      r,
      { kind: 'release_review_verification_passed' },
      ctx(T0),
    );
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'limited_release',
      reason: 'release_review_verification_passed',
    });
  });

  it('failed → REVIEW_REQUIRED', () => {
    const r = row('release_review');
    const result = computeEventTransition(
      r,
      { kind: 'release_review_verification_failed' },
      ctx(T0),
    );
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'review_required',
      reason: 'release_review_verification_failed',
    });
  });
});

describe('computeEventTransition: dispute_raised', () => {
  it.each(['check_in_pending', 'escalation_pending', 'release_review', 'limited_release'] as const)(
    'from %s → REVIEW_REQUIRED',
    (s) => {
      const r = row(s);
      const result = computeEventTransition(r, { kind: 'dispute_raised' }, ctx(T0));
      expect(result).toMatchObject({
        kind: 'transition',
        toState: 'review_required',
        reason: 'dispute_raised',
      });
    },
  );

  it('dispute against FULL_RELEASE is a no-op (already terminal)', () => {
    const r = row('full_release');
    const result = computeEventTransition(r, { kind: 'dispute_raised' }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });
});

describe('computeEventTransition: engine_armed', () => {
  it('PRE_ACTIVE → ACTIVE with check-in timer set', () => {
    const r = row('pre_active');
    const result = computeEventTransition(r, { kind: 'engine_armed' }, ctx(T0));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'active',
      reason: 'engine_armed',
      lastCheckInAt: T0,
      nextActionAt: addDays(T0, 30),
    });
  });

  it('engine_armed outside PRE_ACTIVE is a no-op (idempotency)', () => {
    const r = row('active');
    const result = computeEventTransition(r, { kind: 'engine_armed' }, ctx(T0));
    expect(result.kind).toBe('no_change');
  });
});

describe('computeEventTransition: user_manual_trigger / pre_registered_absence', () => {
  it('ACTIVE + manual trigger → CHECK_IN_PENDING', () => {
    const r = row('active');
    const result = computeEventTransition(r, { kind: 'user_manual_trigger' }, ctx(T0));
    expect(result).toMatchObject({ kind: 'transition', toState: 'check_in_pending' });
  });

  it('ACTIVE + pre-registered absence expired → CHECK_IN_PENDING', () => {
    const r = row('active');
    const result = computeEventTransition(r, { kind: 'pre_registered_absence_expired' }, ctx(T0));
    expect(result).toMatchObject({
      kind: 'transition',
      toState: 'check_in_pending',
      reason: 'pre_registered_absence_expired',
    });
  });
});

// ---------------------------------------------------------------------------
// All transitions emit an audit_event effect (deliverable 3 wires the writer)
// ---------------------------------------------------------------------------

describe('every transition emits at least one audit_event effect', () => {
  function pickFirstTransition(events: EngineEvent[], states: EngineState[]): void {
    for (const s of states) {
      for (const e of events) {
        const result = computeEventTransition(row(s, { previousState: 'limited_release' }), e, ctx(T0));
        if (result.kind === 'transition') {
          const hasAudit = result.effects.some((eff) => eff.kind === 'audit_event');
          expect(hasAudit, `state=${s} event=${e.kind}`).toBe(true);
        }
      }
    }
  }

  it('covers user-driven events', () => {
    pickFirstTransition(
      [
        { kind: 'user_confirms_active' },
        { kind: 'user_snoozes', snoozeDays: 3 },
        { kind: 'user_manual_trigger' },
        { kind: 'user_authenticated_during_release' },
        { kind: 'user_passphrase_confirm_return' },
        { kind: 'contact_attests_alive' },
        { kind: 'release_review_verification_passed' },
        { kind: 'release_review_verification_failed' },
        { kind: 'dispute_raised' },
        { kind: 'engine_armed' },
        { kind: 'pre_registered_absence_expired' },
      ],
      [
        'pre_active',
        'active',
        'check_in_pending',
        'notification_stalled',
        'escalation_pending',
        'release_review',
        'limited_release',
        'staged_release',
        'returning',
      ],
    );
  });

  it('covers time-driven transitions', () => {
    for (const r of [
      { row: row('active', { lastCheckInAt: T0 }), now: addDays(T0, 31) },
      { row: row('check_in_pending'), now: addDays(T0, 8) },
      { row: row('escalation_pending'), now: addDays(T0, 15) },
      { row: row('limited_release'), now: addDays(T0, 8) },
      { row: row('staged_release'), now: addDays(T0, 15) },
      { row: row('returning', { previousState: 'limited_release' }), now: addDays(T0, 8) },
    ]) {
      const result = computeTimeTransition(r.row, ctx(r.now));
      expect(result.kind).toBe('transition');
      if (result.kind === 'transition') {
        const hasAudit = result.effects.some((e) => e.kind === 'audit_event');
        expect(hasAudit, `from=${r.row.state}`).toBe(true);
      }
    }
  });
});
