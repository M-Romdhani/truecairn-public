import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineDashboard } from '../src/screens/engine/EngineDashboard.js';

// The owner's release-progress panel: the live who-affirmed/what-windows view.
// Labels decrypt with the session master key; these tests run LOCKED, so the
// panel must degrade to the neutral name — the safety panel never crashes (or
// leaks a raw ciphertext string) over a display label.

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const engineStatus = {
  state: 'release_review',
  previousState: null,
  nextActionAt: null,
  snoozeUntil: null,
  enrolledContactCount: 2,
  pendingSensitiveActions: [],
};

const aff = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contactId: 'c-1',
  role: 'personal',
  status: 'pending',
  affirmedAt: null,
  revocationWindowExpiresAt: null,
  committedAt: null,
  revokedAt: null,
  displayLabelCiphertext: 'b3BhcXVl',
  displayLabelNonce: 'bm9uY2U=',
  ...over,
});

const ceremony = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ceremonyId: 'cer-1',
  tier: 's2',
  status: 'collecting_affirmations',
  threshold: 2,
  committed: 0,
  initiatedAt: '2026-07-20T00:00:00.000Z',
  syncWindowExpiresAt: '2026-07-22T00:00:00.000Z',
  outerKeyReleasedAt: null,
  reconstructionStartedAt: null,
  releasedAt: null,
  cancellationReason: null,
  failureReason: null,
  affirmations: [aff(), aff({ contactId: 'c-2', role: 'recovery', status: 'tentative', affirmedAt: '2026-07-20T10:00:00.000Z', revocationWindowExpiresAt: '2026-07-22T10:00:00.000Z' })],
  recipients: [{ contactId: 'c-1', role: 'personal', status: 'pending', completedAt: null, displayLabelCiphertext: 'b3BhcXVl', displayLabelNonce: 'bm9uY2U=' }],
  ...over,
});

function renderDash(progress: { ceremonies: unknown[] }): void {
  const fetchImpl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/v1/engine/status')) return json(engineStatus);
    if (u.endsWith('/v1/engine/release-progress')) return json(progress);
    return json({ title: 'not found' }, 404);
  }) as unknown as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <EngineDashboard fetchImpl={fetchImpl} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('owner release-progress panel', () => {
  it('shows the consensus state per contact, with the neutral name when locked', async () => {
    renderDash({ ceremonies: [ceremony()] });
    await waitFor(() => expect(screen.getByTestId('release-progress')).toBeInTheDocument());
    expect(screen.getByTestId('release-progress-s2')).toHaveTextContent('S2 — 2-of-3 consensus');
    expect(screen.getByTestId('release-progress-s2')).toHaveTextContent('Waiting for your contacts');
    expect(screen.getByTestId('release-progress-s2-consensus')).toHaveTextContent('0 of 2 confirmations needed');
    expect(screen.getByTestId('release-progress-s2-consensus')).toHaveTextContent(/collection window closes/i);
    // Locked session → the neutral label, never the raw ciphertext.
    expect(screen.getByTestId('release-progress-aff-c-1')).toHaveTextContent('A trusted contact');
    expect(screen.getByTestId('release-progress-aff-c-1')).not.toHaveTextContent('b3BhcXVl');
    expect(screen.getByTestId('release-progress-aff-c-1')).toHaveTextContent('Has not responded yet');
    // A tentative affirmation shows its revocation deadline — "still revocable".
    expect(screen.getByTestId('release-progress-aff-c-2')).toHaveTextContent(/still revocable until/i);
    // The safety pointer to the protective controls above.
    expect(screen.getByTestId('release-progress')).toHaveTextContent(/protective controls above/i);
  });

  it('shows retrievals once the gate is open, and plain words for a failed ceremony', async () => {
    renderDash({
      ceremonies: [
        ceremony({
          ceremonyId: 'cer-open',
          tier: 's1',
          status: 'released',
          threshold: 1,
          committed: 1,
          reconstructionStartedAt: '2026-07-21T00:00:00.000Z',
          affirmations: [aff({ status: 'committed', committedAt: '2026-07-20T12:00:00.000Z' })],
          recipients: [
            { contactId: 'c-1', role: 'personal', status: 'released', completedAt: '2026-07-21T01:00:00.000Z', displayLabelCiphertext: 'b3BhcXVl', displayLabelNonce: 'bm9uY2U=' },
          ],
        }),
        ceremony({
          ceremonyId: 'cer-failed',
          tier: 's3',
          status: 'failed',
          failureReason: 'sync_window_expired_below_threshold',
          affirmations: [aff({ contactId: 'c-9' })],
          recipients: [],
        }),
      ],
    });
    await waitFor(() => expect(screen.getByTestId('release-progress')).toBeInTheDocument());
    expect(screen.getByTestId('release-progress-s1')).toHaveTextContent('Retrieved');
    expect(screen.getByTestId('release-progress-rcp-c-1')).toHaveTextContent(/retrieved their release/i);
    expect(screen.getByTestId('release-progress-s3')).toHaveTextContent('Failed closed');
    expect(screen.getByTestId('release-progress-s3')).toHaveTextContent(
      /closed without enough confirmations — nothing was released/i,
    );
  });

  it('renders nothing when there are no ceremonies', async () => {
    renderDash({ ceremonies: [] });
    await waitFor(() => expect(screen.getByTestId('engine-state')).toBeInTheDocument());
    expect(screen.queryByTestId('release-progress')).toBeNull();
  });
});
