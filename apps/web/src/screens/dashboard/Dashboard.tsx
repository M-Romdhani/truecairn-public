import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SVGProps } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { listContacts, type ContactRow } from '../../contacts/api.js';
import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';
import { decryptContactLabel } from '../../contacts/crypto.js';
import { getEngineStatus } from '../../engine/api.js';
import { listItems } from '../../vault/api.js';
import { decryptTitle } from '../../vault/crypto.js';
import { categoryLabel } from '../../lib/labels.js';
import {
  aiPlan,
  decideProposal,
  fetchReadiness,
  listProposals,
  type AiPlanStep,
  type AiProposal,
  type AiReadinessGap,
} from '../../ai/api.js';
import { AiDisclosure } from '../../ai/AiDisclosure.js';
import { CreateItem } from '../vault/CreateItem.js';
import { engineStateLabel } from '../../engine/states.js';
import { formatDate } from '../../lib/dates.js';
import { useT, type TFunction } from '../../i18n/useT.js';
import './Dashboard.css';

// The readiness gaps the scorer can emit. The server sends a CODE and numeric
// detail ONLY — never a label, never a link — so every word below is ours and
// lives in the catalog. Keep that property: a gap whose text came from the server
// could not be translated, and would also be a hole in the AI chokepoint
// (invariant 8) that this closed list is part of.
//
// The message keys are DERIVED from the code (`dash.gap.<code>.title`), so
// TypeScript checks the whole set against the catalog: adding a code here without
// adding its three messages is a compile error, and no lookup can silently miss.
const GAP_CODES = [
  'no_vault_items',
  'no_enrolled_contacts',
  's1_beneficiary_unset',
  's2_coverage_insufficient',
  's3_coverage_insufficient',
  's2_role_diversity_unsatisfiable',
  's3_role_diversity_unsatisfiable',
  's2_passphrase_slot_unset',
  'engine_not_armed',
  'checkin_overdue',
  'stale_items',
  'no_verified_channel',
  'contact_key_unconfirmed',
] as const;
type GapCode = (typeof GAP_CODES)[number];
const isGapCode = (code: string): code is GapCode =>
  (GAP_CODES as readonly string[]).includes(code);

// Where each gap is fixed. Only the ROUTE lives here now — the label, the
// explanation and the button text are all message keys derived from the code.
const GAP_ROUTE: Record<GapCode, string> = {
  no_vault_items: '/vault',
  no_enrolled_contacts: '/contacts',
  s1_beneficiary_unset: '/contacts',
  s2_coverage_insufficient: '/contacts',
  s3_coverage_insufficient: '/contacts',
  s2_role_diversity_unsatisfiable: '/contacts',
  s3_role_diversity_unsatisfiable: '/contacts',
  s2_passphrase_slot_unset: '/contacts',
  engine_not_armed: '/engine',
  checkin_overdue: '/engine',
  stale_items: '/vault',
  no_verified_channel: '/settings',
  contact_key_unconfirmed: '/contacts',
};

const gapTitle = (code: string, t: TFunction): string =>
  isGapCode(code) ? t(`dash.gap.${code}.title`) : t('dash.gap.unknown.title');
const gapCta = (code: string, t: TFunction): string =>
  isGapCode(code) ? t(`dash.gap.${code}.cta`) : t('dash.gap.unknown.cta');
const gapRoute = (code: string): string => (isGapCode(code) ? GAP_ROUTE[code] : '/engine');

// Sharpen a gap's explanation with the numbers the scorer measured, when it sent
// any. `detail` is numeric-only by construction, so this can never render free
// text. The number and its noun are one message per plural form rather than a
// stitched 's' — see the catalog note.
function gapSub(g: AiReadinessGap, t: TFunction): string {
  const base = isGapCode(g.code) ? t(`dash.gap.${g.code}.sub`) : t('dash.gap.unknown.sub');
  const d = g.detail ?? {};
  const assigned = d['assigned'];
  const needed = d['needed'];
  if (assigned !== undefined && needed !== undefined) {
    return t('dash.gap.detail.shares', { assigned, needed, base });
  }
  const count = d['count'];
  if (g.code === 'contact_key_unconfirmed' && count !== undefined) {
    return t('dash.gap.detail.awaiting', { count, base });
  }
  if (g.code === 'stale_items' && count !== undefined) {
    return t('dash.gap.detail.stale', { count, base });
  }
  return base;
}

