// The closed set of languages the product speaks (docs/40 Phase 0).
//
// SHARED, not web-only, and that is the point. Three consumers need the same
// list and must not drift: the SPA (which renders in it), the API (which will
// stamp it on a user row), and packages/notifications (which renders the 13
// transactional emails server-side, where the browser's language is not
// available and only a stored value can be read). A second list in any of them
// is how a user ends up with a Spanish app and English mail.
//
// ORDER IS THE UI ORDER. The language picker renders LOCALES in this order, so
// it is editorial, not alphabetical: the default first, then by how complete the
// translation is.
export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

// The languages a user can actually REACH — the picker lists these, and
// auto-detection only ever resolves into these. A locale in LOCALES but not here
// is fully built and fully tested and simply not offered yet.
//
// A REPO CONSTANT, DELIBERATELY NOT ENV-DERIVED, for the same reason as
// WITHDRAWN_CHANNEL_TYPES in apps/api/src/billing/entitlement.ts: no stray
// production variable can switch a language on, and offering one is a reviewed
// commit that a human read.
//
// 'es' IS NOW OFFERED (2026-08-26, owner decision). The two gates this comment
// used to name were coverage and native-speaker review. They did not both pass,
// and saying so is the point of leaving this note rather than deleting it.
//
// COVERAGE: passed, comfortably. The reason for withholding was that "only the
// three auth screens are extracted" — true when written, and long since false.
// Measured on the day of the flip: 1103 of 1115 keys, 98.9% (app 100%, pages
// 100%, site 94.5%), across ~38 files on the i18n-fence allowlist including
// Home, Engine, Vault, Contacts and Settings. A Spanish reader no longer meets a
// cliff at /onboarding.
//
// NATIVE-SPEAKER REVIEW: NOT PASSED. No native speaker has read the catalog. The
// owner decided to offer Spanish anyway, having been told that plainly. What was
// done instead is narrower and mechanical, and must not be mistaken for the
// gate: a pass against QA-i18n-spanish-2026-08-25.md Part 1 confirmed the
// meaning-critical strings still carry the same claims as their English sources
// — S2-optional vs S3-mandatory, the anti-phishing line naming «frase de
// liberación», the by-phone-or-in-person restriction, both readiness consequence
// clauses, the absence statements — and found and fixed one real defect, the
// master passphrase having had two names (#224). That says the strings are
// FAITHFUL. It does not say they read as Spanish rather than as translated
// English, which is the question a native speaker answers and this did not.
//
// So: the honest state is a complete, faithful, model-written translation that a
// human has not yet read. If that review happens and finds problems, they are
// problems in production, not in a staging branch — that is the trade the owner
// made knowingly.
export const OFFERED_LOCALES: readonly Locale[] = ['en', 'es'];

// English is the source language: every string is authored here first, every
// other catalog is a translation OF it, and it is what any incomplete catalog
// falls back to. It is also what a user gets before they have expressed any
// preference at all.
export const DEFAULT_LOCALE: Locale = 'en';

// Endonyms — each language named in itself, never translated. Someone looking
// for their own language scans for the word they use for it; "Spanish" is no
// help to a reader who does not already read English, which is precisely the
// reader the picker exists for.
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = {
  en: 'English',
  es: 'Español',
};

// Narrowing guard for values arriving from outside the type system — a URL
// segment, a stored preference, an Accept-Language header, a database column
// written before a locale was retired. Everything untrusted goes through this.
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

