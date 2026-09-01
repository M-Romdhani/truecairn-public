import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionable, CeremonyPortal, spent } from '../src/screens/ceremony/CeremonyPortal.js';
import type { CeremonyListItem } from '../src/ceremony/api.js';
import { toBase64 } from '@truecairn/crypto';

// ── docs/38 F5: the unseal key must not outlive the ceremony ──────────────────
//
// `discardEphemeral` had exactly ONE call site: the reconstruct success path
// inside the ceremony CARD. But a cancelled or failed ceremony fails
// `actionable()`, so it is filtered out of the list and its card never mounts —
// meaning the one discard could never run for precisely the ceremonies that
// ended without a reconstruction. The ephemeral secret stayed in localStorage
// indefinitely, and anything able to read that storage holds the key that
// unseals the shares.
//
// The safety property in the other direction matters just as much and is the
// reason this is not simply `!actionable()`: a ceremony that is 'released'
// while THIS recipient has not reconstructed yet must KEEP its key. The gate
// stays open for them server-side, and re-registering a different key is
// rejected (the shares are already sealed to the first one) — so discarding
// there would strand their retrieval permanently. Both directions are asserted.

const USER = 'user-1';
const keyFor = (id: string): string => `truecairn.ceremony-ephemeral.${USER}.${id}`;

// A REAL stored ephemeral: 32-byte X25519 halves in the same standard-base64
// the app writes. A placeholder like 'AA' is rejected by libsodium's decoder the
// moment a live ceremony's card mounts and calls loadEphemeral — which would
// make this suite fail on its fixture rather than on the behaviour under test.
const storedEphemeral = (): string =>
  JSON.stringify({
    publicKey: toBase64(new Uint8Array(32).fill(7)),
    secretKey: toBase64(new Uint8Array(32).fill(9)),
  });

vi.mock('../src/crypto/session.js', () => ({
  useSession: () => ({ userId: USER, status: 'unlocked' }),
}));

// The portal renders a ContinuityReportPanel per card; it is not under test.
vi.mock('../src/components/ContinuityReportPanel.js', () => ({
  ContinuityReportPanel: () => null,
}));

function ceremony(over: Partial<CeremonyListItem>): CeremonyListItem {
  return {
    ceremonyId: 'c-x',
    tier: 's2',
    status: 'reconstructing',
    myAffirmation: 'committed',
    myRevocationWindowExpiresAt: null,
    myRecipientStatus: 'pending',
    ...over,
  };
}

