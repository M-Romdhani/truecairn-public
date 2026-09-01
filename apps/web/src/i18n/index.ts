import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  LOCALES,
  OFFERED_LOCALES,
  isLocale,
  matchLocale,
  splitLocalePath,
  type Locale,
} from '@truecairn/shared';
import { siteEn } from './catalog/site/en.js';
import { siteEs } from './catalog/site/es.js';

// ── i18n runtime (docs/40 Phase 0, split by surface in Phase 2) ──────────────
//
// RESOURCES ARE BUNDLED, NOT FETCHED. i18next's usual pattern loads catalogs over
// HTTP at runtime; this one imports them. The public pages are PRERENDERED in
// Node (apps/web/src/prerender.tsx), and a build-time renderToString cannot await
// an HTTP catalog. A fetched catalog would also mean the first paint of every
// screen is English before the real language arrives — on the unlock screen that
// means error text changing under the reader.
//
// ONLY THE SITE HALF IS BUNDLED HERE, and it is the small one. The other two are
// merged in at their own lazy boundaries: the app half (~770 keys of product-UI
// copy the landing never renders) with AuthedApp, and the pages half (the
// long-form public content — guide, security model, company) with PublicPages.
// Both use the same boundary that keeps libsodium off the landing. All three
// merge into i18next's single 'translation' namespace, so no call site knows or
// cares which half a key came from.
//
// COPIED, not passed by reference. i18next's addResourceBundle with deep-merge
// mutates the object it is given, so handing it `siteEn` directly meant
// loadAppCatalog() merged all 769 app keys INTO the exported site catalog —
// leaving the two halves aliased and the eager half measuring 807 keys instead
// of its own. Everything still rendered, which is what makes it worth writing
// down: the only symptom was the catalog test's "define no key twice"
// assertion, which was written for accidental duplication and caught this
// instead.
const resources = {
  en: { translation: { ...siteEn } },
  es: { translation: { ...siteEs } },
};

// Where a chosen language is remembered between visits, for readers who have no
// URL prefix to carry it (every signed-in screen). The ACCOUNT is the real source
// of truth once signed in — see useLocaleSync — and this is what a browser knows
// before that answer arrives.
const STORAGE_KEY = 'truecairn.locale';

// Every localStorage access is wrapped: Safari in private mode, and any browser
// with site data blocked, THROW on access rather than returning null. An
// unreadable preference must degrade to "no preference", never to a blank app.
//
// Exported because "has this browser stored an explicit choice?" is a DIFFERENT
// question from "what language are we rendering in?", and useLocaleSync needs
// the first one: it must not push a merely-defaulted 'en' up to an account that
// has deliberately never chosen (see migration 0067 on why NULL is meaningful).
export function readStoredLocale(): Locale | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // Preference is not persisted; the app still works in the chosen language
    // for this page's lifetime. Nothing to tell the user about.
  }
}

// THE URL WINS. A visitor on `/es/security` has asked for Spanish in the most
// explicit way available — they followed a link, or a search engine sent them —
// and a stored preference from a previous visit must not silently override that.
// Below the URL: a previously chosen language, then the browser's, then English.
//
// Guarded for the prerenderer, which has neither localStorage nor navigator.
export function resolveInitialLocale(pathname?: string): Locale {
  const fromPath = pathname === undefined ? null : splitLocalePath(pathname).locale;
  if (fromPath !== null && fromPath !== DEFAULT_LOCALE) return fromPath;
  const stored = readStoredLocale();
  if (stored !== null) return stored;
  const preferred = globalThis.navigator?.languages;
  return preferred === undefined ? DEFAULT_LOCALE : matchLocale(preferred);
}

// `lang` drives screen-reader pronunciation and hyphenation, so it has to track
// the rendered language rather than sit at the "en" index.html hardcodes. No-op
// under the prerenderer, where the per-route lang attribute is written into the
// static HTML instead.
function syncDocumentLang(locale: Locale): void {
  globalThis.document?.documentElement?.setAttribute('lang', locale);
}

// `keySeparator`/`nsSeparator` OFF: catalog keys are flat and contain dots
// ('auth.login.heading'), which i18next would otherwise read as a path into a
// nested object and fail to resolve. See the note at the top of catalog/site/en.ts.
//
// `escapeValue` off because React escapes interpolated values itself; leaving
// i18next's escaping on would double-encode an apostrophe in a display name.
void i18next.use(initReactI18next).init({
  resources,
  lng: resolveInitialLocale(globalThis.location?.pathname),
  fallbackLng: DEFAULT_LOCALE,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  // A key with no string anywhere is a bug we want loud in development and
  // silent-but-legible in production: i18next renders the key itself.
  returnNull: false,
});

syncDocumentLang(resolveInitialLocale(globalThis.location?.pathname));

// Merge the authenticated half in. Called once from AuthedApp, and safe to call
// again: addResourceBundle with deep+overwrite is idempotent for identical data.
//
// SYNCHRONOUS, because the module is already in the chunk by the time this runs
// — AuthedApp imports it statically, so there is nothing to await and no window
// in which a signed-in screen could paint its keys instead of its copy.
export function loadAppCatalog(appEn: object, appEs: object): void {
  i18next.addResourceBundle('en', 'translation', appEn, true, true);
  i18next.addResourceBundle('es', 'translation', appEs, true, true);
}

// The same door for the public CONTENT pages, merged in from PublicPages — the
// lazy chunk a visitor loads only when they leave "/" for /guide, /security or
// the company pages. Kept separate from the app half because the two chunks are
// mutually exclusive in practice: a signed-out reader of /security downloads no
// product-UI copy, and a signed-in user never pays for the long-form guide.
//
// Synchronous and idempotent for the same reasons as loadAppCatalog, and it runs
// under the PRERENDERER too — prerender.tsx imports PublicPages statically, so
// the bundle is registered at import time, before the first renderToString.
export function loadPagesCatalog(pagesEn: object, pagesEs: object): void {
  i18next.addResourceBundle('en', 'translation', pagesEn, true, true);
  i18next.addResourceBundle('es', 'translation', pagesEs, true, true);
}

export function currentLocale(): Locale {
  const lng = i18next.resolvedLanguage ?? i18next.language;
  return isLocale(lng) ? lng : DEFAULT_LOCALE;
}

// The one way the language changes. Persists, updates <html lang>, and lets
// i18next re-render every subscribed component.
export async function setLocale(locale: Locale): Promise<void> {
  await i18next.changeLanguage(locale);
  writeStoredLocale(locale);
  syncDocumentLang(locale);
}

export { i18next, LOCALES, OFFERED_LOCALES };
