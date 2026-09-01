import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, apiJson } from '../../api/client.js';
import { BrandMark } from '../../components/BrandMark.js';
import { Wordmark } from '../../components/Wordmark.js';
import { formatClock, formatTimestamp } from '../../lib/dates.js';
import './ops-system.css';

// ── The operations centre (/admin/system) ────────────────────────────────────
//
// Built around one question a generic status page never asks: **could a release
// ceremony complete right now?** For this product "the API is up" is nearly
// worthless — the job runs unattended on behalf of someone who cannot complain,
// and every component it depends on can fail silently while the web tier stays
// green.
//
// The composite at the top is a conjunction over the release-critical checks.
// The server decides it (packages/ops/system-status.ts); this page only renders.
// Two things it must never do: colour a tile green for something nothing
// actually checked, and show any user data. Both are enforced server-side and
// asserted in ops.test.ts — the page inherits them by having no data of its own.
//
// REDESIGNED 2026-08-06, and three of the changes are behaviour, not paint:
//
//   * ABSENCE IS NEVER A NUMBER. `queues: null` and `alerts: null` now mean "not
//     counted" and "not readable" and render as such. They used to arrive as six
//     zeros and an empty list — indistinguishable from a quiet, healthy system
//     during the exact outage where nothing could be counted at all.
//   * A FAILED REFRESH NO LONGER DESTROYS THE PAGE. This component used to check
//     `error !== null` before it looked at `data`, so one failed background
//     refetch replaced a working dashboard with "not available for your
//     account". The page whose entire purpose is to be readable when things are
//     broken told you that you were not an admin the moment the API hiccuped.
//     Now only a 404 means not-authorised; every other error keeps the last
//     payload on screen and marks it stale, with its age.
//   * NO EMOJI. State was carried by 🟢🟡🔴⚪, which renders differently on every
//     platform and is announced as "large green circle" by a screen reader.
//     Every state is now a CSS pip PLUS a text label, so it survives greyscale,
//     colour-blindness and audio.

type CheckState = 'ok' | 'degraded' | 'down' | 'unknown';

interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  releaseCritical: boolean;
  latencyMs?: number;
}

interface Queues {
  notificationsQueued: number;
  notificationsDeadLettered: number;
  oldestQueuedAgeSeconds: number | null;
  sensitiveActionsPending: number;
  sensitiveActionsOverdue: number;
  ceremoniesActive: number;
}

interface OpsStatus {
  continuityEngine: CheckState;
  continuitySummary: string;
  checks: Check[];
  versions: { api: string; worker: string | null; skew: boolean };
  // null when nothing could be counted — the database was unreachable. NOT
  // zeros: "0 queued" is a claim, and during that outage it is one we cannot
  // make. Same contract as `accounts` and `alerts` below.
  queues: Queues | null;
  accounts: { total: number; registeredToday: number; active: number; armed: number } | null;
  // null = the event log could not be read. [] = it was read and is empty.
  // These are different facts and this page renders them differently.
  alerts: Array<{ at: string; kind: string; detail: string }> | null;
  observedAt: string;
}

interface HealthBucket {
  at: string;
  severity: number | null;
  worstCheck: string | null;
}

interface HealthSeries {
  buckets: HealthBucket[];
  bucketMinutes: number;
  from: string;
  to: string;
  unobservedBuckets: number;
  measuringSince: string | null;
}

const STATE_CLASS: Record<CheckState, string> = {
  ok: 'is-ok',
  degraded: 'is-degraded',
  down: 'is-down',
  // Deliberately its own class, never sharing with ok: "we don't know" must not
  // read as "we're fine" in colour OR in greyscale (the pip is hollow+dashed).
  unknown: 'is-unknown',
};

const PILL_TEXT: Record<CheckState, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
};

// Severity as stored in status_samples (packages/ops/system-status.ts ORDER).
const SEVERITY_CLASS: Record<number, string> = {
  0: 's-ok',
  1: 's-unknown',
  2: 's-degraded',
  3: 's-down',
};

// ── Small formatting helpers ─────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} m` : `${m} m ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

function fmtRelative(at: string, now: number): string {
  return `${fmtDuration(now - new Date(at).getTime())} ago`;
}

// A clock that ticks so ages on screen stay true. The whole point of the stale
// state is that "4 m 12 s old" keeps counting up while the refresh keeps failing.
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

