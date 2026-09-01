import { describe, expect, it } from 'vitest';
import type { EngineState, UserId } from '@truecairn/shared';
import {
  DRILL_ADVANCEABLE_STATES,
  applyDrillShift,
  computeDrillShift,
  isDrillAdvanceable,
} from './drill-clock.js';
import { computeTimeTransition } from './transitions.js';
import type { EngineStateRow } from './types.js';

// The property that makes the drill clock worth having: for every state with a
// time-driven exit, applying the shift is SUFFICIENT to make transitions.ts fire
// — and it is the only thing the drill does. If a future change moves a deadline
// onto a column this helper does not slide, the paired assertion below (no
// transition before the shift, a transition after it) fails, which is the whole
// point. A drill that silently stopped advancing would otherwise look exactly
// like an account that legitimately had nothing due.

const NOW = new Date('2026-05-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function row(state: EngineState, over: Partial<EngineStateRow> = {}): EngineStateRow {
  return {
    userId: 'u-1' as UserId,
    state,
    previousState: null,
    stateEnteredAt: NOW,
    snoozeUntil: null,
    lastCheckInAt: null,
    nextScheduledCheckInAt: null,
    inactivityThresholdDays: 30,
    checkInTimeoutDays: 7,
    escalationCooldownDays: 7,
    s1ToS2TimerDays: 14,
    s2ToS3TimerDays: 14,
    returningGraceDays: 7,
    notificationStallMaxDays: 30,
    ...over,
  };
}

// notification_stalled's exit is conditional on total unreachability, and
// check_in_pending's on the inverse; supply health so each arm is reachable.
const healthFor = (state: EngineState) =>
  state === 'notification_stalled'
    ? { totalChannels: 1, failingChannels: 1 }
    : { totalChannels: 1, failingChannels: 0 };

describe('drill clock: shifting the clock advances the real ladder', () => {
  for (const state of DRILL_ADVANCEABLE_STATES) {
    it(`${state}: no transition is due before the shift, and one is after it`, () => {
      const before = row(state);
      const ctx = { now: NOW, channelHealth: healthFor(state) };

      // Precondition: the row was just entered, so nothing is due yet. Without
      // this half the test would pass against a helper that did nothing at all.
      expect(computeTimeTransition(before, ctx).kind).toBe('no_change');

      const shift = computeDrillShift(before, NOW);
      expect(shift).not.toBeNull();
      const after = { ...before, ...applyDrillShift(before, shift!) };

      const result = computeTimeTransition(after, ctx);
      expect(result.kind, `${state} did not advance after the drill shift`).toBe('transition');
      // The state is computed by transitions.ts, never written by the drill.
      if (result.kind === 'transition') expect(result.toState).not.toBe(state);
    });
  }

  it('advances active off last_check_in_at, not just state_entered_at', () => {
    // The column that actually carries the deadline in the common case: an
    // account that has been checking in has a stateEnteredAt far in the past and
    // a recent lastCheckInAt. Sliding only stateEnteredAt would move nothing.
    const before = row('active', {
      stateEnteredAt: new Date(NOW.getTime() - 200 * DAY),
      lastCheckInAt: NOW,
    });
    const ctx = { now: NOW, channelHealth: healthFor('active') };
    expect(computeTimeTransition(before, ctx).kind).toBe('no_change');

    const shift = computeDrillShift(before, NOW)!;
    const after = { ...before, ...applyDrillShift(before, shift) };
    expect(computeTimeTransition(after, ctx).kind).toBe('transition');
    expect(shift.basis).toContain('last_check_in_at');
  });

  it('advances check_in_pending off snooze_until when the owner has snoozed', () => {
    const before = row('check_in_pending', {
      stateEnteredAt: new Date(NOW.getTime() - 10 * DAY),
      snoozeUntil: NOW,
    });
    const ctx = { now: NOW, channelHealth: healthFor('check_in_pending') };
    // Snoozed past the plain state_entered_at deadline: nothing is due.
    expect(computeTimeTransition(before, ctx).kind).toBe('no_change');

    const shift = computeDrillShift(before, NOW)!;
    const after = { ...before, ...applyDrillShift(before, shift) };
    expect(computeTimeTransition(after, ctx).kind).toBe('transition');
    expect(shift.basis).toContain('snooze_until');
  });

  it('refuses the states whose exit is an event, not a timer', () => {
    // release_review is the one that matters: a drill must not be able to skip
    // contact consensus. full_release is terminal, review_required waits on the
    // owner, pre_active on arming.
    for (const state of ['pre_active', 'release_review', 'full_release', 'review_required'] as const) {
      const r = row(state);
      expect(isDrillAdvanceable(r)).toBe(false);
      expect(computeDrillShift(r, NOW)).toBeNull();
    }
  });

  it('does not shift backwards past a deadline that has already passed', () => {
    const before = row('escalation_pending', { stateEnteredAt: new Date(NOW.getTime() - 30 * DAY) });
    const shift = computeDrillShift(before, NOW)!;
    expect(shift.shiftMs).toBe(0);
    // next_action_at still gets re-pointed at the (past) deadline so
    // claimDueRows picks the row up.
    expect(applyDrillShift(before, shift).nextActionAt.getTime()).toBeLessThan(NOW.getTime());
    expect(applyDrillShift(before, shift).stateEnteredAt).toEqual(before.stateEnteredAt);
  });
});
