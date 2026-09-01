import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicPages from '../src/PublicPages.js';
import {
  DEFAULT_LOCALE,
  OFFERED_LOCALES,
  SOURCE_LANGUAGE_ONLY_ROUTES,
  type Locale,
} from '@truecairn/shared';
import '../src/i18n/index.js';
import {
  canonicalFor,
  descriptionFor,
  jsonLdFor,
  localesForRoute,
  titleFor,
  PAGE_META,
  SITE_ORIGIN,
} from '../src/site/page-meta.js';
import { PERSONAL_PRICE } from '../src/billing/pricing.js';
import { REPO_URL } from '../src/site/links.js';
import lastmodSidecar from '../../../scripts/sitemap-lastmod.json';

// Head metadata for the public pages. These pin the properties that actually
// decide whether a shared link or a search result is any good — and the SPA
// hazard that a per-page <head> introduces: stale tags surviving a navigation.

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PublicPages />
    </MemoryRouter>,
  );
}

const PUBLIC_PATHS = Object.keys(PAGE_META);

describe('the metadata table', () => {
  it('covers every public route and nothing else', () => {
    // The sitemap is the other half of this contract and is checked against the
    // router in apps/api/src/spa-routes.test.ts; this keeps the copy aligned
    // with the same set.
    expect(PUBLIC_PATHS).toContain('/');
    // 17 → 18 on 2026-08-13: /security/limits (D9). Bumping this number is
    // meant to be a deliberate act — a new public route has to be wired into
    // six other places (the router, spa-routes.ts, the sitemap sources, the
    // footer, llms.txt and this table), and the count is what makes a partial
    // wiring fail loudly here instead of shipping a page that prerenders blank.
    expect(PUBLIC_PATHS.length).toBe(18);
    for (const path of PUBLIC_PATHS) expect(path.startsWith('/')).toBe(true);
  });

  // EVERY PUBLISHED LANGUAGE, not just the source one. A translated title is a
  // published claim that a search engine repeats, and it is subject to the same
  // limits: truncation at 65 characters and the 140–160 description band do not
  // become optional in Spanish. Translations run longer than English far more
  // often than shorter, so this is where that gets caught.
  const published = (path: string): readonly Locale[] => localesForRoute(path);

  it('gives every page a distinct title, in every language it is published in', () => {
    // Identical titles are the pre-existing bug: every page was "TrueCairn", so
    // search results and browser tabs could not be told apart.
    for (const locale of OFFERED_LOCALES) {
      const paths = PUBLIC_PATHS.filter((p) => published(p).includes(locale));
      const titles = paths.map((p) => titleFor(p, locale));
      expect(new Set(titles).size, `${locale}: duplicate titles`).toBe(titles.length);
    }
  });

  it('keeps titles short enough not to be truncated', () => {
    for (const locale of OFFERED_LOCALES) {
      for (const path of PUBLIC_PATHS.filter((p) => published(p).includes(locale))) {
        const title = titleFor(path, locale);
        expect(
          title.length,
          `${locale} ${path}: "${title}" is ${title.length} chars`,
        ).toBeLessThanOrEqual(65);
        expect(title.length).toBeGreaterThan(5);
      }
    }
  });

  it('writes descriptions in the 140–160 band, or omits them entirely', () => {
    for (const locale of OFFERED_LOCALES) {
    for (const path of PUBLIC_PATHS.filter((p) => published(p).includes(locale))) {
      const description = descriptionFor(path, locale);
      if (description === undefined) continue; // omission is allowed, padding is not
      // The band search engines actually render without truncating or padding.
      // Enforced tightly on purpose: a loose bound here is how "write a real
      // description" quietly degrades into "write something".
      expect(
        description.length,
        `${locale} ${path}: description is ${description.length} chars, outside 140–160`,
      ).toBeGreaterThanOrEqual(140);
      expect(
        description.length,
        `${locale} ${path}: description is ${description.length} chars, outside 140–160`,
      ).toBeLessThanOrEqual(160);
    }
    }
  });

  it('gives every page a distinct description', () => {
    for (const locale of OFFERED_LOCALES) {
      const descriptions = PUBLIC_PATHS.filter((p) => published(p).includes(locale))
        .map((p) => descriptionFor(p, locale))
        .filter((d): d is string => d !== undefined);
      expect(new Set(descriptions).size, `${locale}: duplicate descriptions`).toBe(
        descriptions.length,
      );
    }
  });

  // A route published in a language it was never rendered in is a 404 with an
  // hreflang pointing at it. The prerenderer and the sitemap both ask
  // localesForRoute(), so this pins the answer it gives.
  it('publishes the source-language-only routes in one language only', () => {
    for (const route of SOURCE_LANGUAGE_ONLY_ROUTES) {
      expect(localesForRoute(route), `${route} should be source-language only`).toEqual([
        DEFAULT_LOCALE,
      ]);
    }
    const translated = PUBLIC_PATHS.filter((p) => !SOURCE_LANGUAGE_ONLY_ROUTES.includes(p));
    for (const route of translated) {
      expect(localesForRoute(route)).toEqual(OFFERED_LOCALES);
    }
  });

  it('builds canonicals on the apex origin only', () => {
    // www and .xyz both 301 (docs/33), so a canonical pointing at either would
    // name a URL that redirects.
    expect(canonicalFor('/status')).toBe('https://truecairn.app/status');
    expect(SITE_ORIGIN).toBe('https://truecairn.app');
    expect(SITE_ORIGIN).not.toContain('www.');
  });
});

