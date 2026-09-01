import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpsCenter } from '../src/screens/ops/OpsCenter.js';

// The dashboard's value is that its colours are honest. These tests pin the
// properties that make it worth having: the headline answers "could a release
// complete right now?", nothing uninstrumented is ever painted green, and no
// absence is ever rendered as a number.
//
// They assert STATE, not glyphs. The page used to carry state in 🟢🟡🔴⚪ and the
// tests matched on those characters; state is now a CSS pip plus a text label,
// so the assertions moved to the class and the word. The property being pinned —
// unknown must never be indistinguishable from ok — is unchanged.

function renderOps(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OpsCenter />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SERIES = {
  buckets: [
    { at: '2026-07-25T00:00:00.000Z', severity: 0, worstCheck: null },
    { at: '2026-07-25T00:05:00.000Z', severity: 0, worstCheck: null },
  ],
  bucketMinutes: 5,
  from: '2026-07-25T00:00:00.000Z',
  to: '2026-07-25T00:10:00.000Z',
  unobservedBuckets: 0,
  measuringSince: '2026-07-20T00:00:00.000Z',
};

function mockStatus(overrides: Record<string, unknown> = {}): void {
  const body = {
    continuityEngine: 'ok',
    continuitySummary: 'Continuity Engine Operational — a release ceremony could complete right now',
    checks: [
      { id: 'database', label: 'Database', state: 'ok', detail: 'reachable', releaseCritical: true },
      { id: 'worker', label: 'Release worker', state: 'ok', detail: 'last tick 2s ago', releaseCritical: true },
      {
        id: 'outer_layer_kek',
        label: 'Outer-layer key (release gate)',
        state: 'ok',
        detail: 'wrap/unwrap round-trip verified (env:1)',
        releaseCritical: true,
      },
      {
        id: 'backups',
        label: 'Database backups',
        state: 'unknown',
        detail:
          'no verified restore recorded — snapshots are platform-managed; set BACKUPS_LAST_VERIFIED_RESTORE after a drill (docs/23)',
        releaseCritical: false,
      },
    ],
    versions: { api: '0.0.0', worker: '0.0.0', skew: false },
    queues: {
      notificationsQueued: 0,
      notificationsDeadLettered: 0,
      oldestQueuedAgeSeconds: null,
      sensitiveActionsPending: 0,
      sensitiveActionsOverdue: 0,
      ceremoniesActive: 0,
    },
    accounts: { total: 42, registeredToday: 3, active: 40, armed: 31 },
    alerts: [],
    observedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
  // Two endpoints now: the 15s status poll and the 5-minute health series.
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(url.includes('health-series') ? { series: SERIES } : body),
      } as Response),
    ),
  );
}

function mockError(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: false,
        status,
        statusText: 'Error',
        json: () => Promise.resolve({ status, title: 'Error' }),
      } as Response),
    ),
  );
}

