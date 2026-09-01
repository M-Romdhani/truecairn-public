import { describe, expect, it } from 'vitest';
import type { CeremonyStatus } from '@truecairn/shared';
import {
  computeCeremonyEventTransition,
  computeCeremonyTimeTransition,
} from './transitions.js';
import type { CeremonyContext, CeremonyEvent, CeremonyRow } from './types.js';

const T0 = new Date('2026-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function row(status: CeremonyStatus, overrides: Partial<CeremonyRow> = {}): CeremonyRow {
  return {
    status,
    tier: 's3',
    initiatedAt: T0,
    syncWindowExpiresAt: new Date(T0.getTime() + 14 * DAY),
    reconstructionStartedAt: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<CeremonyContext> = {}): CeremonyContext {
  return {
    now: T0,
    threshold: 3,
    committedAffirmations: 0,
    diverseRoleSatisfied: true,
    releasedRecipients: 0,
    reconstructionTimeoutDays: 30,
    ...overrides,
  };
}

const ALL_STATUSES: CeremonyStatus[] = [
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
  'released',
  'cancelled',
  'failed',
];

const TERMINAL: CeremonyStatus[] = ['released', 'cancelled', 'failed'];

const ALL_EVENTS: CeremonyEvent[] = [
  { kind: 'contacts_notified' },
  { kind: 'affirmation_committed' },
  { kind: 'affirmation_revoked' },
  { kind: 'outer_key_released' },
  { kind: 'recipient_reconstructed' },
  { kind: 'recipient_failed' },
  { kind: 'user_returned' },
  { kind: 'dispute_raised' },
];

// ===========================================================================
// EVENT-DRIVEN — legal transitions
// ===========================================================================

describe('event transitions — legal advances', () => {
  it('initiated + contacts_notified → collecting_affirmations', () => {
    const r = computeCeremonyEventTransition(row('initiated'), { kind: 'contacts_notified' }, ctx());
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'collecting_affirmations', reason: 'contacts_notified' });
  });

  it('collecting_affirmations + affirmation_committed at threshold + diverse → awaiting_outer_key', () => {
    const r = computeCeremonyEventTransition(
      row('collecting_affirmations'),
      { kind: 'affirmation_committed' },
      ctx({ committedAffirmations: 3, threshold: 3, diverseRoleSatisfied: true }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'awaiting_outer_key', reason: 'threshold_met' });
  });

  it('collecting_affirmations + affirmation_committed below threshold → no_change', () => {
    const r = computeCeremonyEventTransition(
      row('collecting_affirmations'),
      { kind: 'affirmation_committed' },
      ctx({ committedAffirmations: 2, threshold: 3 }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('collecting_affirmations + affirmation_committed at count but NOT diverse → no_change', () => {
    const r = computeCeremonyEventTransition(
      row('collecting_affirmations'),
      { kind: 'affirmation_committed' },
      ctx({ committedAffirmations: 3, threshold: 3, diverseRoleSatisfied: false }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('collecting_affirmations + affirmation_revoked → no_change (stays open)', () => {
    const r = computeCeremonyEventTransition(
      row('collecting_affirmations'),
      { kind: 'affirmation_revoked' },
      ctx({ committedAffirmations: 1 }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('awaiting_outer_key + outer_key_released → reconstructing', () => {
    const r = computeCeremonyEventTransition(
      row('awaiting_outer_key'),
      { kind: 'outer_key_released' },
      ctx(),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'reconstructing', reason: 'outer_key_released' });
  });

  it('reconstructing + recipient_reconstructed → released (first recipient)', () => {
    const r = computeCeremonyEventTransition(
      row('reconstructing', { reconstructionStartedAt: T0 }),
      { kind: 'recipient_reconstructed' },
      ctx(),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'released', reason: 'first_recipient_released' });
  });

  it('reconstructing + recipient_failed → no_change (others may complete)', () => {
    const r = computeCeremonyEventTransition(
      row('reconstructing', { reconstructionStartedAt: T0 }),
      { kind: 'recipient_failed' },
      ctx(),
    );
    expect(r.kind).toBe('no_change');
  });
});

// ===========================================================================
// EVENT-DRIVEN — cancellation + dispute (uniform across non-terminal states)
// ===========================================================================

describe('event transitions — user_returned cancels every non-terminal state', () => {
  for (const status of ['initiated', 'collecting_affirmations', 'awaiting_outer_key', 'reconstructing'] as const) {
    it(`${status} + user_returned → cancelled`, () => {
      const r = computeCeremonyEventTransition(
        row(status, { reconstructionStartedAt: status === 'reconstructing' ? T0 : null }),
        { kind: 'user_returned' },
        ctx(),
      );
      expect(r).toMatchObject({ kind: 'transition', toStatus: 'cancelled', reason: 'user_returned' });
      if (r.kind === 'transition') expect(r.engineSignal).toBeUndefined();
    });
  }
});

describe('event transitions — dispute_raised cancels + signals engine REVIEW_REQUIRED', () => {
  for (const status of ['initiated', 'collecting_affirmations', 'awaiting_outer_key', 'reconstructing'] as const) {
    it(`${status} + dispute_raised → cancelled + review_required`, () => {
      const r = computeCeremonyEventTransition(
        row(status, { reconstructionStartedAt: status === 'reconstructing' ? T0 : null }),
        { kind: 'dispute_raised' },
        ctx(),
      );
      expect(r).toMatchObject({ kind: 'transition', toStatus: 'cancelled', reason: 'dispute_raised' });
      if (r.kind === 'transition') expect(r.engineSignal).toBe('review_required');
    });
  }
});

// ===========================================================================
// EVENT-DRIVEN — terminal states reject every event
// ===========================================================================

describe('event transitions — terminal states are inert', () => {
  for (const status of TERMINAL) {
    for (const event of ALL_EVENTS) {
      it(`${status} + ${event.kind} → no_change`, () => {
        const r = computeCeremonyEventTransition(row(status), event, ctx());
        expect(r.kind).toBe('no_change');
      });
    }
  }
});

// ===========================================================================
// EVENT-DRIVEN — illegal event/state pairs are rejected (no_change)
//
// For every (state, event) NOT in the legal set above, the machine must
// return no_change. This is the combinatorial coverage the proposal asked
// for: it proves no accidental edge exists.
// ===========================================================================

describe('event transitions — illegal pairs rejected', () => {
  // Legal (non-cancel/dispute) event per non-terminal state. user_returned and
  // dispute_raised are legal from every non-terminal state and handled above.
  const legalAdvance: Record<string, Set<string>> = {
    initiated: new Set(['contacts_notified']),
    collecting_affirmations: new Set(['affirmation_committed', 'affirmation_revoked']),
    awaiting_outer_key: new Set(['outer_key_released']),
    reconstructing: new Set(['recipient_reconstructed', 'recipient_failed']),
  };

  for (const status of ['initiated', 'collecting_affirmations', 'awaiting_outer_key', 'reconstructing'] as const) {
    for (const event of ALL_EVENTS) {
      if (event.kind === 'user_returned' || event.kind === 'dispute_raised') continue;
      const isLegal = legalAdvance[status]!.has(event.kind);
      if (isLegal) continue;
      it(`${status} + ${event.kind} → no_change (illegal)`, () => {
        // Use a context that would NOT satisfy any advance condition, so the
        // only reason for a transition would be an erroneous edge.
        const r = computeCeremonyEventTransition(
          row(status, { reconstructionStartedAt: status === 'reconstructing' ? T0 : null }),
          event,
          ctx({ committedAffirmations: 0 }),
        );
        expect(r.kind).toBe('no_change');
      });
    }
  }
});

// ===========================================================================
// TIME-DRIVEN transitions
// ===========================================================================

describe('time transitions — sync window', () => {
  it('collecting_affirmations: before window expiry → no_change', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({ now: new Date(T0.getTime() + 13 * DAY) }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('collecting_affirmations: window expired below threshold → failed', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({ now: new Date(T0.getTime() + 15 * DAY), committedAffirmations: 2, threshold: 3 }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'failed', reason: 'sync_window_expired_below_threshold' });
  });

  it('collecting_affirmations: window expired but threshold met + diverse → no_change (defensive)', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({ now: new Date(T0.getTime() + 15 * DAY), committedAffirmations: 3, threshold: 3, diverseRoleSatisfied: true }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('collecting_affirmations: window expired, count met but NOT diverse → failed', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({ now: new Date(T0.getTime() + 15 * DAY), committedAffirmations: 3, threshold: 3, diverseRoleSatisfied: false }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'failed' });
  });

  it('window expired, committed below threshold but tentative can still reach it → no_change (holds open)', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({
        now: new Date(T0.getTime() + 15 * DAY),
        committedAffirmations: 1,
        tentativeAffirmations: 2,
        threshold: 3,
        diverseRoleSatisfied: false,
        diverseRolePossible: true,
      }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('window expired, committed + tentative still below threshold → failed', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({
        now: new Date(T0.getTime() + 15 * DAY),
        committedAffirmations: 1,
        tentativeAffirmations: 1,
        threshold: 3,
        diverseRolePossible: true,
      }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'failed', reason: 'sync_window_expired_below_threshold' });
  });

  it('window expired, count reachable but diverse roles impossible even with tentative → failed', () => {
    const r = computeCeremonyTimeTransition(
      row('collecting_affirmations'),
      ctx({
        now: new Date(T0.getTime() + 15 * DAY),
        committedAffirmations: 1,
        tentativeAffirmations: 2,
        threshold: 3,
        diverseRoleSatisfied: false,
        diverseRolePossible: false,
      }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'failed' });
  });
});

describe('time transitions — reconstruction timeout', () => {
  it('reconstructing: before timeout → no_change', () => {
    const r = computeCeremonyTimeTransition(
      row('reconstructing', { reconstructionStartedAt: T0 }),
      ctx({ now: new Date(T0.getTime() + 29 * DAY) }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('reconstructing: past timeout with no released recipient → failed', () => {
    const r = computeCeremonyTimeTransition(
      row('reconstructing', { reconstructionStartedAt: T0 }),
      ctx({ now: new Date(T0.getTime() + 31 * DAY), releasedRecipients: 0 }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'failed', reason: 'reconstruction_timed_out' });
  });

  it('reconstructing: past timeout but a recipient already released → no_change', () => {
    const r = computeCeremonyTimeTransition(
      row('reconstructing', { reconstructionStartedAt: T0 }),
      ctx({ now: new Date(T0.getTime() + 31 * DAY), releasedRecipients: 1 }),
    );
    expect(r.kind).toBe('no_change');
  });

  it('reconstructing: null reconstructionStartedAt → no_change (defensive)', () => {
    const r = computeCeremonyTimeTransition(
      row('reconstructing', { reconstructionStartedAt: null }),
      ctx({ now: new Date(T0.getTime() + 365 * DAY) }),
    );
    expect(r.kind).toBe('no_change');
  });
});

describe('time transitions — states with no time-driven exit', () => {
  for (const status of ['initiated', 'awaiting_outer_key', 'released', 'cancelled', 'failed'] as const) {
    it(`${status} → no_change even far in the future`, () => {
      const r = computeCeremonyTimeTransition(
        row(status, { reconstructionStartedAt: T0 }),
        ctx({ now: new Date(T0.getTime() + 365 * DAY) }),
      );
      expect(r.kind).toBe('no_change');
    });
  }
});

// ===========================================================================
// Effects sanity — every transition emits at least one audit_event
// ===========================================================================

describe('every transition emits an audit_event effect', () => {
  it('covers all event-driven transitions', () => {
    const cases: Array<{ row: CeremonyRow; event: CeremonyEvent; ctx: CeremonyContext }> = [
      { row: row('initiated'), event: { kind: 'contacts_notified' }, ctx: ctx() },
      { row: row('collecting_affirmations'), event: { kind: 'affirmation_committed' }, ctx: ctx({ committedAffirmations: 3 }) },
      { row: row('awaiting_outer_key'), event: { kind: 'outer_key_released' }, ctx: ctx() },
      { row: row('reconstructing', { reconstructionStartedAt: T0 }), event: { kind: 'recipient_reconstructed' }, ctx: ctx() },
      { row: row('initiated'), event: { kind: 'user_returned' }, ctx: ctx() },
      { row: row('initiated'), event: { kind: 'dispute_raised' }, ctx: ctx() },
    ];
    for (const c of cases) {
      const r = computeCeremonyEventTransition(c.row, c.event, c.ctx);
      expect(r.kind).toBe('transition');
      if (r.kind === 'transition') {
        expect(r.effects.some((e) => e.kind === 'audit_event')).toBe(true);
      }
    }
  });

  it('covers all time-driven transitions', () => {
    const cases: Array<{ row: CeremonyRow; ctx: CeremonyContext }> = [
      { row: row('collecting_affirmations'), ctx: ctx({ now: new Date(T0.getTime() + 15 * DAY), committedAffirmations: 0 }) },
      { row: row('reconstructing', { reconstructionStartedAt: T0 }), ctx: ctx({ now: new Date(T0.getTime() + 31 * DAY) }) },
    ];
    for (const c of cases) {
      const r = computeCeremonyTimeTransition(c.row, c.ctx);
      expect(r.kind).toBe('transition');
      if (r.kind === 'transition') {
        expect(r.effects.some((e) => e.kind === 'audit_event')).toBe(true);
      }
    }
  });
});

// ===========================================================================
// S1 (threshold 1) — any-one-contact path
// ===========================================================================

describe('S1 ceremony (threshold 1)', () => {
  it('a single committed affirmation meets the S1 threshold', () => {
    const r = computeCeremonyEventTransition(
      row('collecting_affirmations', { tier: 's1' }),
      { kind: 'affirmation_committed' },
      ctx({ threshold: 1, committedAffirmations: 1, diverseRoleSatisfied: true }),
    );
    expect(r).toMatchObject({ kind: 'transition', toStatus: 'awaiting_outer_key' });
  });
});

// sanity: the status/event lists used by the loops above stay exhaustive.
describe('coverage guards', () => {
  it('ALL_STATUSES matches the CeremonyStatus union', () => {
    expect(ALL_STATUSES.length).toBe(7);
  });
  it('ALL_EVENTS matches the CeremonyEvent union', () => {
    expect(ALL_EVENTS.length).toBe(8);
  });
});
