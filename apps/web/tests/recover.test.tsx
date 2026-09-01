import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KeyMaterial } from '@truecairn/client-crypto';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchKeyMaterial } from '../src/account/keyMaterial.js';
import { SessionProvider } from '../src/crypto/session.js';
import { Recover } from '../src/screens/Recover.js';
import { Unlock } from '../src/screens/Unlock.js';

// Redeeming the recovery code (QA 2026-08-26 F2).
//
// Before this screen existed the code had NO redemption path at all:
// `unlockWithRecovery` was implemented and exercised by
// packages/client-crypto/src/interop.test.ts, but nothing in the product called
// it and no route reached it. The code was issued, shown once, "save this", and
// then unusable — so forgetting the passphrase lost the vault outright.
//
// Same mocking shape as unlock-memory.test.tsx: fetchKeyMaterial is stubbed so
// the screen reaches derivation without a server, and client-crypto's
// `unlockWithRecovery` is replaced so failures are injected rather than provoked.

vi.mock('../src/account/keyMaterial.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/account/keyMaterial.js')>()),
  fetchKeyMaterial: vi.fn(),
}));
const fetchMock = vi.mocked(fetchKeyMaterial);

const recoveryMock = vi.fn();
vi.mock('@truecairn/client-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@truecairn/client-crypto')>()),
  unlockWithRecovery: (...args: unknown[]) => recoveryMock(...args),
}));

const MATERIAL = {} as KeyMaterial;
// 64 hex characters — the shape Onboarding renders.
const VALID_CODE = 'a'.repeat(64);

beforeEach(() => {
  fetchMock.mockResolvedValue({ material: MATERIAL, userId: 'u1' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  recoveryMock.mockReset();
});

function mountRecover(): void {
  render(
    <MemoryRouter initialEntries={['/recover']}>
      <SessionProvider>
        <Recover />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function submit(code: string): Promise<void> {
  mountRecover();
  await userEvent.type(screen.getByLabelText('Recovery code'), code);
  await userEvent.click(screen.getByRole('button', { name: 'Unlock vault' }));
}

describe('Recover: the code opens the vault', () => {
  it('derives with the typed code and unlocks', async () => {
    await submit(VALID_CODE);
    await waitFor(() => expect(recoveryMock).toHaveBeenCalledTimes(1));
    // 32 bytes, not the 64-character string.
    const passed = recoveryMock.mock.calls[0]?.[0] as Uint8Array;
    expect(passed).toBeInstanceOf(Uint8Array);
    expect(passed.length).toBe(32);
  });

  it('accepts a code pasted with spaces and line breaks', async () => {
    // People write this on paper and type it back in groups. A space is not a
    // typo, and rejecting one would be the screen inventing a failure.
    const spaced = `${'a'.repeat(32)}  ${'a'.repeat(32)}`;
    await submit(spaced);
    await waitFor(() => expect(recoveryMock).toHaveBeenCalledTimes(1));
  });
});

describe('Recover: the code never leaves the device', () => {
  it('makes no network call carrying the code', async () => {
    // The zero-knowledge invariant for this screen. The ONLY request it may make
    // is the same wrapped-key-material fetch /unlock makes; the code itself is
    // used purely to derive a KEK locally. A future edit that "verifies" the
    // code server-side would hand us the one secret that opens the vault.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await submit(VALID_CODE);
    await waitFor(() => expect(recoveryMock).toHaveBeenCalled());
    for (const call of fetchSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(VALID_CODE);
    }
  });
});

describe('Recover: the three failures stay distinct', () => {
  // A typo you can fix, and a code that is not yours, are very different news.
  it('rejects a malformed code WITHOUT deriving', async () => {
    await submit('not-a-recovery-code');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('does not look like a recovery code');
    // The point of validating first: never tell someone their saved code is
    // wrong when they simply mistyped it a moment ago.
    expect(alert).not.toHaveTextContent('did not unlock this vault');
    expect(recoveryMock).not.toHaveBeenCalled();
  });

  // 63 and 65 as separate cases so testing-library's afterEach cleanup runs
  // between them — re-rendering inside one test leaves two screens mounted and
  // every getByRole finds a pair.
  it.each([63, 65])('rejects %i characters as a format error, not a wrong code', async (len) => {
    await submit('a'.repeat(len));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'does not look like a recovery code',
    );
    expect(recoveryMock).not.toHaveBeenCalled();
  });

  it('rejects non-hex letters that parseInt would silently accept', async () => {
    // hexToBytes is lenient: Number.parseInt('0z', 16) is 0, not NaN. Without
    // the regex this would derive the WRONG bytes and surface as "that code did
    // not unlock this vault" — telling a user their saved code is bad when the
    // real problem was a slip they could have corrected.
    await submit(`0z${'a'.repeat(62)}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'does not look like a recovery code',
    );
    expect(recoveryMock).not.toHaveBeenCalled();
  });

  it('reports a well-formed but wrong code as a wrong code', async () => {
    recoveryMock.mockImplementation(() => {
      throw new Error('wrong secret key for the given ciphertext');
    });
    await submit(VALID_CODE);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('did not unlock this vault');
    expect(alert).not.toHaveTextContent('ran out of memory');
  });

  it('names an out-of-memory KDF instead of blaming the code', async () => {
    // Worse here than on /unlock: someone told their correct recovery code is
    // wrong has no third credential left to reach for.
    recoveryMock.mockImplementation(() => {
      throw new RangeError('Out of memory');
    });
    await submit(VALID_CODE);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ran out of memory');
    expect(alert).toHaveTextContent('your recovery code was not the problem');
    expect(alert).not.toHaveTextContent('did not unlock this vault');
  });

  it('re-enables the form after a failure so a retry is possible', async () => {
    recoveryMock.mockImplementation(() => {
      throw new RangeError('Out of memory');
    });
    await submit(VALID_CODE);
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeEnabled();
  });
});

describe('Recover: it says what it does not do', () => {
  it('tells the user the passphrase is unchanged', async () => {
    // Recovery unlocks; it does not re-key. Leaving that unsaid would let
    // someone believe they no longer need the code.
    mountRecover();
    expect(screen.getByText(/does not change your passphrase/i)).toBeInTheDocument();
  });
});

describe('Unlock: the recovery route is discoverable (F2)', () => {
  it('links to /recover without needing a failed attempt first', async () => {
    // The original finding: /unlock never mentioned that a recovery code
    // existed. Someone who has forgotten their passphrase may never type a
    // wrong one — they just stop. So the link must be present on arrival.
    render(
      <MemoryRouter initialEntries={['/unlock']}>
        <SessionProvider>
          <Unlock />
        </SessionProvider>
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'Use your recovery code' });
    expect(link).toHaveAttribute('href', '/recover');
  });
});
