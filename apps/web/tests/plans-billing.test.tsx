import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Plans } from '../src/screens/plans/Plans.js';

// Truecairn Pro card on the Plans page (billing). Free shows a single "Upgrade"
// link into the dedicated /upgrade page (the checkout itself lives there now);
// pro shows the active state.

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stub(billing: unknown, extra?: (u: string) => Response | undefined): void {
  const plan = (billing as { plan?: string }).plan ?? 'free';
  const pro = plan === 'pro';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      const s = String(u);
      if (s.endsWith('/v1/account/usage'))
        return json({
          plan,
          contacts: { used: 1, limit: pro ? null : 2 },
          vaultItems: { used: 2, limit: pro ? null : 5 },
          storageBytes: { used: 0, limit: pro ? 5 * 1024 * 1024 * 1024 : 10 * 1024 * 1024 },
        });
      if (s.endsWith('/v1/vault/items') || s.includes('/vault')) return json({ items: [] });
      if (s.includes('/contacts')) return json({ contacts: [] });
      if (s.endsWith('/v1/billing/status')) return json(billing);
      const e = extra?.(s);
      if (e) return e;
      // Checkout endpoint
      const m = s.match(/\/v1\/billing\/checkout\/(\w+)$/);
      if (m) return json({ url: `https://store.lemonsqueezy.com/checkout/buy/${m[1]}?x=1` });
      return json({});
    }),
  );
}

function renderPlans(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Plans />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Plans — Truecairn Pro card', () => {
  it('free plan: shows a single Upgrade link into the /upgrade page', async () => {
    stub({ plan: 'free', status: null, renewsAt: null, endsAt: null });
    renderPlans();

    await waitFor(() => expect(screen.getByTestId('subscription-free')).toBeInTheDocument());
    const upgrade = screen.getByTestId('upgrade');
    expect(upgrade).toHaveAttribute('href', '/upgrade');
    // The old dual checkout buttons are gone — that flow moved to /upgrade.
    expect(screen.queryByTestId('upgrade-monthly')).toBeNull();
    expect(screen.queryByTestId('upgrade-annual')).toBeNull();
  });

  it('pro plan: shows the active state with the renewal date', async () => {
    stub({ plan: 'pro', status: 'active', renewsAt: '2026-09-01T00:00:00.000Z', endsAt: null });
    renderPlans();
    await waitFor(() => expect(screen.getByTestId('subscription-pro')).toBeInTheDocument());
    expect(screen.getByTestId('subscription-pro')).toHaveTextContent(/active/i);
    expect(screen.getByTestId('subscription-pro')).toHaveTextContent(/Renews/i);
  });
});
