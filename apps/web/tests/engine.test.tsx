import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineDashboard } from '../src/screens/engine/EngineDashboard.js';
import { appEn } from '../src/i18n/catalog/app/en.js';
import { appEs } from '../src/i18n/catalog/app/es.js';
import { setLocale } from '../src/i18n/index.js';
import { ENGINE_STATES } from '@truecairn/shared';

// The status pill shows the owner-facing NAME of the state, not the enum. Read
// the expected text out of the catalog rather than hardcoding it here, so a
// reword is a copy change in one place instead of a broken test in another.
const stateName = (s: string): string => appEn[`engine.state.${s}` as keyof typeof appEn];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const engineStatus = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: 'active',
  previousState: null,
  nextActionAt: null,
  snoozeUntil: null,
  enrolledContactCount: 1,
  pendingSensitiveActions: [],
  ...over,
});

function renderDash(
  fetchImpl: typeof fetch,
  proveSecondFactor?: (accepted: string[]) => Promise<void>,
): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    // EngineDashboard's unarmed-state card renders a react-router <Link>, so the
    // component needs a Router in tests as it has one in the app.
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <EngineDashboard fetchImpl={fetchImpl} {...(proveSecondFactor ? { proveSecondFactor } : {})} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('engine dashboard (PHASE4 C5B)', () => {
  it('shows the engine state, the next-action time, and pending cancellable actions', async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        engineStatus({
          state: 'active',
          nextActionAt: '2026-07-01T00:00:00.000Z',
          pendingSensitiveActions: [
            { id: 'sa-1', actionType: 'rotate_recovery_code', requestedAt: 'r', effectiveAt: '2026-06-20T00:00:00.000Z' },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('engine-state')).toHaveTextContent(stateName('active')));
    expect(screen.getByTestId('next-action')).toBeInTheDocument();
    // The list shows the human label (QA Pass 2 Finding B), not the raw action type.
    expect(screen.getByTestId('pending-action-sa-1')).toHaveTextContent('Rotate the recovery code');
    expect(screen.getByTestId('pending-action-sa-1')).toHaveTextContent(/cancellable until then/i);
  });

  // PROPERTY (escalation-ack honesty, direction 1): from escalation_pending the UI
  // shows the escalation and offers ONLY a deliberate acknowledgment, which carries
  // acknowledgedState — never a routine check-in.
  it('in escalation_pending offers ONLY an acknowledge-and-check-in that sends the ack', async () => {
    let sentBody: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/engine/status')) return json(engineStatus({ state: 'escalation_pending' }));
      if (u.endsWith('/v1/engine/check-in')) {
        sentBody = init.body as string;
        return json({ state: 'active', nextActionAt: null });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('escalation-warning')).toBeInTheDocument());
    // The routine check-in must be ABSENT here — it could silently clear the escalation.
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge and check in' }));
    await waitFor(() => expect(sentBody).toBeDefined());
    expect(JSON.parse(sentBody!)).toEqual({ acknowledgedState: 'escalation_pending' });
  });

  // PROPERTY (escalation-ack honesty, direction 2): a routine check-in carries NO
  // acknowledgedState — so the routine path can never accidentally clear an escalation
  // (the server would 409 it anyway, but the UI must not even try).
  it('a routine check-in (check_in_pending) sends no acknowledgedState', async () => {
    let sentBody: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/engine/status')) return json(engineStatus({ state: 'check_in_pending' }));
      if (u.endsWith('/v1/engine/check-in')) {
        sentBody = init.body as string;
        return json({ state: 'active', nextActionAt: null });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check in' })).toBeInTheDocument());
    expect(screen.queryByTestId('escalation-warning')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(sentBody).toBeDefined());
    expect(JSON.parse(sentBody!)).toEqual({}); // no ack — can't clear an escalation
  });

  it('snooze (check_in_pending) sends snoozeDays', async () => {
    let sentBody: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/engine/status')) return json(engineStatus({ state: 'check_in_pending' }));
      if (u.endsWith('/v1/engine/snooze')) {
        sentBody = init.body as string;
        return json({ state: 'active', nextActionAt: null });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Snooze' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    await waitFor(() => expect(sentBody).toBeDefined());
    expect(JSON.parse(sentBody!)).toEqual({ snoozeDays: 7 });
  });

  // PROPERTY (owner release-view increment): a release state names the ladder stage,
  // says plainly what's at stake, and shows the next-stage timer.
  it('names the release-ladder stage, what is at stake, and the next-stage timer', async () => {
    const fetchImpl = vi.fn(async () =>
      json(engineStatus({ state: 'limited_release', nextActionAt: '2026-07-01T00:00:00.000Z' })),
    ) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('release-warning')).toBeInTheDocument());
    expect(screen.getByTestId('release-stage')).toHaveTextContent('Limited release (S1)');
    expect(screen.getByTestId('release-warning')).toHaveTextContent(/most-accessible tier/i);
    expect(screen.getByTestId('release-next')).toBeInTheDocument();
  });

  // PROPERTY (cancel-release via the thin fresh-factor flow): the FIRST POST is 403
  // second-factor-required, the client proves the passkey factor, the retry succeeds,
  // and the engine returns to active.
  it('cancel-release: 403 second-factor-required → passkey prove → retry → engine active', async () => {
    let cancelled = false;
    let cancelPosts = 0;
    let proveCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      const method = (init.method ?? 'GET').toUpperCase();
      if (u.endsWith('/v1/engine/status') && method === 'GET') {
        return json(engineStatus({ state: cancelled ? 'active' : 'limited_release' }));
      }
      if (u.endsWith('/v1/engine/cancel-release') && method === 'POST') {
        cancelPosts += 1;
        if (proveCalls === 0) {
          return json(
            {
              type: 'https://truecairn.app/problems/second-factor-required',
              title: 'Second factor required',
              status: 403,
              secondFactor: { accepted: ['webauthn'], freshnessWindowSeconds: 600 },
            },
            403,
          );
        }
        cancelled = true;
        return json({ state: 'active' });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    const proveSecondFactor = vi.fn(async () => {
      proveCalls += 1;
    });

    renderDash(fetchImpl, proveSecondFactor);
    await waitFor(() => expect(screen.getByTestId('release-warning')).toBeInTheDocument());
    expect(screen.getByTestId('engine-state')).toHaveTextContent(stateName('limited_release'));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel release' }));

    await waitFor(() => expect(screen.getByTestId('engine-state')).toHaveTextContent(stateName('active')));
    expect(proveSecondFactor).toHaveBeenCalledTimes(1);
    expect(cancelPosts).toBe(2); // R1 (403) then the retry (200)
  });

  // QA 2026-07-21 #3: review_required was an owner dead end (the copy pointed at
  // controls that didn't render). Now it shows a resolve card whose button runs
  // the same fresh-second-factor lane as cancel-release and re-arms to active.
  it('review_required: offers a resolve control that proves a factor and re-arms', async () => {
    let resolved = false;
    let proveCalls = 0;
    let resolvePosts = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      const method = (init.method ?? 'GET').toUpperCase();
      if (u.endsWith('/v1/engine/status') && method === 'GET') {
        return json(engineStatus({ state: resolved ? 'active' : 'review_required' }));
      }
      if (u.endsWith('/v1/engine/resolve-review') && method === 'POST') {
        resolvePosts += 1;
        if (proveCalls === 0) {
          return json(
            {
              type: 'https://truecairn.app/problems/second-factor-required',
              title: 'Second factor required',
              status: 403,
              secondFactor: { accepted: ['webauthn'], freshnessWindowSeconds: 600 },
            },
            403,
          );
        }
        resolved = true;
        return json({ state: 'active' });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    const proveSecondFactor = vi.fn(async () => {
      proveCalls += 1;
    });

    renderDash(fetchImpl, proveSecondFactor);
    await waitFor(() => expect(screen.getByTestId('review-required')).toBeInTheDocument());
    expect(screen.getByTestId('engine-state')).toHaveTextContent(stateName('review_required'));

    await userEvent.click(screen.getByTestId('resolve-review-btn'));

    await waitFor(() => expect(screen.getByTestId('engine-state')).toHaveTextContent(stateName('active')));
    expect(proveSecondFactor).toHaveBeenCalledTimes(1);
    expect(resolvePosts).toBe(2); // R1 (403) then the retry (200)
  });

  // PROPERTY (audit B2): the Arm control mirrors the server's enrolled-contact
  // prerequisite — disabled, with a plain explanation, until at least one contact
  // is enrolled. The owner can't arm a switch that could never actually fire.
  it('unarmed with no enrolled contact: Arm is disabled and explains the prerequisite', async () => {
    const fetchImpl = vi.fn(async () =>
      json(engineStatus({ state: null, enrolledContactCount: 0 })),
    ) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('engine-unarmed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Arm engine' })).toBeDisabled();
    expect(screen.getByTestId('arm-prereq')).toBeInTheDocument();
  });

  it('unarmed with an enrolled contact: Arm is enabled and POSTs /v1/engine/arm', async () => {
    let armed = false;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.endsWith('/v1/engine/status')) {
        return json(engineStatus({ state: armed ? 'active' : null, enrolledContactCount: 1 }));
      }
      if (u.endsWith('/v1/engine/arm') && method === 'POST') {
        armed = true;
        return json({ state: 'active', nextActionAt: null });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderDash(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('engine-unarmed')).toBeInTheDocument());
    const arm = screen.getByRole('button', { name: 'Arm engine' });
    expect(arm).toBeEnabled();
    expect(screen.queryByTestId('arm-prereq')).toBeNull();

    await userEvent.click(arm);
    await waitFor(() => expect(screen.getByTestId('engine-state')).toHaveTextContent(stateName('active')));
  });
});

