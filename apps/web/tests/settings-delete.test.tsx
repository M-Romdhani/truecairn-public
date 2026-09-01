import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateEnrollmentMaterial, lock, type KeyMaterial } from '@truecairn/client-crypto';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '../src/crypto/session.js';
import { Settings } from '../src/screens/settings/Settings.js';

// Account deletion from Settings (QA Pass 3 Finding C): type-to-confirm gates the
// button, and a successful request shows the pending banner. The session must be
// UNLOCKED (the step-up signature needs the in-memory key), so the harness does a
// real unlock first — same pattern as session.test.tsx.

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let material: KeyMaterial;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

beforeAll(() => {
  material = generateEnrollmentMaterial(utf8('pw-settings')).material;
});
afterEach(() => {
  lock();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Settings' read queries use the global fetch; only the delete mutation takes
// the injected fetchImpl.
function stubGlobalFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1/account/me')) return json({ email: 'owner@example.com' });
      if (u.endsWith('/v1/account/ai-settings')) return json({ optOut: false });
      if (u.endsWith('/v1/account/ai-autonomy')) return json({ enabled: false, checkinFloorDays: null });
      if (u.endsWith('/v1/settings/channels')) return json({ channels: [] });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

function UnlockButton(): JSX.Element {
  const s = useSession();
  return (
    <button type="button" onClick={() => s.unlock(utf8('pw-settings'), material, 'uid-1')}>
      unlock-harness
    </button>
  );
}

function renderSettings(fetchImpl: typeof fetch): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionProvider>
          <UnlockButton />
          <Settings proveSecondFactor={() => Promise.resolve()} fetchImpl={fetchImpl} />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings — delete account (QA Pass 3 Finding C)', () => {
  it('keeps the button disabled until the exact word DELETE is typed', async () => {
    stubGlobalFetch();
    renderSettings(vi.fn() as unknown as typeof fetch);

    const button = screen.getByTestId('delete-account');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByTestId('delete-confirm'), 'delete');
    expect(button).toBeDisabled(); // case-sensitive on purpose
    await userEvent.clear(screen.getByTestId('delete-confirm'));
    await userEvent.type(screen.getByTestId('delete-confirm'), 'DELETE');
    expect(button).toBeEnabled();
  });

  it('requests deletion and shows the 7-day pending banner', async () => {
    stubGlobalFetch();
    const deleteFetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/account/delete'))
        return json({ sensitiveActionId: 'sa-1', effectiveAt: '2026-07-17T00:00:00.000Z' }, 202);
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    renderSettings(deleteFetch);

    await userEvent.click(screen.getByText('unlock-harness')); // runs Argon2id
    await userEvent.type(screen.getByTestId('delete-confirm'), 'DELETE');
    await userEvent.click(screen.getByTestId('delete-account'));

    await waitFor(() =>
      expect(screen.getByTestId('delete-pending')).toHaveTextContent(/deletion pending/i),
    );
    expect(screen.getByTestId('delete-pending')).toHaveTextContent(/cancel it from the Engine page/i);
    expect(deleteFetch).toHaveBeenCalledWith(
      '/v1/account/delete',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
