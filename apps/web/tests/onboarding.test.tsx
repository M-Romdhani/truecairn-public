import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { decodeKeyMaterial, lock, unlock, withTierKey } from '@truecairn/client-crypto';
import { validateTierKeyCheck } from '@truecairn/keys';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '../src/crypto/session.js';
import { Onboarding } from '../src/screens/Onboarding.js';

// The enrollment ceremony, end-to-end in the component gate: a user picks a
// passphrase, the component generates real key material, uploads it (mock API),
// shows the recovery code, and unlocks. We capture the uploaded material and
// prove it actually unlocks + its tier keys validate — so the screen really
// provisions a working account, not just a happy-looking form.

afterEach(() => {
  lock();
  vi.restoreAllMocks();
});

function StatusProbe(): JSX.Element {
  const { status } = useSession();
  return <span data-testid="lock-status">{status}</span>;
}

describe('Onboarding ceremony', () => {
  it('provisions real key material, shows the recovery code, and unlocks the vault', async () => {
    let uploaded: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      uploaded = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ provisioned: true, userId: 'uid-ob' }), { status: 201 });
    }) as unknown as typeof fetch;

    render(
      <MemoryRouter>
        <SessionProvider>
          <StatusProbe />
          <Onboarding fetchImpl={fetchImpl} />
        </SessionProvider>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Begin' }));
    const pass = screen.getByLabelText('Master passphrase');
    const confirm = screen.getByLabelText('Confirm passphrase');
    await userEvent.type(pass, 'correct horse battery');
    await userEvent.type(confirm, 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // The ceremony completes: the recovery code is shown and the vault is unlocked.
    await waitFor(() => expect(screen.getByLabelText('recovery code')).toBeInTheDocument(), {
      timeout: 20_000,
    });
    expect(screen.getByTestId('lock-status')).toHaveTextContent('unlocked');

    // The passphrase field was cleared (PHASE4 §a — no lingering plaintext).
    expect((pass as HTMLInputElement).value).toBe('');

    // What was uploaded is REAL, usable key material: decode it, unlock a fresh
    // session with the same passphrase, and confirm every tier key validates.
    expect(uploaded).not.toBeNull();
    const fetched = decodeKeyMaterial(uploaded as never);
    expect(fetched.tierKeys).toHaveLength(3);
    lock(); // drop the ceremony's session, then unlock a fresh one with the upload
    unlock(new TextEncoder().encode('correct horse battery'), fetched);
    for (const t of fetched.tierKeys) {
      const ok = withTierKey(t.tier, (tk) =>
        validateTierKeyCheck(
          tk,
          {
            plaintext: t.tierKeyCheckPlaintext,
            ciphertext: t.tierKeyCheckCiphertext,
            nonce: t.tierKeyCheckNonce,
          },
          t.generation,
        ),
      );
      expect(ok).toBe(true);
    }
  });

  it('rejects a too-short or mismatched passphrase before doing any crypto', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <MemoryRouter>
        <SessionProvider>
          <Onboarding fetchImpl={fetchImpl} />
        </SessionProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Begin' }));
    await userEvent.type(screen.getByLabelText('Master passphrase'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
