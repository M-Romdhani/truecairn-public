import { describe, expect, it } from 'vitest';
import { ASSIST_SYSTEM_INSTRUCTION, buildAssistPrompt } from './assist-prompt.js';
import type { BriefingInputs } from './briefing-prompt.js';

const META: BriefingInputs = {
  engineState: 'active',
  previousState: null,
  nextActionAt: null,
  inactivityThresholdDays: 30,
  vaultItemCount: 2,
  contactCount: 3,
  enrolledContactCount: 1,
  pendingContactCount: 2,
};

describe('assist-prompt', () => {
  it('includes the user question and the safe metadata context', () => {
    const p = buildAssistPrompt('How do I add a recovery contact?', META);
    expect(p).toContain('How do I add a recovery contact?');
    expect(p).toContain('vault items: 2');
    expect(p).toContain('enrolled: 1, pending: 2');
  });

  it('works without metadata (e.g. an invited contact asking what they are agreeing to)', () => {
    const p = buildAssistPrompt('What am I agreeing to?', null);
    expect(p).toContain('What am I agreeing to?');
    expect(p).not.toContain('vault items');
  });

  it('the system instruction carries the no-secrets guardrail', () => {
    const s = ASSIST_SYSTEM_INSTRUCTION.toLowerCase();
    expect(s).toContain('never');
    expect(s).toMatch(/passphrase|secret|recovery code/);
  });

  it('distinguishes S2 (optional passphrase) from S3 (mandatory passphrase) — audit F-1', () => {
    const s = ASSIST_SYSTEM_INSTRUCTION.toLowerCase();
    // S2: the release passphrase is an OPTIONAL fallback — 2 diverse-role contacts
    // reconstruct WITHOUT it.
    expect(s).toContain('optional fallback');
    expect(s).toContain('without it');
    // S3 (nested, docs/24): the passphrase is MANDATORY; losing it makes S3
    // permanently unrecoverable. The prompt must NOT claim S3 survives without it,
    // and must not carry the stale "3-of-4 for S3" threshold. Pin the corrected
    // facts so the prompt can't silently regress to the old (false) claim.
    expect(s).toContain('mandatory');
    expect(s).toContain('permanently unrecoverable');
    expect(s).not.toContain('3-of-4');
    // The server can never reset/recover a passphrase (zero-knowledge).
    expect(s).toContain('cannot reset');
  });

  it('pins the engine-arming requirement — ONE enrolled contact, not three (QA Finding 2)', () => {
    const s = ASSIST_SYSTEM_INSTRUCTION.toLowerCase();
    // The assistant told a user they need three enrolled contacts to start the
    // engine, contradicting the Engine page (one enrolled contact suffices to arm).
    // Pin the corrected fact: arming needs one enrolled contact; 2/3 are RELEASE
    // reconstruction thresholds, not arming.
    expect(s).toContain('arming');
    expect(s).toMatch(/one enrolled contact|at least one enrolled/);
    expect(s).toContain('never to how many contacts are');
  });

  it('refers users to the in-app User Guide for step-by-step walkthroughs', () => {
    const s = ASSIST_SYSTEM_INSTRUCTION.toLowerCase();
    // The assistant should be able to hand off to the full guide rather than
    // reproducing it inline (the guide is the long-form source of truth).
    expect(s).toContain('user guide');
  });

  it('pins the product positioning — digital continuity, never "dead man\'s switch"', () => {
    const s = ASSIST_SYSTEM_INSTRUCTION.toLowerCase();
    // Positioning rule: the assistant must describe the product as a digital
    // continuity platform and must be explicitly told not to adopt the
    // "dead man's switch" framing, even when a user uses it first.
    expect(s).toContain('digital continuity platform');
    expect(s).toContain('never call it a "dead man\'s switch"');
  });

  it('names the three distinct secrets — passkey, master passphrase, release passphrase (audit M1)', () => {
    const s = ASSIST_SYSTEM_INSTRUCTION.toLowerCase();
    // The assistant previously denied a separate master passphrase existed,
    // conflating "unlock" with day-to-day sign-in. Pin the three-secret model so it
    // can't regress: passkey (sign in) ≠ master passphrase (unlock) ≠ release
    // passphrase (ceremony).
    expect(s).toContain('passkey');
    expect(s).toContain('master passphrase');
    expect(s).toContain('release passphrase');
    expect(s).toContain('unlock');
    expect(s).toContain('recovery code');
  });
});
