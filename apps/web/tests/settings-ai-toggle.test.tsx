import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/crypto/session.js';
import { Settings } from '../src/screens/settings/Settings.js';
import { OFFERED_LOCALES } from '@truecairn/shared';

// The two AI settings are segmented on/off controls, not checkboxes. The state a
// segment claims is carried by aria-pressed, which is what both the screen reader
// and the stylesheet read — so these assertions are the same fact the user sees.

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  url: string;
  body: unknown;
}

function stubFetch(initial: { optOut: boolean; autonomy: boolean }): Sent[] {
  const sent: Sent[] = [];
  const state = { ...initial };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        const body: unknown = init?.body === undefined ? null : JSON.parse(String(init.body));
        sent.push({ url: u, body });
      }
      if (u.endsWith('/v1/account/me')) return json({ email: 'owner@example.com' });
      if (u.endsWith('/v1/account/ai-settings')) return json({ optOut: state.optOut });
      if (u.endsWith('/v1/account/ai-opt-out') && method === 'POST') {
        state.optOut = (JSON.parse(String(init?.body)) as { optOut: boolean }).optOut;
        return json({ optOut: state.optOut });
      }
      if (u.endsWith('/v1/account/ai-autonomy') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        state.autonomy = body.enabled;
        return json({ enabled: state.autonomy, checkinFloorDays: null });
      }
      if (u.endsWith('/v1/account/ai-autonomy'))
        return json({ enabled: state.autonomy, checkinFloorDays: null });
      if (u.includes('/v1/settings/channels/preferences')) return json({ channels: [] });
      if (u.includes('/v1/settings/channels'))
        return json({ channels: [], pushPublicKey: null, plan: 'free', enrollableChannelTypes: ['email'] });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
  return sent;
}

function renderSettings(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionProvider>
          <Settings />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// The "Language" card must not render a heading over nothing.
//
// LanguagePicker returns null while only one language is offered; the section
// wrapping it in Settings used to render regardless, so production showed a
// titled card with an empty body — reported 2026-08-25 as a language setting
// that appeared to be broken. Both sides now ask hasLanguageChoice(), and this
// asserts the RENDERED page rather than the predicate, because the predicate
// being right is not the same as Settings calling it.
describe('Settings — the language section', () => {
  it('renders no Language heading while only one language is offered', () => {
    stubFetch({ optOut: false, autonomy: false });
    renderSettings();
    // Guarded on the real gate: when Spanish (or any second language) is offered
    // this expectation INVERTS rather than becoming wrong, so flipping
    // OFFERED_LOCALES does not leave a stale assertion behind.
    if (OFFERED_LOCALES.length < 2) {
      expect(screen.queryByRole('heading', { name: /language|idioma/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('language-picker')).not.toBeInTheDocument();
    } else {
      expect(screen.getByTestId('language-picker')).toBeInTheDocument();
    }
  });
});

describe('Settings — AI assistance on/off controls', () => {
  it('shows the current state on the pressed segment and sends the flip', async () => {
    const sent = stubFetch({ optOut: false, autonomy: false });
    renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId('ai-opt-out-on')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByTestId('ai-opt-out-off')).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByTestId('ai-opt-out-off'));
    await waitFor(() =>
      expect(screen.getByTestId('ai-opt-out-off')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(sent).toContainEqual({
      url: expect.stringContaining('/v1/account/ai-opt-out') as unknown as string,
      body: { optOut: true },
    });
  });

  it('does not re-send when the segment already in effect is clicked', async () => {
    const sent = stubFetch({ optOut: false, autonomy: false });
    renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId('ai-opt-out-on')).toHaveAttribute('aria-pressed', 'true'),
    );
    await userEvent.click(screen.getByTestId('ai-opt-out-on'));
    expect(sent.filter((s) => s.url.includes('/ai-opt-out'))).toHaveLength(0);
  });

  it('locks the autonomy control while AI is off for the account', async () => {
    stubFetch({ optOut: true, autonomy: false });
    renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId('ai-opt-out-off')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByTestId('ai-autonomy-on')).toBeDisabled();
    expect(screen.getByTestId('ai-autonomy-off')).toBeDisabled();
  });

  it('turns autonomy on, keeping the current floor', async () => {
    const sent = stubFetch({ optOut: false, autonomy: false });
    renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId('ai-autonomy-off')).toHaveAttribute('aria-pressed', 'true'),
    );
    await userEvent.click(screen.getByTestId('ai-autonomy-on'));
    await waitFor(() =>
      expect(screen.getByTestId('ai-autonomy-on')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(sent).toContainEqual({
      url: expect.stringContaining('/v1/account/ai-autonomy') as unknown as string,
      body: { enabled: true, checkinFloorDays: null },
    });
  });
});