describe('operations centre', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leads with whether a release could complete right now', async () => {
    mockStatus();
    renderOps();
    const status = await screen.findByTestId('continuity-status');
    expect(status.getAttribute('data-state')).toBe('ok');
    expect(status.textContent).toMatch(/Continuity Engine Operational/);
  });

  it('goes red and names the failing component', async () => {
    mockStatus({
      continuityEngine: 'down',
      continuitySummary: 'Release path DOWN — Release worker',
    });
    renderOps();
    const status = await screen.findByTestId('continuity-status');
    expect(status.getAttribute('data-state')).toBe('down');
    // "Something is wrong" is not actionable; the component must be named.
    expect(status.textContent).toMatch(/Release worker/);
  });

  it('does NOT paint an uninstrumented check green', async () => {
    mockStatus();
    renderOps();
    const backups = await screen.findByTestId('check-backups');
    // The unknown pip is hollow and dashed and the label reads "unknown": "we
    // don't know" must never render as "we're fine", in colour or in greyscale.
    expect(backups.className).toMatch(/is-unknown/);
    expect(backups.className).not.toMatch(/is-ok/);
    expect(backups.textContent).toMatch(/unknown/i);
    expect(backups.textContent).toMatch(/no verified restore recorded/);
  });

  it('carries every state as text, not only as colour', async () => {
    mockStatus();
    renderOps();
    const db = await screen.findByTestId('check-database');
    // A screen reader and a greyscale monitor both have to be able to read this.
    expect(db.querySelector('.ops-statelabel')?.textContent).toBe('ok');
  });

  it('shows the outer-layer key was verified by a real round-trip', async () => {
    mockStatus();
    renderOps();
    const kek = await screen.findByTestId('check-outer_layer_kek');
    expect(kek.textContent).toMatch(/round-trip verified/);
  });

  it('shows how many accounts exist, and how many the engine is watching', async () => {
    mockStatus();
    renderOps();
    const accounts = await screen.findByTestId('accounts');
    expect(accounts.textContent).toMatch(/42/);
    expect(accounts.textContent).toMatch(/40/);
    expect(accounts.textContent).toMatch(/31/);
    // Registered today is labelled with its day boundary — "3" is meaningless
    // without knowing whose midnight it counts from.
    expect(accounts.textContent).toMatch(/since 00:00 UTC/);
  });

  it('renders an uncounted account total as absent, never as zero', async () => {
    // The server sends null only when it could not read the database. Printing
    // "0" there would invent a fact — the same failure as a green tile for
    // something nothing checked.
    mockStatus({ accounts: null });
    renderOps();
    const missing = await screen.findByTestId('accounts-unavailable');
    expect(missing.textContent).toMatch(/not zero/i);
    expect(screen.queryByTestId('accounts')).toBeNull();
  });

  it('renders uncounted QUEUES as absent, never as six zeros', async () => {
    // Same rule as accounts, and the reason the payload had to change: six zeros
    // during a database outage is a claim that nothing is queued, made in the one
    // failure where the depth cannot be known.
    mockStatus({ queues: null });
    renderOps();
    const missing = await screen.findByTestId('queues-unavailable');
    expect(missing.textContent).toMatch(/not counted/);
    expect(missing.textContent).not.toMatch(/\b0\b/);
    expect(screen.queryByTestId('queues')).toBeNull();
  });

  it('distinguishes an unreadable event log from an empty one', async () => {
    mockStatus({ alerts: null });
    renderOps();
    const missing = await screen.findByTestId('alerts-unavailable');
    expect(missing.textContent).toMatch(/not an empty log/i);
    expect(missing.textContent).not.toMatch(/Nothing recorded/);
  });

  it('warns on API/worker version skew', async () => {
    mockStatus({ versions: { api: '1.0.0', worker: '0.9.0', skew: true } });
    renderOps();
    expect((await screen.findByTestId('version-skew')).textContent).toMatch(/half-succeeded/);
  });

  it('answers a non-admin with a dead end that admits nothing exists', async () => {
    mockError(404);
    renderOps();
    const denied = await screen.findByTestId('ops-denied');
    // The API answers 404 rather than 403 so a stranger cannot confirm this
    // surface exists. The page must not undo that by explaining itself.
    expect(denied.textContent).toMatch(/Not found/);
    expect(denied.textContent).not.toMatch(/admin/i);
    expect(denied.textContent).not.toMatch(/allowlist/i);
    expect(denied.textContent).not.toMatch(/OPS_ADMIN_EMAILS/);
    expect(denied.textContent).not.toMatch(/dashboard/i);
  });

  it('does not report a server outage as a permission problem', async () => {
    // The regression this replaced: any error rendered "not available for your
    // account", so the page whose job is to be readable during an outage told
    // an admin they lacked access the moment the API returned 500.
    mockError(500);
    renderOps();
    const err = await screen.findByTestId('ops-unreachable');
    expect(err.textContent).toMatch(/No answer from the API/);
    expect(err.textContent).not.toMatch(/not available for your account/i);
    expect(screen.queryByTestId('ops-denied')).toBeNull();
  });
});