describe('JSON-LD', () => {
  function nodesFor(route: string): Record<string, unknown>[] {
    const raw = jsonLdFor(route);
    expect(raw, `${route} should carry JSON-LD`).toBeDefined();
    return JSON.parse(raw!) as Record<string, unknown>[];
  }

  function typesFor(route: string): unknown[] {
    return nodesFor(route).map((n) => n['@type']);
  }

  it('puts the site-wide entities on the landing page only', () => {
    // Organization, WebSite and the product describe the SITE. Repeating them on
    // every page would ask a crawler to reconcile seventeen copies of one entity.
    expect(typesFor('/')).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
      'WebPage',
    ]);
    for (const path of PUBLIC_PATHS.filter((p) => p !== '/')) {
      expect(typesFor(path), `${path} must not redeclare the site`).not.toContain('Organization');
      expect(typesFor(path)).not.toContain('SoftwareApplication');
    }
  });

  it('gives every public route a WebPage node', () => {
    for (const path of PUBLIC_PATHS) {
      expect(typesFor(path), `${path} needs a WebPage`).toContain('WebPage');
    }
  });

  it('names no legal entity, because none exists', () => {
    // The Organization node carried `legalName: 'Truecairn, Inc.'` until
    // 2026-08-13 for a company that has never been incorporated (docs/31 §1).
    // This is the widest-reach surface of the six that carried the claim: it is
    // machine-readable, a search engine repeats it verbatim to people who never
    // visited the site, and it shipped in the prerendered HTML of all 17 public
    // pages rather than only where a reader might look for it.
    //
    // Asserted over the field AND over the serialized string: dropping
    // `legalName` while a corporate identity returns under `name`, `alternateName`
    // or `founder` would satisfy a field check and republish the same claim.
    // Guarding the whole document is what makes this pin hard to defeat by
    // accident, which is the only way it will be defeated.
    const org = nodesFor('/').find((n) => n['@type'] === 'Organization')!;
    expect(org['legalName'], 'no legalName until an entity exists').toBeUndefined();
    for (const path of PUBLIC_PATHS) {
      expect(jsonLdFor(path), `${path} JSON-LD must name no corporate entity`).not.toMatch(
        /\bInc\.?\b|\bLLC\b|\bLtd\.?\b|\bGmbH\b|\bCorp\.?\b/,
      );
    }
  });

  it('breadcrumbs the nested routes, two levels, and nothing else', () => {
    // /security/*, /legal/*, /company/* have a parent; /guide and /status do not.
    for (const path of PUBLIC_PATHS) {
      const nested = path.split('/').length === 3;
      const crumb = nodesFor(path).find((n) => n['@type'] === 'BreadcrumbList');
      if (!nested) {
        expect(crumb, `${path} should have no breadcrumb`).toBeUndefined();
        continue;
      }
      expect(crumb, `${path} should have a breadcrumb`).toBeDefined();
      const items = crumb!['itemListElement'] as Record<string, unknown>[];
      // Exactly two: root → page. A middle crumb would name a section index
      // (/legal, /company) that 404s.
      expect(items.length, `${path} breadcrumb depth`).toBe(2);
      expect(items[0]!['item']).toBe(SITE_ORIGIN);
      expect(items[1]!['item']).toBe(canonicalFor(path));
    }
  });

  it('dates pages from the sitemap sidecar, never from a build date', () => {
    // The sidecar is generated from source digests by scripts/sitemap.mjs. A
    // build date would claim every page changed on every deploy.
    const sidecar = lastmodSidecar as { routes: Record<string, { lastmod?: string }> };
    for (const path of PUBLIC_PATHS) {
      const page = nodesFor(path).find((n) => n['@type'] === 'WebPage')!;
      const expected = sidecar.routes[path]?.lastmod;
      // Absent from the sidecar ⇒ no dateModified at all. An absent date reads
      // as unknown; a wrong one is believed.
      expect(page['dateModified'], `${path} dateModified`).toBe(expected);
    }
  });

  it('claims nothing a public page does not already say', () => {
    // Structured data that overclaims is worse than none: a search engine
    // repeats it on our behalf, to people who never visited. Same rule as the
    // press page's refusal list — which states we hold no certifications.
    for (const path of PUBLIC_PATHS) {
      const raw = jsonLdFor(path)!;
      expect(raw, path).not.toMatch(/aggregateRating|review|award|numberOfEmployees/i);
      expect(raw, path).not.toMatch(/SOC ?2|ISO ?27001/i);
    }
  });

  it('sames-as only the profiles that exist', () => {
    // One real profile ⇒ one entry. Padding sameAs with accounts nobody holds
    // is how a machine-readable claim quietly becomes a lie.
    const org = nodesFor('/').find((n) => n['@type'] === 'Organization')!;
    expect(org['sameAs']).toEqual([REPO_URL]);
  });

  it('prices the offers at what is actually billed', () => {
    // Mirrors the landing pricing section, from the same constants that render
    // it. The $6.67 headline is the annual total ÷ 12 for display — nobody is
    // charged it — so it must NOT appear here.
    const app = nodesFor('/').find((n) => n['@type'] === 'SoftwareApplication')!;
    expect(app['applicationCategory']).toBe('SecurityApplication');
    const offers = app['offers'] as Record<string, unknown>[];
    expect(offers.map((o) => o['price'])).toEqual([
      '0',
      String(PERSONAL_PRICE.monthlyPerMonth),
      String(PERSONAL_PRICE.annualPerYear),
    ]);
    for (const offer of offers) expect(offer['priceCurrency']).toBe('USD');
    expect(JSON.stringify(offers)).not.toContain('6.67');
  });

  it('uses absolute URLs on the canonical origin', () => {
    for (const path of PUBLIC_PATHS) {
      for (const node of nodesFor(path)) {
        if (typeof node['url'] === 'string') {
          expect(node['url'].startsWith(SITE_ORIGIN), `${path}: ${node['url']}`).toBe(true);
        }
        if (typeof node['logo'] === 'string') {
          expect(node['logo'].startsWith(`${SITE_ORIGIN}/`)).toBe(true);
        }
      }
    }
  });

  it('emits nothing for a path that is not a real page', () => {
    // A 404 asserting in machine-readable form that it exists is the soft-404
    // bug wearing a different hat.
    expect(jsonLdFor('/not-a-page')).toBeUndefined();
    expect(jsonLdFor('/vault')).toBeUndefined();
  });
});