// ── Chrome ───────────────────────────────────────────────────────────────────
//
// Its own top bar rather than the app's sidebar (AppShell). Three reasons, and
// the first is functional: this page is reachable while the vault is LOCKED, so
// the app sidebar would sit next to it advertising Vault and Contacts links that
// bounce straight to /unlock. It also gets the sidebar's 248px back for a
// six-column chain, and a visibly different chrome means you can never mistake
// the system's state for your own account's.

function OpsChrome({
  tone,
  bar,
  children,
}: {
  tone: CheckState;
  bar: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`ops-page ops-tone-${tone}`}>
      <header className="ops-bar">{bar}</header>
      {children}
    </div>
  );
}

// The brand alone. Used by the not-authorised page, which must not name this
// surface — see OpsDenied.
function BrandOnly(): JSX.Element {
  return (
    <span className="ops-bar-left">
      <Link className="ops-brand" to="/home">
        <BrandMark />
        <Wordmark />
      </Link>
    </span>
  );
}

function OpsBarLeft(): JSX.Element {
  return (
    <span className="ops-bar-left">
      <Link className="ops-brand" to="/home">
        <BrandMark />
        <Wordmark />
      </Link>
      <span className="ops-bar-sep" />
      <span className="ops-bar-title">Operations</span>
      <span className="ops-bar-scope">admin only</span>
    </span>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

// The API answers a non-admin with 404 rather than 403 so an authenticated
// stranger cannot confirm this dashboard exists. The page has to keep that
// promise: it names no dashboard, no allowlist and no environment variable, and
// its chrome carries the brand ONLY — a bar reading "Operations · admin only"
// would give away precisely what the 404 withholds.
function OpsDenied(): JSX.Element {
  return (
    <OpsChrome tone="ok" bar={<BrandOnly />}>
      <div className="ops-denied" data-testid="ops-denied">
        <div className="ops-empty-line" />
        <h1>Not found</h1>
        <p>There is nothing at this address.</p>
        <p className="small t-3">
          If you typed it, check it. Otherwise there is nothing here to do.
        </p>
        <Link className="btn secondary" to="/vault">
          Go to your vault
        </Link>
      </div>
    </OpsChrome>
  );
}

// First load failed for a reason that is NOT "you may not see this" — the API is
// unreachable, or it answered 5xx. Distinct from OpsDenied on purpose: telling an
// admin they lack access because the server is down is the bug this redesign
// exists to remove, and it must not come back in a different shape.
function OpsUnreachable({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <OpsChrome tone="unknown" bar={<OpsBarLeft />}>
      <div className="ops-denied" data-testid="ops-unreachable">
        <div className="ops-empty-line" />
        <h1>No answer from the API</h1>
        <p>
          This page could not be loaded, so nothing below it can be trusted to be current. That is
          itself a signal: the API serves this dashboard, so it cannot report on its own absence.
        </p>
        <p className="small t-3">
          Check the platform dashboard and the worker heartbeat directly.
        </p>
        <button className="btn secondary" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    </OpsChrome>
  );
}

// The skeleton is the real layout at the real sizes — six chain nodes, six
// tiles, one strip — so nothing moves when the payload lands.
function OpsLoading(): JSX.Element {
  return (
    <OpsChrome tone="ok" bar={<OpsBarLeft />}>
      <div className="ops-head">
        <div className="ops-head-inner">
          <div className="ops-head-top">
            <div className="ops-head-left ops-sk-head">
              <span className="ops-sk ops-sk-pill" />
              <span className="ops-sk ops-sk-title" />
            </div>
            <div className="ops-head-meta ops-sk-stack">
              <span className="ops-sk ops-sk-meta" />
              <span className="ops-sk ops-sk-meta" />
            </div>
          </div>
          <div className="ops-chain">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="ops-sk ops-sk-node" />
            ))}
          </div>
          <p className="ops-head-note">{RELEASE_NEEDS}</p>
        </div>
      </div>
      <main className="ops-main">
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Supporting</h2>
            <span className="ops-rule" />
          </div>
          <div className="ops-grid-3">
            {Array.from({ length: 3 }, (_, i) => (
              <span key={i} className="ops-sk ops-sk-node" />
            ))}
          </div>
        </section>
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Queues</h2>
            <span className="ops-rule" />
          </div>
          <div className="card ops-clip">
            <div className="ops-tiles ops-tiles-6">
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className="ops-tile ops-sk-tile">
                  <span className="ops-sk ops-sk-line" />
                </span>
              ))}
            </div>
          </div>
        </section>
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Composite health</h2>
            <span className="ops-rule" />
          </div>
          <div className="card ops-tl-wrap">
            <span className="ops-sk ops-sk-strip" />
          </div>
        </section>
      </main>
    </OpsChrome>
  );
}