// Best supported match for a browser/OS language list (navigator.languages, or
// an Accept-Language header once the server needs one).
//
// Matches on the PRIMARY SUBTAG only: 'es-MX', 'es-419' and 'es' all resolve to
// 'es'. Regional Spanish varies in vocabulary, and if that ever matters enough
// to split, it becomes a new entry in LOCALES with its own catalog — never a
// silent near-match here. Returns DEFAULT_LOCALE when nothing matches, so the
// caller never has to handle an absent result.
//
// `supported` defaults to what is OFFERED, not to what EXISTS: auto-detection
// must never resolve a visitor into a language the picker would not show them,
// which would strand them somewhere they cannot navigate back from. Callers pass
// LOCALES explicitly only to test the matching itself.
export function matchLocale(
  preferred: readonly string[],
  supported: readonly Locale[] = OFFERED_LOCALES,
): Locale {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split('-')[0];
    if (isLocale(primary) && supported.includes(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

// ── Locale in the URL (docs/40 Phase 2) ──────────────────────────────────────
//
// Public pages carry the language in the PATH: `/security` is English,
// `/es/security` is Spanish. Distinct URLs are what let a search engine show the
// Spanish page to a Spanish searcher, and the SPA already prerenders one static
// file per public route, which is a shape a path prefix fits exactly.
//
// SIGNED-IN SCREENS CARRY NO PREFIX. They are Disallow-ed in robots.txt and
// absent from the sitemap, so a prefix would buy no discoverability while
// doubling the route table and the surface around the single-origin session and
// WebAuthn setup. They render in the language stored on the account instead.
//
// THE DEFAULT LOCALE HAS NO PREFIX. `/security`, not `/en/security` — the
// canonical English URLs are already published, indexed and linked, and moving
// them would break every inbound link to buy nothing.

// The path segment a locale owns, '' for the default.
export function localePathPrefix(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? '' : `/${locale}`;
}

// Split a pathname into the locale it names and the path beneath it.
// `/es/security` → { locale: 'es', path: '/security' }; `/security` →
// { locale: DEFAULT_LOCALE, path: '/security' }.
//
// Matches only a WHOLE first segment, so a path that merely starts with the
// letters ('/estate-planning') is not mistaken for a prefixed one. A bare
// `/es` resolves to that locale's home.
export function splitLocalePath(pathname: string): { locale: Locale; path: string } {
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const prefix = `/${locale}`;
    if (pathname === prefix) return { locale, path: '/' };
    if (pathname.startsWith(`${prefix}/`)) return { locale, path: pathname.slice(prefix.length) };
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}

// The inverse: put a path under a locale. Idempotent against an already-prefixed
// path, so callers never have to check first.
export function localizePath(path: string, locale: Locale): string {
  const { path: bare } = splitLocalePath(path);
  const prefix = localePathPrefix(locale);
  if (prefix === '') return bare;
  return bare === '/' ? prefix : `${prefix}${bare}`;
}

// Public routes published ONLY in the source language (docs/40 Phase 2).
//
// NOT A BACKLOG — a decision, taken 2026-08-22. The CHANGELOG is append-only
// history and 44% of the site's words; translating it would put "and get it
// translated" into the lockstep rule that must hold on every user-visible
// change, and the first release that cannot wait for a translator is the release
// that quietly breaks it. The LEGAL pages wait for a company: a Spanish
// terms-of-service can create obligations in Spanish, and in much of the
// Spanish-speaking world the consumer's language can govern, so publishing one
// is a decision for a company rather than an engineering default.
//
// HERE, not in either app, because three things must agree about it and they
// live in different packages: the SPA (which does not render these routes in
// other languages), the prerenderer (which does not emit files for them), and
// the API's route table (which must 404 `/es/legal/privacy` rather than answer
// 200 for a page the build never produced — a soft 404 is exactly what that
// module exists to prevent). A second copy of this list is how one of the three
// silently disagrees.
export const SOURCE_LANGUAGE_ONLY_ROUTES: readonly string[] = [
  '/changelog',
  '/legal/privacy',
  '/legal/terms',
  '/legal/dpa',
  '/legal/sub-processors',
  '/legal/wind-down',
];

// The languages a public route is actually published in. Everything that reasons
// about alternates — hreflang, the sitemap, the prerenderer's file list, the
// server's 404 — asks THIS, so a route can never be linked in a language it was
// never rendered in.
export function localesForRoute(route: string): readonly Locale[] {
  return SOURCE_LANGUAGE_ONLY_ROUTES.includes(route) ? [DEFAULT_LOCALE] : OFFERED_LOCALES;
}
