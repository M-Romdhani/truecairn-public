import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { usePageMeta } from './site/usePageMeta.js';
import { useT } from './i18n/useT.js';
import { NotFound } from './site/NotFound.js';
import { OpsCenter } from './screens/ops/OpsCenter.js';
import { proveStepUpWithPasskey } from './auth/stepup.js';
import { AppShell } from './components/AppShell.js';
import { BrandMark } from './components/BrandMark.js';
import { Wordmark } from './components/Wordmark.js';
import { useSession } from './crypto/session.js';
import { Assistant } from './screens/assistant/Assistant.js';
import { CeremonyPortal } from './screens/ceremony/CeremonyPortal.js';
import { AcceptAndEnroll } from './screens/contacts/AcceptAndEnroll.js';
import { Contacts } from './screens/contacts/Contacts.js';
import { Dashboard } from './screens/dashboard/Dashboard.js';
import { EngineDashboard } from './screens/engine/EngineDashboard.js';
import { Login } from './screens/Login.js';
import { Onboarding } from './screens/Onboarding.js';
import { Plans } from './screens/plans/Plans.js';
import { Upgrade } from './screens/plans/Upgrade.js';
import { Recover } from './screens/Recover.js';
import { Register } from './screens/Register.js';
import { Settings } from './screens/settings/Settings.js';
import { Unlock } from './screens/Unlock.js';
import { Vault } from './screens/vault/Vault.js';
import { VaultItemDetail } from './screens/vault/VaultItemDetail.js';

// Two chromes. The AUTHENTICATED app screens (Home, Vault, Contacts, Engine,
// Ceremony) render inside the AppShell sidebar; the auth/onboarding screens keep
// the simpler app-bar — they run before unlock, and the enrolment E2E drives the
// nav from /onboarding. All in-vault routes are gated on the vault being
// unlocked. The lock-status testid lives in BOTH chromes so it is always present
// (the unlock flow now lands on an app route).

// Pathnames that render inside the sidebar shell.
function isAppPath(pathname: string): boolean {
  if (pathname.startsWith('/vault/')) return true;
  return (
    pathname === '/home' ||
    pathname === '/vault' ||
    pathname === '/plans' ||
    pathname === '/contacts' ||
    pathname === '/contacts/accept' ||
    pathname === '/engine' ||
    pathname === '/ceremony' ||
    pathname === '/assistant' ||
    pathname === '/settings'
  );
}

