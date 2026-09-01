import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isKnownClientRoute,
  AUTHED_CLIENT_ROUTES,
  PUBLIC_CLIENT_ROUTES,
} from './spa-routes.js';
import {
  DEFAULT_LOCALE,
  LOCALES,
  OFFERED_LOCALES,
  SOURCE_LANGUAGE_ONLY_ROUTES,
  localesForRoute,
} from '@truecairn/shared';

// The route list in spa-routes.ts duplicates the React router, and a duplicate
// that silently falls behind is worse than none: a newly added page would 404
// for every crawler while looking perfect in a browser, and a removed one would
// keep answering 200 forever. So these tests read the ACTUAL sources — the same
// fs-scanning approach as docs-truth.test.ts and authority-fence.test.ts.

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../web');
const REPO_ROOT = resolve(HERE, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(WEB, rel), 'utf8');
}

// Duplicated from scripts/sitemap.mjs rather than imported, for the same reason
// digestFor() below is duplicated: a guard must not import the generator it
// guards, or a generator bug is faithfully reproduced by the test meant to catch
// it. Used by both sitemap blocks, so it lives here rather than in either.
function localizePath(route: string, locale: string): string {
  if (locale === DEFAULT_LOCALE) return route;
  return route === '/' ? `/${locale}` : `/${locale}${route}`;
}

