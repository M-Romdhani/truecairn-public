import type { EngineStateRow } from './types.js';
import { computeNextActionAt, addDays } from './next-action.js';

// ---------------------------------------------------------------------------
// The drill clock (docs/29).
//
// A recovery drill has to walk an account down the real ladder — active →
// check_in_pending → notification_stalled | escalation_pending → release_review
// — without waiting the 30-odd real days it is bounded by. Until now the only
// way to do that was a hand-written UPDATE on production:
//
//     UPDATE engine_states SET state = 'release_review', … WHERE user_id = …;
//
// which is wrong for two reasons that both matter more than the convenience.
//
// 1. It BYPASSES transitions.ts, and with it every audit event the ladder
//    emits. The product's own Home panel says "every event is signed and
//    timestamped"; a drill that manufactures a state the audit chain cannot
//    account for corrupts the single artifact a disputed release would be
//    adjudicated on. The chain still verifies — that is the problem. It
//    verifies a history that did not happen.
// 2. It skips the part actually under test. Jumping to release_review exercises
//    the ceremony and leaves the ladder — the 30-day stall bound, the
//    reachability logic, the lockStall guard — completely unexercised, which is
//    precisely the half a real death walks through.
//
// So this module moves the CLOCK, never the state. It computes how far back an
// account's clock-backing timestamps must slide for the NEXT time-driven
// deadline to have just passed; the caller writes that patch, the worker claims
// the row on its normal poll, and transitions.ts computes the transition and
// emits its audit events exactly as it would have after a real month of silence.
//
// Nothing on a product path imports this — drill-clock-fence.test.ts pins that.
// It is an operator tool (scripts/ceremony-drill.ts) and a test fixture, not a
// branch in the engine (CLAUDE.md invariant 3: no test-mode branches; tests and
// drills compress time through config and DB preconditions, which is what this
// writes).
// ---------------------------------------------------------------------------

// States with a time-driven exit. Everything else waits for an explicit event
// and no amount of clock movement will advance it:
//   pre_active      — waits for engine_armed
//   release_review  — waits for the CEREMONY's verdict (release_review_
//                     verification_passed/_failed). This is the ladder's
//                     deliberate stopping point for a drill: consensus is not
//                     a timer, and a drill that could skip it would be
//                     rehearsing a release no real contact had to authorise.
//   full_release    — terminal
//   review_required — waits for the owner to resolve the dispute
export const DRILL_ADVANCEABLE_STATES = [
  'active',
  'check_in_pending',
  'notification_stalled',
  'escalation_pending',
  'limited_release',
  'staged_release',
  'returning',
] as const;

export type DrillAdvanceableState = (typeof DRILL_ADVANCEABLE_STATES)[number];

export interface DrillShift {
  // How far back every clock-backing timestamp moves. 0 when the deadline has
  // already passed and only next_action_at needs re-pointing.
  shiftMs: number;
  // The deadline that is in the past once the shift is applied — what
  // next_action_at becomes, so claimDueRows picks the row up.
  deadline: Date;
  // What transitions.ts computes this deadline from, for the transcript.
  basis: string;
}

// The timestamp columns a caller writes back. Every one of these is read by
// transitions.ts (directly or through computeNextActionAt) except
// nextScheduledCheckInAt, which is display-only and moves with the rest so the
// row does not describe a check-in schedule its own state contradicts.
export interface DrillClockPatch {
  stateEnteredAt: Date;
  lastCheckInAt: Date | null;
  snoozeUntil: Date | null;
  nextScheduledCheckInAt: Date | null;
  nextActionAt: Date;
}

export function isDrillAdvanceable(row: EngineStateRow): boolean {
  return (DRILL_ADVANCEABLE_STATES as readonly string[]).includes(row.state);
}

// The deadline transitions.ts measures against for this state.
//
// Every state but one delegates to computeNextActionAt, which is the same
// arithmetic the transition arms use — deliberately, so the drill cannot drift
// from the ladder it is supposed to be exercising. NOTIFICATION_STALLED is the
// exception: computeNextActionAt returns null there because the worker re-checks
// that state every tick for channel recovery (toNotificationStalled sets
// nextActionAt: now, not a future date), while transitions.ts separately bounds
// the stall at notificationStallMaxDays off stateEnteredAt. That bound is the
// deadline a drill wants.
function timeDeadline(row: EngineStateRow): Date | null {
  if (row.state === 'notification_stalled') {
    return addDays(row.stateEnteredAt, row.notificationStallMaxDays);
  }
  return computeNextActionAt(row.state, row);
}

// How far back to slide this row's clock so its next time-driven deadline has
// passed by `marginMs`. Null when the state has no time-driven exit at all —
// the caller should report that and stop rather than shifting harder.
//
// Note this does NOT account for lockStall: an account under an active account
// lock holds the ladder for a further notificationStallMaxDays past the
// deadline, on purpose (a locked owner is one the system is itself preventing
// from answering). A drill against a locked account therefore needs a second
// shift, and the CLI reports the no-progress tick rather than looping.
export function computeDrillShift(
  row: EngineStateRow,
  now: Date,
  marginMs = 1000,
): DrillShift | null {
  const deadline = timeDeadline(row);
  if (deadline === null) return null;
  const overshoot = deadline.getTime() - now.getTime() + marginMs;
  return {
    shiftMs: Math.max(0, overshoot),
    deadline: new Date(deadline.getTime() - Math.max(0, overshoot)),
    basis: basisFor(row),
  };
}

function basisFor(row: EngineStateRow): string {
  switch (row.state) {
    case 'active':
      return `${row.lastCheckInAt !== null ? 'last_check_in_at' : 'state_entered_at'} + ${row.inactivityThresholdDays}d (inactivity threshold)`;
    case 'check_in_pending':
      return `${row.snoozeUntil !== null ? 'snooze_until' : 'state_entered_at'} + ${row.checkInTimeoutDays}d (check-in timeout)`;
    case 'notification_stalled':
      return `state_entered_at + ${row.notificationStallMaxDays}d (stall bound)`;
    case 'escalation_pending':
      return `state_entered_at + ${row.escalationCooldownDays}d (escalation cooldown)`;
    case 'limited_release':
      return `state_entered_at + ${row.s1ToS2TimerDays}d (S1→S2 timer)`;
    case 'staged_release':
      return `state_entered_at + ${row.s2ToS3TimerDays}d (S2→S3 timer)`;
    case 'returning':
      return `state_entered_at + ${row.returningGraceDays}d (returning grace)`;
    default:
      return 'no time-driven exit';
  }
}

// The row patch that realises a shift. Pure: the caller owns the write, so the
// same function serves the CLI (one UPDATE) and the integration test.
export function applyDrillShift(row: EngineStateRow, shift: DrillShift): DrillClockPatch {
  const back = (d: Date): Date => new Date(d.getTime() - shift.shiftMs);
  return {
    stateEnteredAt: back(row.stateEnteredAt),
    lastCheckInAt: row.lastCheckInAt === null ? null : back(row.lastCheckInAt),
    snoozeUntil: row.snoozeUntil === null ? null : back(row.snoozeUntil),
    nextScheduledCheckInAt:
      row.nextScheduledCheckInAt === null ? null : back(row.nextScheduledCheckInAt),
    nextActionAt: shift.deadline,
  };
}
