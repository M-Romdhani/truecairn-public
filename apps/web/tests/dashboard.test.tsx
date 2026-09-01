import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/screens/dashboard/Dashboard.js';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const ENGINE = {
  state: 'active',
  previousState: null,
  nextActionAt: null,
  snoozeUntil: null,
  enrolledContactCount: 0,
  pendingSensitiveActions: [],
};

// Anything a readiness case needs to differ on. Unstubbed routes still throw, which
// react-query surfaces as an errored query — the fail-soft path the component takes
// when a surface is off, so leaving one out is a meaningful default, not a gap.
interface Extras {
  readiness?: unknown;
  items?: unknown[];
  contacts?: unknown[];
}

// Dashboard takes no fetchImpl prop, so its queries use global fetch — stub it.
// NOTE: /v1/briefing is deliberately NOT stubbed. The dashboard no longer calls it
// (the card was retired 2026-08-07), so a request to it would fall through to the
// `unexpected` throw — which is what pins the retirement in `makes no call to the
// retired briefing endpoint` below.
function stubFetch(plan: unknown = { steps: [] }, extras: Extras = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/engine/status')) return json(ENGINE);
      if (u.includes('/v1/vault/items')) return json({ items: extras.items ?? [], nextCursor: null });
      if (u.includes('/v1/ai/readiness')) {
        if (extras.readiness === undefined) throw new Error('readiness not stubbed');
        return json(extras.readiness);
      }
      if (u.includes('/v1/ai/plan')) return json(plan);
      if (u.includes('/v1/contacts')) return json({ contacts: extras.contacts ?? [] });
      throw new Error(`unexpected ${u}`);
    }),
  );
}
// An account the LOCAL heuristic scores 100/100: items present, two verified
// contacts, engine active. Used to prove the server score overrides it.
const LOOKS_PERFECT: Extras = {
  items: [{ id: 'i1' }],
  contacts: [
    { id: 'c1', x25519Pubkey: 'k1' },
    { id: 'c2', x25519Pubkey: 'k2' },
  ],
};

function renderDash(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Dashboard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dashboard AI plan card', () => {
  it('makes no call to the retired briefing endpoint, and shows no briefing card', async () => {
    // The briefing was free prose doing the readiness explanation's job with less
    // behind it. Retired 2026-08-07. Two assertions because they fail differently:
    // the card could be deleted while the query survives (spend with nothing to
    // show), or the query removed while some other surface still renders one.
    stubFetch({ steps: [] });
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-briefing')).toBeNull();
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map((c) => String(c[0])).filter((u) => u.includes('/v1/briefing'))).toEqual([]);
  });

  it('renders AI plan steps with action links', async () => {
    stubFetch({
      steps: [{ kind: 'add_contact', title: 'Add a trusted contact', why: 'You have none yet.' }],
    });
    renderDash();
    await waitFor(() =>
      expect(screen.getByTestId('ai-plan')).toHaveTextContent(/Add a trusted contact/),
    );
    expect(screen.getByTestId('ai-plan')).toHaveTextContent(/You have none yet/);
  });

  it('omits the AI plan card when there are no steps and no failure', async () => {
    stubFetch({ steps: [] });
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-plan')).toBeNull();
  });

  it('shows a fail-soft message when the AI plan is unavailable (never silently hidden)', async () => {
    stubFetch({ steps: [], reason: 'unavailable' });
    renderDash();
    await waitFor(() =>
      expect(screen.getByTestId('ai-plan')).toHaveTextContent(/generate a plan just now/i),
    );
  });
});

