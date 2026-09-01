import { render, screen } from '@testing-library/react';
import { bytesToHex, randomBytes } from '@truecairn/crypto';
import { describe, expect, it } from 'vitest';

// Proves the component gate itself before any app code rides on it: jsdom + RTL
// render a component, AND the crypto initialised in setup.ts works in this
// environment (so the crypto-session tests that follow are trustworthy).
describe('component-test harness', () => {
  it('renders a React component into the simulated DOM', () => {
    render(<div role="status">truecairn</div>);
    expect(screen.getByRole('status')).toHaveTextContent('truecairn');
  });

  it('has working crypto in the jsdom environment (Node loader)', () => {
    const a = randomBytes(16);
    expect(bytesToHex(a)).toHaveLength(32);
  });
});
