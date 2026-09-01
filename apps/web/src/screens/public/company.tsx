import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans } from 'react-i18next';
import { PublicPage, type PubPill } from '../../site/PublicPage.js';
import { formatDate } from '../../lib/dates.js';
import { CONTACT_EMAIL, SECURITY_EMAIL } from '../../site/links.js';
import {
  useLiveStatus,
  type CheckState,
  type LiveAvailability,
  type LiveStatus,
} from './live-status.js';
import { SourceLangLink } from '../../site/SourceLangLink.js';
import { useT, type TFunction, type TranslationKey } from '../../i18n/useT.js';

// Public COMPANY pages. We build only what is real: an honest "about", a contact
// address, a press kit that ships only assets and facts we can stand behind, and
// a status page whose numbers are measured rather than asserted. No invented
// customers, testimonials, logos, press coverage, uptime figures, or incident
// history. Copy lives in the PAGES catalog half (docs/40 Phase 2), and the
// editing rules for each page are written down beside it there — they bind a
// translation at least as hard as they bind the English.

// Sibling-page pill nav shared by the company family.
function useCompanyPills(): readonly PubPill[] {
  const t = useT();
  return [
    { to: '/company/about', label: t('site.company.pill.about') },
    { to: '/company/contact', label: t('site.company.pill.contact') },
    { to: '/company/press', label: t('site.company.pill.press') },
    { to: '/status', label: t('site.company.pill.status') },
  ];
}

export function About(): JSX.Element {
  const t = useT();
  return (
    <PublicPage
      eyebrow={t('site.company.about.eyebrow')}
      title={t('site.company.about.title')}
      pills={useCompanyPills()}
      current="/company/about"
    >
      <p>{t('site.company.about.p1')}</p>
      <p>{t('site.company.about.p2')}</p>
      <p>
        <Trans
          i18nKey="site.company.about.p3"
          components={{
            model: <Link to="/security" />,
            threat: <Link to="/security/threat-model" />,
          }}
        />
      </p>
    </PublicPage>
  );
}

