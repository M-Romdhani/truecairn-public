import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AccountMenu } from './AccountMenu.js';
import { CommandPalette } from './CommandPalette.js';
import { BrandMark } from './BrandMark.js';
import { Wordmark } from './Wordmark.js';
import { listContacts } from '../contacts/api.js';
import { listItems } from '../vault/api.js';
import { useLocaleSync } from '../i18n/useLocaleSync.js';
import { useT } from '../i18n/useT.js';

// The authenticated app chrome (design follow-on #6): the Linear-style sidebar +
// main column shared by every unlocked screen (Home, Vault, Plans, Contacts,
// Engine, Ceremony). Auth/onboarding screens keep the simpler app-bar (App.tsx)
// — they run before unlock and the enrolment E2E drives the nav from there.
//
// Nav link NAMES are load-bearing: the Playwright E2E navigates by them
// ("Vault", "Contacts", "Accept invite", "Engine", "Ceremony"), and the
// lock-status testid is asserted after unlock (which now lands on an app route),
// so it lives here too.

const IcHome = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 7L8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3v-4h-4v4h-3a.5.5 0 0 1-.5-.5V7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
const IcVault = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.3"/><line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>;
const IcContacts = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 13c.7-2.6 2.7-3.8 5-3.8s4.3 1.2 5 3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>;
const IcEngine = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M2 8c0-3 2.7-5.5 6-5.5S14 5 14 8M14 8c0 3-2.7 5.5-6 5.5S2 11 2 8" stroke="currentColor" strokeWidth="1.3"/></svg>;
const IcCeremony = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>;
const IcPlans = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2L14 5 8 8 2 5 8 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
const IcInvite = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11v7h-11z" stroke="currentColor" strokeWidth="1.3"/><path d="M2.5 5l5.5 4 5.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
const IcSettings = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>;
const IcAssistant = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11v6h-7l-3 2.5v-2.5h-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M6 7h4M6 9h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>;
const IcSearch = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>;
const IcMenu = () => <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;

// Counts beside Vault and Contacts. `.sb-item .sb-count` has been in the
// stylesheet since the design landed with nothing rendering into it.
//
// These use the CANONICAL query keys the two screens use, so the fetch is shared
// rather than duplicated: landing on /vault finds the list already cached, and
// the palette reads the same entries. Fail-soft by construction — an unresolved
// or failed query renders no badge at all, never a zero, because a confident "0"
// on a vault that simply has not loaded is worse than no number.
function useNavCounts(): { vault: number | null; contacts: number | null } {
  const vaultQ = useQuery({ queryKey: ['vault-items', ''], queryFn: () => listItems() });
  const contactsQ = useQuery({ queryKey: ['contacts'], queryFn: () => listContacts() });
  return {
    vault: vaultQ.data === undefined ? null : vaultQ.data.items.length,
    contacts: contactsQ.data === undefined ? null : contactsQ.data.contacts.length,
  };
}

const NAV = [
  { to: '/home', label: 'shell.nav.home', icon: IcHome },
  { to: '/vault', label: 'shell.nav.vault', icon: IcVault },
  { to: '/plans', label: 'shell.nav.plans', icon: IcPlans },
  { to: '/contacts', label: 'shell.nav.contacts', icon: IcContacts },
  { to: '/engine', label: 'shell.nav.engine', icon: IcEngine },
  { to: '/ceremony', label: 'shell.nav.ceremony', icon: IcCeremony },
  { to: '/assistant', label: 'shell.nav.assistant', icon: IcAssistant },
] as const;

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  // Reconcile the browser's language with the one stored on the account
  // (docs/40 Phase 1). HERE rather than in App.tsx because this chrome renders
  // only on authed paths, so it never fires a /v1/account/me that would 401 on
  // the sign-in page — and AccountMenu below already fetches that exact query,
  // so the sync costs no additional request.
  useLocaleSync();
  const t = useT();
  const { pathname } = useLocation();
  // Mobile nav drawer (audit B1). On desktop the CSS keeps the sidebar a static
  // column and this state is inert; below 900px the sidebar is an off-canvas
  // drawer this toggles.
  const [navOpen, setNavOpen] = useState(false);
  const counts = useNavCounts();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Close the drawer whenever the route changes (so following a nav link, which
  // changes pathname, dismisses it) — and on Escape while it is open.
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const activeFor = (to: string): boolean => {
    if (to === '/home') return pathname === '/home';
    if (to === '/vault') return pathname === '/vault' || pathname.startsWith('/vault/');
    if (to === '/contacts') return pathname === '/contacts';
    return pathname === to;
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t('shell.skipToContent')}
      </a>

      <div className="mobile-topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-label={t('shell.openNav')}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((v) => !v)}
        >
          <IcMenu />
        </button>
        <Link className="mt-brand" to="/home">
          <BrandMark />
          <Wordmark />
        </Link>
      </div>

      {navOpen && (
        <div className="nav-overlay" aria-hidden="true" onClick={() => setNavOpen(false)} />
      )}

      <aside id="app-sidebar" className={`sidebar${navOpen ? ' open' : ''}`}>
        <Link className="sb-brand" to="/home">
          <BrandMark />
          <Wordmark />
        </Link>
        {/* Opens the palette. This was an <input> with no handler for as long as
            the sidebar has advertised the shortcut beside it — a control that
            looked live, took focus, and did nothing when you typed in it. */}
        <button
          type="button"
          className="sb-search"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          data-testid="palette-trigger"
        >
          <IcSearch />
          <span className="sb-search-label">{t('shell.search')}</span>
          <span className="kbd">⌘ K</span>
        </button>
        <nav className="sb-nav">
          {NAV.map((it) => {
            const Icon = it.icon;
            const count =
              it.to === '/vault' ? counts.vault : it.to === '/contacts' ? counts.contacts : null;
            return (
              <Link key={it.to} className={`sb-item${activeFor(it.to) ? ' active' : ''}`} to={it.to}>
                <Icon />
                <span>{t(it.label)}</span>
                {count !== null && count > 0 && <span className="sb-count">{count}</span>}
              </Link>
            );
          })}
          <div className="sb-section">{t('shell.nav.more')}</div>
          <Link className={`sb-item${pathname === '/contacts/accept' ? ' active' : ''}`} to="/contacts/accept">
            <IcInvite />
            <span>{t('shell.nav.acceptInvite')}</span>
          </Link>
          <Link
            className={`sb-item${pathname === '/settings' ? ' active' : ''}`}
            to="/settings"
          >
            <IcSettings />
            <span>{t('shell.nav.settings')}</span>
          </Link>
        </nav>
        <AccountMenu />
      </aside>

      <main className="main" id="main-content">
        <div className="main-inner">{children}</div>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
