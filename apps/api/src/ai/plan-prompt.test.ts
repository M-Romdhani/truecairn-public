import { describe, expect, it } from 'vitest';
import type { BriefingInputs } from './briefing-prompt.js';
import { buildPlanPrompt, parsePlanSteps } from './plan-prompt.js';

describe('parsePlanSteps', () => {
  it('parses a valid JSON array of steps', () => {
    const txt = JSON.stringify([
      { kind: 'add_contact', title: 'Add a contact', why: 'You have none yet.' },
      { kind: 'arm_engine', title: 'Arm the engine', why: 'Turn on monitoring.' },
    ]);
    const steps = parsePlanSteps(txt);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.kind).toBe('add_contact');
    expect(steps[1]!.kind).toBe('arm_engine');
  });

  it('tolerates a ```json code fence', () => {
    const steps = parsePlanSteps('```json\n[{"kind":"review","title":"Review","why":"All good."}]\n```');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('review');
  });

  it('drops items whose kind is not in the closed allowlist', () => {
    const txt = JSON.stringify([
      { kind: 'delete_everything', title: 'x', why: 'y' },
      { kind: 'enrol_contact', title: 'Finish enrolling', why: 'A contact is pending.' },
    ]);
    const steps = parsePlanSteps(txt);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('enrol_contact');
  });

  it('is fail-soft to [] on non-array or garbage output', () => {
    expect(parsePlanSteps('not json at all')).toEqual([]);
    expect(parsePlanSteps('{"kind":"review"}')).toEqual([]); // an object, not an array
    expect(parsePlanSteps('')).toEqual([]);
  });

  it('caps at 4 steps', () => {
    const many = Array.from({ length: 8 }, () => ({ kind: 'review', title: 't', why: 'w' }));
    expect(parsePlanSteps(JSON.stringify(many))).toHaveLength(4);
  });
});

describe('buildPlanPrompt', () => {
  it('renders the safe metadata', () => {
    const meta: BriefingInputs = {
      engineState: null,
      previousState: null,
      nextActionAt: null,
      inactivityThresholdDays: null,
      vaultItemCount: 0,
      contactCount: 0,
      enrolledContactCount: 0,
      pendingContactCount: 0,
    };
    expect(buildPlanPrompt(meta)).toContain('vault items: 0');
    expect(buildPlanPrompt(meta)).toContain('engine state: not started');
  });
});
