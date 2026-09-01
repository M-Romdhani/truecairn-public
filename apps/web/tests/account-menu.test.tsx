import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lock } from '@truecairn/client-crypto';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from '../src/components/AccountMenu.js';
import { SessionProvider } from '../src/crypto/session.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface StubAccount {
  email: string;
  displayName: string | null;
  title: string | null;
  plan: 'free' | 'pro';
}

function stubFetch(account?: Partial<StubAccount>): ReturnType<typeof vi.fn> {
  const acc: StubAccount = {
    email: 'jane.doe@example.com',
    displayName: null,
    title: null,
    plan: 'free',
    ...account,
  };
  const f = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/v1/account/me'))
      return json({ email: acc.email, displayName: acc.displayName, title: acc.title });
    if (u.endsWith('/v1/billing/status'))
      return json({ plan: acc.plan, status: null, renewsAt: null, endsAt: null });
    if (u.endsWith('/v1/auth/logout')) return json({});
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}

function renderMenu(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionProvider>
          <AccountMenu />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  lock();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sidebar account menu', () => {
  it('shows real initials and the lock status on the trigger (no hardcoded "TC")', async () => {
    stubFetch();
    renderMenu();
    // Lock status is always present on the trigger (E2E hook).
    expect(screen.getByTestId('lock-status')).toHaveTextContent('locked');
    // Initials derive from the real email once it loads — "jane.doe" → "JD".
    await waitFor(() => expect(screen.getAllByText('JD').length).toBeGreaterThan(0));
    expect(screen.queryByText('TC')).toBeNull();
  });

  it('shows the display name (with honorific) and plan tier on the trigger', async () => {
    stubFetch({ displayName: 'Jane Doe', title: 'Mrs.', plan: 'pro' });
    renderMenu();
    // The chip shows "Mrs. Jane Doe" and the paid plan tier "Personal".
    await waitFor(() => expect(screen.getByText('Mrs. Jane Doe')).toBeInTheDocument());
    expect(screen.getByText('Personal')).toBeInTheDocument();
    // The lock-status hook still carries exactly the status word.
    expect(screen.getByTestId('lock-status')).toHaveTextContent('locked');
    // Initials now derive from the name, not the email.
    expect(screen.getAllByText('JD').length).toBeGreaterThan(0);
  });

  it('falls back to "Your account" and the Free tier when no name/plan is set', async () => {
    stubFetch();
    renderMenu();
    await waitFor(() => expect(screen.getByText('Free')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /your account/i })).toBeInTheDocument();
  });

  it('opens on click and reveals the email and menu items', async () => {
    stubFetch();
    renderMenu();
    const trigger = screen.getByRole('button', { name: /your account/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Closed: the email (popover-only) is not mounted.
    expect(screen.queryByTestId('account-email')).toBeNull();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await waitFor(() =>
      expect(screen.getByTestId('account-email')).toHaveTextContent('jane.doe@example.com'),
    );
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('menuitem', { name: 'Plans' })).toHaveAttribute('href', '/plans');
    expect(screen.getByRole('menuitem', { name: 'User guide' })).toHaveAttribute('href', '/guide');
  });

  it('has no Language row (2026 design: no fake switcher, not even a disabled one)', async () => {
    stubFetch();
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /your account/i }));
    await waitFor(() => expect(screen.getByTestId('account-email')).toBeInTheDocument());
    expect(screen.queryByText('Language')).toBeNull();
    // The menu is exactly the designed set: three links + sign out.
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Settings',
      'Plans',
      'User guide',
      'Sign out',
    ]);
  });

  it('closes on Escape', async () => {
    stubFetch();
    renderMenu();
    const trigger = screen.getByRole('button', { name: /your account/i });
    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('account-email')).toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('account-email')).toBeNull());
  });

  it('signs out from the sidebar without visiting Settings', async () => {
    const f = stubFetch();
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: /your account/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));
    await waitFor(() =>
      expect(f.mock.calls.some((c) => String(c[0]).endsWith('/v1/auth/logout'))).toBe(true),
    );
  });
});
