import type { EngineEvent } from '@truecairn/engine';
import { describe, expect, it } from 'vitest';
import {
  AI_ACTION_KINDS,
  AI_ALLOWED_ENGINE_SIGNALS,
  AI_AUDIT_EVENT_TYPES,
  AiAuthority,
  AiAuthorityError,
  assertAllowedEngineSignal,
  isAiAuditEventType,
  type AiAuditPort,
} from './index.js';

// ── The asymmetric-authority invariant (plan docs/25 §0.5 / P3) ───────────────
//
// PERMANENT test. The core promise: AI may ADD safety (emit the fail-closed
// review_required signal) and NEVER remove it (no forward engine event, no
// ceremony advance, no gate skip). These assertions must never be weakened; a
// change that flips one is a bug, not a fix.

// EXHAUSTIVE over the engine's event union. This Record has one key per
// EngineEvent['kind'] — adding an engine event fails to typecheck here until the
// author adds it, FORCING a conscious decision about AI reachability (the answer
// is always: not reachable, unless the AI allowlist is consciously extended in a
// security review). Every one of these is a forward/neutral engine event the AI
// must never be able to emit.
const EVERY_ENGINE_EVENT_KIND: Record<EngineEvent['kind'], true> = {
  user_confirms_active: true,
  user_snoozes: true,
  user_manual_trigger: true,
  user_authenticated_during_release: true,
  user_passphrase_confirm_return: true,
  // Owner-only exit from review_required (fresh second factor). It moves AWAY
  // from release, but it is still a human protective action the AI must never
  // be able to emit — like every other engine event, denied to the AI.
  owner_resolves_review: true,
  contact_attests_alive: true,
  release_review_verification_passed: true,
  release_review_verification_failed: true,
  dispute_raised: true,
  engine_armed: true,
  pre_registered_absence_expired: true,
};

describe('asymmetry: engine authority', () => {
  it('allows exactly the one fail-closed signal', () => {
    expect([...AI_ALLOWED_ENGINE_SIGNALS]).toEqual(['review_required']);
  });

  it('the chokepoint guard throws for EVERY real engine event kind', () => {
    for (const kind of Object.keys(EVERY_ENGINE_EVENT_KIND)) {
      // No engine event kind is an allowed AI signal — not even dispute_raised,
      // which is the concrete event the ONE allowed signal maps to internally.
      expect(() => assertAllowedEngineSignal(kind), kind).toThrow(AiAuthorityError);
    }
  });

  it('rejects forward transition reasons and release-authorising strings', () => {
    for (const forbidden of [
      'release_review_verification_passed',
      's1_to_s2_timer_expired',
      's2_to_s3_timer_expired',
      'user_confirmed_active',
      'contact_attested_alive',
      'engine_armed',
      'full_release',
      'limited_release',
      'staged_release',
    ]) {
      expect(() => assertAllowedEngineSignal(forbidden), forbidden).toThrow(AiAuthorityError);
    }
  });
});

describe('asymmetry: audit authority', () => {
  // A recording fake so we can assert what the chokepoint DID (and did not) write.
  function fakeAudit(): AiAuditPort & { events: { type: string; actor: string }[] } {
    const events: { type: string; actor: string }[] = [];
    return {
      events,
      async append(_db, _u, eventType, _payload, opts) {
        events.push({ type: eventType, actor: opts.actor });
        return { id: 'x', seq: 1n, entryHash: new Uint8Array() };
      },
    };
  }

  it('an actor=ai write can ONLY carry an allowlisted AI event type', async () => {
    const audit = fakeAudit();
    const authority = new AiAuthority({ audit });
    // Every allowlisted AI event type is accepted and stamped actor='ai'.
    for (const type of AI_AUDIT_EVENT_TYPES) {
      await authority.appendAiAudit({} as never, 'u' as never, type, {});
    }
    expect(audit.events.every((e) => e.actor === 'ai')).toBe(true);
    expect(audit.events.every((e) => isAiAuditEventType(e.type))).toBe(true);

    // A forward engine audit event cannot be laundered through the chokepoint.
    for (const forbidden of [
      'engine.release_review_passed',
      'engine.full_release',
      'ceremony.reconstructed',
      'release_review_verification_passed',
    ]) {
      await expect(
        authority.appendAiAudit({} as never, 'u' as never, forbidden as never, {}),
      ).rejects.toThrow(AiAuthorityError);
    }
    // None of the forbidden attempts reached the writer.
    expect(audit.events).toHaveLength(AI_AUDIT_EVENT_TYPES.length);
  });
});

describe('asymmetry: action authority', () => {
  it('no registered action kind loosens protection at the autonomous tier', () => {
    for (const [kind, spec] of Object.entries(AI_ACTION_KINDS)) {
      if (spec.tiers.includes('autonomous')) {
        expect(spec.safetyDirection, `${kind} is autonomous`).not.toBe('open');
      }
    }
  });
});
