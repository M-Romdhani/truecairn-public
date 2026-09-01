import { DEFAULT_LOCALE, OFFERED_LOCALES, SOURCE_LANGUAGE_ONLY_ROUTES, type Locale } from '@truecairn/shared';

// ── Which client-side paths actually exist (2026-07-30) ──────────────────────
//
// The SPA is served same-origin by this API (docs/23), so the server is the only
// thing that can set a status code for a client route. Before this module the
// not-found handler returned the SPA shell with an implicit 200 for EVERY
// non-/v1 GET, which made every typo, every dead inbound link and every probe a
// SOFT 404: a page that says "not found" to a human while telling every crawler,
// monitor and link-checker that it found something.
//
// That is worth fixing beyond tidiness. A soft 404 gets the shell indexed under
// arbitrary URLs, it hides broken links from anything automated, and on a
// product whose whole public argument is "we do not claim things we cannot
// stand behind" it is the same class of error as a green tile nobody earned.
//
// So: a known client route returns 200 and the shell (React renders it), and
// anything else returns 404 AND the shell (the SPA still renders a usable page —
// the status line is for machines, the body is for people).
//
// DRIFT IS THE REAL RISK. This list duplicates the router, and a list that
// silently falls behind is worse than none: a new page would 404 for crawlers
// while looking perfect in a browser. spa-routes.test.ts parses the actual route
// definitions out of apps/web/src and fails when the two disagree, which is the
// same fs-scanning approach docs-truth.test.ts and authority-fence.test.ts use.

// Public, crawlable. Mirrors isPublicContentPath() in apps/web/src/main.tsx plus
// the routes in PublicPages.tsx, plus '/' (the landing, rendered directly).
// Kept exported and ordered: /sitemap.xml lists exactly this set.
export const PUBLIC_CLIENT_ROUTES: readonly string[] = [
  '/',
  '/guide',
  '/changelog',
  '/status',
  '/security',
  '/security/ai',
  '/security/build',
  '/security/disclosure',
  '/security/limits',
  '/security/threat-model',
  '/legal/privacy',
  '/legal/terms',
  '/legal/dpa',
  '/legal/sub-processors',
  '/legal/wind-down',
  '/company/about',
  '/company/contact',
  '/company/press',
];

// Authenticated and auth-adjacent. Real routes, so they must answer 200 — but
// they are Disallow-ed in robots.txt and absent from the sitemap, because a
// crawler following them only ever reaches a login redirect.
export const AUTHED_CLIENT_ROUTES: readonly string[] = [
  '/register',
  '/login',
  '/unlock',
  // Redeeming the recovery code. Authed-adjacent like /unlock: it needs a live
  // session to reach anything, so a crawler following it only sees a redirect.
  '/recover',
  '/onboarding',
  '/home',
  '/dashboard',
  '/vault',
  '/plans',
  '/upgrade',
  '/contacts',
  '/contacts/accept',
  '/engine',
  '/ceremony',
  '/assistant',
  '/settings',
  '/admin/system',
];

// Parameterised routes, which cannot be matched by string equality.
const DYNAMIC_CLIENT_ROUTES: readonly RegExp[] = [
  // /vault/:id — a vault item. The id is opaque here; whether it EXISTS is a
  // question only the authenticated client can answer, so the shell is served
  // 200 and the app resolves it. Never leak existence through a status code.
  /^\/vault\/[^/]+$/,
];

const EXACT = new Set([...PUBLIC_CLIENT_ROUTES, ...AUTHED_CLIENT_ROUTES]);

// ── The language prefix (docs/40 Phase 2) ────────────────────────────────────
//
// Public pages are published per language under a path prefix — `/es/security`
// is the Spanish `/security` — so the prefix is stripped before matching and the
// route list stays one entry per page rather than one per page per language.
//
// TWO THINGS ARE DELIBERATELY NOT PREFIXABLE. Authenticated routes: they render
// in the language stored on the account, are Disallow-ed in robots.txt, and a
// `/es/vault` that answered 200 would be a second URL for a page no crawler
// should reach and no link should point to. And SOURCE-LANGUAGE-ONLY routes —
// the changelog and the legal pages, which are published in one language by
// decision (see the SPA's catalog) — because a URL that answers 200 for a page
// the build never rendered is a soft 404, which is precisely what this module
// exists to prevent.
//
// OFFERED_LOCALES, NOT LOCALES. A language can exist in code long before it is
// published — Spanish does today — and while it is unpublished the build emits no
// files for it. Accepting `/es/security` then would answer 200 for a page that
// was never rendered, which is the soft 404 this module exists to prevent, and it
// would make "not offered" mean "unlinked" rather than "unreachable". Turning the
// language on flips both the build and this, from the same one constant.
//
// `offered` is injectable so the multi-language behaviour stays under test while
// only one language is published — the same seam the SPA's language picker uses.
// Trailing slashes are equivalent ('/status/' is '/status'), matching how the
// router treats them. '/' itself is the one path that keeps its slash.
export function isKnownClientRoute(
  pathname: string,
  offered: readonly Locale[] = OFFERED_LOCALES,
): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') : pathname;

  for (const prefix of offered.filter((l) => l !== DEFAULT_LOCALE).map((l) => `/${l}`)) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    const bare = path === prefix ? '/' : path.slice(prefix.length);
    // Public and translated only — see the note above on why the other two
    // categories must 404 under a prefix rather than answer 200.
    return PUBLIC_CLIENT_ROUTES.includes(bare) && !SOURCE_LANGUAGE_ONLY_ROUTES.includes(bare);
  }

  if (EXACT.has(path)) return true;
  return DYNAMIC_CLIENT_ROUTES.some((re) => re.test(path));
}
