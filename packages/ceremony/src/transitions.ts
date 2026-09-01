import type { CeremonyStatus } from '@truecairn/shared';
import type {
  CeremonyContext,
  CeremonyEffect,
  CeremonyEvent,
  CeremonyRow,
  CeremonyTransitionReason,
  CeremonyTransitionResult,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Time-driven transitions. The worker scans for these (sync-window expiry in
// collecting_affirmations; reconstruction timeout in reconstructing). Pure:
// given the row + clock + counts, returns no_change or a full transition.
// ---------------------------------------------------------------------------

export function computeCeremonyTimeTransition(
  row: CeremonyRow,
  ctx: CeremonyContext,
): CeremonyTransitionResult {
  switch (row.status) {
    case 'collecting_affirmations': {
      if (ctx.now < row.syncWindowExpiresAt) return noChange();
      // Window expired. If the threshold is already met the ceremony should
      // have advanced on the commit event; don't fail it out from under that.
      if (ctx.committedAffirmations >= ctx.threshold && ctx.diverseRoleSatisfied) {
        return noChange();
      }
      // Tentative affirmations inside their revocation window can still commit
      // (docs/18 §112: the outer key releases after the revocation window expires
      // for all tentative affirmations). Hold the window open while the pending
      // commits could still reach a diverse-role threshold; each tick re-checks,
      // so a revocation that makes the threshold unreachable fails it then.
      const tentative = ctx.tentativeAffirmations ?? 0;
      const diversePossible = ctx.diverseRolePossible ?? ctx.diverseRoleSatisfied;
      if (ctx.committedAffirmations + tentative >= ctx.threshold && diversePossible) {
        return noChange();
      }
      return {
        kind: 'transition',
        toStatus: 'failed',
        reason: 'sync_window_expired_below_threshold',
        effects: [
          audit('ceremony.sync_window_expired', {
            committedAffirmations: ctx.committedAffirmations,
            threshold: ctx.threshold,
          }),
        ],
        // Fail-closed: tell the engine consensus was NOT reached so it leaves
        // release_review (→ review_required) rather than hanging or releasing.
        engineSignal: 'release_review_verification_failed',
      };
    }

    case 'reconstructing': {
      if (row.reconstructionStartedAt === null) return noChange();
      const deadline = new Date(
        row.reconstructionStartedAt.getTime() + ctx.reconstructionTimeoutDays * DAY_MS,
      );
      if (ctx.now < deadline) return noChange();
      // If any recipient already released, the ceremony is 'released'
      // (terminal) and we never reach here. Timing out means nobody completed.
      if (ctx.releasedRecipients > 0) return noChange();
      return transition('failed', 'reconstruction_timed_out', [
        audit('ceremony.reconstruction_timed_out', {
          timeoutDays: ctx.reconstructionTimeoutDays,
        }),
      ]);
    }

    // No time-driven transition out of these states.
    case 'initiated':
    case 'awaiting_outer_key':
    case 'released':
    case 'cancelled':
    case 'failed':
      return noChange();
  }
}

// ---------------------------------------------------------------------------
// Event-driven transitions. The worker / API feed user, contact, and system
// events. The asymmetry principle holds: every non-terminal state collapses to
// 'cancelled' on user_returned, and a dispute additionally signals the engine
// to REVIEW_REQUIRED.
// ---------------------------------------------------------------------------

export function computeCeremonyEventTransition(
  row: CeremonyRow,
  event: CeremonyEvent,
  ctx: CeremonyContext,
): CeremonyTransitionResult {
  // Terminal states never transition, for any event.
  if (row.status === 'released' || row.status === 'cancelled' || row.status === 'failed') {
    return noChange();
  }

  // Cancellation + dispute are uniform across every non-terminal state.
  if (event.kind === 'user_returned') {
    return transition('cancelled', 'user_returned', [
      audit('ceremony.cancelled', { reason: 'user_returned', from: row.status }),
      notify('engine_state_change', 'Release cancelled — you are confirmed active'),
    ]);
  }
  if (event.kind === 'dispute_raised') {
    return {
      kind: 'transition',
      toStatus: 'cancelled',
      reason: 'dispute_raised',
      effects: [audit('ceremony.disputed', { from: row.status })],
      engineSignal: 'review_required',
    };
  }

  switch (row.status) {
    case 'initiated':
      if (event.kind === 'contacts_notified') {
        return transition('collecting_affirmations', 'contacts_notified', [
          audit('ceremony.collecting_affirmations', {}),
          notify('ceremony_affirmation_request', 'Trusted contacts asked to affirm release'),
        ]);
      }
      return noChange();

    case 'collecting_affirmations':
      if (event.kind === 'affirmation_committed') {
        if (ctx.committedAffirmations >= ctx.threshold && ctx.diverseRoleSatisfied) {
          return {
            kind: 'transition',
            toStatus: 'awaiting_outer_key',
            reason: 'threshold_met',
            effects: [
              audit('ceremony.threshold_met', {
                committedAffirmations: ctx.committedAffirmations,
                threshold: ctx.threshold,
              }),
            ],
            // Consensus reached → authorise the engine to leave release_review.
            // The tiered release still gates on the engine stage (awaiting_outer_key).
            engineSignal: 'release_review_verification_passed',
          };
        }
        return noChange();
      }
      // affirmation_revoked: the count drops but the ceremony stays open.
      return noChange();

    case 'awaiting_outer_key':
      if (event.kind === 'outer_key_released') {
        return transition('reconstructing', 'outer_key_released', [
          audit('ceremony.outer_key_released', {}),
          notify('engine_state_change', 'Outer-layer key released to the ceremony'),
        ]);
      }
      return noChange();

    case 'reconstructing':
      if (event.kind === 'recipient_reconstructed') {
        // First successful recipient flips the ceremony terminal-released.
        // Further recipients reconstruct independently (tracked per-recipient
        // in ceremony_recipients) without changing the ceremony status.
        return transition('released', 'first_recipient_released', [
          audit('ceremony.released', { firstRecipient: true }),
        ]);
      }
      // recipient_failed: one recipient failed; others may still complete.
      return noChange();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function noChange(): CeremonyTransitionResult {
  return { kind: 'no_change' };
}

function transition(
  toStatus: CeremonyStatus,
  reason: CeremonyTransitionReason,
  effects: CeremonyEffect[],
): CeremonyTransitionResult {
  return { kind: 'transition', toStatus, reason, effects };
}

function audit(eventType: string, payload: Record<string, unknown>): CeremonyEffect {
  return { kind: 'audit_event', eventType, payload };
}

function notify(
  purpose: Extract<CeremonyEffect, { kind: 'enqueue_notification' }>['purpose'],
  summary: string,
): CeremonyEffect {
  return { kind: 'enqueue_notification', purpose, summary };
}
