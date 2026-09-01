import { ENGINE_STATES, type EngineState } from '@truecairn/shared';
import type { TFunction } from '../i18n/useT.js';

// ── One name per engine state, and one ladder, shared by every screen ────────
//
// This exists because Home and Engine disagreed about what the engine was doing.
// Home carried its own label map listing `grace`, `check_in_due`,
// `reconstructing` and `released` — none of which `ENGINE_STATES` contains — and
// omitting SEVEN states that it does, including `check_in_pending`: the ordinary
// "we are waiting to hear from you" state, and so the one an owner is most likely
// to meet. It fell through to a `replace(/_/g,' ')` fallback and rendered
// "check in pending" in English on both language settings. Meanwhile the Engine
// screen printed the bare enum in its status pill.
//
// The label set is now derived from ENGINE_STATES itself and pinned by
// engine-states.test.ts, so a state added to the enum without a label is a failing
// test rather than a screen that quietly starts speaking snake_case.

export function engineStateLabel(state: EngineState | null, t: TFunction): string {
  if (state === null) return t('engine.state.none');
  return t(`engine.state.${state}`);
}

// The escalation ladder, in the order the engine climbs it. This is the SUBSET of
// ENGINE_STATES that forms the timed path from "alive" to "handed over"; the
// remaining states are branches off it, mapped by ladderPosition below.
export const LADDER: readonly EngineState[] = [
  'active',
  'check_in_pending',
  'escalation_pending',
  'release_review',
  'limited_release',
  'staged_release',
  'full_release',
] as const;

export type LadderPosition =
  // Engine not armed — the ladder is shown unlit, because none of it applies yet.
  | { kind: 'before' }
  // On the ladder at `index`.
  | { kind: 'on'; index: number }
  // Off the ladder, but anchored to the rung it branched from, so the picture
  // still says how far things went. `review_required` and `returning` are holds
  // and returns, NOT rungs — drawing them as progress would overstate the state.
  | { kind: 'aside'; index: number; state: EngineState };

export function ladderPosition(state: EngineState | null): LadderPosition {
  if (state === null || state === 'pre_active') return { kind: 'before' };
  const direct = LADDER.indexOf(state);
  if (direct !== -1) return { kind: 'on', index: direct };
  // notification_stalled is a fault branch of the check-in wait: the engine could
  // not get a notice out, so it is anchored there rather than further up.
  if (state === 'notification_stalled') {
    return { kind: 'aside', index: LADDER.indexOf('check_in_pending'), state };
  }
  // Both of these are reached FROM a release state and mean the ladder stopped.
  // release_review is the honest anchor: it is the last rung at which nothing has
  // been handed over, and neither state tells us which rung it paused.
  return { kind: 'aside', index: LADDER.indexOf('release_review'), state };
}

// Re-exported so the pinning test can assert coverage against the same list the
// app uses, rather than a second copy of it.
export { ENGINE_STATES };