export function Contact(): JSX.Element {
  const t = useT();
  return (
    <PublicPage
      eyebrow={t('site.company.contact.eyebrow')}
      title={t('site.company.contact.title')}
      pills={useCompanyPills()}
      current="/company/contact"
    >
      <p>{t('site.company.contact.lede')}</p>
      <ul>
        <li>
          <Trans
            i18nKey="site.company.contact.general"
            values={{ email: CONTACT_EMAIL }}
            components={{ strong: <strong />, email: <a href={`mailto:${CONTACT_EMAIL}`} /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.contact.security"
            values={{ email: SECURITY_EMAIL }}
            components={{
              strong: <strong />,
              email: <a href={`mailto:${SECURITY_EMAIL}`} />,
              disclosure: <Link to="/security/disclosure" />,
            }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.contact.press"
            components={{ strong: <strong />, press: <Link to="/company/press" /> }}
          />
        </li>
      </ul>
      <p>{t('site.company.contact.neverEmail')}</p>
    </PublicPage>
  );
}

// ── Press ────────────────────────────────────────────────────────────────────
// The approved boilerplate, verbatim, with copy buttons — a journalist should be
// able to quote us without a call. Both strings are ALSO the on-page text, so the
// thing they copy is the thing they read; there is no second, rosier version.
// Which is why they are ordinary catalog keys: a translated press kit has to be
// quotable in that language too, carrying exactly the same claims.

// `Legal name: Truecairn, Inc.` and `Offices: San Francisco and Berlin` stood
// here until 2026-08-13 and were both false: no company has been incorporated
// (docs/31 §1) and there are no offices in either city. `Operated by` replaces
// the pair with the one thing that is true. It reads oddly plain for a press
// page, which is the point — this table already volunteers "Nothing announced"
// and "No third-party audit published", and a journalist who trusts those two
// is trusting them because rows like this one are here.
function useFacts(t: TFunction): readonly { k: string; v: string }[] {
  return [
    { k: t('site.company.press.facts.operatedBy.k'), v: t('site.company.press.facts.operatedBy.v') },
    { k: t('site.company.press.facts.whatItIs.k'), v: t('site.company.press.facts.whatItIs.v') },
    { k: t('site.company.press.facts.licence.k'), v: t('site.company.press.facts.licence.v') },
    { k: t('site.company.press.facts.status.k'), v: t('site.company.press.facts.status.v') },
    { k: t('site.company.press.facts.funding.k'), v: t('site.company.press.facts.funding.v') },
    { k: t('site.company.press.facts.audit.k'), v: t('site.company.press.facts.audit.v') },
    { k: t('site.company.press.facts.contact.k'), v: CONTACT_EMAIL },
  ];
}

// The wordmark's "ai" has its OWN blue, deeper than the UI accent — see the note
// on `wordmarkAi` in apps/mobile/lib/src/theme/tokens.dart and `.wm-ai` in
// design-system.css. Publishing it as a separate swatch is the point: a reader who
// assumed it was the accent would set the wordmark a shade wrong.
function useSwatches(t: TFunction): readonly { name: string; hex: string; cls: string }[] {
  return [
    { name: t('site.company.press.swatch.accent'), hex: '#2743F0', cls: 'accent' },
    { name: t('site.company.press.swatch.accentHover'), hex: '#1D33C4', cls: 'accent-hover' },
    { name: t('site.company.press.swatch.wordmarkAi'), hex: '#002FD7', cls: 'wordmark-ai' },
    { name: t('site.company.press.swatch.ink'), hex: '#12142B', cls: 'ink' },
    { name: t('site.company.press.swatch.sheet'), hex: '#FAFAF9', cls: 'sheet' },
  ];
}

// The brand marks, served from apps/web/public/assets/brand — the SAME files the
// app itself uses, so a download can never drift from what we ship.
function useMarks(
  t: TFunction,
): readonly { file: string; name: string; note: string; frame: string; size: number }[] {
  return [
    {
      file: 'mark.svg',
      name: t('site.company.press.marks.full.name'),
      note: t('site.company.press.marks.full.note'),
      frame: 'light',
      size: 52,
    },
    {
      file: 'mark-inverse.svg',
      name: t('site.company.press.marks.inverse.name'),
      note: t('site.company.press.marks.inverse.note'),
      frame: 'ink',
      size: 52,
    },
    {
      file: 'mark-mono.svg',
      name: t('site.company.press.marks.mono.name'),
      note: t('site.company.press.marks.mono.note'),
      frame: 'mono',
      size: 52,
    },
    // The icon carries its own rounded plate, so it is drawn a size up — at 52 the
    // mark inside it reads as a smudge.
    {
      file: 'app-icon.svg',
      name: t('site.company.press.marks.icon.name'),
      note: t('site.company.press.marks.icon.note'),
      frame: 'light',
      size: 64,
    },
  ];
}

function useShots(t: TFunction): readonly { file: string; name: string }[] {
  return [
    { file: 'dashboard-preview.png', name: t('site.company.press.shots.dashboard') },
    { file: 'vault-preview.png', name: t('site.company.press.shots.vault') },
    { file: 'ceremony-preview.png', name: t('site.company.press.shots.ceremony') },
  ];
}

// A copy-to-clipboard button that reports back in its own label. Clipboard writes
// can be refused (permissions, insecure context, older browsers), so a failure
// says so rather than showing a "Copied" that did not happen — the text is on the
// page in full either way, so the fallback is simply to select it.
function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const t = useT();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    const reset = (next: 'done' | 'failed'): void => {
      setState(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2200);
    };
    void navigator.clipboard
      ?.writeText(text)
      .then(() => reset('done'))
      .catch(() => reset('failed'));
    if (navigator.clipboard === undefined) reset('failed');
  }, [text]);

  return (
    <button
      type="button"
      className="pr-copy-btn"
      onClick={copy}
      aria-label={t('site.company.press.copyAria', { label })}
    >
      {state === 'done'
        ? t('site.company.press.copied')
        : state === 'failed'
          ? t('site.company.press.copyFailed')
          : t('site.company.press.copy')}
    </button>
  );
}

function Boilerplate({
  meta,
  text,
  label,
}: {
  meta: string;
  text: string;
  label: string;
}): JSX.Element {
  return (
    <div className="pr-copy">
      <div className="pr-copy-head">
        <span className="pr-copy-meta">{meta}</span>
        <CopyButton text={text} label={label} />
      </div>
      <p className="pr-copy-body">{text}</p>
    </div>
  );
}