const RELEASE_NEEDS =
  'A release needs all of: the database, the worker driving it, initialised crypto, a working ' +
  'outer-layer key, audit signing, and some way to reach people. This is all of them, checked together.';

// ── Queue + account tiles ────────────────────────────────────────────────────

interface Tile {
  label: string;
  value: string;
  sub: string;
  valueClass?: string | undefined;
  warn?: boolean | undefined;
}

// The six "not counted" tiles. An em dash and a reason, never a zero.
const QUEUE_LABELS = [
  'Notifications queued',
  'Oldest queued',
  'Dead-lettered',
  'Actions pending',
  '…of which overdue',
  'Ceremonies active',
] as const;

function queueTiles(q: Queues): Tile[] {
  return [
    {
      label: 'Notifications queued',
      value: String(q.notificationsQueued),
      sub: q.notificationsQueued === 0 ? 'nothing waiting' : 'waiting on the worker',
    },
    {
      label: 'Oldest queued',
      value:
        q.oldestQueuedAgeSeconds === null ? '—' : fmtDuration(q.oldestQueuedAgeSeconds * 1000),
      sub: q.oldestQueuedAgeSeconds === null ? 'no queue to age' : 'since its next attempt was due',
      valueClass: q.oldestQueuedAgeSeconds === null ? 'is-none' : undefined,
    },
    {
      label: 'Dead-lettered',
      value: String(q.notificationsDeadLettered),
      // The one queue number that is a person not reached, rather than a person
      // not reached YET.
      sub:
        q.notificationsDeadLettered === 0
          ? 'none'
          : 'retries exhausted — nobody was reached',
      warn: q.notificationsDeadLettered > 0,
    },
    {
      label: 'Actions pending',
      value: String(q.sensitiveActionsPending),
      sub: q.sensitiveActionsPending === 0 ? 'none pending' : 'inside their delay',
    },
    {
      label: '…of which overdue',
      value: String(q.sensitiveActionsOverdue),
      sub:
        q.sensitiveActionsOverdue === 0
          ? 'none past due'
          : 'the worker is not applying them',
      warn: q.sensitiveActionsOverdue > 0,
    },
    {
      label: 'Ceremonies active',
      value: String(q.ceremoniesActive),
      sub: q.ceremoniesActive === 0 ? 'none in flight' : 'in flight',
    },
  ];
}

function TileGrid({
  tiles,
  columns,
  testId,
}: {
  tiles: Tile[];
  columns: 4 | 6;
  testId?: string;
}): JSX.Element {
  return (
    <div className={`ops-tiles ops-tiles-${columns}`} data-testid={testId}>
      {tiles.map((t) => (
        <div key={t.label} className={`ops-tile${t.warn === true ? ' is-warn' : ''}`}>
          <span className="ops-tile-label">{t.label}</span>
          <span className={`ops-tile-val${t.valueClass !== undefined ? ` ${t.valueClass}` : ''}${t.warn === true ? ' is-warn' : ''}`}>
            {t.value}
          </span>
          <span className={`ops-tile-sub${t.warn === true ? ' is-warn' : ''}`}>{t.sub}</span>
        </div>
      ))}
    </div>
  );
}

// ── The composite health strip ───────────────────────────────────────────────
//
// One element per display bucket. Composite ONLY — status_samples stores the
// release-path severity and the check that drove it, not per-check states, so
// there is no honest per-check strip to draw and this does not invent one.

function describeSeries(series: HealthSeries, labelFor: (id: string) => string): string {
  const { buckets, bucketMinutes } = series;
  if (buckets.length === 0) return 'No samples yet.';
  const bucketMs = bucketMinutes * 60_000;

  // The trailing run: what is true NOW is what the reader came for.
  const last = buckets[buckets.length - 1];
  if (last === undefined) return 'No samples yet.';
  let run = 1;
  for (let i = buckets.length - 2; i >= 0; i--) {
    if (buckets[i]?.severity === last.severity) run++;
    else break;
  }
  const span = fmtDuration(run * bucketMs);

  if (last.severity === null) {
    return (
      `No sample for the last ${span} — the worker writes these, so a missing stretch is part of ` +
      `the outage, not a gap in it.`
    );
  }
  const cause = last.worstCheck === null ? '' : `, driven by ${labelFor(last.worstCheck)}`;
  const head =
    last.severity === 0
      ? `Ok for the last ${span}.`
      : `${last.severity === 3 ? 'Down' : last.severity === 2 ? 'Degraded' : 'Unknown'} for the last ${span}${cause}.`;

  const unobserved = series.unobservedBuckets;
  if (unobserved === 0) return head;
  return `${head} ${fmtDuration(unobserved * bucketMs)} unsampled elsewhere in the window.`;
}

