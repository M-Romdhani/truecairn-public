import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionAccount } from '../src/onboarding/enroll.js';
import { SessionProvider } from '../src/crypto/session.js';
import { Onboarding } from '../src/screens/Onboarding.js';

// The enrollment FAILURE path (deployed-QA blocker). The screen used to wipe
// both passphrase inputs BEFORE provisioning; when provisioning then failed
// (KDF out of memory in a constrained browser, a failed POST), the user faced
// silently-emptied fields and the next Continue click reported the false
// "at least 8 characters" error with no network request — indistinguishable
// from broken validation. These tests pin the recovery behaviour: a failure
// keeps the typed values, tells the truth, and retry re-runs provisioning.
//
// provisionAccount is mocked — the real one runs two production-memlimit
// Argon2id derivations per click, and this file exercises submits repeatedly.
vi.mock('../src/onboarding/enroll.js', () => ({
  provisionAccount: vi.fn(),
}));
const provisionMock = vi.mocked(provisionAccount);

const PHRASE = 'correct horse battery'; // ≥ 8 chars, matching in both fields

beforeEach(() => {
  // The component console.errors the underlying cause; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  provisionMock.mockReset();
});

async function renderAndSubmit(): Promise<{ pass: HTMLInputElement; confirm: HTMLInputElement }> {
  render(
    <MemoryRouter>
      <SessionProvider>
        <Onboarding />
      </SessionProvider>
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Begin' }));
  const pass = screen.getByLabelText('Master passphrase') as HTMLInputElement;
  const confirm = screen.getByLabelText('Confirm passphrase') as HTMLInputElement;
  await userEvent.type(pass, PHRASE);
  await userEvent.type(confirm, PHRASE);
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  return { pass, confirm };
}

describe('Onboarding provisioning failure', () => {
  it('keeps the typed passphrases and reports the failure honestly', async () => {
    provisionMock.mockRejectedValue(new Error('boom'));
    const { pass, confirm } = await renderAndSubmit();

    // The honest message — NOT the false validation error.
    expect(screen.getByRole('alert')).toHaveTextContent('could not complete setup');
    expect(screen.getByRole('alert')).not.toHaveTextContent('at least 8');

    // The typed values survive for the retry.
    expect(pass.value).toBe(PHRASE);
    expect(confirm.value).toBe(PHRASE);
  });

  it('retries provisioning on the next Continue instead of failing validation', async () => {
    provisionMock.mockRejectedValue(new Error('boom'));
    await renderAndSubmit();
    expect(provisionMock).toHaveBeenCalledTimes(1);

    // The QA agent's second click: it must re-run provisioning (fields intact),
    // never report the min-length error against a passphrase the user typed.
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(provisionMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).not.toHaveTextContent('at least 8');
  });

  it('names the out-of-memory case so a constrained browser is actionable', async () => {
    // Emscripten/libsodium heap-growth failures surface as RangeErrors or
    // "Cannot enlarge memory"-style messages.
    provisionMock.mockRejectedValue(new RangeError('Out of memory'));
    await renderAndSubmit();
    expect(screen.getByRole('alert')).toHaveTextContent('enough memory');
  });
});
