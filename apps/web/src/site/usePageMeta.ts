import { useEffect } from 'react';
import i18next from 'i18next';
import type { Locale } from '@truecairn/shared';
import { useActiveLocale } from '../i18n/useT.js';
import {
  canonicalFor,
  descriptionFor,
  jsonLdFor,
  ogImageFor,
  titleFor,
  SITE_ORIGIN,
} from './page-meta.js';

// Resolved with an explicit `lng` for the same reason page-meta's helpers are:
// the value must not depend on i18next's ambient language, which the prerenderer
// moves between routes.
const t404Title = (locale: Locale): string =>
  i18next.t('site.meta.notFound.title' as never, { lng: locale });

// ── Head metadata, set imperatively (2026-07-30) ─────────────────────────────
//
// NO LIBRARY, DELIBERATELY. react-helmet and friends are the obvious reach here,
// but the constraint that rules them out is the CSP: apps/api/src/app.ts serves
// the SPA with `script-src 'self' 'wasm-unsafe-eval'; style-src 'self'` and no
// 'unsafe-inline'. Anything that injects an inline <script> or <style> works
// perfectly in local preview and is silently blocked in production — the worst
// possible failure shape, because nothing fails in the environment you test in.
//
// Writing to document.title and appending head elements from module code is NOT
// inline script and is unaffected. Verified in Chromium under the exact
// production policy, including the JSON-LD data block, before this shipped.
//
// UPSERT, NEVER APPEND-ONLY. This is a single-page app: navigating from /status
// to /security must REPLACE the description, not stack a second one. Every tag
// this module owns carries data-managed="page-meta" so it can find its own
// previous output and overwrite it, without touching the tags index.html ships.

const MANAGED = 'data-managed';
const MANAGED_VALUE = 'page-meta';

type MetaKey = { name: string } | { property: string };

function upsertMeta(key: MetaKey, content: string): void {
  const selector =
    'name' in key ? `meta[name="${key.name}"]` : `meta[property="${key.property}"]`;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (el === null) {
    el = document.createElement('meta');
    if ('name' in key) el.setAttribute('name', key.name);
    else el.setAttribute('property', key.property);
    el.setAttribute(MANAGED, MANAGED_VALUE);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function removeMeta(key: MetaKey): void {
  const selector =
    'name' in key ? `meta[name="${key.name}"]` : `meta[property="${key.property}"]`;
  document.head.querySelector(selector)?.remove();
}

function removeLink(rel: string): void {
  document.head.querySelector(`link[rel="${rel}"]`)?.remove();
}

function upsertLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (el === null) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    el.setAttribute(MANAGED, MANAGED_VALUE);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

// JSON-LD is a DATA BLOCK, not executable script: the HTML spec never prepares a
// <script> whose type is not a JavaScript MIME type, so CSP's script-src has
// nothing to block. Confirmed empirically under the production policy — both as
// served markup and injected this way — rather than taken on faith in either
// direction.
function upsertJsonLd(json: string | null): void {
  const existing = document.head.querySelector(
    `script[type="application/ld+json"][${MANAGED}="${MANAGED_VALUE}"]`,
  );
  if (json === null) {
    existing?.remove();
    return;
  }
  const el = existing ?? document.createElement('script');
  if (existing === null) {
    el.setAttribute('type', 'application/ld+json');
    el.setAttribute(MANAGED, MANAGED_VALUE);
    document.head.appendChild(el);
  }
  el.textContent = json;
}

export interface PageMetaInput {
  title: string;
  description?: string | undefined;
  canonical?: string | undefined;
  jsonLd?: string | undefined;
  // Authenticated routes ask not to be indexed. Belt-and-braces with robots.txt:
  // a Disallow stops a crawl, `noindex` stops an already-known URL being listed.
  noindex?: boolean | undefined;
}

export function usePageMeta(input: PageMetaInput): void {
  const { title, description, canonical, jsonLd, noindex } = input;
  useEffect(() => {
    document.title = title;

    if (description !== undefined) {
      upsertMeta({ name: 'description' }, description);
      upsertMeta({ property: 'og:description' }, description);
      upsertMeta({ name: 'twitter:description' }, description);
    } else {
      // A page with no honest description gets NO tag, so the search engine
      // picks a snippet from the content — better than inheriting the previous
      // route's sentence, which is what leaving it in place would do.
      for (const key of [
        { name: 'description' },
        { property: 'og:description' },
        { name: 'twitter:description' },
      ] as MetaKey[]) {
        removeMeta(key);
      }
    }

    upsertMeta({ property: 'og:title' }, title);
    upsertMeta({ property: 'og:type' }, 'website');
    upsertMeta({ property: 'og:site_name' }, 'Truecairn');
    upsertMeta({ property: 'og:image' }, ogImageFor());
    upsertMeta({ name: 'twitter:card' }, 'summary_large_image');
    upsertMeta({ name: 'twitter:title' }, title);

    if (canonical !== undefined) {
      upsertMeta({ property: 'og:url' }, canonical);
      upsertLink('canonical', canonical);
    } else {
      // Same rule as the description above, and for a stronger reason. This is a
      // single-page app: leaving the previous route's canonical in place would
      // have every 404 declare itself the canonical form of whatever page the
      // visitor came from — telling a crawler that /security and /typo are the
      // same document. A missing canonical is ignored; a wrong one is believed.
      removeMeta({ property: 'og:url' });
      removeLink('canonical');
    }

    if (noindex === true) upsertMeta({ name: 'robots' }, 'noindex, nofollow');
    else removeMeta({ name: 'robots' });

    upsertJsonLd(jsonLd ?? null);
  }, [title, description, canonical, jsonLd, noindex]);
}

// The public-page convenience: look the route up in the table and apply it.
// Called by PublicPage, so every public page gets metadata by existing rather
// than by each one remembering to ask.
export function usePublicPageMeta(pathname: string, notFound = false): void {
  // Subscribes this hook to the active language, so a page's title, description
  // and JSON-LD all re-resolve when it changes — the same reason every screen
  // reads its copy through the catalog rather than holding rendered strings.
  const locale = useActiveLocale();
  usePageMeta({
    title: notFound ? t404Title(locale) : titleFor(pathname, locale),
    description: notFound ? undefined : descriptionFor(pathname, locale),
    // A 404 must not name a canonical: the pathname is arbitrary and does not
    // exist, so emitting one would invite a crawler to index an infinite family
    // of URLs as though each were a real page. noindex for the same reason —
    // and no JSON-LD, which would otherwise have the page assert in
    // machine-readable form that it exists.
    ...(notFound
      ? { noindex: true }
      : { canonical: canonicalFor(pathname, locale), jsonLd: jsonLdFor(pathname, locale) }),
  });
}

export { SITE_ORIGIN };