function HealthStrip({
  series,
  labelFor,
}: {
  series: HealthSeries;
  labelFor: (id: string) => string;
}): JSX.Element {
  const cells = useMemo(
    () =>
      series.buckets.map((b) => ({
        at: b.at,
        cls: b.severity === null ? 's-na' : (SEVERITY_CLASS[b.severity] ?? 's-unknown'),
      })),
    [series],
  );
  const axis = useMemo(() => {
    const from = new Date(series.from).getTime();
    const to = new Date(series.to).getTime();
    return [0, 0.25, 0.5, 0.75].map((f) => formatClock(from + (to - from) * f, false));
  }, [series]);

  return (
    <div className="card ops-tl-wrap">
      <div className="ops-tl" data-testid="health-strip">
        {cells.map((c) => (
          <span key={c.at} className={`ops-tl-s ${c.cls}`} />
        ))}
      </div>
      <div className="ops-tl-axis">
        {axis.map((t) => (
          <span key={t}>{t}</span>
        ))}
        <span>now</span>
      </div>
      <p className="ops-foot-note">{describeSeries(series, labelFor)}</p>
      <div className="ops-legend">
        <span className="ops-legend-item">
          <span className="ops-sw s-ok" />
          ok
        </span>
        <span className="ops-legend-item">
          <span className="ops-sw s-degraded" />
          degraded
        </span>
        <span className="ops-legend-item">
          <span className="ops-sw s-down" />
          down
        </span>
        <span className="ops-legend-item">
          <span className="ops-sw s-unknown" />
          unknown
        </span>
        <span className="ops-legend-item">
          <span className="ops-sw s-na" />
          no sample — the worker writes these, so a gap is part of the outage
        </span>
      </div>
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function OpsCenter(): JSX.Element {
  const system = useQuery<OpsStatus>({
    queryKey: ['ops-system'],
    queryFn: async () => apiJson<OpsStatus>(await api('/v1/ops/system')),
    // Operational data goes stale fast; a dashboard showing a cached green while
    // the worker is down would be worse than no dashboard.
    refetchInterval: 15_000,
    retry: false,
  });

  // 24 hours of history that moves once every five minutes has no business
  // riding the 15-second poll.
  const health = useQuery<{ series: HealthSeries | null }>({
    queryKey: ['ops-health-series'],
    queryFn: async () =>
      apiJson<{ series: HealthSeries | null }>(await api('/v1/ops/health-series')),
    refetchInterval: 300_000,
    retry: false,
  });

  const now = useNow();
  const data = system.data;

  // A 404 is the ONLY thing that means "not for you" — the API answers non-admins
  // that way deliberately. Everything else is an outage, and an outage must never
  // be reported as a permission problem.
  if (isNotFound(system.error)) return <OpsDenied />;
  if (data === undefined) {
    if (system.isError) return <OpsUnreachable onRetry={() => void system.refetch()} />;
    return <OpsLoading />;
  }

  const critical = data.checks.filter((c) => c.releaseCritical);
  const supporting = data.checks.filter((c) => !c.releaseCritical);
  const passing = critical.filter((c) => c.state === 'ok').length;
  const labelFor = (id: string): string =>
    data.checks.find((c) => c.id === id)?.label ?? id;

  // Stale = the payload on screen is real, the refresh that would confirm it is
  // not. We keep every number and say how old it is; discarding good data
  // because the next fetch failed is the bug this replaced.
  const stale = system.isError;
  const observedAge = now - new Date(data.observedAt).getTime();
  const tone = data.continuityEngine;

  return (
    <OpsChrome
      tone={tone}
      bar={
        <>
          <OpsBarLeft />
          <span className="ops-bar-right">
            <span className={`ops-live${stale ? ' is-failing' : ''}`}>
              <span className={`ops-pip sm ${stale ? 'is-degraded' : STATE_CLASS[tone]}`} />
              <span>{stale ? 'refresh failing ·' : 'auto · 15 s ·'}</span>
              <span className="ops-live-time">{formatClock(data.observedAt)}</span>
            </span>
            <button
              className="btn secondary sm"
              type="button"
              onClick={() => {
                void system.refetch();
                void health.refetch();
              }}
            >
              Re-run checks
            </button>
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => {
                // Exactly what is already on screen — no extra fields, nothing
                // the reader has not already been shown.
                void navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
              }}
            >
              Copy diagnostics
            </button>
          </span>
        </>
      }
    >
      {stale && (
        <div className="ops-stale" data-testid="ops-stale" role="status">
          <span className="ops-pip is-degraded" />
          <span>
            Showing the observation from{' '}
            <span className="ops-stale-age">{formatClock(data.observedAt)}</span>, now{' '}
            <span className="ops-stale-age">{fmtDuration(observedAge)}</span> old. The last{' '}
            {system.failureCount} refresh{system.failureCount === 1 ? '' : 'es'} failed.
          </span>
          <button className="btn secondary sm" type="button" onClick={() => void system.refetch()}>
            Re-run checks
          </button>
        </div>
      )}

      {/* The headline. Everything else on this page exists to explain it. */}
      <div className="ops-head">
        <div className="ops-head-inner">
          <div className="ops-head-top">
            <div
              className="ops-head-left"
              role="status"
              data-testid="continuity-status"
              data-state={tone}
            >
              <span className={`ops-pill ${STATE_CLASS[tone]}`}>
                <span className={`ops-pip ${STATE_CLASS[tone]}`} />
                {PILL_TEXT[tone]}
              </span>
              <h1 className="ops-summary">{data.continuitySummary}</h1>
            </div>
            <div className="ops-head-meta">
              <span className="ops-head-meta-big">
                {passing} of {critical.length} release-critical checks passing
              </span>
              <span className="ops-head-meta-small">
                observed {formatTimestamp(data.observedAt)}
              </span>
              <span className="ops-head-meta-small">
                {stale ? 'no successful re-check since' : 're-checks every 15 s'}
              </span>
            </div>
          </div>

          {/* The six release-critical checks drawn as a chain, because the
              composite is literally their conjunction: the link IS the AND. */}
          <div className="ops-chain">
            {critical.map((c) => (
              <div
                key={c.id}
                className={`ops-node ${STATE_CLASS[c.state]}`}
                data-testid={`check-${c.id}`}
              >
                <span className="ops-node-h">
                  <span className={`ops-pip ${STATE_CLASS[c.state]}`} />
                  <span className={`ops-statelabel ${STATE_CLASS[c.state]}`}>{c.state}</span>
                  {c.latencyMs !== undefined && (
                    <span className="ops-node-lat">{c.latencyMs} ms</span>
                  )}
                </span>
                <span className="ops-node-label">{c.label}</span>
                <p className="ops-node-detail">{c.detail}</p>
              </div>
            ))}
          </div>
          <p className="ops-head-note">{RELEASE_NEEDS}</p>
        </div>
      </div>

      <main className="ops-main" id="main-content">
        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Supporting</h2>
            <span className="ops-rule" />
            <span className="ops-sec-meta">
              not release-critical — a problem here does not stop a ceremony
            </span>
          </div>
          <div className="ops-grid-3">
            {supporting.map((c) => (
              <div
                key={c.id}
                className={`card ops-sup ${STATE_CLASS[c.state]}`}
                data-testid={`check-${c.id}`}
              >
                <span className="ops-sup-h">
                  <span className={`ops-pip ${STATE_CLASS[c.state]}`} />
                  <span className={`ops-statelabel ${STATE_CLASS[c.state]}`}>{c.state}</span>
                </span>
                <span className="ops-sup-label">{c.label}</span>
                <p className="ops-sup-detail">{c.detail}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Queues</h2>
            <span className="ops-rule" />
            <span className="ops-sec-meta">
              {data.queues === null
                ? 'not counted — the database could not be read'
                : `counted at ${formatClock(data.observedAt)}`}
            </span>
          </div>
          <div className="card ops-clip">
            {data.queues === null ? (
              <TileGrid
                testId="queues-unavailable"
                columns={6}
                tiles={QUEUE_LABELS.map((label) => ({
                  label,
                  value: '—',
                  sub: 'not counted',
                  valueClass: 'is-none',
                }))}
              />
            ) : (
              <TileGrid testId="queues" columns={6} tiles={queueTiles(data.queues)} />
            )}
          </div>
        </section>

        <div className="ops-grid-2">
          <section className="ops-sec">
            <div className="ops-sec-h">
              <h2>Accounts</h2>
              <span className="ops-rule" />
              <span className="ops-sec-meta">totals only</span>
            </div>
            <div className="card ops-clip">
              {data.accounts === null ? (
                // A sentence, not a zero: the only way this count fails is the
                // database being unreachable, and printing "0" there would
                // invent a fact — the same dishonesty as a green tile for
                // something nothing checked.
                <div className="ops-absent" data-testid="accounts-unavailable">
                  <span className="ops-pip is-unknown" />
                  <p>Not counted — the database could not be read. This is not zero.</p>
                </div>
              ) : (
                <TileGrid
                  testId="accounts"
                  columns={4}
                  tiles={[
                    { label: 'Registered', value: String(data.accounts.total), sub: 'all time' },
                    {
                      label: 'Registered today',
                      value: String(data.accounts.registeredToday),
                      sub: 'since 00:00 UTC',
                    },
                    {
                      label: 'Active',
                      value: String(data.accounts.active),
                      sub: 'account_status = active',
                    },
                    {
                      label: 'Armed',
                      value: String(data.accounts.armed),
                      sub: 'the engine is watching these',
                      valueClass: 'is-accent',
                    },
                  ]}
                />
              )}
            </div>
            <p className="ops-foot-note">
              Totals only. This dashboard has no per-account view and no way to look one up.
            </p>
          </section>

          <section className="ops-sec">
            <div className="ops-sec-h">
              <h2>Build</h2>
              <span className="ops-rule" />
            </div>
            <div className="card ops-build">
              <span className="ops-build-row">
                <span className="ops-build-k">API</span>
                <span className="ops-build-v">{data.versions.api}</span>
              </span>
              <span className="ops-build-row">
                <span className="ops-build-k">Worker</span>
                <span
                  className={`ops-build-v${data.versions.worker === null ? ' is-none' : ''}`}
                >
                  {data.versions.worker ?? 'unknown'}
                </span>
              </span>
              {data.versions.skew && (
                <p className="ops-skew" data-testid="version-skew">
                  <span className="ops-pip is-degraded" />
                  API and worker are running different builds — a deploy may have half-succeeded.
                </p>
              )}
            </div>
          </section>
        </div>

        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Composite health</h2>
            <span className="ops-rule" />
            <span className="ops-sec-meta">
              {health.data?.series == null
                ? 'not readable'
                : `last 24 h · ${health.data.series.bucketMinutes}-minute buckets · 90-day retention`}
            </span>
          </div>
          {health.data?.series == null ? (
            <div className="card ops-clip">
              <div className="ops-empty">
                <div className="ops-empty-line" />
                <p className="ops-sup-detail">
                  {health.isLoading
                    ? 'Reading the series…'
                    : 'Not readable — the health series lives in the database. This is not an absence of incidents.'}
                </p>
              </div>
            </div>
          ) : (
            <HealthStrip series={health.data.series} labelFor={labelFor} />
          )}
        </section>

        <section className="ops-sec">
          <div className="ops-sec-h">
            <h2>Recent operational events</h2>
            <span className="ops-rule" />
            <span className="ops-sec-meta">
              {data.alerts === null ? 'not readable' : 'up to 20, newest first'}
            </span>
          </div>
          <div className="card ops-clip">
            {data.alerts === null ? (
              // "Not readable" and "nothing happened" must never look the same.
              <div className="ops-empty" data-testid="alerts-unavailable">
                <div className="ops-empty-line" />
                <p className="ops-sup-detail">
                  Not readable — the event log lives in the database. This is not an empty log.
                </p>
              </div>
            ) : data.alerts.length === 0 ? (
              <div className="ops-empty">
                <div className="ops-empty-line" />
                <p className="ops-sup-detail">Nothing recorded.</p>
              </div>
            ) : (
              <div data-testid="alerts">
                {data.alerts.map((a, i) => (
                  <div key={`${a.at}-${i}`} className="ops-evt">
                    <span className="ops-evt-kind">{a.kind}</span>
                    <span className="ops-evt-to">{a.detail}</span>
                    <span className="ops-evt-time">
                      <span className="ops-evt-rel">{fmtRelative(a.at, now)}</span>
                      <span className="ops-evt-abs">{formatTimestamp(a.at)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="ops-foot-note">
            Event types and times only — this surface carries no user data by construction.
          </p>
        </section>
      </main>
    </OpsChrome>
  );
}
