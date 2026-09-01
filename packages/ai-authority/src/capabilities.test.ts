import { describe, expect, it } from 'vitest';
import {
  AI_ACTION_KINDS,
  AI_ALLOWED_ENGINE_SIGNALS,
  AiAuthorityError,
  assertActionKindAllowed,
  assertActionSpecAllowed,
  assertAllowedEngineSignal,
  toEngineEvent,
  type ActionKindSpec,
} from './capabilities.js';

describe('engine-signal authority', () => {
  it('allows exactly one signal', () => {
    expect([...AI_ALLOWED_ENGINE_SIGNALS]).toEqual(['review_required']);
    expect(() => assertAllowedEngineSignal('review_required')).not.toThrow();
  });

  // The forward events + reasons the AI must NEVER be able to emit. If a new
  // engine event is added and someone tries to route AI to it, this list (and the
  // Phase 0.5 invariant test that enumerates the real unions) must stay red until
  // a security review consciously extends the allowlist.
  it.each([
    'release_review_verification_passed',
    'release_review_verification_failed',
    'contact_attests_alive',
    'user_confirms_active',
    'engine_armed',
    'dispute_raised', // even the concrete event name is not an allowed SIGNAL
    'full_release',
    '',
    'REVIEW_REQUIRED',
  ])('rejects forbidden signal %j', (signal) => {
    expect(() => assertAllowedEngineSignal(signal)).toThrow(AiAuthorityError);
  });

  it('maps the one signal to the fail-closed dispute_raised event only', () => {
    expect(toEngineEvent('review_required')).toEqual({ kind: 'dispute_raised' });
  });
});

describe('action-kind authority', () => {
  it('every registered kind carries a safety direction and at least one tier', () => {
    for (const [kind, spec] of Object.entries(AI_ACTION_KINDS) as [string, ActionKindSpec][]) {
      expect(['closed', 'neutral', 'open']).toContain(spec.safetyDirection);
      expect(spec.tiers.length).toBeGreaterThan(0);
      // No registered kind loosens protection — and if one ever did it could not
      // be autonomous.
      if (spec.safetyDirection === 'open') {
        expect(spec.tiers).not.toContain('autonomous');
      }
      void kind;
    }
  });

  it('permits registered kinds at their declared tier', () => {
    expect(() => assertActionKindAllowed('tighten_checkin_schedule', 'proposal')).not.toThrow();
    expect(() => assertActionKindAllowed('tighten_checkin_schedule', 'autonomous')).not.toThrow();
    expect(() => assertActionKindAllowed('send_reminder_nudge', 'autonomous')).not.toThrow();
    expect(() => assertActionKindAllowed('draft_contact_message', 'proposal')).not.toThrow();
  });

  it('rejects an unregistered kind', () => {
    expect(() => assertActionKindAllowed('delete_everything', 'proposal')).toThrow(AiAuthorityError);
  });

  it('rejects a proposal-only kind at the autonomous tier', () => {
    expect(() => assertActionKindAllowed('draft_contact_message', 'autonomous')).toThrow(
      AiAuthorityError,
    );
    expect(() => assertActionKindAllowed('flag_readiness_gap', 'autonomous')).toThrow(
      AiAuthorityError,
    );
  });
});

// Gap plan G-2 / D5: channel removal is a sensitive action a HUMAN enqueues
// (step-up + delay). Silencing the owner's reminders LOOSENS protection, so the
// AI must never be able to enqueue it — pinned here at the registry, the single
// door every AI action passes. A "fix" that registers remove_channel as
// AI-enqueueable is a bug (CLAUDE.md invariant 8).
describe('remove_channel is not an AI capability (G-2/D5)', () => {
  it('the registry does not know remove_channel at any tier', () => {
    expect(Object.keys(AI_ACTION_KINDS)).not.toContain('remove_channel');
    expect(() => assertActionKindAllowed('remove_channel', 'proposal')).toThrow(AiAuthorityError);
    expect(() => assertActionKindAllowed('remove_channel', 'autonomous')).toThrow(AiAuthorityError);
  });

  it("even IF it were ever registered, its direction is 'open' — autonomy rejects it by construction", () => {
    const hypothetical: ActionKindSpec = {
      safetyDirection: 'open',
      tiers: ['proposal', 'autonomous'], // a future mistake
    };
    expect(() => assertActionSpecAllowed('remove_channel', 'autonomous', hypothetical)).toThrow(
      AiAuthorityError,
    );
  });
});
