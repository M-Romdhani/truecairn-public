import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateEnrollmentMaterial, lock, type KeyMaterial } from '@truecairn/client-crypto';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '../src/crypto/session.js';
import { Settings } from '../src/screens/settings/Settings.js';

// Notification-channel enrolment card (Continuity Verification CV-0.0): list,
// add → code sent, verify round-trip, remove. All channel calls ride the global
// fetch (plain session ops — no key material, no step-up).

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A real unlocked session for the verified-removal test — the remove_channel
// step-up path needs userId (same harness as settings-delete.test.tsx).
let material: KeyMaterial;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
beforeAll(() => {
  material = generateEnrollmentMaterial(utf8('pw-channels')).material;
});

afterEach(() => {
  lock();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

interface StubChannel {
  id: string;
  channelType: string;
  destination: string;
  verified: boolean;
  health: string;
  createdAt: string;
  pendingVerification: boolean;
}

// A stateful stub: add creates a pending channel, verify flips it, delete drops it.
function stubFetch(initial: StubChannel[]): { calls: string[] } {
  const channels = [...initial];
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${u}`);
      if (u.endsWith('/v1/account/me')) return json({ email: 'owner@example.com' });
      if (u.endsWith('/v1/account/ai-settings')) return json({ optOut: false });
      if (u.endsWith('/v1/account/ai-autonomy')) return json({ enabled: false, checkinFloorDays: null });
      if (u.endsWith('/v1/settings/channels/preferences') && method === 'GET')
        return json({
          channels: channels.map((c) => ({
            id: c.id,
            channelType: c.channelType,
            destination: c.destination,
            verified: c.verified,
            classes: { owner_verification: true, owner_notices: true, contact_notices: true },
          })),
        });
      if (u.endsWith('/v1/settings/channels/preferences') && method === 'PUT') {
        return json(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (u.endsWith('/v1/settings/channels') && method === 'GET')
        return json({
          channels,
          pushPublicKey: null,
          plan: 'pro',
          enrollableChannelTypes: ['email', 'sms', 'whatsapp'],
        });
      if (u.endsWith('/v1/settings/channels') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { channelType: string; destination: string };
        const ch: StubChannel = {
          id: `ch-${channels.length + 1}`,
          channelType: body.channelType,
          destination: body.destination,
          verified: false,
          health: 'healthy',
          createdAt: new Date().toISOString(),
          pendingVerification: true,
        };
        channels.push(ch);
        return json({ id: ch.id, channelType: body.channelType, destination: ch.destination, verified: false }, 201);
      }
      const verifyMatch = u.match(/\/v1\/settings\/channels\/(.+)\/verify$/);
      if (verifyMatch && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { code: string };
        if (body.code !== '123456') return json({ type: 'about:blank', title: 'Bad Request', status: 400 }, 400);
        const ch = channels.find((c) => c.id === verifyMatch[1]);
        if (ch) {
          ch.verified = true;
          ch.pendingVerification = false;
        }
        return json({ id: verifyMatch[1], verified: true });
      }
      const delMatch = u.match(/\/v1\/settings\/channels\/([^/]+)$/);
      if (delMatch && method === 'DELETE') {
        const i = channels.findIndex((c) => c.id === delMatch[1]);
        if (i >= 0) channels.splice(i, 1);
        return json({ removed: true });
      }
      // Verified-channel removal: the sensitive-actions lane. The channel stays
      // in the list — the server keeps it live through the 7-day cooldown.
      if (u.endsWith('/v1/settings/channels/remove') && method === 'POST') {
        return json(
          { sensitiveActionId: 'sa-rm-1', effectiveAt: '2026-07-23T00:00:00.000Z' },
          202,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
  return { calls };
}

function UnlockButton(): JSX.Element {
  const s = useSession();
  return (
    <button type="button" onClick={() => s.unlock(utf8('pw-channels'), material, 'uid-1')}>
      unlock-harness
    </button>
  );
}

function renderSettings(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionProvider>
          <UnlockButton />
          <Settings proveSecondFactor={() => Promise.resolve()} />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings — notification channels (CV-0.0)', () => {
  it('lists channels with their verification state and the no-tracking explainer', async () => {
    stubFetch([
      {
        id: 'ch-a',
        channelType: 'email',
        destination: 'verified@example.com',
        verified: true,
        health: 'healthy',
        createdAt: new Date().toISOString(),
        pendingVerification: false,
      },
      {
        id: 'ch-b',
        channelType: 'email',
        destination: 'pending@example.com',
        verified: false,
        health: 'healthy',
        createdAt: new Date().toISOString(),
        pendingVerification: true,
      },
    ]);
    renderSettings();

    // The destination appears in the list row AND the matrix grid below.
    await waitFor(() =>
      expect(screen.getAllByText('verified@example.com').length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/Verified email channel/i)).toBeInTheDocument();
    expect(screen.getByText(/verification code was sent/i)).toBeInTheDocument();
    expect(screen.getByTestId('channel-code-ch-b')).toBeInTheDocument();
    expect(screen.getByText(/never track whether you open or read anything/i)).toBeInTheDocument();
  });

  it('adds a channel, then verifies it with the code round-trip', async () => {
    const { calls } = stubFetch([]);
    renderSettings();

    await waitFor(() => expect(screen.getByTestId('channel-add')).toBeInTheDocument());
    expect(screen.getByTestId('channel-add')).toBeDisabled(); // no @ yet
    await userEvent.type(screen.getByTestId('channel-add-destination'), 'me@example.com');
    await userEvent.click(screen.getByTestId('channel-add'));

    // The new channel appears pending, with a code input.
    await waitFor(() => expect(screen.getByTestId('channel-code-ch-1')).toBeInTheDocument());
    expect(calls).toContain('POST /v1/settings/channels');

    // A wrong code surfaces the error and the channel stays unverified.
    await userEvent.type(screen.getByTestId('channel-code-ch-1'), '999999');
    await userEvent.click(screen.getByTestId('channel-verify-ch-1'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not accepted/i));

    // The right code verifies it.
    await userEvent.clear(screen.getByTestId('channel-code-ch-1'));
    await userEvent.type(screen.getByTestId('channel-code-ch-1'), '123456');
    await userEvent.click(screen.getByTestId('channel-verify-ch-1'));
    await waitFor(() => expect(screen.getByText(/Verified email channel/i)).toBeInTheDocument());
  });

  it('enrols an SMS channel via the type selector (CV-2)', async () => {
    const { calls } = stubFetch([]);
    renderSettings();

    // Wait for the plan/enrollable-types query to resolve so the SMS option
    // (pro-gated) is rendered before we select it.
    await waitFor(() =>
      expect(
        screen.getByTestId('channel-add-type').querySelector('option[value="sms"]'),
      ).not.toBeNull(),
    );
    // Switch to SMS; the button gates on a leading '+' rather than an '@'.
    await userEvent.selectOptions(screen.getByTestId('channel-add-type'), 'sms');
    expect(screen.getByTestId('channel-add')).toBeDisabled();
    await userEvent.type(screen.getByTestId('channel-add-destination'), '+15552223333');
    await userEvent.click(screen.getByTestId('channel-add'));

    await waitFor(() =>
      expect(screen.getAllByText('+15552223333').length).toBeGreaterThan(0),
    );
    expect(calls).toContain('POST /v1/settings/channels');
    // The verify input appears for the pending SMS channel.
    expect(screen.getByTestId('channel-code-ch-1')).toBeInTheDocument();
  });

  it('on the free plan, hides SMS/WhatsApp from the picker and shows the Pro upgrade hint', async () => {
    // A free-plan channel list: only email is enrollable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        const s = String(u);
        if (s.endsWith('/v1/account/me')) return json({ email: 'owner@example.com' });
        if (s.endsWith('/v1/account/ai-settings')) return json({ optOut: false });
        if (s.endsWith('/v1/account/ai-autonomy')) return json({ enabled: false, checkinFloorDays: null });
        if (s.endsWith('/v1/settings/channels'))
          return json({ channels: [], pushPublicKey: null, plan: 'free', enrollableChannelTypes: ['email'] });
        throw new Error(`unexpected fetch: ${s}`);
      }),
    );
    renderSettings();

    await waitFor(() => expect(screen.getByTestId('channel-add-type')).toBeInTheDocument());
    // Only Email is offered; the paid channels are absent.
    const options = Array.from(
      screen.getByTestId('channel-add-type').querySelectorAll('option'),
    ).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['email']);
    expect(screen.getByTestId('channel-upgrade-hint')).toHaveTextContent(/Truecairn Personal/i);
  });

  it('removes an UNVERIFIED channel immediately (a typo cleanup needs no ceremony)', async () => {
    const { calls } = stubFetch([
      {
        id: 'ch-x',
        channelType: 'email',
        destination: 'gone@example.com',
        verified: false,
        health: 'healthy',
        createdAt: new Date().toISOString(),
        pendingVerification: false,
      },
    ]);
    renderSettings();

    await waitFor(() => expect(screen.getByTestId('channel-remove-ch-x')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('channel-remove-ch-x'));
    // Both the list row and the matrix row disappear (shared invalidation).
    await waitFor(() => expect(screen.queryByText('gone@example.com')).not.toBeInTheDocument());
    expect(calls).toContain('DELETE /v1/settings/channels/ch-x');
  });

  it('a VERIFIED channel goes through the sensitive lane: 202 → "Removal scheduled", channel stays listed', async () => {
    const { calls } = stubFetch([
      {
        id: 'ch-v',
        channelType: 'email',
        destination: 'guarded@example.com',
        verified: true,
        health: 'healthy',
        createdAt: new Date().toISOString(),
        pendingVerification: false,
      },
    ]);
    renderSettings();

    await waitFor(() =>
      expect(screen.getAllByText('guarded@example.com').length).toBeGreaterThan(0),
    );
    // The step-up signature needs the in-memory key + userId — unlock first.
    await userEvent.click(screen.getByText('unlock-harness'));
    await userEvent.click(screen.getByTestId('channel-remove-ch-v'));

    await waitFor(() =>
      expect(screen.getByTestId('channel-removal-pending-ch-v')).toHaveTextContent(
        /Removal scheduled/i,
      ),
    );
    expect(screen.getByTestId('channel-removal-pending-ch-v')).toHaveTextContent(/Engine page/i);
    // The sensitive lane was used; the immediate DELETE was not.
    expect(calls).toContain('POST /v1/settings/channels/remove');
    expect(calls).not.toContain('DELETE /v1/settings/channels/ch-v');
    // The channel is still listed — the server keeps it live through the delay.
    expect(screen.getAllByText('guarded@example.com').length).toBeGreaterThan(0);
  });
});

describe('Settings — downgrade transparency banner (docs/28, G-3)', () => {
  const paidChannel = (id: string, type: 'sms' | 'whatsapp', verified: boolean): StubChannel => ({
    id,
    channelType: type,
    destination: '+15550001111',
    verified,
    health: 'healthy',
    createdAt: new Date().toISOString(),
    pendingVerification: false,
  });

  function stubWithPlan(plan: 'free' | 'pro', channels: StubChannel[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        const s = String(u);
        if (s.endsWith('/v1/account/me')) return json({ email: 'owner@example.com' });
        if (s.endsWith('/v1/account/ai-settings')) return json({ optOut: false });
        if (s.endsWith('/v1/account/ai-autonomy')) return json({ enabled: false, checkinFloorDays: null });
        if (s.endsWith('/v1/settings/channels/preferences'))
          return json({
            channels: channels.map((c) => ({
              id: c.id,
              channelType: c.channelType,
              destination: c.destination,
              verified: c.verified,
              classes: { owner_verification: true, owner_notices: true, contact_notices: true },
            })),
          });
        if (s.endsWith('/v1/settings/channels'))
          return json({
            channels,
            pushPublicKey: null,
            plan,
            enrollableChannelTypes: plan === 'pro' ? ['email', 'sms', 'whatsapp'] : ['email'],
          });
        throw new Error(`unexpected fetch: ${s}`);
      }),
    );
  }

  it('a lapsed plan with residual verified paid channels shows the persistent banner', async () => {
    stubWithPlan('free', [paidChannel('ch-sms', 'sms', true)]);
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('downgrade-banner')).toBeInTheDocument());
    expect(screen.getByTestId('downgrade-banner')).toHaveTextContent(/keeps protecting you/i);
    expect(screen.getByTestId('downgrade-banner')).toHaveTextContent('+15550001111');
    expect(screen.getByTestId('downgrade-banner')).toHaveTextContent(/Nothing was turned off/i);
    // The channel ROW itself renders too — the list shows every channel on the
    // account, never filtered by what the current plan can ADD (QA 2026-07-17
    // C4: a grandfathered channel must stay visible and removable).
    expect(screen.getByTestId('channel-ch-sms')).toBeInTheDocument();
    expect(screen.getByTestId('channel-remove-ch-sms')).toBeInTheDocument();
  });

  it('no banner while Pro, and none on free without paid channels (incl. unverified ones)', async () => {
    stubWithPlan('pro', [paidChannel('ch-sms', 'sms', true)]);
    renderSettings();
    await waitFor(() =>
      expect(screen.getAllByText('+15550001111').length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('downgrade-banner')).not.toBeInTheDocument();

    cleanup();
    stubWithPlan('free', [paidChannel('ch-wa', 'whatsapp', false)]);
    renderSettings();
    await waitFor(() =>
      expect(screen.getAllByText('+15550001111').length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('downgrade-banner')).not.toBeInTheDocument();
  });
});

describe('Settings — channel matrix (docs/26 §3.1, QA issue #3)', () => {
  it('renders the grid with the safety-floor explainer and PUTs a toggled cell', async () => {
    const { calls } = stubFetch([
      {
        id: 'ch-m',
        channelType: 'email',
        destination: 'matrix@example.com',
        verified: true,
        health: 'healthy',
        createdAt: new Date().toISOString(),
        pendingVerification: false,
      },
    ]);
    renderSettings();

    await waitFor(() => expect(screen.getByTestId('channel-matrix')).toBeInTheDocument());
    // The safety floor is stated where the switches live.
    expect(screen.getByTestId('channel-matrix')).toHaveTextContent(
      /always delivered — no setting can silence them/i,
    );
    // Three cells for the channel, all enabled (absent preference = enabled).
    for (const pc of ['owner_verification', 'owner_notices', 'contact_notices']) {
      expect(screen.getByTestId(`matrix-ch-m-${pc}`)).toBeChecked();
    }

    await userEvent.click(screen.getByTestId('matrix-ch-m-owner_notices'));
    await waitFor(() =>
      expect(calls).toContain('PUT /v1/settings/channels/preferences'),
    );
  });

  it('hides the card entirely when no channels exist', async () => {
    stubFetch([]);
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('channel-add')).toBeInTheDocument());
    expect(screen.queryByTestId('channel-matrix')).not.toBeInTheDocument();
  });
});
