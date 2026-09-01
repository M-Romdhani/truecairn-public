// Design system + self-hosted fonts, loaded globally: the marketing landing uses
// the same tokens/components as the app (the CSP forbids Google Fonts, so every
// face is bundled and served from 'self'). Inter is the text face, Poppins the
// display face (page titles + wordmark). The heavy authed graph — crypto,
// libsodium WASM — stays behind the lazy AuthedApp boundary below.
import './styles/design-system.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
// Side-effect import: initialises i18next with the SITE catalog before anything
// renders. HERE rather than in AuthedApp as of Phase 2, because the landing and
// the public pages are translated now and cannot wait on a lazy chunk. Only the
// site half ships eagerly — see i18n/catalog/site/en.ts.
import './i18n/index.js';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { localePathPrefix, splitLocalePath } from '@truecairn/shared';
import { Landing } from './screens/Landing.js';

// Entry point (PHASE4 C6). The split that keeps the public landing lean: the only
// things in the eager bundle are React, the router, and the (crypto-free) Landing.
// EVERYTHING authenticated — session machinery, @truecairn/client-crypto, the
// libsodium WASM, every app screen — lives behind AuthedApp, a dynamic import that
// loads ONLY when a visitor leaves "/" for an app route. So an anonymous visitor to
// "/" downloads no crypto and runs no key init.
const AuthedApp = lazy(() => import('./AuthedApp.js'));
// The public content pages (security, legal, company, status, changelog, guide)
// live in their OWN lazy chunk that imports NONE of the authed graph — so deep-
// linking to e.g. /security or /guide never pulls libsodium/crypto. (PublicPages.tsx)
const PublicPages = lazy(() => import('./PublicPages.js'));

// Public content pathnames. Kept in sync with PublicPages.tsx's routes; matched in
// Root BEFORE the authed fallback so these pages bypass the crypto graph entirely.
function isPublicContentPath(pathname: string): boolean {
  return (
    pathname === '/guide' ||
    pathname === '/changelog' ||
    pathname === '/status' ||
    pathname.startsWith('/security') ||
    pathname.startsWith('/legal') ||
    pathname.startsWith('/company')
  );
}

// Route at the root WITHOUT mounting the authed Routes tree: "/" renders Landing
// directly; the public content pages suspend on the crypto-free PublicPages chunk;
// anything else suspends on the lazy authed chunk. (Landing and the public pages
// are rendered outside the authed app so their chunks never pull the authed graph.)
// THE ONE STRING THAT STAYS ENGLISH, and deliberately (docs/40 Phase 1).
//
// These two "Loading…" fallbacks render while the lazy chunks are still being
// fetched — before AuthedApp has run, and AuthedApp is where i18next is
// initialised. Translating them would mean importing the catalogs into the EAGER
// bundle, i.e. into every anonymous visit to the landing page, to translate a
// word that is visible for a few hundred milliseconds.
//
// The alternative was considered and rejected: the landing bundle is kept
// deliberately lean (see the note at the top of this file), and paying for the
// whole catalog there to translate one word is the wrong trade. Recorded here so
// the next reader knows it was a decision, not an oversight.
function Root(): JSX.Element {
  const { pathname } = useLocation();
  if (pathname === '/') return <Landing />;
  if (isPublicContentPath(pathname)) {
    return (
      <Suspense fallback={<p>Loading…</p>}>
        <PublicPages />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <AuthedApp />
    </Suspense>
  );
}

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('#root element not found');

// THE LANGUAGE PREFIX IS THE ROUTER'S BASENAME (docs/40 Phase 2).
//
// `/es/security` and `/security` are the same route in two languages, so the
// prefix is stripped once, here, and every route below is written unprefixed.
// The payoff is that every <Link to="/security"> in the app stays
// language-relative and renders as `/es/security` on a Spanish page without a
// single call site knowing the prefix exists — which is the only version of this
// that survives contact with a hundred links.
//
// Read once at boot rather than tracked reactively: switching language on a
// public page navigates to a different URL, which reloads the document anyway.
const basename = localePathPrefix(splitLocalePath(window.location.pathname).locale);

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <Root />
    </BrowserRouter>
  </StrictMode>,
);
