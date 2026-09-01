import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateEnrollmentMaterial, isUnlocked, lock, type KeyMaterial } from '@truecairn/client-crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SessionProvider, useSession } from '../src/crypto/session.js';

// One enrollment (production Argon2id) shared across the file; the material is
// ciphertext-only and reusable. Each unlock re-encodes the passphrase fresh.
let material: KeyMaterial;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

beforeAll(() => {
  material = generateEnrollmentMaterial(utf8('pw-session')).material;
});
afterEach(() => {
  lock();
});

function Harness(): JSX.Element {
  const s = useSession();
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="uid">{s.userId ?? 'none'}</span>
      <button type="button" onClick={() => s.unlock(utf8('pw-session'), material, 'uid-1')}>
        unlock
      </button>
      <button type="button" onClick={() => s.lock()}>
        lock
      </button>
    </div>
  );
}

describe('SessionProvider', () => {
  it('starts locked, reflects unlock (status + userId), and locks again', async () => {
    render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    expect(screen.getByTestId('status')).toHaveTextContent('locked');
    expect(screen.getByTestId('uid')).toHaveTextContent('none');

    await userEvent.click(screen.getByText('unlock')); // runs Argon2id
    expect(screen.getByTestId('status')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('uid')).toHaveTextContent('uid-1');

    await userEvent.click(screen.getByText('lock'));
    expect(screen.getByTestId('status')).toHaveTextContent('locked');
    expect(screen.getByTestId('uid')).toHaveTextContent('none');
  });

  it('locks on pagehide, so a bfcache-restored page cannot come back unlocked', async () => {
    render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    await userEvent.click(screen.getByText('unlock')); // runs Argon2id
    expect(screen.getByTestId('status')).toHaveTextContent('unlocked');

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(screen.getByTestId('status')).toHaveTextContent('locked');
    expect(isUnlocked()).toBe(false);
  });

  it('wipes the master key when the provider unmounts (leaving the authed app)', async () => {
    const { unmount } = render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    await userEvent.click(screen.getByText('unlock')); // runs Argon2id
    expect(isUnlocked()).toBe(true);

    unmount();
    expect(isUnlocked()).toBe(false);
  });
});
