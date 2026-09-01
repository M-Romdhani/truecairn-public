import { describe, expect, it } from 'vitest';
import { detectSensitiveInput } from '../src/ai/sensitive.js';

describe('detectSensitiveInput', () => {
  it('BLOCKS the actual QA secrets before they leave the device', () => {
    expect(detectSensitiveInput('My master passphrase is QaTest-Truecairn-2026! is it strong?')).toBe(true);
    expect(
      detectSensitiveInput('here is my recovery code 09c89f9a08776ae6e022f50b834174f6af9c5bad0e0b2d65a5f1336c7aa07c03'),
    ).toBe(true);
    expect(detectSensitiveInput('check 09c89f9a08776ae6e022f50b834174f6')).toBe(true);
  });

  it('LETS normal questions through — even ones that mention passphrases', () => {
    expect(detectSensitiveInput('What happens if I lose my release passphrase?')).toBe(false);
    expect(detectSensitiveInput('How many contacts do I need for an S2 release?')).toBe(false);
    expect(detectSensitiveInput('Is my password strong enough in general?')).toBe(false);
    expect(detectSensitiveInput('How does the release ceremony work?')).toBe(false);
    expect(detectSensitiveInput('See https://truecairn.app/help/recovery-code for details')).toBe(false);
  });
});