// ── The status pill in Spanish, rendered, for every state the engine can report ──
//
// QA 2026-08-26 asked to confirm no snake_case leaks into the Engine pill once the
// language changes. engine-states.test.ts proves the CATALOG is clean; this proves
// the render path actually reaches it, which is the half a catalog check cannot
// see — the old defect was precisely a component falling back to
// replace(/_/g,' ') while both catalogs sat there correct and unused.
//
// Spanish is not in OFFERED_LOCALES yet (coverage, not quality — see
// packages/shared/src/locale.ts). setLocale bypasses that gate deliberately, so
// flipping the list later turns on strings already proven to render.
describe('the status pill speaks the chosen language, never the enum', () => {
  afterEach(async () => {
    await setLocale('en');
  });

  for (const state of ENGINE_STATES) {
    it(`renders ${state} in Spanish with no underscores`, async () => {
      await setLocale('es');
      const fetchImpl = vi.fn(async () => json(engineStatus({ state })));
      renderDash(fetchImpl as unknown as typeof fetch);
      const pill = await screen.findByTestId('engine-state');
      expect(pill.textContent).toBe(appEs[`engine.state.${state}` as keyof typeof appEs]);
      expect(pill.textContent).not.toMatch(/_/);
      // And it is genuinely the Spanish string, not English leaking through a
      // missing key — the two differ for every state in this catalog.
      expect(pill.textContent).not.toBe(appEn[`engine.state.${state}` as keyof typeof appEn]);
    });
  }
});
