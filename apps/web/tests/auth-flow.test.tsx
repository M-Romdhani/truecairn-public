import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encodeKeyMaterial, generateEnrollmentMaterial, lock } from '@truecairn/client-crypto';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { SessionProvider } from '../src/crypto/session.js';

// The WebAuthn ceremony needs a real authenticator (Playwright E2E covers it); in
// the jsdom gate we mock @simplewebauthn/browser and assert the ORCHESTRATION —
// the right endpoints, in the right order, with the routing that follows.
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(async () => ({ id: 'cred-1', type: 'public-key' })),
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', type: 'public-key' })),
}));

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  lock();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderApp(path: string): ReturnType<typeof render> {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider> as ReactElement,
  );
}

describe('passkey registration flow', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith('/v1/auth/register/options')) return json({ options: { challenge: 'a' }, challengeId: 'c1' });
        if (u.endsWith('/v1/auth/register/verify')) return json({ credentialId: 'cid' }, 201);
        if (u.endsWith('/v1/auth/login/options')) return json({ options: { challenge: 'b' }, challengeId: 'c2' });
        if (u.endsWith('/v1/auth/login/verify')) return json({ userId: 'u1' });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
  });

  it('registers, logs in, and lands in the onboarding ceremony', async () => {
    renderApp('/register');
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Set up Truecairn' })).toBeInTheDocument(),
    );
  });
});

describe('login → unlock flow', () => {
  it('fetches key material and unlocks the vault with the passphrase', async () => {
    const { material } = generateEnrollmentMaterial(utf8('pw-unlock'));
    const dto = encodeKeyMaterial(material);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/account/me')) return json({ email: 'own@example.com' });
        if (String(url).endsWith('/v1/account/key-material')) return json({ userId: 'u1', ...dto });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderApp('/unlock');
    await userEvent.type(screen.getByLabelText('Master passphrase'), 'pw-unlock');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(screen.getByTestId('lock-status')).toHaveTextContent('unlocked'), {
      timeout: 20_000,
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your vault' })).toBeInTheDocument());
  });

  it('rejects a wrong passphrase without unlocking', async () => {
    const { material } = generateEnrollmentMaterial(utf8('the-right-one'));
    const dto = encodeKeyMaterial(material);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/account/me')) return json({ email: 'own@example.com' });
        if (String(url).endsWith('/v1/account/key-material')) return json({ userId: 'u1', ...dto });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderApp('/unlock');
    await userEvent.type(screen.getByLabelText('Master passphrase'), 'the-wrong-one');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument(), { timeout: 20_000 });
    expect(screen.getByTestId('lock-status')).toHaveTextContent('locked');
  });

  it('routes a signed-out visitor to sign-in on arrival, before any passphrase (audit B3)', async () => {
    // A signed-out/expired session used to sit on the unlock form until the user
    // typed their passphrase, waited out the KDF, and got a 401. The mount probe
    // (the key-material bootstrap fetch) detects the dead session and re-routes
    // immediately.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/account/key-material'))
          return json({ title: 'Unauthorized', status: 401 }, 401);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderApp('/unlock');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('routes an ORPHAN (registered, never provisioned) back to onboarding, not a dead-end passphrase prompt (QA 2026-07-17 #4)', async () => {
    // An outage mid-onboarding can leave a passkey with no key material. The
    // unlock screen would demand a passphrase that never existed; the mount
    // probe sees the 404 (= null bootstrap) and resumes setup instead.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/account/key-material'))
          return json({ title: 'Not Found', status: 404 }, 404);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderApp('/unlock');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Set up Truecairn' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('routes to sign-in — not a passphrase error — when the session dies mid-unlock (audit B3)', async () => {
    // The probe passed (key material exists) but the session expired before
    // submit: the submit-time key-material fetch 401s BEFORE the passphrase is
    // ever tried, so blaming the passphrase would be wrong. Route to
    // re-authentication instead.
    const { material } = generateEnrollmentMaterial(utf8('pw-midway'));
    const dto = encodeKeyMaterial(material);
    let keyMaterialCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/account/key-material')) {
          keyMaterialCalls += 1;
          // Mount probe succeeds; the session is dead by the submit fetch.
          if (keyMaterialCalls === 1) return json({ userId: 'u1', ...dto });
          return json({ title: 'Unauthorized', status: 401 }, 401);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderApp('/unlock');
    await userEvent.type(screen.getByLabelText('Master passphrase'), 'any-passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