function renderWith(ceremonies: CeremonyListItem[]): void {
  const fetchImpl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/v1/ceremonies') && !u.includes('continuity')) {
      return new Response(JSON.stringify({ ceremonies }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Continuity report is recipient-gated; 404 is a normal answer here.
    return new Response(JSON.stringify({ title: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    });
  }) as unknown as typeof fetch;

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <CeremonyPortal fetchImpl={fetchImpl} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ceremony ephemeral discard on terminal states (F5)', () => {
  it('drops the ephemeral for a CANCELLED ceremony', async () => {
    localStorage.setItem(keyFor('c-cancelled'), storedEphemeral());
    renderWith([ceremony({ ceremonyId: 'c-cancelled', status: 'cancelled' })]);
    await waitFor(() => {
      expect(localStorage.getItem(keyFor('c-cancelled'))).toBeNull();
    });
  });

  it('drops the ephemeral for a FAILED ceremony', async () => {
    localStorage.setItem(keyFor('c-failed'), storedEphemeral());
    renderWith([ceremony({ ceremonyId: 'c-failed', status: 'failed' })]);
    await waitFor(() => {
      expect(localStorage.getItem(keyFor('c-failed'))).toBeNull();
    });
  });

  it('drops the ephemeral once THIS recipient has reconstructed', async () => {
    localStorage.setItem(keyFor('c-done'), storedEphemeral());
    renderWith([
      ceremony({ ceremonyId: 'c-done', status: 'released', myRecipientStatus: 'released' }),
    ]);
    await waitFor(() => {
      expect(localStorage.getItem(keyFor('c-done'))).toBeNull();
    });
  });

  // ── The two negatives, and how they were hollow until 2026-08-31 ───────────
  //
  // Both of these used `await waitFor(() => expect(key).not.toBeNull())` and
  // called it "giving the sweep every chance to run". It is the opposite:
  // waitFor resolves as soon as its callback does not throw, and this callback
  // is ALREADY TRUE on the first tick — before React has run the effect. So it
  // returned immediately and the assertion passed whether or not the sweep had
  // happened. An independent audit proved it by making spent() return true for
  // EVERY ceremony — discarding every key, live ones included — and both tests
  // still passed.
  //
  // The fix is to wait on something that must CHANGE. A control ceremony that
  // is unambiguously spent is seeded alongside; once its key is gone, the
  // effect has demonstrably run, and only then is the survival of the key under
  // test meaningful. Verified to bite: with spent() over-eager, these now fail.
  //
  // This is the direction that matters. Discarding here strands a recipient
  // permanently — their gate is still open server-side and re-registering a
  // different key is rejected, because the shares are already sealed to the
  // first one.
  it('KEEPS the ephemeral when the ceremony is released but this recipient has not reconstructed', async () => {
    localStorage.setItem(keyFor('c-open'), storedEphemeral());
    localStorage.setItem(keyFor('c-control'), storedEphemeral());
    renderWith([
      ceremony({ ceremonyId: 'c-open', status: 'released', myRecipientStatus: 'pending' }),
      ceremony({ ceremonyId: 'c-control', status: 'cancelled' }),
    ]);
    // The control disappearing is the proof the sweep ran at all.
    await waitFor(() => {
      expect(localStorage.getItem(keyFor('c-control'))).toBeNull();
    });
    expect(localStorage.getItem(keyFor('c-open'))).not.toBeNull();
  });

  it('KEEPS the ephemeral for a ceremony still in flight', async () => {
    localStorage.setItem(keyFor('c-live'), storedEphemeral());
    localStorage.setItem(keyFor('c-control'), storedEphemeral());
    renderWith([
      ceremony({ ceremonyId: 'c-live', status: 'reconstructing' }),
      ceremony({ ceremonyId: 'c-control', status: 'cancelled' }),
    ]);
    await waitFor(() => {
      expect(localStorage.getItem(keyFor('c-control'))).toBeNull();
    });
    expect(localStorage.getItem(keyFor('c-live'))).not.toBeNull();
  });

  it('sweeps a terminal ceremony without disturbing a live one alongside it', async () => {
    localStorage.setItem(keyFor('c-dead'), storedEphemeral());
    localStorage.setItem(keyFor('c-alive'), storedEphemeral());
    renderWith([
      ceremony({ ceremonyId: 'c-dead', status: 'cancelled' }),
      ceremony({ ceremonyId: 'c-alive', status: 'reconstructing' }),
    ]);
    await waitFor(() => {
      expect(localStorage.getItem(keyFor('c-dead'))).toBeNull();
    });
    expect(localStorage.getItem(keyFor('c-alive'))).not.toBeNull();
  });
});

// ── The coupling, made explicit ──────────────────────────────────────────────
//
// `spent` and `!actionable` return the same answer for every reachable input
// today. That is a fact worth pinning rather than a duplication worth removing:
// `actionable` governs DISPLAY and `spent` governs irreversible key DESTRUCTION,
// so if a future UI change widens `actionable` — a "recently finished" section,
// say — this test goes red and somebody has to decide what should happen to the
// keys, instead of the behaviour changing silently underneath the release path.
describe('spent() vs !actionable() — the equivalence is deliberate, not accidental', () => {
  const STATUSES = [
    'initiated',
    'collecting_affirmations',
    'awaiting_outer_key',
    'reconstructing',
    'released',
    'cancelled',
    'failed',
  ];
  const RECIPIENT = ['pending', 'reconstructing', 'released', 'failed'];

  it('agrees on every CeremonyStatus x RecipientReconstructionStatus pair', () => {
    const divergent: string[] = [];
    for (const status of STATUSES) {
      for (const myRecipientStatus of RECIPIENT) {
        const c = ceremony({ status, myRecipientStatus });
        if (spent(c) !== !actionable(c)) divergent.push(`${status}/${myRecipientStatus}`);
      }
    }
    expect(divergent).toEqual([]);
    expect(STATUSES.length * RECIPIENT.length).toBe(28);
  });
});