// The server scorer (apps/api/src/ai/readiness.ts) reads share coverage, release-role
// diversity and beneficiary configuration — none of which this client can see. These
// pin that its verdict wins when present, and that its absence never degrades the
// page below what it showed before the report was wired in.
describe('dashboard continuity readiness (server-scored)', () => {
  it('overrides the local estimate and surfaces a blocker the client could never detect', async () => {
    // The local heuristic scores this account 100. The server knows every S3
    // share-holder shares one role, so a release consensus can never be diverse and
    // that tier can never reconstruct. Showing 100 here would be a lie.
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 80,
        gaps: [
          {
            code: 's3_role_diversity_unsatisfiable',
            severity: 'blocker',
            tier: 's3',
            detail: { distinctRoles: 1, needed: 2 },
          },
        ],
        explanation: 'One tier cannot reconstruct as configured.',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-06T00:00:00.000Z',
      },
    });
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toHaveTextContent('80'));
    expect(screen.getByText(/different role/i)).toBeInTheDocument();
    expect(screen.getByTestId('readiness-explanation')).toHaveTextContent(/cannot reconstruct/i);
  });

  // QA 2026-08-12 Bug 2. This screen called a contact "Verified" when it meant
  // "has published a key" — i.e. enrolled. That collided head-on with the
  // contact_key_unconfirmed checkup, which uses "confirmed" for the separate
  // out-of-band safety-number step: the panel showed a green Verified badge for
  // the very contact the checkup above it said to go and confirm.
  it('says "enrolled", never "verified", about a contact that has only published a key', async () => {
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 92,
        gaps: [{ code: 'contact_key_unconfirmed', severity: 'warning', detail: { count: 2 } }],
        explanation: 'Confirm your contacts’ security codes.',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-12T00:00:00.000Z',
      },
    });
    renderDash();
    await waitFor(() => expect(screen.getByText(/2 contacts · 2 enrolled/i)).toBeInTheDocument());
    // The word that used to contradict the checkup must not appear about contacts.
    // (`no_verified_channel` copy is a different subject and is not in this fixture.)
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    // And the checkup asking for confirmation is on the same screen — the pair is
    // the whole point: the badge and the checkup must not disagree.
    expect(screen.getByText(/awaiting confirmation/i)).toBeInTheDocument();
  });

  // QA 2026-08-11 §5. The page header and the Engine tile both asserted overall
  // health from engine LIVENESS alone, so "Everything is healthy." sat above a
  // 12/100 ring, "A release could not complete today", and an active blocker. The
  // engine being alive and the setup being sound are different claims.
  it('the header does not say "everything is healthy" while a blocker stands', async () => {
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 12,
        gaps: [{ code: 'no_verified_channel', severity: 'blocker' }],
        explanation: 'You have no verified way to be contacted.',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-11T00:00:00.000Z',
      },
    });
    renderDash();
    // Wait for the loaded state: the summary element exists immediately carrying
    // its pre-load fallback, so findByTestId alone would assert against that.
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-summary')).toHaveTextContent(/would stop a release completing/i),
    );
    expect(screen.getByTestId('dashboard-summary')).not.toHaveTextContent(/everything is healthy/i);
    // The Engine tile carried the same claim in miniature.
    expect(screen.queryByText('All healthy')).not.toBeInTheDocument();
    expect(screen.getByText('1 blocker')).toBeInTheDocument();
  });

  it('still says "everything is healthy" when the engine is active and nothing blocks', async () => {
    // The near-miss. A guard that never lets the page report health is not a fix,
    // it is the same defect with the sign flipped.
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 100,
        gaps: [],
        explanation: 'Your continuity setup looks complete.',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-11T00:00:00.000Z',
      },
    });
    renderDash();
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-summary')).toHaveTextContent(/everything is healthy/i),
    );
    expect(screen.getByText('All healthy')).toBeInTheDocument();
  });

  it('claims nothing about health when readiness is unavailable', async () => {
    // `readiness` unstubbed ⇒ the query errors ⇒ serverReadiness is null and
    // blockerCount is 0. Reporting "everything is healthy" off that is asserting
    // health from an ABSENT signal — the same mistake docs/38 names in its own
    // ranking rule, where `unknown` ranks worse than `open`.
    stubFetch({ steps: [] }, LOOKS_PERFECT);
    renderDash();
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-summary')).toHaveTextContent(/your engine is active/i),
    );
    expect(screen.getByTestId('dashboard-summary')).not.toHaveTextContent(/everything is healthy/i);
  });

  it('never reads as healthy while a blocker stands, even at the score a blocker produces', async () => {
    // QA finding F2 (docs/36 pass, 2026-08-07). One blocker deducts 20 from 100 and
    // the success band starts at 80, so the account whose S3 tier can never
    // reconstruct scored 80 IN GREEN — the exact reassurance this work removed at
    // 100/100, reappearing 20 points lower. The ring colour and the stated line are
    // keyed on the presence of a blocker, never on the number.
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 80,
        gaps: [
          {
            code: 's3_role_diversity_unsatisfiable',
            severity: 'blocker',
            tier: 's3',
            detail: { distinctRoles: 1, needed: 2 },
          },
        ],
        explanation: '',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-06T00:00:00.000Z',
      },
    });
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toHaveTextContent('80'));
    expect(screen.getByTestId('readiness-blocked')).toHaveTextContent(/could not complete/i);
    const ring = document.querySelector('.readiness-ring-fill');
    expect(ring?.getAttribute('stroke')).toBe('var(--warning)');
  });

  it('reads as healthy at the same score when the gaps are only warnings', async () => {
    // The other side of the rule: 80 is a good result when nothing BLOCKS a release,
    // so the fix must not simply paint every imperfect account amber.
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 84,
        gaps: [{ code: 'stale_items', severity: 'warning', detail: { count: 2 } }],
        explanation: '',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-06T00:00:00.000Z',
      },
    });
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toHaveTextContent('84'));
    expect(screen.queryByTestId('readiness-blocked')).toBeNull();
    const ring = document.querySelector('.readiness-ring-fill');
    expect(ring?.getAttribute('stroke')).toBe('var(--success)');
  });

  it('keeps the local estimate when the proposer flag is off — a disabled report never blanks the ring', async () => {
    // The flag-off shape is score 0 with no gaps. Trusting it would tell a healthy
    // owner they are at zero readiness.
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 0,
        gaps: [],
        explanation: 'AI proposals are not enabled.',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-06T00:00:00.000Z',
        reason: 'disabled',
      },
    });
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toHaveTextContent('100'));
    expect(screen.queryByTestId('readiness-explanation')).toBeNull();
  });

  it('keeps the local estimate when the readiness call fails outright (fail-soft)', async () => {
    stubFetch({ steps: [] }, LOOKS_PERFECT); // readiness unstubbed ⇒ throws
    renderDash();
    await waitFor(() => expect(screen.getByTestId('readiness-score')).toHaveTextContent('100'));
    expect(screen.queryByTestId('readiness-explanation')).toBeNull();
  });

  it('discloses AI only when the model actually wrote the explanation', async () => {
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 72,
        gaps: [{ code: 'checkin_overdue', severity: 'warning' }],
        explanation: 'Your check-in is overdue; confirming now stops the ladder.',
        llmWritten: true,
        model: 'gemini-2.5-flash',
        generatedAt: '2026-08-06T00:00:00.000Z',
      },
    });
    renderDash();
    const note = await waitFor(() => screen.getByTestId('readiness-explanation'));
    expect(within(note).getByTestId('ai-disclosure')).toBeInTheDocument();
  });

  it('renders the scorer numeric detail rather than any model-supplied text', async () => {
    stubFetch({ steps: [] }, {
      ...LOOKS_PERFECT,
      readiness: {
        score: 40,
        gaps: [
          {
            code: 's2_coverage_insufficient',
            severity: 'blocker',
            tier: 's2',
            detail: { assigned: 1, needed: 2 },
          },
        ],
        explanation: '',
        llmWritten: false,
        model: null,
        generatedAt: '2026-08-06T00:00:00.000Z',
      },
    });
    renderDash();
    await waitFor(() => expect(screen.getByText(/1 of 2 required contact shares/i)).toBeInTheDocument());
    // An empty explanation renders no note at all rather than an empty band.
    expect(screen.queryByTestId('readiness-explanation')).toBeNull();
  });
});
