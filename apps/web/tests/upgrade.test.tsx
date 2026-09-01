import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Upgrade } from '../src/screens/plans/Upgrade.js';

// The dedicated /upgrade page (task 4): a back-to-vault arrow, a monthly/yearly
// switch that drives both the displayed price and the checkout it opens, and the
// active state for a user already on Personal.

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(billing: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      const s = String(u);
      if (s.endsWith('/v1/billing/status')) return json(billing);
      const m = s.match(/\/v1\/billing\/checkout\/(\w+)$/);
      if (m) return json({ url: `https://store.lemonsqueezy.com/checkout/buy/${m[1]}?x=1` });
      return json({});
    }),
  );
}

function renderUpgrade(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Upgrade />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Upgrade page', () => {
  it('has a back-to-vault arrow', () => {
    stub({ plan: 'free', status: null, renewsAt: null, endsAt: null });
    renderUpgrade();
    expect(screen.getByTestId('upgrade-back')).toHaveAttribute('href', '/vault');
  });

  it('defaults to yearly pricing and shows the savings', () => {
    stub({ plan: 'free', status: null, renewsAt: null, endsAt: null });
    renderUpgrade();
    // Yearly default: $80/12 = $6.67/mo effective, and the billed-yearly note.
    expect(screen.getByText('$6')).toBeInTheDocument();
    expect(screen.getByText('.67')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-personal-sub')).toHaveTextContent(/\$80 billed yearly/);
  });

  it('switching to Monthly shows the monthly rate', async () => {
    stub({ plan: 'free', status: null, renewsAt: null, endsAt: null });
    renderUpgrade();
    await userEvent.click(screen.getByRole('button', { name: /monthly/i }));
    expect(screen.getByText('$8')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-personal-sub')).toHaveTextContent(/\$8 billed monthly/);
  });

  it('opens the ANNUAL checkout by default, the MONTHLY one after switching', async () => {
    stub({ plan: 'free', status: null, renewsAt: null, endsAt: null });
    const hrefs: string[] = [];
    vi.stubGlobal('location', {
      get href() {
        return '';
      },
      set href(v: string) {
        hrefs.push(v);
      },
    } as unknown as Location);
    renderUpgrade();

    await userEvent.click(screen.getByTestId('upgrade-checkout'));
    await waitFor(() => expect(hrefs.some((h) => h.includes('/checkout/buy/pro_annual'))).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: /monthly/i }));
    await userEvent.click(screen.getByTestId('upgrade-checkout'));
    await waitFor(() => expect(hrefs.some((h) => h.includes('/checkout/buy/pro_monthly'))).toBe(true));
  });

  it('pro plan: shows the current-plan state instead of a checkout button', async () => {
    stub({ plan: 'pro', status: 'active', renewsAt: '2026-09-01T00:00:00.000Z', endsAt: null });
    renderUpgrade();
    await waitFor(() => expect(screen.getByTestId('current-pro')).toBeInTheDocument());
    expect(screen.queryByTestId('upgrade-checkout')).toBeNull();
    expect(screen.getByTestId('upgrade-renews')).toHaveTextContent(/renews/i);
  });
});
