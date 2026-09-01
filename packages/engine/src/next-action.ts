import type { EngineState } from '@truecairn/shared';
import type { EngineStateRow } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

// Compute when the worker should wake up for this user, given the state it is
// in and the row's timer columns. Returns null for states with no time-driven
// transition out (the engine waits for an explicit event).
export function computeNextActionAt(state: EngineState, row: EngineStateRow): Date | null {
  switch (state) {
    case 'pre_active':
      return null;
    case 'active': {
      const base = row.lastCheckInAt ?? row.stateEnteredAt;
      return addDays(base, row.inactivityThresholdDays);
    }
    case 'check_in_pending': {
      const base = row.snoozeUntil ?? row.stateEnteredAt;
      return addDays(base, row.checkInTimeoutDays);
    }
    case 'notification_stalled':
      return null;
    case 'escalation_pending':
      return addDays(row.stateEnteredAt, row.escalationCooldownDays);
    case 'release_review':
      return null;
    case 'limited_release':
      return addDays(row.stateEnteredAt, row.s1ToS2TimerDays);
    case 'staged_release':
      return addDays(row.stateEnteredAt, row.s2ToS3TimerDays);
    case 'full_release':
      return null;
    case 'returning':
      return addDays(row.stateEnteredAt, row.returningGraceDays);
    case 'review_required':
      return null;
  }
}
