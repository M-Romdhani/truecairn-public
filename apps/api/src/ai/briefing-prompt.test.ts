import { describe, expect, it } from 'vitest';
import {
  BRIEFING_SYSTEM_INSTRUCTION,
  buildBriefingPrompt,
  type BriefingInputs,
} from './briefing-prompt.js';

const INPUTS: BriefingInputs = {
  engineState: 'active',
  previousState: 'pre_active',
  nextActionAt: '2026-07-01T00:00:00.000Z',
  inactivityThresholdDays: 30,
  vaultItemCount: 3,
  contactCount: 2,
  enrolledContactCount: 1,
  pendingContactCount: 1,
};

describe('buildBriefingPrompt — zero-knowledge boundary', () => {
  it('renders the safe metadata values', () => {
    const p = buildBriefingPrompt(INPUTS);
    expect(p).toContain('engine state: active');
    expect(p).toContain('vault items stored: 3');
    expect(p).toContain('enrolled/verified: 1');
    expect(p).toContain('pending: 1');
  });

  it('pins the product positioning — digital continuity, never "dead man\'s switch"', () => {
    const s = BRIEFING_SYSTEM_INSTRUCTION.toLowerCase();
    // Positioning rule: the briefing model is told to describe the product as a
    // digital continuity platform, never with the "dead man's switch" framing.
    expect(s).toContain('digital continuity platform');
    expect(s).toContain('never as a "dead man\'s switch"');
  });

  // The real guard is the BriefingInputs TYPE (no ciphertext/PII field exists, so
  // none can be rendered). This test documents and locks that intent: neither the
  // prompt nor the static system instruction may carry a secret-shaped token.
  it('never contains secret-shaped tokens (the prompt is metadata-only)', () => {
    const haystack = (buildBriefingPrompt(INPUTS) + ' ' + BRIEFING_SYSTEM_INSTRUCTION).toLowerCase();
    for (const forbidden of [
      'ciphertext',
      'passphrase',
      'private key',
      'wrappedshare',
      'recovery code',
      'titlecipher',
      'displaylabel',
    ]) {
      expect(haystack).not.toContain(forbidden);
    }
  });
});
