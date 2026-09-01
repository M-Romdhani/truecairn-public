import { type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark.js';
import { Wordmark } from '../components/Wordmark.js';
import { SiteFooter } from './SiteFooter.js';
import { usePublicPageMeta } from './usePageMeta.js';
import './public.css';
import { useT } from '../i18n/useT.js';

// Shared chrome for the PUBLIC content pages (security, legal, company, changelog,
// and the guide when read while signed out). These render OUTSIDE the AppShell —
// a prospect can read them with no account — so they bring their own lightweight
// marketing header + the shared SiteFooter, and constrain the body to a readable
// prose column. Class-only styling (the SPA CSP forbids inline styles).
//
// `eyebrow` is the small category label above the title; `updated` is an optional
// "last updated" line shown under the title (a literal string — these are
// hand-authored pages, so there is no Date to format). `pills` renders the
// sibling-page pill nav under the title (the security/legal/company families),
// with the current page highlighted.
export interface PubPill {
  to: string;
  label: string;
}

export function PublicPage({
  eyebrow,
  title,
  updated,
  pills,
  current,
  notFound,
  children,
}: {
  eyebrow: string;
  title: string;
  updated?: string;
  pills?: readonly PubPill[];
  current?: string;
  // Set by the 404 page only: the pathname is arbitrary and has no PAGE_META
  // row, so the table lookup below must be skipped rather than falling back to
  // a bare title and a canonical for a URL that does not exist.
  notFound?: boolean;
  children: ReactNode;
}): JSX.Element {
  const t = useT();
  // Head metadata for every public page, applied here rather than page by page:
  // a page gets a title, description and canonical by EXISTING, instead of by
  // its author remembering to ask. Keyed on the live pathname (not the `current`
  // prop, which several pages omit); trailing slashes normalised so /status/ and
  // /status resolve to the same entry in PAGE_META.
  const { pathname } = useLocation();
  usePublicPageMeta(
    pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname,
    notFound === true,
  );

  return (
    <div className="pub">
      <a className="skip-link" href="#pub-main">
        {t('site.chrome.skipToContent')}
      </a>
      <header className="pub-header">
        <div className="pub-header-inner">
          <Link className="mk-brand" to="/">
            <BrandMark />
            <Wordmark />
          </Link>
          <div className="pub-header-actions">
            <Link className="btn ghost sm" to="/login">
              {t('site.chrome.signIn')}
            </Link>
            <Link className="btn primary sm" to="/register">
              {t('site.chrome.getStarted')}
            </Link>
          </div>
        </div>
      </header>

      <main className="pub-main" id="pub-main">
        <Link className="pub-back" to="/">
          <span aria-hidden="true">←</span> {t('site.chrome.backHome')}
        </Link>
        <p className="pub-eyebrow">{eyebrow}</p>
        <h1 className="pub-title">{title}</h1>
        {updated !== undefined && (
          <p className="pub-updated">{t('site.chrome.lastUpdated', { date: updated })}</p>
        )}
        {pills !== undefined && (
          <nav className="pub-pills" aria-label={t('site.chrome.pillsLabel', { section: eyebrow })}>
            {pills.map((p) => (
              <Link
                key={p.to}
                className={`pub-pill${p.to === current ? ' active' : ''}`}
                to={p.to}
                aria-current={p.to === current ? 'page' : undefined}
              >
                {p.label}
              </Link>
            ))}
          </nav>
        )}
        <div className="pub-prose">{children}</div>
      </main>

      <SiteFooter />
    </div>
  );
}