export function App(): JSX.Element {
  const t = useT();
  // Every route in this tree is authenticated or auth-adjacent, so none of it
  // should be indexed. robots.txt already Disallows these paths, but a Disallow
  // only stops a CRAWL — a URL discovered elsewhere can still be listed without
  // being fetched. `noindex` is what actually keeps it out of results.
  usePageMeta({ title: 'Truecairn', noindex: true });
  const { status } = useSession();
  const { pathname, search } = useLocation();
  const unlocked = status === 'unlocked';
  // Preserve the attempted destination across the unlock bounce (audit M2): a
  // hard nav to a gated route while locked carries the path to /unlock, which
  // returns there after a successful unlock instead of always /vault.
  const unlockRedirect = `/unlock?next=${encodeURIComponent(pathname + search)}`;

  const routes = (
    <Routes>
      <Route path="/admin/system" element={<OpsCenter />} />
      <Route path="/register" element={<Register />} />
      <Route path="/login" element={<Login />} />
      <Route path="/unlock" element={<Unlock />} />
      <Route path="/recover" element={<Recover />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/home" element={unlocked ? <Dashboard /> : <Navigate to={unlockRedirect} replace />} />
      <Route path="/vault" element={unlocked ? <Vault /> : <Navigate to={unlockRedirect} replace />} />
      {/* Legacy URL: the Vault list used to live at /dashboard (audit M6 — the URL
          now matches its content). Redirect old links/bookmarks. */}
      <Route path="/dashboard" element={<Navigate to="/vault" replace />} />
      <Route path="/plans" element={unlocked ? <Plans /> : <Navigate to={unlockRedirect} replace />} />
      {/* The upgrade page renders as its own focused chrome (its own back-arrow,
          no sidebar) — see the standalone branch below. */}
      <Route path="/upgrade" element={unlocked ? <Upgrade /> : <Navigate to={unlockRedirect} replace />} />
      <Route
        path="/vault/:id"
        element={unlocked ? <VaultItemRoute /> : <Navigate to={unlockRedirect} replace />}
      />
      <Route
        path="/contacts"
        element={
          unlocked ? <Contacts proveSecondFactor={proveStepUpWithPasskey} /> : <Navigate to={unlockRedirect} replace />
        }
      />
      <Route
        path="/contacts/accept"
        element={unlocked ? <AcceptAndEnroll /> : <Navigate to={unlockRedirect} replace />}
      />
      <Route
        path="/engine"
        element={
          unlocked ? <EngineDashboard proveSecondFactor={proveStepUpWithPasskey} /> : <Navigate to={unlockRedirect} replace />
        }
      />
      <Route path="/ceremony" element={unlocked ? <CeremonyPortal /> : <Navigate to={unlockRedirect} replace />} />
      <Route path="/assistant" element={unlocked ? <Assistant /> : <Navigate to={unlockRedirect} replace />} />
      <Route
        path="/settings"
        element={
          unlocked ? (
            <Settings proveSecondFactor={proveStepUpWithPasskey} />
          ) : (
            <Navigate to={unlockRedirect} replace />
          )
        }
      />
      {/* Unknown paths RENDER a 404 rather than redirecting to /register. The old
          redirect rewrote the address bar, so a trusted contact whose ceremony link
          had been mangled in transit was silently handed a signup form — no broken
          URL to report, and a strong hint that creating an account was the right
          next step. It is not (QA P3-1). */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );

  // Standalone chromes: these screens carry their own. The upgrade page has its
  // own back-to-vault arrow, like the reference upgrade flow.
  //
  // /admin/system carries the operations top bar, and its reason is functional
  // rather than cosmetic: the dashboard is session-gated ONLY — it shows no vault
  // data, so it deliberately does not require the master key to be unlocked,
  // because the whole point is to be reachable when something is wrong. Rendered
  // inside AppShell it sat next to a sidebar full of Vault/Contacts links that
  // bounce straight to /unlock. It also reclaims the sidebar's 248px for the
  // six-column release chain, and being visibly a different surface means the
  // system's state can never be mistaken for the reader's own account's.
  if (pathname === '/upgrade' || pathname === '/admin/system') {
    return routes;
  }

  if (isAppPath(pathname)) {
    return <AppShell>{routes}</AppShell>;
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        {t('shell.skipToContent')}
      </a>
      <header className="appbar">
        {/* The wordmark is a link home — from /login, /register, /unlock and
            /onboarding it is the way back out (audit: these pages were dead ends).
            Unlocked, it lands on the app dashboard; otherwise the public landing. */}
        <Link className="brand" to={unlocked ? '/home' : '/'} aria-label={t('shell.brandHome')}>
          <BrandMark />
          <Wordmark />
        </Link>
        <div className="row gap-md middle">
          {unlocked && (
            <nav>
              <Link to="/home">{t('shell.nav.home')}</Link>
              <Link to="/vault">{t('shell.nav.vault')}</Link>
              <Link to="/plans">{t('shell.nav.plans')}</Link>
              <Link to="/contacts">{t('shell.nav.contacts')}</Link>
              <Link to="/contacts/accept">{t('shell.nav.acceptInvite')}</Link>
              <Link to="/engine">{t('shell.nav.engine')}</Link>
              <Link to="/ceremony">{t('shell.nav.ceremony')}</Link>
              <Link to="/assistant">{t('shell.nav.assistant')}</Link>
            </nav>
          )}
          {/* The lock-status chip is only meaningful once the user is past
              sign-in; on /register and /login the vault is trivially "locked" and
              showing it there is just noise (audit m6). */}
          {pathname !== '/register' && pathname !== '/login' && (
            <span className={'badge' + (unlocked ? ' success' : '')} data-testid="lock-status">
              {status}
            </span>
          )}
        </div>
      </header>
      <main className="content" id="main-content">
        {routes}
      </main>
    </div>
  );
}

function VaultItemRoute(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (id === undefined) return <Navigate to="/vault" replace />;
  return <VaultItemDetail itemId={id} proveSecondFactor={proveStepUpWithPasskey} />;
}
