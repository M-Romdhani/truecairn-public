import type { CeremonyStatus, VaultTier } from '@truecairn/shared';

// Narrow view of a release_ceremonies row that drives the pure ceremony state
// machine. Mirrors how @truecairn/engine's EngineStateRow keeps the pure
// transition functions away from DB internals.
export interface CeremonyRow {
  status: CeremonyStatus;
  tier: VaultTier;
  initiatedAt: Date;
  syncWindowExpiresAt: Date;
  reconstructionStartedAt: Date | null;
}

// Context the worker assembles before computing a transition: the clock, the
// tier threshold, the live counts the transition needs, and the timeout knob.
export interface CeremonyContext {
  now: Date;
  // Shamir threshold for the tier: 1 (S1, any-one-contact), 2 (S2), 3 (S3).
  threshold: number;
  // committed (not merely tentative) affirmations so far.
  committedAffirmations: number;
  // tentative affirmations still inside their revocation window. At sync-window
  // expiry these can still commit (docs/18 §112), so the window holds open while
  // committed + tentative could reach the threshold. Optional (defaults to 0)
  // to keep the pure function backward-compatible.
  tentativeAffirmations?: number;
  // Whether the committed affirmations satisfy the diverse-role requirement
  // (docs/12 §5.4.5, docs/14 §5.6.5). Computed by the worker from contact roles.
  diverseRoleSatisfied: boolean;
  // Whether committed + tentative affirmations TOGETHER could satisfy the
  // diverse-role requirement — used only by the hold-open decision at
  // sync-window expiry. Optional; defaults to diverseRoleSatisfied.
  diverseRolePossible?: boolean;
  // How many recipients have reached 'released' (reconstructed their content).
  releasedRecipients: number;
  // Days a ceremony may sit in 'reconstructing' with no recipient completing
  // before it is failed. docs ruling: 30.
  reconstructionTimeoutDays: number;
}

// Events the worker / API feed to the event-driven transition function.
export type CeremonyEvent =
  | { kind: 'contacts_notified' }
  | { kind: 'affirmation_committed' }
  | { kind: 'affirmation_revoked' }
  | { kind: 'outer_key_released' }
  | { kind: 'recipient_reconstructed' }
  | { kind: 'recipient_failed' }
  | { kind: 'user_returned' }
  | { kind: 'dispute_raised' };

export type CeremonyTransitionReason =
  | 'contacts_notified'
  | 'threshold_met'
  | 'outer_key_released'
  | 'first_recipient_released'
  | 'sync_window_expired_below_threshold'
  | 'reconstruction_timed_out'
  | 'user_returned'
  | 'dispute_raised';

// Side effects of a ceremony transition. The processor (next checkpoint)
// realises these against the DB / audit / notifications.
export type CeremonyEffect =
  | { kind: 'audit_event'; eventType: string; payload: Record<string, unknown> }
  | {
      kind: 'enqueue_notification';
      purpose:
        | 'ceremony_initiation'
        | 'ceremony_affirmation_request'
        | 'ceremony_revocation_window'
        | 'engine_state_change';
      summary: string;
    };

export type CeremonyTransitionResult =
  | { kind: 'no_change' }
  | {
      kind: 'transition';
      toStatus: CeremonyStatus;
      reason: CeremonyTransitionReason;
      effects: CeremonyEffect[];
      // When set, the worker must also push the engine via this signal. The
      // worker maps it to an engine event (CEREMONY_COMPLETION Bridge 3):
      //   - verification_passed: consensus reached → engine release_review →
      //     limited_release (gates the actual tiered release behind consensus).
      //   - verification_failed: the affirmation sync window expired below
      //     threshold → engine release_review → review_required (fail-closed; no
      //     release on silence).
      //   - review_required: a dispute → engine dispute_raised → review_required.
      // A user return / cancel is handled by the engine's own cancel path, so it
      // is not signalled here (the ceremony only records its own cancellation).
      engineSignal?: CeremonyEngineSignal;
    };

export type CeremonyEngineSignal =
  | 'review_required'
  | 'release_review_verification_passed'
  | 'release_review_verification_failed';
