import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../src/account/keyMaterial.js';
import { currentLocale, setLocale } from '../src/i18n/index.js';
import { useLocaleSync } from '../src/i18n/useLocaleSync.js';

// The three states in useLocaleSync (docs/40 Phase 1). State 3 is the one worth
// the test: doing NOTHING is the correct behaviour, and the natural
// implementation writes the default instead — which would restate every account
// in existence as having deliberately chosen English.

const fetchAccount = vi.fn<() => Promise<AccountInfo>>();
const setAccountLocale = vi.fn(async (locale: string) => ({ locale }));

vi.mock('../src/account/keyMaterial.js', () => ({
  fetchAccount: (): Promise<AccountInfo> => fetchAccount(),
}));
vi.mock('../src/account/api.js', () => ({
  setAccountLocale: (locale: string) => setAccountLocale(locale),
}));

const account = (locale: AccountInfo['locale']): AccountInfo => ({
  email: 'owner@example.com',
  displayName: null,
  title: null,
  locale,
});

function Harness(): JSX.Element {
  useLocaleSync();
  return <span data-testid="active">{currentLocale()}</span>;
}

const renderHarness = (): ReturnType<typeof render> => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider> as ReactElement,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(async () => {
  await setLocale('en');
  localStorage.clear();
});

describe('account language sync', () => {
  // State 1 — the account is the cross-device truth. Someone who chose Spanish
  // on their laptop must not meet English on their phone.
  it('adopts the language stored on the account', async () => {
    fetchAccount.mockResolvedValue(account('es'));
    const { getByTestId } = renderHarness();
    await waitFor(() => expect(getByTestId('active')).toHaveTextContent('es'));
    expect(setAccountLocale).not.toHaveBeenCalled();
  });

  // State 2 — a preference made in this browser before the account column
  // existed is migrated up, without asking the owner to choose twice.
  it('pushes up an explicit browser choice when the account has none', async () => {
    localStorage.setItem('truecairn.locale', 'es');
    fetchAccount.mockResolvedValue(account(null));
    renderHarness();
    await waitFor(() => expect(setAccountLocale).toHaveBeenCalledWith('es'));
  });

  // State 3 — THE one that matters. No stored account value and no explicit
  // browser choice means nobody has ever chosen, and an effect firing a write is
  // not a choice. The column must stay NULL.
  it('writes nothing when neither side holds a real choice', async () => {
    fetchAccount.mockResolvedValue(account(null));
    const { getByTestId } = renderHarness();
    await waitFor(() => expect(getByTestId('active')).toHaveTextContent('en'));
    // Give any stray effect a chance to fire before asserting the negative.
    await new Promise((r) => setTimeout(r, 50));
    expect(setAccountLocale).not.toHaveBeenCalled();
  });

  // A switch made AFTER the first reconciliation is a real choice and is stored.
  it('stores a language the owner picks after load', async () => {
    fetchAccount.mockResolvedValue(account('en'));
    const { getByTestId } = renderHarness();
    await waitFor(() => expect(getByTestId('active')).toHaveTextContent('en'));
    expect(setAccountLocale).not.toHaveBeenCalled();

    await setLocale('es');
    await waitFor(() => expect(setAccountLocale).toHaveBeenCalledWith('es'));
  });

  // A 401/500 on the account read must not blank the app or throw: the language
  // simply stays whatever this browser was already using.
  it('leaves the language alone when the account cannot be read', async () => {
    fetchAccount.mockRejectedValue(new Error('offline'));
    const { getByTestId } = renderHarness();
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId('active')).toHaveTextContent('en');
    expect(setAccountLocale).not.toHaveBeenCalled();
  });
});