export function Press(): JSX.Element {
  const t = useT();
  const facts = useFacts(t);
  const swatches = useSwatches(t);
  const marks = useMarks(t);
  const shots = useShots(t);
  const boilerplateShort = t('site.company.press.boilerplateShort');
  const boilerplateLong = t('site.company.press.boilerplateLong');

  return (
    <PublicPage
      eyebrow={t('site.company.press.eyebrow')}
      title={t('site.company.press.title')}
      pills={useCompanyPills()}
      current="/company/press"
    >
      <p className="pub-lede">{t('site.company.press.lede')}</p>

      <div className="pr-actions">
        <a className="btn primary" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        <a className="btn ghost" href="#assets">
          {t('site.company.press.brandAssetsCta')}
        </a>
      </div>
      <p className="pub-fine">{t('site.company.press.oneAddress')}</p>

      <h2 id="story">{t('site.company.press.story.title')}</h2>
      <p>{t('site.company.press.story.p1')}</p>
      <p>{t('site.company.press.story.p2')}</p>

      <div className="pub-note">
        <p>
          <Trans i18nKey="site.company.press.quotable" components={{ strong: <strong /> }} />
        </p>
      </div>

      <h2 id="boilerplate">{t('site.company.press.boilerplate.title')}</h2>
      <p>{t('site.company.press.boilerplate.lede')}</p>
      {/* The word counts are counts of the string actually rendered, so a
          translated boilerplate advertises its own length rather than the
          English one. A journalist working to a word budget is the reason the
          number is on the page at all. */}
      <Boilerplate
        meta={t('site.company.press.boilerplate.shortMeta', {
          words: boilerplateShort.split(/\s+/).length,
        })}
        text={boilerplateShort}
        label={t('site.company.press.boilerplate.shortLabel')}
      />
      <Boilerplate
        meta={t('site.company.press.boilerplate.longMeta', {
          words: boilerplateLong.split(/\s+/).length,
        })}
        text={boilerplateLong}
        label={t('site.company.press.boilerplate.longLabel')}
      />

      <h2 id="facts">{t('site.company.press.facts.title')}</h2>
      <div className="pr-facts">
        {facts.map((row) => (
          <div className="pr-fact" key={row.k}>
            <span className="pr-fact-k">{row.k}</span>
            <span className="pr-fact-v">{row.v}</span>
          </div>
        ))}
      </div>
      <p className="pub-fine">{t('site.company.press.facts.codename')}</p>

      <h2 id="assets">{t('site.company.press.assets.title')}</h2>
      <p>
        <Trans
          i18nKey="site.company.press.assets.lede"
          components={{ strong: <strong />, code: <code />, ai: <Link to="/security/ai" /> }}
        />
      </p>

      <div className="pr-assets">
        {marks.map((m) => (
          <div className="pr-asset" key={m.file}>
            <div className={`pr-asset-frame ${m.frame}`}>
              <img src={`/assets/brand/${m.file}`} alt={m.name} width={m.size} height={m.size} />
            </div>
            <div className="pr-asset-meta">
              <span className="pr-asset-name">{m.name}</span>
              <span className="pr-asset-file">
                {m.file} · {m.note}
              </span>
              <a className="pr-dl" href={`/assets/brand/${m.file}`} download>
                {t('site.company.press.downloadSvg')}
              </a>
            </div>
          </div>
        ))}
      </div>

      <h3>{t('site.company.press.colour.title')}</h3>
      <div className="pr-swatches">
        {swatches.map((sw) => (
          <div className="pr-swatch" key={sw.hex}>
            <span className={`pr-swatch-chip ${sw.cls}`} aria-hidden="true" />
            <span className="pr-swatch-text">
              <span className="pr-swatch-name">{sw.name}</span>
              <span className="pr-swatch-hex">{sw.hex}</span>
            </span>
          </div>
        ))}
      </div>
      <p>
        <Trans i18nKey="site.company.press.type" components={{ strong: <strong /> }} />
      </p>

      <h2 id="screenshots">{t('site.company.press.shots.title')}</h2>
      <p>{t('site.company.press.shots.lede')}</p>
      <div className="pr-shots">
        {shots.map((sh) => (
          <div className="pr-asset" key={sh.file}>
            <img className="pr-shot" src={`/assets/landing/${sh.file}`} alt={sh.name} />
            <div className="pr-asset-meta">
              <span className="pr-asset-name">{sh.name}</span>
              <a className="pr-dl" href={`/assets/landing/${sh.file}`} download>
                {t('site.company.press.downloadPng')}
              </a>
            </div>
          </div>
        ))}
      </div>

      <h2 id="claims">{t('site.company.press.claims.title')}</h2>
      <p>{t('site.company.press.claims.lede')}</p>
      <ul>
        <li>
          <Trans
            i18nKey="site.company.press.claims.willSay"
            components={{
              strong: <strong />,
              em: <em />,
              model: <Link to="/security" />,
              threat: <Link to="/security/threat-model" />,
              build: <Link to="/security/build" />,
            }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.press.claims.willNotSay"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.press.claims.noCustomers"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.press.claims.noAudit"
            components={{ strong: <strong />, audits: <Link to="/security#audits" /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.press.claims.noCoverage"
            components={{ strong: <strong /> }}
          />
        </li>
      </ul>

      <h2 id="contact">{t('site.company.press.reach.title')}</h2>
      <ul>
        <li>
          <Trans
            i18nKey="site.company.press.reach.press"
            values={{ email: CONTACT_EMAIL }}
            components={{ strong: <strong />, email: <a href={`mailto:${CONTACT_EMAIL}`} /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.company.press.reach.security"
            values={{ email: SECURITY_EMAIL }}
            components={{
              strong: <strong />,
              email: <a href={`mailto:${SECURITY_EMAIL}`} />,
              disclosure: <Link to="/security/disclosure" />,
            }}
          />
        </li>
      </ul>
      <p>{t('site.company.press.reach.deadline')}</p>
    </PublicPage>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────
// Live as of 2026-07-30. The page reads GET /v1/status — the public projection
// of the internal operations dashboard (packages/ops/src/public-status.ts).
//
// THE PROSE LIVES IN THE CATALOG, NOT ON THE SERVER. The route sends IDs, enums
// and integers and no sentences at all, because every detail string the internal
// dashboard composes is interpolated from a live count ("3 delivery(s) dead-
// lettered", the active KEK id). So each entry below carries its own
// explanation and is matched to a live state by `id`. If a check moves in
// packages/ops, this page moves with it — an id with no entry here renders with
// its server-supplied label and no prose, never silently disappears.

function useWatched(
  t: TFunction,
): readonly { id: string | null; name: string; detail: string; critical: boolean }[] {
  return [
    {
      id: 'worker',
      name: t('site.status.watch.worker.name'),
      detail: t('site.status.watch.worker.detail'),
      critical: true,
    },
    {
      id: 'database',
      name: t('site.status.watch.database.name'),
      detail: t('site.status.watch.database.detail'),
      critical: true,
    },
    {
      id: 'outer_layer_kek',
      name: t('site.status.watch.outerLayerKek.name'),
      detail: t('site.status.watch.outerLayerKek.detail'),
      critical: true,
    },
    {
      id: 'crypto',
      name: t('site.status.watch.crypto.name'),
      detail: t('site.status.watch.crypto.detail'),
      critical: true,
    },
    {
      id: 'audit_signing',
      name: t('site.status.watch.auditSigning.name'),
      detail: t('site.status.watch.auditSigning.detail'),
      critical: true,
    },
    {
      id: 'notifications',
      name: t('site.status.watch.notifications.name'),
      detail: t('site.status.watch.notifications.detail'),
      critical: true,
    },
    {
      id: 'audit_chain',
      name: t('site.status.watch.auditChain.name'),
      detail: t('site.status.watch.auditChain.detail'),
      critical: false,
    },
    {
      id: 'backups',
      name: t('site.status.watch.backups.name'),
      detail: t('site.status.watch.backups.detail'),
      critical: false,
    },
    {
      id: null,
      name: t('site.status.watch.api.name'),
      detail: t('site.status.watch.api.detail'),
      critical: false,
    },
  ];
}

// The four dot states. `label` is looked up rather than hardcoded because it is
// used TWICE — as the legend below and as the spoken state inside each dot's
// aria-label — and a legend whose words disagree with what a screen reader says
// is worse than an untranslated one.
const STATE_LABEL: Record<CheckState, TranslationKey> = {
  ok: 'site.status.state.ok.label',
  degraded: 'site.status.state.degraded.label',
  down: 'site.status.state.down.label',
  unknown: 'site.status.state.unknown.label',
};

function useStates(t: TFunction): readonly { label: string; meaning: string; cls: string }[] {
  return [
    { label: t('site.status.state.ok.label'), meaning: t('site.status.state.ok.meaning'), cls: 'ok' },
    {
      label: t('site.status.state.degraded.label'),
      meaning: t('site.status.state.degraded.meaning'),
      cls: 'degraded',
    },
    {
      label: t('site.status.state.down.label'),
      meaning: t('site.status.state.down.meaning'),
      cls: 'down',
    },
    {
      label: t('site.status.state.unknown.label'),
      meaning: t('site.status.state.unknown.meaning'),
      cls: 'unknown',
    },
  ];
}

// The one-line verdict, phrased from the composite. Written as four separate
// catalog entries rather than assembled from fragments so each state reads like
// a sentence a person wrote — and so 'unknown' gets its own wording instead of
// being described as a degree of working.
const VERDICT_KEY: Record<CheckState, TranslationKey> = {
  ok: 'site.status.verdict.ok',
  degraded: 'site.status.verdict.degraded',
  down: 'site.status.verdict.down',
  unknown: 'site.status.verdict.unknown',
};

function LiveHeadline({
  status,
  failed,
}: {
  status: LiveStatus | null;
  failed: boolean;
}): JSX.Element {
  const t = useT();
  // Reaching this page proves the web tier is up but says nothing about the
  // engine, so a failed fetch is reported as unknown — never as fine.
  const state: CheckState = failed || status === null ? 'unknown' : status.releasePath;
  return (
    <div className="st-live-head">
      <span className={`st-dot ${state}`} aria-hidden="true" />
      <p className="st-live-verdict">
        {failed || status === null
          ? t('site.status.verdict.unavailable')
          : t(VERDICT_KEY[state])}
      </p>
    </div>
  );
}

function Availability({ a }: { a: LiveAvailability }): JSX.Element {
  const t = useT();
  // Three honest cases, and the first two are the common ones early on. A
  // placeholder number would defeat the entire point of the series.
  //
  // `since` is derived AFTER the null check rather than above it: TypeScript
  // narrows `a.measuringSince`, not a separate const computed from it, so
  // hoisting the format left every later use typed `string | null`.
  if (a.measuringSince === null) {
    return <p className="st-avail-none">{t('site.status.availability.notStarted')}</p>;
  }
  const since = formatDate(a.measuringSince, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  if (a.releasePathOkPercent === null) {
    return <p className="st-avail-none">{t('site.status.availability.tooEarly', { since })}</p>;
  }
  // "of the last 1 days" (QA 2026-08-10 F-03). observedDays is rounded to one
  // decimal, so it is a number like 1, 1.5 or 90 — and the plural is chosen by
  // i18next from the whole phrase rather than by appending an "s", because the
  // rule differs by language.
  const days = a.observedDays < a.requestedWindowDays ? a.observedDays : a.requestedWindowDays;
  return (
    <div className="st-avail">
      <div className="st-avail-figure">
        <span className="st-avail-pct">{a.releasePathOkPercent}%</span>
        <span className="st-avail-label">
          {t('site.status.availability.figureLabel', {
            days: t('site.status.availability.days', { count: days }),
          })}
        </span>
      </div>
      <p className="st-avail-note">
        {t('site.status.availability.measuringSince', { since })}{' '}
        {a.observedDays < a.requestedWindowDays
          ? `${t('site.status.availability.shortWindow', { days: a.requestedWindowDays })} `
          : null}
        {a.unobservedMinutes > 0 ? (
          <Trans
            i18nKey="site.status.availability.unobserved"
            count={a.unobservedMinutes}
            components={{ em: <em /> }}
          />
        ) : (
          t('site.status.availability.allObserved')
        )}
      </p>
    </div>
  );
}

export function Status(): JSX.Element {
  const t = useT();
  const { data, failed, loading } = useLiveStatus();
  const watched = useWatched(t);
  const states = useStates(t);
  // Live state by check id, so each watched component below carries its own dot.
  const byId = new Map((data?.checks ?? []).map((c) => [c.id, c]));

  return (
    <PublicPage
      eyebrow={t('site.status.eyebrow')}
      title={t('site.status.title')}
      pills={useCompanyPills()}
      current="/status"
    >
      <section className="st-headline" role="status">
        <div className="st-headline-row">
          <span className="st-dot ok" aria-hidden="true" />
          <p className="st-headline-title">{t('site.status.headline.title')}</p>
        </div>
        <p>
          <Trans i18nKey="site.status.headline.body" components={{ em: <em /> }} />
        </p>
      </section>

      <section className="st-live" aria-live="polite" aria-busy={loading}>
        {loading && data === null ? (
          <div className="st-live-head">
            <span className="st-dot unknown" aria-hidden="true" />
            <p className="st-live-verdict">{t('site.status.checking')}</p>
          </div>
        ) : (
          <LiveHeadline status={data} failed={failed} />
        )}
        <p className="st-live-sub">
          <Trans i18nKey="site.status.live.sub" components={{ strong: <strong /> }} />
        </p>
        {data !== null && failed ? (
          <p className="st-live-stale">{t('site.status.live.stale')}</p>
        ) : null}
      </section>

      <h2 id="watched">{t('site.status.watched.title')}</h2>
      <p>
        <Trans i18nKey="site.status.watched.lede" components={{ em: <em /> }} />
      </p>
      <div className="st-watch-list">
        {watched.map((w) => {
          const live = w.id === null ? undefined : byId.get(w.id);
          return (
            <div className="st-watch" key={w.name}>
              <div className="st-watch-head">
                <span className="st-watch-name">
                  {/* No dot for a component the server does not report on: an
                      undrawn state is honest, an assumed green is not. */}
                  {live === undefined ? null : (
                    <span
                      className={`st-dot ${live.state}`}
                      role="img"
                      aria-label={t('site.status.dotAria', {
                        name: w.name,
                        state: t(STATE_LABEL[live.state]),
                      })}
                    />
                  )}
                  {w.name}
                </span>
                <span className={`st-tag ${w.critical ? 'critical' : 'supporting'}`}>
                  {w.critical ? t('site.status.tag.critical') : t('site.status.tag.supporting')}
                </span>
              </div>
              <p className="st-watch-detail">{w.detail}</p>
            </div>
          );
        })}
      </div>

      <h2 id="availability">{t('site.status.availability.title')}</h2>
      <p>{t('site.status.availability.lede')}</p>
      {data === null ? (
        <p className="st-avail-none">
          {failed
            ? t('site.status.availability.unreachable')
            : t('site.status.availability.loading')}
        </p>
      ) : (
        <Availability a={data.availability} />
      )}
      <p>
        <Trans
          i18nKey="site.status.availability.trustworthy"
          components={{ strong: <strong /> }}
        />
      </p>

      <h2 id="watchdog">{t('site.status.watchdog.title')}</h2>
      <p>{t('site.status.watchdog.lede')}</p>
      <div className="st-pair">
        <div className="st-card">
          <p className="st-card-label">{t('site.status.watchdog.inside.label')}</p>
          <p>
            <Trans i18nKey="site.status.watchdog.inside.body" components={{ strong: <strong /> }} />
          </p>
        </div>
        <div className="st-card">
          <p className="st-card-label">{t('site.status.watchdog.outside.label')}</p>
          <p>{t('site.status.watchdog.outside.body')}</p>
        </div>
      </div>
      <p>
        <Trans i18nKey="site.status.watchdog.durability" components={{ strong: <strong /> }} />
      </p>

      <h2 id="unknown">{t('site.status.unknown.title')}</h2>
      <p>{t('site.status.unknown.lede')}</p>
      <div className="st-states">
        {states.map((st) => (
          <span className="st-state" key={st.cls}>
            <span className={`st-dot ${st.cls}`} aria-hidden="true" />
            <span className="st-state-label">{st.label}</span>
            <span className="st-state-meaning">{st.meaning}</span>
          </span>
        ))}
      </div>
      <p>{t('site.status.unknown.twoThings')}</p>
      <ul>
        <li>
          <Trans i18nKey="site.status.unknown.backups" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.status.unknown.attachments" components={{ strong: <strong /> }} />
        </li>
      </ul>
      <p>{t('site.status.unknown.publishesLess')}</p>

      <h2 id="outage">{t('site.status.outage.title')}</h2>
      <p>
        <Trans
          i18nKey="site.status.outage.lede"
          values={{ email: CONTACT_EMAIL }}
          components={{ email: <a href={`mailto:${CONTACT_EMAIL}`} /> }}
        />
      </p>
      <ul>
        <li>
          <Trans i18nKey="site.status.outage.lockedOut" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans
            i18nKey="site.status.outage.unexpectedPrompt"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.status.outage.channelsFailing"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.status.outage.securityProblem"
            values={{ email: SECURITY_EMAIL }}
            components={{
              strong: <strong />,
              email: <a href={`mailto:${SECURITY_EMAIL}`} />,
              disclosure: <Link to="/security/disclosure" />,
            }}
          />
        </li>
        <li>
          <Trans i18nKey="site.status.outage.midCeremony" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2 id="planned">{t('site.status.planned.title')}</h2>
      <p>{t('site.status.planned.body')}</p>
      <p>
        <Trans
          i18nKey="site.status.planned.changelog"
          components={{
            changelog: <SourceLangLink to="/changelog" />,
            build: <Link to="/security/build" />,
          }}
        />
      </p>
    </PublicPage>
  );
}