describe('applied to the document', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.querySelectorAll('[data-managed="page-meta"]').forEach((el) => el.remove());
    document.querySelectorAll('link[rel="canonical"]').forEach((el) => el.remove());
  });

  function head() {
    return {
      title: document.title,
      description:
        document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
      canonical:
        document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogTitle:
        document.head.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null,
    };
  }

  it('sets title, description and canonical for a public page', () => {
    renderAt('/security/threat-model');
    const h = head();
    expect(h.title).toBe(titleFor('/security/threat-model', DEFAULT_LOCALE));
    expect(h.description).toBe(descriptionFor('/security/threat-model', DEFAULT_LOCALE));
    expect(h.canonical).toBe('https://truecairn.app/security/threat-model');
    expect(h.ogTitle).toBe(h.title);
  });

  it('replaces rather than accumulates when the route changes', () => {
    // THE SPA hazard. Without an upsert, navigating leaves the previous page's
    // description in the head and appends a second one — so a share card can
    // show the wrong page's copy, and which one wins is undefined.
    const first = renderAt('/status');
    expect(head().title).toBe(titleFor('/status', DEFAULT_LOCALE));
    first.unmount();

    renderAt('/legal/privacy');
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(head().description).toBe(descriptionFor('/legal/privacy', DEFAULT_LOCALE));
    expect(head().canonical).toBe('https://truecairn.app/legal/privacy');
  });

  it('treats a trailing slash as the same route', () => {
    renderAt('/company/press/');
    expect(document.title).toBe(titleFor('/company/press', DEFAULT_LOCALE));
  });

  it('marks no public page noindex', () => {
    renderAt('/guide');
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots).toBeNull();
  });
});