// Pull every `<Route path="…">` literal out of a router module.
function routePaths(source: string): string[] {
  return [...source.matchAll(/<Route\s+[^>]*path="([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((p) => p !== '*');
}

describe('the client-route list cannot drift from the router', () => {
  it('covers every public route the SPA actually defines', () => {
    const declared = routePaths(read('src/PublicPages.tsx'));
    expect(declared.length).toBeGreaterThan(10);
    for (const path of declared) {
      expect(
        PUBLIC_CLIENT_ROUTES.includes(path),
        `PublicPages.tsx routes ${path} but spa-routes.ts does not list it — it would 404 for crawlers`,
      ).toBe(true);
    }
  });

  it('lists no public route the SPA does not define', () => {
    const declared = new Set(routePaths(read('src/PublicPages.tsx')));
    // '/' is the landing, rendered directly in main.tsx rather than as a Route.
    for (const path of PUBLIC_CLIENT_ROUTES.filter((p) => p !== '/')) {
      expect(declared.has(path), `spa-routes.ts lists ${path}, which PublicPages.tsx no longer routes`).toBe(
        true,
      );
    }
  });

  it('covers every authenticated route the SPA defines', () => {
    const declared = routePaths(read('src/App.tsx'));
    expect(declared.length).toBeGreaterThan(10);
    for (const path of declared) {
      // Parameterised routes are matched by pattern, not equality.
      const concrete = path.replace(/:[^/]+/g, 'x');
      expect(
        isKnownClientRoute(concrete),
        `App.tsx routes ${path} but spa-routes.ts would 404 it`,
      ).toBe(true);
    }
  });

  it('keeps main.tsx public-path matching aligned with the list', () => {
    // main.tsx decides which chunk loads; spa-routes.ts decides the status code.
    // If they disagree, a page loads fine and still reports 404, or vice versa.
    const main = read('src/main.tsx');
    for (const path of PUBLIC_CLIENT_ROUTES) {
      if (path === '/') continue;
      const prefix = `/${path.split('/')[1]!}`;
      const matched =
        main.includes(`pathname === '${path}'`) || main.includes(`pathname.startsWith('${prefix}')`);
      expect(matched, `${path} is public per spa-routes.ts but main.tsx would not load PublicPages for it`).toBe(
        true,
      );
    }
  });
});

describe('the sitemap lists exactly the public routes', () => {
  const sitemap = read('public/sitemap.xml');
  // Extract <loc> values WITHOUT assuming the origin — a regex anchored to
  // truecairn.app would silently skip a stray www or .xyz entry, which is
  // precisely what the origin test below needs to catch.
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  const ORIGIN = 'https://truecairn.app';
  const listed = locs
    .filter((loc) => loc.startsWith(ORIGIN))
    .map((loc) => loc.slice(ORIGIN.length));

  // LOCALE-AWARE, and that is the whole point of this block (QA 2026-08-25).
  //
  // These two assertions used to compare the sitemap against the UNLOCALIZED
  // route list, which tied it to the set of PAGES and to nothing else. Adding a
  // language to OFFERED_LOCALES changes what the sitemap should contain without
  // changing anything the old assertions read, so the suite stayed green on the
  // committed English-only file — measured by flipping the gate to
  // ['en', 'es'] and re-running this file: 27/27 passed, with zero /es/ entries
  // in sitemap.xml.
  //
  // Nothing downstream would have caught it either. The sitemap is
  // generate-and-commit by design (scripts/sitemap.mjs explains why the dates
  // must not be computed at build time), and `pnpm --filter @truecairn/web build`
  // deliberately does not refresh it. So regenerating was a manual step in the
  // launch PR, remembered only by whoever had read the note — and Spanish would
  // otherwise have shipped with its URLs advertised nowhere.
  //
  const published = PUBLIC_CLIENT_ROUTES.flatMap((route) =>
    localesForRoute(route).map((locale) => localizePath(route, locale)),
  );

  it('lists every public route, in every language it is published in', () => {
    for (const path of published) {
      expect(
        listed.includes(path),
        `${path} is published but missing from sitemap.xml — run: pnpm gen:sitemap`,
      ).toBe(true);
    }
  });

  it('lists nothing that is not a published route', () => {
    for (const path of listed) {
      expect(
        published.includes(path),
        `sitemap.xml advertises ${path}, which is not a public route in a language it is published in`,
      ).toBe(true);
    }
  });

  it('never advertises an authenticated route', () => {
    // The failure this prevents is a crawler being pointed at a login redirect,
    // and a sitemap that disagrees with robots.txt.
    for (const path of AUTHED_CLIENT_ROUTES) {
      expect(listed.includes(path)).toBe(false);
    }
  });

  it('uses the canonical apex origin for every URL, never www or the retired .xyz', () => {
    // Both 301 at the edge (docs/33), so either would advertise a redirect.
    // Asserted over the parsed <loc> values, not the raw file: the comment
    // explaining WHY those origins are wrong is not itself an advertisement.
    // Counted against the PUBLISHED set, not the route list: with a second
    // language offered the sitemap carries one <loc> per route per language, so
    // comparing to PUBLIC_CLIENT_ROUTES.length would go red on a correctly
    // regenerated file — a guard that fires on the right action is worse than no
    // guard, because the fix for it is to delete the guard.
    expect(locs.length).toBe(published.length);
    for (const loc of locs) {
      expect(loc.startsWith(ORIGIN), `${loc} is not on the canonical origin`).toBe(true);
    }
  });
});

// ── sitemap <lastmod> (2026-08-09) ───────────────────────────────────────────
//
// sitemap.xml and its sidecar are generated by scripts/sitemap.mjs from the git
// commit date of each page's source file. These tests are what make that date
// trustworthy, and they do it WITHOUT running git: CI checks out at
// actions/checkout@v4's default fetch-depth of 1, where `git log -1 -- <file>`
// answers nothing for any file that single commit did not touch. A git-based
// guard would fail spuriously or skip, and a skipped suite reads exactly like a
// passing one (CLAUDE.md). The recorded content digest closes that gap instead.
describe('sitemap lastmod', () => {
  interface SidecarEntry {
    lastmod: string | null;
    sources: string[];
    keys: string[];
    digest: string;
  }
  const sidecar = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts/sitemap-lastmod.json'), 'utf8'),
  ) as { routes: Record<string, SidecarEntry> };
  const sitemap = read('public/sitemap.xml');
  const entries = Object.entries(sidecar.routes);

  // Deliberately duplicates digestFor() in scripts/sitemap.mjs — the guard must
  // not import the generator it is guarding, or a generator bug would be
  // reproduced by the test that is supposed to catch it. A divergence between
  // the two fails here loudly rather than passing quietly.
  //
  // `keys` arrived with the i18n extraction (docs/40 Phase 2), which moved every
  // public page's copy out of its component and into shared catalog modules. A
  // route therefore hashes its own component file whole PLUS only the catalog
  // entries whose key matches one of its prefixes — otherwise one catalog serving
  // four pages would restamp all of them whenever any one of them was edited.
  const CATALOGS = [
    'apps/web/src/i18n/catalog/site/en.ts',
    'apps/web/src/i18n/catalog/pages/en.ts',
  ] as const;

  const CATALOG_ENTRY =
    /^\s*(['"])((?:site|settings)\.[A-Za-z0-9._]+)\1\s*:\s*([\s\S]*?),\n(?=\s*(?:\/\/|['"]|\}))/gm;

  function catalogEntries(rel: string): Map<string, string> {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const out = new Map<string, string>();
    for (const m of src.matchAll(CATALOG_ENTRY)) {
      out.set(m[2]!, m[3]!.replace(/\s+/g, ' ').trim());
    }
    return out;
  }

  function digestOf(files: readonly string[], keys: readonly string[]): string {
    const h = createHash('sha256');
    for (const rel of files) {
      h.update(rel);
      h.update('\0');
      h.update(readFileSync(join(REPO_ROOT, rel)));
      h.update('\0');
    }
    const matched: string[] = [];
    for (const rel of CATALOGS) {
      for (const [key, value] of catalogEntries(rel)) {
        if (keys.some((prefix) => key.startsWith(prefix))) matched.push(`${key}=${value}`);
      }
    }
    for (const line of matched.sort()) {
      h.update(line);
      h.update('\0');
    }
    return h.digest('hex').slice(0, 16);
  }

  it('covers exactly the public routes', () => {
    expect(Object.keys(sidecar.routes).sort()).toEqual([...PUBLIC_CLIENT_ROUTES].sort());
  });

  it('names source files that exist', () => {
    for (const [route, entry] of entries) {
      expect(entry.sources.length, `${route} has no source file`).toBeGreaterThan(0);
      for (const rel of entry.sources) {
        expect(existsSync(join(REPO_ROOT, rel)), `${route}: ${rel} does not exist`).toBe(true);
      }
    }
  });

  it('records a date that still describes the source it was taken from', () => {
    // THE POINT OF THE WHOLE MECHANISM. Edit a public page's prose without
    // regenerating and its lastmod now describes an older version of the file:
    // the sitemap asserts a date that is not true of the page it points at,
    // which is precisely what the previous no-lastmod policy existed to avoid.
    for (const [route, entry] of entries) {
      expect(
        digestOf(entry.sources, entry.keys),
        `${route}: ${entry.sources.join(', ')} or its catalog keys (${entry.keys.join(', ')}) changed since the sitemap was generated — run \`pnpm gen:sitemap\``,
      ).toBe(entry.digest);
    }
  });

  it('publishes an ISO date, never a future one', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const [route, entry] of entries) {
      if (entry.lastmod === null) continue; // omission is allowed, a guess is not
      expect(entry.lastmod, `${route}: "${entry.lastmod}" is not YYYY-MM-DD`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(
        entry.lastmod.localeCompare(today),
        `${route}: lastmod ${entry.lastmod} is in the future`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it('gives every public route a lastmod', () => {
    // Not a spec requirement — lastmod is optional, and the generator omits it
    // rather than guessing. But every route here IS backed by a committed file,
    // so a null means the generator ran somewhere without git history and
    // produced a sitemap weaker than the one already in the repo.
    for (const [route, entry] of entries) {
      expect(entry.lastmod, `${route} has no lastmod`).not.toBeNull();
    }
  });

  it('publishes exactly what the generator recorded, for every published language', () => {
    // Both files are written by the same run. If only one was committed, the
    // published sitemap and the record guarding it disagree.
    //
    // MATCHED AS A PREFIX, not as a whole line (QA 2026-08-25). A route
    // published in more than one language carries xhtml:link alternates after
    // the <lastmod>, so the old whole-line comparison stopped matching the
    // moment a second language was offered — this assertion went red on a
    // CORRECTLY regenerated sitemap, which is the worst kind of guard, because
    // the quickest way to make it green is to weaken it. Verified: with the gate
    // at ['en', 'es'] and `pnpm gen:sitemap` freshly run, the old form failed here
    // while the file was right.
    //
    // The alternates themselves are covered above (every published URL is listed,
    // and nothing else is) and by page-meta.test.tsx's hreflang tests. What this
    // block is for is the DATE, and the prefix pins the date to its URL.
    for (const [route, entry] of entries) {
      for (const locale of localesForRoute(route)) {
        const loc = `<loc>https://truecairn.app${localizePath(route, locale)}</loc>`;
        if (entry.lastmod === null) {
          // An absent date must stay absent. Without this the null case would be
          // satisfied by a line that carries a lastmod the record never recorded.
          expect(
            sitemap,
            `${route} (${locale}): recorded no lastmod, but the sitemap publishes one`,
          ).not.toContain(`${loc}<lastmod>`);
          expect(sitemap, `${route} (${locale}): missing from sitemap.xml`).toContain(
            `  <url>${loc}`,
          );
        } else {
          expect(
            sitemap,
            `${route} (${locale}): sitemap.xml does not match the generated record`,
          ).toContain(`  <url>${loc}<lastmod>${entry.lastmod}</lastmod>`);
        }
      }
    }
  });
});

describe('robots.txt', () => {
  const robots = read('public/robots.txt');

  it('disallows the authenticated surface and the API', () => {
    for (const path of ['/vault', '/settings', '/engine', '/ceremony', '/assistant', '/v1']) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });

  it('never disallows a public route', () => {
    const disallowed = [...robots.matchAll(/^Disallow: (\S+)$/gm)].map((m) => m[1]!);
    for (const path of PUBLIC_CLIENT_ROUTES) {
      if (path === '/') continue;
      expect(
        disallowed.some((d) => path === d || path.startsWith(`${d}/`)),
        `robots.txt blocks ${path}, which is meant to be crawlable`,
      ).toBe(false);
    }
  });

  it('points at the sitemap on the canonical origin', () => {
    expect(robots).toContain('Sitemap: https://truecairn.app/sitemap.xml');
  });
});

describe('isKnownClientRoute', () => {
  it('accepts public and authenticated routes', () => {
    expect(isKnownClientRoute('/')).toBe(true);
    expect(isKnownClientRoute('/security/threat-model')).toBe(true);
    expect(isKnownClientRoute('/vault')).toBe(true);
  });

  it('accepts a parameterised vault item without leaking whether it exists', () => {
    // Existence is an authenticated question; the status code must not answer it.
    expect(isKnownClientRoute('/vault/01J0000000000000000000')).toBe(true);
    expect(isKnownClientRoute('/vault/definitely-not-a-real-id')).toBe(true);
  });

  it('treats a trailing slash as the same route', () => {
    expect(isKnownClientRoute('/status/')).toBe(true);
  });

  it('rejects everything else', () => {
    for (const path of [
      '/nope',
      '/security/nonexistent',
      '/legal',
      '/vault/a/b',
      '/wp-admin',
      '/.env',
    ]) {
      expect(isKnownClientRoute(path), `${path} should not be a known route`).toBe(false);
    }
  });
});

// ── Language-prefixed public routes (docs/40 Phase 2) ────────────────────────
//
// A public page is published per language under a path prefix. The server has to
// agree with what the build actually EMITTED, in both directions: a prefixed page
// that exists must answer 200, and a prefixed URL the build never produced must
// 404. The second is the one that matters — this module exists to stop soft 404s,
// and a `/es/legal/privacy` answering 200 with the English shell would be one.
describeLocalePrefixes();

function describeLocalePrefixes(): void {
  describe('language-prefixed routes', () => {
    // EVERY language that exists, passed explicitly — so this exercises the real
    // multi-language behaviour while only English is published. Whether a
    // language is offered is a separate question, asserted at the foot.
    const all = LOCALES;
    const others = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

    it('accepts a translated public route under every non-default language', () => {
      for (const locale of others) {
        for (const path of PUBLIC_CLIENT_ROUTES.filter(
          (p) => !SOURCE_LANGUAGE_ONLY_ROUTES.includes(p),
        )) {
          const prefixed = path === '/' ? `/${locale}` : `/${locale}${path}`;
          expect(isKnownClientRoute(prefixed, all), `${prefixed} should be a known route`).toBe(true);
        }
      }
    });

    // The decision, not a gap: these pages are published in one language only
    // (SOURCE_LANGUAGE_ONLY_ROUTES in @truecairn/shared), so the build emits no
    // file for them under a prefix and neither may the server claim one.
    it('404s a source-language-only route under a language prefix', () => {
      for (const locale of others) {
        for (const path of SOURCE_LANGUAGE_ONLY_ROUTES) {
          const prefixed = `/${locale}${path}`;
          expect(
            isKnownClientRoute(prefixed, all),
            `${prefixed} should NOT be a known route`,
          ).toBe(false);
        }
      }
    });

    // Authenticated screens render in the language stored on the account and are
    // Disallow-ed in robots.txt. A prefixed one would be a second URL for a page
    // no crawler should reach and no link points to.
    it('404s an authenticated route under a language prefix', () => {
      for (const locale of others) {
        for (const path of AUTHED_CLIENT_ROUTES) {
          expect(isKnownClientRoute(`/${locale}${path}`, all)).toBe(false);
        }
      }
    });

    it('404s an unknown page under a language prefix', () => {
      for (const locale of others) {
        expect(isKnownClientRoute(`/${locale}/not-a-page`, all)).toBe(false);
        expect(isKnownClientRoute(`/${locale}/security/not-a-page`, all)).toBe(false);
      }
    });

    it('does not mistake a path that merely starts with the letters', () => {
      // '/estate-planning' is a page that does not exist, not a prefixed one.
      expect(isKnownClientRoute('/estate-planning', all)).toBe(false);
    });

    // The gate, by default. A language that exists but is not published must be
    // unreachable, not merely unlinked: the build emits no files for it, so a
    // 200 here would serve the shell for a page that was never rendered.
    it('404s a prefix for a language that is not offered', () => {
      for (const locale of LOCALES.filter((l) => !OFFERED_LOCALES.includes(l))) {
        expect(
          isKnownClientRoute(`/${locale}/security`),
          `/${locale}/security is not offered and must 404`,
        ).toBe(false);
      }
    });
  });
}
