import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/AppShell.js';

// ── The sidebar counts must never state a number they do not have ────────────
//
// `.sb-item .sb-count` shipped in the stylesheet with nothing rendering into it.
// Filling it in is easy; filling it in HONESTLY is the part worth a test.
//
// A count is a claim about the owner's vault. Rendering "0" while the request is
// still in flight — or after it failed — tells someone their vault is empty at a
// glance, on every screen, which is both wrong and alarming in a product whose
// whole subject is whether their things are still there. Absent is the correct
// rendering for unknown; zero is a different statement.

vi.mock('../src/i18n/useLocaleSync.js', () => ({ useLocaleSync: () => undefined }));
vi.mock('../src/components/AccountMenu.js', () => ({ AccountMenu: () => null }));
vi.mock('../src/components/CommandPalette.js', () => ({ CommandPalette: () => null }));

const listItems = vi.hoisted(() => vi.fn());
const listContacts = vi.hoisted(() => vi.fn());
vi.mock('../src/vault/api.js', () => ({ listItems }));
vi.mock('../src/contacts/api.js', () => ({ listContacts }));

function renderShell(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AppShell>
          <div />
        </AppShell>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('sidebar counts', () => {
  it('render the real counts once both lists resolve', async () => {
    listItems.mockResolvedValue({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    listContacts.mockResolvedValue({ contacts: [{ contactId: 'x' }] });
    renderShell();
    await waitFor(() => {
      const badges = screen.getAllByText(/^[0-9]+$/);
      expect(badges.map((b) => b.textContent)).toEqual(['3', '1']);
    });
  });

  // The failure this exists to prevent.
  it('render NOTHING rather than 0 while the lists are still loading', () => {
    listItems.mockReturnValue(new Promise(() => undefined));
    listContacts.mockReturnValue(new Promise(() => undefined));
    renderShell();
    expect(screen.queryByText('0')).toBeNull();
  });

  // NOTE the shape of the two tests below. Both pair the case under test with a
  // list that RESOLVES to a non-zero count, and wait for that badge to appear
  // before asserting. Waiting on static chrome instead ("Vault" is in the DOM
  // immediately) asserts before either query settles, so the assertion passes for
  // the wrong reason — which is exactly what the first draft of this file did:
  // deliberately removing the `count > 0` guard left all four tests green.
  it('render NOTHING rather than 0 when a list fails', async () => {
    listItems.mockRejectedValue(new Error('offline'));
    listContacts.mockResolvedValue({ contacts: [{ contactId: 'x' }, { contactId: 'y' }] });
    renderShell();
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    expect(screen.queryByText('0')).toBeNull();
  });

  // An empty vault is a KNOWN zero, and still not worth a badge: the number adds
  // nothing the empty state does not already say, and a lone "0" beside a nav
  // item reads as a defect.
  it('render no badge for a genuinely empty vault', async () => {
    listItems.mockResolvedValue({ items: [] });
    listContacts.mockResolvedValue({ contacts: [{ contactId: 'x' }, { contactId: 'y' }] });
    renderShell();
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    expect(screen.queryByText('0')).toBeNull();
  });
});
