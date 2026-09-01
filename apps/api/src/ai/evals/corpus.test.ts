import {
  NARRATION_OUTPUT_SPEC,
  validateAiArrayOutput,
  validateAiObjectOutput,
} from '@truecairn/ai-authority';
import { describe, expect, it } from 'vitest';
import { parsePlanSteps, PLAN_STEP_KINDS } from '../plan-prompt.js';
import { validateProposalPayload } from '../proposals.js';
import {
  NARRATION_REJECT_CASES,
  OUTPUT_REJECT_CASES,
  PLAN_INJECTION_CASES,
  PROPOSAL_ATTACK_CASES,
  PROPOSAL_SCHEMA,
} from './corpus.js';

// The injection corpus runs against the deterministic validators in CI (plan
// §0.6). Every adversarial output is asserted rejected / safely dropped — proving
// there is no path from unvalidated model text to an action.

describe('injection corpus: object-schema outputs are rejected deny-by-default', () => {
  it.each(OUTPUT_REJECT_CASES.map((c) => [c.name, c.output] as const))(
    'rejects %s',
    (_name, output) => {
      const asObject = validateAiObjectOutput(PROPOSAL_SCHEMA, output);
      expect(asObject.ok).toBe(false);
      // The same payload as a single-element array must also reject (the array
      // validator rejects the whole thing on one bad element).
      const asArray = validateAiArrayOutput(PROPOSAL_SCHEMA, `[${output || 'null'}]`, 4);
      expect(asArray.ok).toBe(false);
    },
  );

  it('a well-formed proposal DOES validate (the gate is not vacuous)', () => {
    const good = validateAiObjectOutput(
      PROPOSAL_SCHEMA,
      '{"kind":"flag_readiness_gap","title":"Add a second S3 contact","priority":2}',
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      // Only declared fields survive — nothing the model added rides through.
      expect(Object.keys(good.value).sort()).toEqual(['kind', 'priority', 'title']);
    }
  });
});

describe('injection corpus: proposal payloads are rejected deny-by-default', () => {
  it.each(PROPOSAL_ATTACK_CASES.map((c) => [c.name, c] as const))('rejects %s', (_name, c) => {
    expect(validateProposalPayload(c.kind, c.payload).ok).toBe(false);
  });

  it('a well-formed proposal payload still validates (gate not vacuous)', () => {
    expect(validateProposalPayload('flag_readiness_gap', { gap: 'stale_items', severity: 'warning' }).ok).toBe(true);
    expect(validateProposalPayload('tighten_checkin_schedule', { currentDays: 90, proposedDays: 30 }).ok).toBe(true);
  });
});

describe('injection corpus: plan parser drops injected kinds', () => {
  const allowed = new Set<string>(PLAN_STEP_KINDS);

  it.each(PLAN_INJECTION_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const steps = parsePlanSteps(c.output);
    // No step with a non-allowlisted kind ever survives.
    for (const step of steps) expect(allowed.has(step.kind)).toBe(true);
    // No more than the expected number of VALID steps survive.
    expect(steps.length).toBeLessThanOrEqual(c.maxValidSurviving);
    // No smuggled fields (href/action/execute) ride through — steps carry exactly
    // the three known keys.
    for (const step of steps) expect(Object.keys(step).sort()).toEqual(['kind', 'title', 'why']);
  });
});

describe('injection corpus: continuity narration is deny-by-default (G-1)', () => {
  it.each(NARRATION_REJECT_CASES.map((c) => [c.name, c.output] as const))(
    'rejects %s',
    (_name, output) => {
      expect(validateAiObjectOutput(NARRATION_OUTPUT_SPEC, output).ok).toBe(false);
    },
  );

  it('a well-formed narration DOES validate, and only the declared field survives', () => {
    const good = validateAiObjectOutput(
      NARRATION_OUTPUT_SPEC,
      '{"narration":"The owner has not confirmed activity for 40 days; messages provably reached their email channel and no check-in followed."}',
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(Object.keys(good.value)).toEqual(['narration']);
  });
});
