import { describe, expect, it } from 'vitest';
import { INVITE_SYSTEM_INSTRUCTION, buildInvitePrompt } from './invite-prompt.js';

describe('invite-prompt', () => {
  it('tailors the prompt to each contact role', () => {
    expect(buildInvitePrompt('personal')).toContain('personal contact');
    expect(buildInvitePrompt('professional')).toContain('professional contact');
    expect(buildInvitePrompt('recovery')).toContain('recovery contact');
  });

  it('the system instruction forbids embedding the invite token, links, or PII', () => {
    const s = INVITE_SYSTEM_INSTRUCTION.toLowerCase();
    expect(s).toMatch(/do not include/);
    expect(s).toContain('invite token'); // the owner adds the one-time token themselves
  });
});
