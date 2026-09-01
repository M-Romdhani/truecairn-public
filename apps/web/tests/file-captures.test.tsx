import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileCaptures } from '../src/screens/vault/FileCaptures.js';
import * as capturesApi from '../src/vault/captures.js';

// The filing queue (docs/34 D4/D5). Two things are pinned here: the metadata is
// exactly tier + size + arrival (a title on this screen would be a leak, since
// nothing is decrypted until the owner files), and the release-plan consequence
// is present and worded as a fact rather than an alarm.

function renderPanel(): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <FileCaptures />
    </QueryClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('FileCaptures', () => {
  it('renders nothing at all when the queue is empty', async () => {
    vi.spyOn(capturesApi, 'listCaptures').mockResolvedValue([]);
    const { container } = render(renderPanel());
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('shows tier, size and arrival — and no title, because there is none to show', async () => {
    vi.spyOn(capturesApi, 'listCaptures').mockResolvedValue([
      {
        id: 'c1',
        tier: 's3',
        sizeBytes: 2_516_582,
        // 14:32 local — the assertion below reads the rendered string rather
        // than recomputing it, so a timezone cannot make this flaky.
        createdAt: new Date(2026, 6, 31, 14, 32).toISOString(),
      },
    ]);
    render(renderPanel());

    expect(await screen.findByText('S3 · 2.4 MB · sealed box')).toBeInTheDocument();
    expect(screen.getByText('Arrived 31 Jul 2026, 14:32')).toBeInTheDocument();
    // The count pill, and the singular voice for one item.
    expect(screen.getByText('1 waiting')).toBeInTheDocument();
    expect(screen.getByText(/One item is waiting to be filed/)).toBeInTheDocument();
  });

  it('states the release-plan consequence, quietly rather than as an alert', async () => {
    vi.spyOn(capturesApi, 'listCaptures').mockResolvedValue([
      { id: 'c1', tier: 's1', sizeBytes: 900, createdAt: '2026-07-31T09:12:00.000Z' },
    ]);
    const { container } = render(renderPanel());

    const lead = await screen.findByText('Filing is what puts an item into your release plan.');
    expect(lead.tagName).toBe('STRONG');
    // In the sunken band, NOT in an alert: this is how capture works, not a
    // fault, and red here would cry wolf on every arrival (docs/34 D4).
    expect(container.querySelector('.filing-note')).toContainElement(lead);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(screen.getByText(/trusted contacts would not receive it/)).toBeInTheDocument();
  });

  it('offers File it as the primary action and Discard beside it', async () => {
    vi.spyOn(capturesApi, 'listCaptures').mockResolvedValue([
      { id: 'c1', tier: 's2', sizeBytes: 900, createdAt: '2026-07-31T09:12:00.000Z' },
      { id: 'c2', tier: 's2', sizeBytes: 900, createdAt: '2026-07-31T09:13:00.000Z' },
    ]);
    const { container } = render(renderPanel());

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('2 waiting')).toBeInTheDocument();

    const first = within(rows[0]!);
    expect(first.getByRole('button', { name: 'File it' })).toHaveClass('btn', 'primary');
    // Discard is the quiet one. `secondary` rather than a bare `.btn`, which in
    // this stylesheet is solid near-black and would put two heavy buttons in
    // every row; and deliberately NOT `.danger`, because a capture has never
    // been under a tier key nor reachable by a release, so throwing away a
    // mis-scan is tidying up, not destroying vault content.
    const discard = first.getByRole('button', { name: 'Discard' });
    expect(discard).toHaveClass('btn', 'secondary');
    expect(discard).not.toHaveClass('danger');
    expect(discard).not.toHaveClass('primary');
    expect(container.querySelector('.filing-count')).toHaveTextContent('2 waiting');
  });

  it('never renders anything that could carry item content', async () => {
    // A defensive read of the whole panel: the server does not send a title and
    // this component must not grow a place to put one.
    vi.spyOn(capturesApi, 'listCaptures').mockResolvedValue([
      { id: 'c1', tier: 's2', sizeBytes: 1024, createdAt: '2026-07-31T09:12:00.000Z' },
    ]);
    const { container } = render(renderPanel());
    await screen.findByText('S2 · 1 KB · sealed box');

    const text = container.textContent ?? '';
    expect(text).toContain('Titles and contents stay encrypted until you file');
    // The capture id is a server handle, not information the owner needs — and
    // printing it would be the first step toward printing more.
    expect(text).not.toContain('c1');
  });
});
