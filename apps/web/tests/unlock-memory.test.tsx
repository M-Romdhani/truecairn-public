import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KeyMaterial } from '@truecairn/client-crypto';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchKeyMaterial } from '../src/account/keyMaterial.js';
import { SessionProvider } from '../src/crypto/session.js';
import { Unlock } from '../src/screens/Unlock.js';

// The unlock FAILURE path, and specifically the one failure that is NOT the
// user's fault. Deriving the master key runs Argon2id at the production
// memlimit; on a low-memory device, a memory-capped or sandboxed tab, or simply
// with enough other tabs open, that allocation is refused. This screen used to
// let every non-401/403 error fall through to "That passphrase did not unlock
// your vault." — so a user holding the CORRECT passphrase was told it was
// wrong, deterministically, which reads as a lost vault and invites the one
// destructive response (burn the recovery code, or re-enrol over a vault that
// was fine). Onboarding has named this case since enrollment shipped; the fix
// shares that detector (src/crypto/memory.ts) instead of copying it.
//
// fetchKeyMaterial is mocked so the screen reaches the derivation without a
// server, and client-crypto's `unlock` is replaced so the failure is injected
// rather than provoked — the real call would have to genuinely exhaust the
// heap, which is not something a test can ask for reliably.
vi.mock('../src/account/keyMaterial.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/account/keyMaterial.js')>()),
  fetchKeyMaterial: vi.fn(),
}));
const fetchMock = vi.mocked(fetchKeyMaterial);

const unlockMock = vi.fn();
vi.mock('@truecairn/client-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@truecairn/client-crypto')>()),
  unlock: (...args: unknown[]) => unlockMock(...args),
}));

// Opaque to this test: the real `unlock` is never called, so nothing reads it.
const MATERIAL = {} as KeyMaterial;

beforeEach(() => {
  fetchMock.mockResolvedValue({ material: MATERIAL, userId: 'u1' });
  // The component console.errors the underlying cause; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  unlockMock.mockReset();
});

async function submitPassphrase(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/unlock']}>
      <SessionProvider>
        <Unlock />
      </SessionProvider>
    </MemoryRouter>,
  );
  await userEvent.type(screen.getByLabelText('Master passphrase'), 'the-correct-passphrase');
  await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
}

describe('Unlock: an out-of-memory KDF is not a wrong passphrase', () => {
  // WebAssembly.Memory.grow refuses with a RangeError…
  it('names the device memory failure instead of blaming the passphrase', async () => {
    unlockMock.mockImplementation(() => {
      throw new RangeError('Out of memory');
    });
    await submitPassphrase();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('ran out of memory');
    expect(alert).toHaveTextContent('your passphrase was not the problem');
    // The regression itself: the old message must not be what the user sees.
    expect(alert).not.toHaveTextContent('That passphrase did not unlock your vault.');
  });

  // …and Emscripten's allocator refuses with a message instead. Both shapes
  // reach this screen, so both have to be recognised.
  it('recognises the Emscripten heap-growth message too', async () => {
    unlockMock.mockImplementation(() => {
      throw new Error('Cannot enlarge memory arrays');
    });
    await submitPassphrase();
    expect(screen.getByRole('alert')).toHaveTextContent('ran out of memory');
  });

  // The boundary in the other direction: a genuinely wrong passphrase fails the
  // AEAD open, and that must still say so. A detector wide enough to swallow it
  // would trade one wrong message for another.
  it('still reports a wrong passphrase as a wrong passphrase', async () => {
    unlockMock.mockImplementation(() => {
      throw new Error('wrong secret key for the given ciphertext');
    });
    await submitPassphrase();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That passphrase did not unlock your vault.');
    expect(alert).not.toHaveTextContent('ran out of memory');
  });

  // The failure is transient by nature — closing a tab really can fix it — so
  // the button has to come back, not stay stuck on "Unlocking…".
  it('re-enables the form so the retry the message asks for is possible', async () => {
    unlockMock.mockImplementation(() => {
      throw new RangeError('Out of memory');
    });
    await submitPassphrase();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });
});
