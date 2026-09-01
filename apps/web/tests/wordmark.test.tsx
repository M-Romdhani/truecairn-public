import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Wordmark } from '../src/components/Wordmark.js';

describe('Wordmark', () => {
  it('reads as a single "TrueCairn" name with the "ai" accented', () => {
    const { container } = render(<Wordmark />);
    // Whole wordmark reads correctly regardless of the internal span split.
    expect(container.textContent).toBe('TrueCairn');
    // The "ai" is the accented span (brand blue via .wm-ai), not the rest.
    const ai = container.querySelector('.wm-ai');
    expect(ai?.textContent).toBe('ai');
  });
});