function proposalLabel(p: AiProposal, t: TFunction): string {
  if (p.kind === 'flag_readiness_gap') return gapTitle(String(p.payload['gap'] ?? ''), t);
  if (p.kind === 'tighten_checkin_schedule') {
    return t('dash.proposals.label.tighten', {
      from: Number(p.payload['currentDays'] ?? 0),
      to: Number(p.payload['proposedDays'] ?? 0),
    });
  }
  if (p.kind === 'draft_contact_message') return t('dash.proposals.label.draftMessage');
  if (p.kind === 'suggest_metadata_recategorization') return t('dash.proposals.label.recategorize');
  return t('dash.proposals.label.unknown');
}

// The Home dashboard CONTENT (design follow-on #6) — rendered inside AppShell,
// which owns the sidebar chrome. Aggregates the REAL signals the backend exposes
// (engine status, vault item count, trusted contacts) into the designed
// readiness view. No invented data: the score and the "continuity checkups" are
// derived from actual account gaps; activity shows an honest empty state until
// an audit-feed API exists.

const sz = (p: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({ width: 14, height: 14, fill: 'none', ...p });
const IcPlus = () => <svg {...sz({})} viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
const IcDot = () => <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor"><circle cx="3" cy="3" r="2.5"/></svg>;

// Engine-state naming moved to ../../engine/states.ts, shared with the Engine
// screen. The map that lived here listed `grace`, `check_in_due`,
// `reconstructing` and `released` — four states ENGINE_STATES does not contain —
// while omitting seven that it does, so the most ordinary non-active state
// (check_in_pending) fell through to a snake_case fallback in both languages.

// ── "Everything is healthy" must not outrank the evidence (QA 2026-08-11 §5) ──
//
// Both of these used to key off `state === 'active'` alone — engine LIVENESS —
// and assert overall health from it. That let "Everything is healthy." sit at the
// top of a screen whose ring read 12/100, whose readiness card read "A release
// could not complete today", and whose checkup list carried a blocker. The engine
// being alive and the setup being sound are different claims, and only the first
// was being measured.
//
// Three states, not two, because the third has the same defect in a quieter form:
// when the readiness API is off or failed we have NO evidence either way, and
// asserting health from an absent signal is the same mistake docs/38 names in its
// own ranking rule — absence of evidence is not evidence of health. So an
// unknown-readiness dashboard states the engine fact and claims nothing beyond it.
function headerSummary(
  haveReadiness: boolean,
  blockerCount: number,
  next: string,
  t: TFunction,
): string {
  if (!haveReadiness) return t('dash.summary.unknownReadiness', { next });
  if (blockerCount === 0) return t('dash.summary.healthy', { next });
  return t('dash.summary.blockers', { count: blockerCount, next });
}

function engineSub(haveReadiness: boolean, blockerCount: number, t: TFunction): string {
  if (!haveReadiness) return t('dash.tile.engine.running');
  if (blockerCount === 0) return t('dash.tile.engine.allHealthy');
  return t('dash.tile.engine.blockers', { count: blockerCount });
}

function greeting(t: TFunction): string {
  const h = new Date().getHours();
  if (h < 12) return t('dash.greeting.morning');
  if (h < 18) return t('dash.greeting.afternoon');
  return t('dash.greeting.evening');
}

function nextCheckIn(nextActionAt: string | null, t: TFunction): { value: string; sub: string } {
  if (nextActionAt === null) {
    return { value: t('dash.nextCheckIn.none'), sub: t('dash.nextCheckIn.noneSub') };
  }
  const due = new Date(nextActionAt);
  const days = Math.round((due.getTime() - Date.now()) / 86_400_000);
  const value = days <= 0 ? t('dash.nextCheckIn.due') : t('dash.nextCheckIn.days', { days });
  return { value, sub: formatDate(due, { month: 'short', day: 'numeric' }) };
}

const CONTACT_ROLES = ['personal', 'professional', 'recovery'] as const;
const roleLabel = (role: string, t: TFunction): string =>
  (CONTACT_ROLES as readonly string[]).includes(role)
    ? t(`dash.role.${role as (typeof CONTACT_ROLES)[number]}`)
    : t('dash.role.fallback');

// Map each AI-plan step kind to a known in-app deep-link. A closed map (the API
// validates kind against the same allowlist) — the model can't smuggle a link,
// and its button text is ours, keyed off the kind.
const PLAN_ROUTE: Record<AiPlanStep['kind'], string> = {
  add_vault_item: '/vault',
  add_contact: '/contacts',
  enrol_contact: '/contacts',
  assign_shares: '/contacts',
  arm_engine: '/engine',
  review: '/engine',
};

// Home is a summary, not a second copy of the Vault and Contacts screens. Both
// cards show a handful and link to the whole list.
const VAULT_SHOWN = 4;
const CONTACTS_SHOWN = 4;

interface Checkup {
  // The gap this row came from, when the server produced it. Lets a row offer an
  // in-place fix for the gaps that have one, and fall back to a deep link for the
  // rest. Absent on the local fallback checkups, which are counts-only guesses.
  code?: string;
  // Stable React key. Titles can repeat once gaps fall back to generic copy, so the
  // list is keyed explicitly rather than by its rendered text.
  key: string;
  priority: 'high' | 'med' | 'low';
  title: string;
  sub: string;
  cta: string;
  to: string;
}

export function Dashboard(): JSX.Element {
  const t = useT();
  // Which checkup, if any, is open for an in-place fix.
  const [openCheckup, setOpenCheckup] = useState<string | null>(null);
  const engineQ = useQuery({ queryKey: ['dash', 'engine'], queryFn: () => getEngineStatus() });
  const vaultQ = useQuery({ queryKey: ['dash', 'vault'], queryFn: () => listItems() });
  const contactsQ = useQuery({ queryKey: ['dash', 'contacts'], queryFn: () => listContacts() });
  // The "AI readiness briefing" card lived here. Retired 2026-08-07: it was free
  // prose doing the same job as the readiness explanation below, on the same
  // screen, with less behind it. The explanation is anchored to a deterministic
  // score and typed gaps and falls back to a written template; the briefing was
  // ungrounded prose with no fallback. Two AI paragraphs about readiness on one
  // dashboard was one too many, and the weaker one went.
  // AI-prioritized, actionable next steps (deep-linked). Fail-soft to empty.
  const planQ = useQuery({ queryKey: ['dash', 'plan'], queryFn: () => aiPlan() });
  // AI proposals inbox (Phase 1). Empty (reason 'disabled') until AI_PROPOSER_ENABLED.
  const queryClient = useQueryClient();
  const proposalsQ = useQuery({ queryKey: ['dash', 'proposals'], queryFn: () => listProposals() });
  // Server-computed continuity readiness (plan §5). Its score and gaps are
  // deterministic and know what this client cannot: Shamir share coverage per tier,
  // release-role diversity, the S2 passphrase slot, S1 beneficiaries. Fail-soft — if
  // the proposer flag is off or the call fails we keep the local estimate below,
  // which is what the dashboard showed before this was wired in.
  const readinessQ = useQuery({ queryKey: ['dash', 'readiness'], queryFn: () => fetchReadiness() });
  const decideM = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      decideProposal(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dash', 'proposals'] }),
  });
  const proposals = proposalsQ.data?.proposals ?? [];

  const items = vaultQ.data?.items ?? [];
  const contacts: ContactRow[] = contactsQ.data?.contacts ?? [];
  const vaultCount = items.length;
  const contactCount = contacts.length;
  // ENROLLED, not verified (QA 2026-08-12 Bug 2). This counts contacts who have
  // published a key — it says nothing about whether the owner confirmed their
  // safety number out of band, which is the separate gate that actually decides
  // whether they can hold a release share (`key_pin_confirmed_at`, migration 0061).
  //
  // The word used to be "verified" on this screen, which collided head-on with the
  // new `contact_key_unconfirmed` checkup: the panel showed a green "Verified"
  // badge for the very contact the checkup above it said to go and confirm. Two
  // meanings of one word, contradicting each other on one screen, undermining
  // exactly the signal that checkup exists to raise.
  const enrolledCount = contacts.filter((c) => c.x25519Pubkey !== null).length;
  const pendingCount = contactCount - enrolledCount;
  const state = engineQ.data?.state ?? null;
  const next = nextCheckIn(engineQ.data?.nextActionAt ?? null, t);

  // Only trust the server report when the capability is actually on; 'disabled' is
  // the flag-off shape (score 0, no gaps) and must never blank the ring.
  const readiness = readinessQ.data;
  const serverReadiness = readiness !== undefined && readiness.reason !== 'disabled' ? readiness : null;

  // The pre-existing local estimate. Kept as the fail-soft fallback — it can only
  // see counts, so it cannot tell a reconstructible tier from an unreconstructible
  // one, which is exactly why the server score takes precedence when present.
  //
  // It credits ENROLLED contacts, and cannot see safety-number confirmation at
  // all — so on the fallback path it will read higher than the server would for an
  // owner whose contacts are enrolled but unconfirmed. Left as is deliberately:
  // this path only runs when the server report is unavailable, and the honest
  // alternative (blanking the ring) was rejected earlier for good reason. It is
  // an over-estimate on a degraded path, not a second opinion competing with the
  // server's — the server score always wins when present.
  let localScore = 0;
  if (vaultCount > 0) localScore += 30;
  if (contactCount >= 1) localScore += 20;
  localScore += enrolledCount >= 2 ? 25 : enrolledCount === 1 ? 12 : 0;
  if (state === 'active') localScore += 25;
  localScore = Math.min(100, localScore);

  const score = serverReadiness?.score ?? localScore;

  // A blocker means a release could not complete today. That is binary, not a
  // percentage — so the ring must never read as healthy while one stands, whatever
  // the arithmetic says. A single blocker deducts 20 from 100, and the success band
  // starts at 80, so it lands exactly in green: a tier whose contacts all share one
  // role (and so can never reconstruct) scores 80, which is the reassurance this
  // guard exists to remove.
  //
  // The empty vault used to score 80 here too. It scores 0 as of 2026-08-11 (F-04,
  // apps/api/src/ai/readiness.ts) — but this guard is not redundant and must stay:
  // it keys off the BLOCKER, not off any particular score, so it holds for every
  // blocker whose arithmetic happens to land in the green band.
  const blockerCount = serverReadiness?.gaps.filter((g) => g.severity === 'blocker').length ?? 0;
  const ringColor =
    blockerCount > 0
      ? 'var(--warning)'
      : score >= 80
        ? 'var(--success)'
        : score >= 50
          ? 'var(--accent)'
          : 'var(--warning)';
  const circ = 2 * Math.PI * 42;
  const offset = circ - (score / 100) * circ;

  const localCheckups: Checkup[] = [];
  if (vaultCount === 0)
    localCheckups.push({
      // The same gap the scorer calls `no_vault_items`, so the in-place fix is
      // offered on this path too. Without it the inline create appeared ONLY
      // when the AI proposer was on — and this fallback is what every owner with
      // AI off actually sees, which is the wrong half to leave without it.
      code: 'no_vault_items',
      key: 'local_no_items',
      priority: 'high',
      title: t('dash.checkups.local.noItems.title'),
      sub: t('dash.checkups.local.noItems.sub'),
      cta: t('dash.checkups.cta.add'),
      to: '/vault',
    });
  if (contactCount === 0)
    localCheckups.push({
      key: 'local_no_contacts',
      priority: 'high',
      title: t('dash.checkups.local.noContacts.title'),
      sub: t('dash.checkups.local.noContacts.sub'),
      cta: t('dash.checkups.cta.add'),
      to: '/contacts',
    });
  if (pendingCount > 0)
    // "only once their key is verified" was the same word-collision, and actively
    // wrong: finishing enrolment is necessary and NOT sufficient — the owner must
    // also confirm the safety number before that contact can hold a share.
    localCheckups.push({
      key: 'local_pending',
      priority: 'med',
      title: t('dash.checkups.local.pending.title', { count: pendingCount }),
      sub: t('dash.checkups.local.pending.sub'),
      cta: t('dash.checkups.cta.open'),
      to: '/contacts',
    });
  if (contactCount === 1 && pendingCount === 0)
    localCheckups.push({
      key: 'local_second_contact',
      priority: 'med',
      title: t('dash.checkups.local.secondContact.title'),
      sub: t('dash.checkups.local.secondContact.sub'),
      cta: t('dash.checkups.cta.add'),
      to: '/contacts',
    });

  // Server gaps become the checkup list when the report is available, blockers
  // first — a blocker means a release could not complete today, so it outranks
  // every warning regardless of the order the scorer emitted them in.
  const checkups: Checkup[] = serverReadiness
    ? serverReadiness.gaps
        .map((g, i) => ({
          key: `${g.code}_${g.tier ?? 'all'}_${i}`,
          code: g.code,
          priority: g.severity === 'blocker' ? ('high' as const) : ('med' as const),
          title: gapTitle(g.code, t),
          sub: gapSub(g, t),
          cta: gapCta(g.code, t),
          to: gapRoute(g.code),
        }))
        .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1))
    : localCheckups;

  // Which gaps the assistant raised, rather than the deterministic scorer. The
  // proposal payload names the gap code, so a row can say so instead of leaving
  // "why am I being told this" unanswered — and the disclosure below the list
  // then has something concrete to be about.
  const aiGapCodes = new Set(
    proposals
      .filter((p) => p.kind === 'flag_readiness_gap')
      .map((p) => String(p.payload['gap'] ?? '')),
  );

  const tiles = [
    {
      label: t('dash.tile.vaultItems'),
      value: String(vaultCount),
      sub: vaultCount === 0 ? t('dash.tile.vaultItems.empty') : t('dash.tile.vaultItems.sub'),
    },
    {
      label: t('dash.tile.contacts'),
      value: String(contactCount),
      sub:
        contactCount === 0
          ? t('dash.tile.contacts.empty')
          : t('dash.tile.contacts.sub', { count: enrolledCount }),
    },
    {
      label: t('dash.tile.engine'),
      value: engineStateLabel(state, t),
      // "All healthy" used to key off engine liveness alone, so it sat beside a
      // 12/100 ring and an active blocker on the same card (QA 2026-08-11 §5).
      // The engine being alive is not the same claim as the setup being sound,
      // and this tile was making the second while measuring the first.
      sub:
        state !== 'active'
          ? t('dash.tile.engine.liveness')
          : engineSub(serverReadiness !== null, blockerCount, t),
    },
    { label: t('dash.tile.nextCheckIn'), value: next.value, sub: next.sub },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <div className="hint">
            {formatDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          <h1 className="h-page">{greeting(t)}</h1>
          <p className="small t-2" data-testid="dashboard-summary">
            {state === 'active'
              ? headerSummary(serverReadiness !== null, blockerCount, next.value, t)
              : t('dash.summary.idle')}
          </p>
        </div>
        <div className="row gap-sm middle">
          <Link className="btn secondary sm" to="/vault">
            <IcPlus /> {t('dash.newItem')}
          </Link>
        </div>
      </header>

      <section className="card readiness">
        <div className="readiness-left">
          <svg width="120" height="120" viewBox="0 0 100 100" className="readiness-ring" aria-hidden="true">
            <circle cx="50" cy="50" r="42" stroke="var(--border)" strokeWidth="5" fill="none" />
            <circle
              cx="50"
              cy="50"
              r="42"
              className="readiness-ring-fill"
              stroke={ringColor}
              strokeWidth="5"
              fill="none"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          </svg>
          <div className="readiness-num">
            <div className="ro-val" data-testid="readiness-score">
              {score}
              <span className="ro-of">/100</span>
            </div>
            <div className="ro-cap">{t('dash.readiness.caption')}</div>
            {blockerCount > 0 && (
              <div className="ro-blocked" data-testid="readiness-blocked">
                {t('dash.readiness.blocked')}
              </div>
            )}
          </div>
        </div>
        <div className="readiness-grid">
          {tiles.map((t) => (
            <div className="tile" key={t.label}>
              <div className="tile-label">{t.label}</div>
              <div className="tile-val">{t.value}</div>
              <div className="tile-sub">{t.sub}</div>
            </div>
          ))}
        </div>
        {/* The scorer's own reading of the gaps above. Deterministic template unless
            the model rewrote it, which is the only case that warrants the disclosure. */}
        {serverReadiness !== null && serverReadiness.explanation !== '' && (
          <div className="readiness-note" data-testid="readiness-explanation">
            <p className="small t-2">{serverReadiness.explanation}</p>
            {serverReadiness.llmWritten && <AiDisclosure className="mt-xs" />}
          </div>
        )}
      </section>

      <div className="grid-2col">
        <div className="stack gap-md">
          <section className="card">
            <header className="card-h">
              <div>
                <h2 className="h-section">{t('dash.checkups.heading')}</h2>
                <p className="small">
                  {checkups.length === 0
                    ? t('dash.checkups.none')
                    : t('dash.checkups.count', { count: checkups.length })}
                </p>
              </div>
              {/* Blockers versus warnings, at a glance. A count alone flattens
                  "one thing would stop a release today" into the same shape as
                  "three things could be tidier". */}
              {checkups.length > 0 && (
                <div className="stack gap-xs checkup-steps">
                  <div className="steps" aria-hidden="true">
                    {checkups.map((c) => (
                      <span key={c.key} className={`seg${c.priority === 'high' ? ' blocker' : ''}`} />
                    ))}
                  </div>
                  {/* A RATIO, not a repeat. The header sentence above already
                      names the blocker count in words; saying it again beside
                      the strip is noise on screen, and it made "1 blocker"
                      ambiguous to anything selecting by text — which is how the
                      header's own safety test found it. */}
                  <div className="mono t-3" data-testid="checkup-ratio">
                    {blockerCount}/{checkups.length}
                  </div>
                </div>
              )}
            </header>
            {checkups.length === 0 ? (
              <div className="empty">
                <div className="empty-line" />
                <p className="small">{t('dash.checkups.emptyBody')}</p>
              </div>
            ) : (
              <ul className="list">
                {checkups.map((c) => {
                  // Only `no_vault_items` is fixed in place, and only because
                  // CreateItem is already a self-contained component that can be
                  // dropped in here whole. The other gaps end in flows this
                  // screen would have to REIMPLEMENT — the contact invite, the
                  // safety-number confirmation, the tier split — and a second
                  // copy of a crypto flow is a place for the two to drift apart.
                  // Those keep their deep link, which is not a lesser answer:
                  // it lands on the screen that owns the change.
                  const inline = c.code === 'no_vault_items';
                  const isOpen = openCheckup === c.key;
                  return (
                    <li className="list-row checkup-row" key={c.key}>
                      <div className="row middle gap-md w-full">
                        <span className={`prio prio-${c.priority}`}>
                          <IcDot />
                        </span>
                        <div className="stack min-w-0 flex-1">
                          <div className="row middle gap-sm wrap">
                            <span className="row-title">{c.title}</span>
                            {c.code !== undefined && aiGapCodes.has(c.code) && (
                              <span className="badge accent">{t('dash.checkups.aiSuggested')}</span>
                            )}
                          </div>
                          <div className="small mt-xs">{c.sub}</div>
                        </div>
                        {inline ? (
                          <button
                            type="button"
                            className={`btn ${c.priority === 'high' ? 'primary' : 'secondary'} sm`}
                            aria-expanded={isOpen}
                            onClick={() => setOpenCheckup(isOpen ? null : c.key)}
                            data-testid={`checkup-open-${c.code}`}
                          >
                            {isOpen ? t('dash.checkups.close') : c.cta}
                          </button>
                        ) : (
                          <Link
                            className={`btn ${c.priority === 'high' ? 'primary' : 'secondary'} sm`}
                            to={c.to}
                          >
                            {c.cta}
                          </Link>
                        )}
                      </div>
                      {inline && isOpen && (
                        <div className="checkup-panel" data-testid="checkup-panel">
                          {/* No onCancel: the row's own toggle above is the
                              close control, and two Close buttons on one panel
                              is a choice the reader has to make for no reason. */}
                          <CreateItem
                            onCreated={() => {
                              setOpenCheckup(null);
                              void queryClient.invalidateQueries({ queryKey: ['vault-items', ''] });
                              void queryClient.invalidateQueries({ queryKey: ['dash', 'readiness'] });
                            }}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Only when something on this list actually came from the model. A
                standing disclosure under a purely deterministic list would be
                telling people about a thing that did not happen. */}
            {aiGapCodes.size > 0 && (
              <div className="card-pad">
                <AiDisclosure />
              </div>
            )}
          </section>

          {((planQ.data?.steps.length ?? 0) > 0 || planQ.data?.reason === 'unavailable') && (
            <section className="card" data-testid="ai-plan">
              <header className="card-h">
                <div>
                  <h2 className="h-section">{t('dash.plan.heading')}</h2>
                  <p className="small">{t('dash.plan.sub')}</p>
                </div>
              </header>
              {(planQ.data?.steps.length ?? 0) > 0 ? (
                <ul className="list">
                  {planQ.data!.steps.map((s, i) => (
                    <li className="list-row" key={`${s.kind}-${i}`}>
                      <div className="stack flex-1 min-w-0">
                        <div className="row-title">{s.title}</div>
                        <div className="small t-2">{s.why}</div>
                      </div>
                      <Link className="btn secondary sm" to={PLAN_ROUTE[s.kind] ?? '/home'}>
                        {s.kind in PLAN_ROUTE
                          ? t(`dash.plan.cta.${s.kind}`)
                          : t('dash.plan.cta.fallback')}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="card-pad">
                  <p className="small t-2">{t('dash.plan.unavailable')}</p>
                </div>
              )}
            </section>
          )}

          {proposals.length > 0 && (
            <section className="card" data-testid="ai-proposals">
              <header className="card-h">
                <div>
                  <h2 className="h-section">{t('dash.proposals.heading')}</h2>
                  <p className="small">{t('dash.proposals.sub')}</p>
                </div>
              </header>
              <ul className="list">
                {proposals.map((p) => (
                  <li className="list-row" key={p.id}>
                    <div className="stack flex-1 min-w-0">
                      <div className="row-title">{proposalLabel(p, t)}</div>
                      <div className="small t-2">
                        {t('dash.proposals.suggested', {
                          date: formatDate(new Date(p.createdAt), {
                            month: 'short',
                            day: 'numeric',
                          }),
                        })}
                      </div>
                    </div>
                    <div className="row gap-sm middle">
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={decideM.isPending}
                        onClick={() => decideM.mutate({ id: p.id, decision: 'reject' })}
                      >
                        {t('dash.proposals.dismiss')}
                      </button>
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={decideM.isPending}
                        onClick={() => decideM.mutate({ id: p.id, decision: 'approve' })}
                      >
                        {t('dash.proposals.accept')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="card-pad">
                <AiDisclosure />
              </div>
            </section>
          )}

          <section className="card">
            <header className="card-h">
              <div>
                <h2 className="h-section">{t('dash.activity.heading')}</h2>
                <p className="small">{t('dash.activity.sub')}</p>
              </div>
            </header>
            <div className="empty">
              <div className="empty-line" />
              <p className="small">{t('dash.activity.empty')}</p>
            </div>
          </section>
        </div>

        <div className="stack gap-md">
          <section className="card">
            <header className="card-h">
              <div>
                <h2 className="h-section">{t('dash.contacts.heading')}</h2>
                <p className="small">
                  {t('dash.contacts.count', { count: contactCount, enrolled: enrolledCount })}
                </p>
              </div>
              <Link className="btn ghost sm" to="/contacts">
                <IcPlus /> {t('dash.contacts.add')}
              </Link>
            </header>
            {contactCount === 0 ? (
              <div className="empty">
                <div className="empty-line" />
                <p className="small">{t('dash.contacts.empty')}</p>
                <Link className="btn primary sm mt-md" to="/contacts">
                  {t('dash.contacts.addFirst')}
                </Link>
              </div>
            ) : (
              <ul className="list">
                {contacts.slice(0, CONTACTS_SHOWN).map((c) => {
                  const enrolled = c.x25519Pubkey !== null;
                  const role = roleLabel(c.role, t);
                  // Show the owner's real label for the contact (audit M12), the
                  // same decrypted name the Contacts page shows — not a generic
                  // role. Fall back to the role if the label can't be decrypted.
                  let name = role;
                  try {
                    const label = decryptContactLabel(c.displayLabelCiphertext, c.displayLabelNonce, c.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY);
                    if (label.trim() !== '') name = label;
                  } catch {
                    /* keep the role fallback */
                  }
                  return (
                    <li className="list-row" key={c.contactId}>
                      <div className="row middle gap-md flex-1 min-w-0">
                        <div className="avi" aria-hidden="true">
                          {name.charAt(0).toUpperCase()}
                        </div>
                        <div className="stack min-w-0">
                          <div className="row-title">{name}</div>
                          <div className="small">{role}</div>
                        </div>
                      </div>
                      {enrolled ? (
                        <span className="badge success">
                          <span className="dot" />
                          {t('dash.contacts.enrolled')}
                        </span>
                      ) : (
                        // A pending contact is not a status to read, it is a
                        // thing to finish — the badge alone left the next step
                        // unstated on the screen that exists to state next steps.
                        <Link className="btn secondary sm" to="/contacts">
                          {t('dash.contacts.finish')}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {contactCount > CONTACTS_SHOWN && (
              <div className="card-pad">
                <Link className="link" to="/contacts">
                  {t('dash.contacts.more', { count: contactCount - CONTACTS_SHOWN })}
                </Link>
              </div>
            )}
          </section>

          {/* The vault, which this screen never showed. Home summarised the vault
              as a COUNT in the readiness tile and then never named a single item,
              so the one place an owner lands had nothing of theirs on it. Titles
              are decrypted here, same as the vault list; content is never
              fetched. */}
          <section className="card" data-testid="dash-vault">
            <header className="card-h">
              <div>
                <h2 className="h-section">{t('dash.vault.heading')}</h2>
                <p className="small">{t('dash.vault.count', { count: vaultCount })}</p>
              </div>
              <Link className="btn ghost sm" to="/vault">
                <IcPlus /> {t('dash.vault.new')}
              </Link>
            </header>
            {vaultCount === 0 ? (
              <div className="empty">
                <div className="empty-line" />
                <p className="small">{t('dash.vault.empty')}</p>
                <Link className="btn primary sm mt-md" to="/vault">
                  {t('dash.vault.addFirst')}
                </Link>
              </div>
            ) : (
              <ul className="list">
                {items.slice(0, VAULT_SHOWN).map((it) => {
                  // EVERYTHING about a row is defensive, not just the decrypt.
                  // The first version read `it.tier.toUpperCase()` directly and
                  // threw on an item without one, and because this map runs
                  // during render that unmounted the ENTIRE home screen — the
                  // readiness ring, the checkups, the contacts, all of it, over a
                  // meta line. Same containment the vault list already applies to
                  // titles, extended to the whole row: a row degrades, the page
                  // survives.
                  let title: string | null;
                  try {
                    title = decryptTitle(it);
                  } catch {
                    title = null;
                  }
                  const meta = [
                    typeof it.tier === 'string' ? it.tier.toUpperCase() : null,
                    typeof it.category === 'string' ? categoryLabel(it.category) : null,
                  ].filter((x): x is string => x !== null);
                  return (
                    <li className="list-row" key={it.id}>
                      <Link className="vault-row-btn flex-1 min-w-0" to={`/vault/${it.id}`}>
                        {title ?? <span className="t-3">{t('vault.list.titleUnavailable')}</span>}
                      </Link>
                      {meta.length > 0 && <span className="vault-meta">{meta.join(' · ')}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            {vaultCount > VAULT_SHOWN && (
              <div className="card-pad">
                <Link className="link" to="/vault">
                  {t('dash.vault.more', { count: vaultCount - VAULT_SHOWN })}
                </Link>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
