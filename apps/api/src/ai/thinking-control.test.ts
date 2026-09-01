import { ThinkingLevel } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { thinkingControlFor } from './gemini.js';

// ── The thinking control must follow the model family ────────────────────────
//
// Measured live 2026-08-25 against the real API with both models (see the
// comment on thinkingControlFor for the raw numbers). The property this pins:
//
//   2.5 → thinkingBudget: 0   (thinkingLevel is a hard 400 there)
//   3.x → thinkingLevel: LOW  (thinkingBudget is accepted AND IGNORED there)
//
// The 3.x direction is the one worth a test. Sending the 2.5 control to a 3.x
// model does not fail — it succeeds, silently spends the output budget on
// thinking, and reintroduces the truncated/empty answers this option exists to
// prevent. A defect that only shows as "the plan card is sometimes empty" is
// exactly the kind that survives review, so it gets an assertion instead.
describe('thinkingControlFor', () => {
  it('sends the budget form to the 2.5 family, which rejects the level form', () => {
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']) {
      expect(thinkingControlFor(model), model).toEqual({ thinkingBudget: 0 });
    }
  });

  it('sends the level form to 3.x and later, which ignores the budget form', () => {
    for (const model of [
      'gemini-3.7-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-4.0-flash',
      // Two-digit majors must not fall back to the 2.5 branch by accident.
      'gemini-10.1-flash',
    ]) {
      expect(thinkingControlFor(model), model).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    }
  });

  // An unrecognised string must take the conservative branch. thinkingBudget is
  // the safe default because a wrong guess there is a LOUD 400 at the provider,
  // whereas a wrong guess the other way is silent — and a silent wrong answer is
  // the failure this whole file exists to avoid.
  it('falls back to the loud option for anything it does not recognise', () => {
    for (const model of ['', 'some-other-model', 'gemini-flash-latest']) {
      expect(thinkingControlFor(model), model).toEqual({ thinkingBudget: 0 });
    }
  });
});
