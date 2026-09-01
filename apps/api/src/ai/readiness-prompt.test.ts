import { describe, expect, it } from 'vitest';
import {
  buildReadinessPrompt,
  deterministicReadinessExplanation,
  READINESS_SYSTEM_INSTRUCTION,
  templateExplanation,
} from './readiness-prompt.js';
import { READINESS_GAP_CODES, type ReadinessGap } from './readiness.js';

// ── The blocker-consequence rule (QA 2026-08-11 §3) ───────────────────────────
//
// WHAT THESE TESTS CAN AND CANNOT DO, stated up front because the distinction is
// the whole point of the finding. A unit test can prove the instruction CARRIES
// the rule and that the prompt gives the model what it needs to apply it. It
// cannot prove the model OBEYS it — that needs a live call, and this is the
// surface docs/38 §5 lists as never having been evaluated against the live model.
// These are a regression guard against the rule being silently dropped, not
// evidence that the output is now correct.
//
// The observed failure: the template for `no_verified_channel` says "a check-in
// request cannot reach you, and the engine reads that silence as inactivity"; the
// live model rendered it as "add and verify a notification channel so we can
// contact you" — item one of a four-item to-do list. The consequence, which is the
// entire payload of a blocker, was the first thing a compressing rephrase dropped.

const gap = (code: string, severity: 'blocker' | 'warning'): ReadinessGap =>
  ({ code, severity }) as ReadinessGap;

describe('READINESS_SYSTEM_INSTRUCTION — the consequence rule is load-bearing', () => {
  it('instructs the model to preserve a consequence, not just the action', () => {
    const s = READINESS_SYSTEM_INSTRUCTION.toLowerCase();
    expect(s).toContain('consequence');
    expect(s).toMatch(/never drop it|must not drop/);
    // Blockers keep their own clause: never reduced to a to-do item.
    expect(s).toContain('blocker');
  });

  // The 2026-08-12 correction. The rule was severity-based, and QA found the edge:
  // `contact_key_unconfirmed` is a WARNING whose consequence is "they cannot hold a
  // share of your release", and the live model dropped it under a rule that said
  // warnings could be shortened freely. Severity ranks how broken a setup is; it
  // does not rank how much the owner needs to know what happens if they ignore the
  // sentence. Keying off the TEXT covers every future gap without a second decision.
  it('binds the rule to the TEXT, not to severity — warnings with a consequence are covered', () => {
    const s = READINESS_SYSTEM_INSTRUCTION.toLowerCase();
    expect(s).toMatch(/applies to warnings/);
    // And it must NOT re-introduce the old licence to compress any warning.
    expect(s).not.toMatch(/warnings may be shortened freely/);
    // Consequence-free lines stay compressible, or the instruction degrades into
    // "never shorten anything" and the model stops obeying the part that matters.
    expect(s).toMatch(/states no consequence/);
  });

  it('still forbids inventing gaps and still demands prose', () => {
    // The new rule must not have displaced the old constraints.
    const s = READINESS_SYSTEM_INSTRUCTION.toLowerCase();
    expect(s).toContain('do not invent gaps');
    expect(s).toContain('prose only');
  });
});

describe('buildReadinessPrompt — the model can tell a blocker from a warning', () => {
  it('labels every gap with its severity', () => {
    const prompt = buildReadinessPrompt({
      score: 12,
      gaps: [gap('no_verified_channel', 'blocker'), gap('stale_items', 'warning')],
    });
    expect(prompt).toContain('no_verified_channel (blocker)');
    expect(prompt).toContain('stale_items (warning)');
  });

  it('carries the consequence sentence into the prompt, for warnings as well as blockers', () => {
    // The model cannot preserve a consequence it was never given. This is the
    // precondition for the system instruction's rule to be satisfiable at all —
    // and it has to hold for the warning too, since that is the case the
    // severity-based rule got wrong.
    const blocker = buildReadinessPrompt({ score: 12, gaps: [gap('no_verified_channel', 'blocker')] });
    expect(blocker).toContain('reads that silence as inactivity');

    const warning = buildReadinessPrompt({ score: 92, gaps: [gap('contact_key_unconfirmed', 'warning')] });
    expect(warning).toContain('cannot be given a share of your release');
  });

  it('sends no free text beyond the closed codes and their own templates', () => {
    // The metadata boundary, from the prompt side: a gap contributes its code, its
    // severity, an optional tier and numeric detail — nothing owner-authored.
    const prompt = buildReadinessPrompt({
      score: 40,
      gaps: [{ code: 's2_coverage_insufficient', severity: 'blocker', tier: 's2', detail: { assigned: 1, needed: 2 } }],
    });
    expect(prompt).toContain('s2_coverage_insufficient (blocker, s2)');
    expect(prompt).toContain('{"assigned":1,"needed":2}');
  });
});

describe('the deterministic fallback is what ships when the model is unavailable', () => {
  // The fallback is not a lesser path — it is what every opted-out, breaker-tripped
  // or AI-disabled owner reads. It must carry the consequence unconditionally,
  // since no model is involved to drop it.
  it('every gap code has a template, and blockers lead', () => {
    for (const code of READINESS_GAP_CODES) {
      expect(templateExplanation(gap(code, 'blocker'))).toBeTruthy();
    }
    const text = deterministicReadinessExplanation({
      score: 12,
      gaps: [gap('stale_items', 'warning'), gap('no_verified_channel', 'blocker')],
    });
    // Blocker first, regardless of input order.
    expect(text.indexOf('no verified way')).toBeLessThan(text.indexOf('not been updated'));
    expect(text).toContain('reads that silence as inactivity');
  });
});
