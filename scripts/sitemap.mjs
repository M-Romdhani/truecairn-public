#!/usr/bin/env node
// ── Sitemap generator (2026-08-09) ───────────────────────────────────────────
//
// Writes apps/web/public/sitemap.xml and its sidecar scripts/sitemap-lastmod.json.
// Run it after editing any public page's prose:
//
//     pnpm gen:sitemap
//
// WHY THIS EXISTS. The sitemap used to be hand-maintained and carried no
// <lastmod>, on the reasoning that we had no per-page timestamp that was not a
// guess — and that a wrong date teaches crawlers our dates mean nothing. That
// reasoning still holds; what changed is that a non-guessed timestamp was
// available all along. Each public page's prose lives in a source file, and git
// records when that file's content last changed. So lastmod here is the commit
// date of the page's own source, and nothing else.
//
// NEVER THE BUILD DATE. This is the whole point, and the failure mode to guard
// against: deriving lastmod from `new Date()` at build time would stamp every
// page as freshly modified on every deploy, which is worse than omitting it —
// it turns the sitemap into a source of noise a crawler learns to discount.
// Hence generate-and-commit rather than generate-at-build: the dates are fixed
// in the repo, and the deploy pipeline neither computes nor touches them.
//
// WHY NOT LOOK UP GIT AT TEST TIME. CI checks out with actions/checkout@v4 at
// its default fetch-depth of 1, so `git log -1 -- <file>` returns nothing there
// for any file the single fetched commit did not touch. A test built on that
// would fail spuriously or, worse, skip — and a skipped suite reads exactly like
// a passing one (CLAUDE.md). Instead the digest below lets the test verify the
// dates are current WITHOUT git, in any clone, shallow or not.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://truecairn.app';
const SITEMAP_PATH = join(REPO_ROOT, 'apps/web/public/sitemap.xml');
const SIDECAR_PATH = join(REPO_ROOT, 'scripts/sitemap-lastmod.json');

// Route → the source(s) carrying that page's PROSE, in the order the sitemap
// lists them (which is PUBLIC_CLIENT_ROUTES in apps/api/src/spa-routes.ts;
// spa-routes.test.ts fails if the two sets ever diverge).
//
// PROSE ONLY, NOT THE SHARED CHROME. PublicPage.tsx and SiteFooter.tsx render on
// every page, so including them would restamp every page every time someone
// adjusts a footer link — announcing that the privacy policy changed when it did
// not. A page's lastmod tracks the words it shows.
//
// Several routes share a file (the five legal pages are all legal.tsx), so they
// share a date. That is coarse but not a guess: the sitemap spec defines lastmod
// as the last modification of the file, and for these pages the file IS the page.
// It can over-report freshness for a sibling, never under-report it.
//
// ── `keys`, added 2026-08-24 with the i18n extraction ────────────────────────
//
// The rule above — "a page's lastmod tracks the file its words live in" — broke
// silently when docs/40 Phase 2 moved every public page's copy out of its
// component and into shared catalog modules. Afterwards the component files hold
// structure and key NAMES, so the mapping was exactly backwards: editing the
// catalog (where a copy edit or a translation actually changes words) restamped
// nothing, and editing a component's markup (which changes no words) restamped
// the page.
//
// Naming the whole catalog file as a source fixes the under-reporting and
// creates the over-reporting this comment already rejects for chrome — one
// catalog holds four pages' worth of copy, so a guide edit would restamp the
// security pages. So a route names its catalog KEY PREFIXES instead, and the
// digest covers only the entries belonging to that page. Precision is preserved
// on both sides: a page restamps when ITS words change, and only then.
//
// English only, deliberately. The sitemap lists the source-language URLs; when
// Spanish is offered it gains its own /es/ entries, and those are what would key
// off the Spanish catalogs.
const CATALOGS = [
  'apps/web/src/i18n/catalog/site/en.ts',
  'apps/web/src/i18n/catalog/pages/en.ts',
];

const ROUTE_SOURCES = {
  '/': { files: ['apps/web/src/screens/Landing.tsx'], keys: ['site.landing.', 'site.meta.home.'] },
  '/guide': {
    files: ['apps/web/src/screens/guide/Guide.tsx'],
    keys: ['site.guide.', 'site.meta.guide.'],
  },
  // Not extracted (source-language only by decision, docs/40 Phase 0), so its
  // words are still in its own file. Its <head> copy is in the catalog.
  '/changelog': {
    files: ['apps/web/src/screens/public/Changelog.tsx'],
    keys: ['site.meta.changelog.'],
  },
  '/status': {
    files: ['apps/web/src/screens/public/company.tsx'],
    keys: ['site.status.', 'site.meta.status.'],
  },
  '/security': {
    files: ['apps/web/src/screens/public/security.tsx'],
    keys: ['site.security.model.', 'site.meta.security.title', 'site.meta.security.description'],
  },
  '/security/ai': {
    files: ['apps/web/src/screens/public/security.tsx'],
    keys: ['site.security.ai.', 'site.meta.security.ai.'],
  },
  '/security/build': {
    files: ['apps/web/src/screens/public/build.tsx'],
    keys: ['site.build.', 'site.meta.security.build.'],
  },
  '/security/disclosure': {
    files: ['apps/web/src/screens/public/security.tsx'],
    keys: ['site.security.disclosure.', 'site.meta.security.disclosure.'],
  },
  '/security/limits': {
    files: ['apps/web/src/screens/public/security.tsx'],
    keys: ['site.security.limits.', 'site.meta.security.limits.'],
  },
  '/security/threat-model': {
    files: ['apps/web/src/screens/public/security.tsx'],
    keys: ['site.security.threat.', 'site.meta.security.threatModel.'],
  },
  '/legal/privacy': {
    files: ['apps/web/src/screens/public/legal.tsx'],
    keys: ['site.meta.legal.privacy.'],
  },
  '/legal/terms': {
    files: ['apps/web/src/screens/public/legal.tsx'],
    keys: ['site.meta.legal.terms.'],
  },
  '/legal/dpa': { files: ['apps/web/src/screens/public/legal.tsx'], keys: ['site.meta.legal.dpa.'] },
  '/legal/sub-processors': {
    files: ['apps/web/src/screens/public/legal.tsx'],
    keys: ['site.meta.legal.subProcessors.'],
  },
  '/legal/wind-down': {
    files: ['apps/web/src/screens/public/legal.tsx'],
    keys: ['site.meta.legal.windDown.'],
  },
  '/company/about': {
    files: ['apps/web/src/screens/public/company.tsx'],
    keys: ['site.company.about.', 'site.meta.company.about.'],
  },
  '/company/contact': {
    files: ['apps/web/src/screens/public/company.tsx'],
    keys: ['site.company.contact.', 'site.meta.company.contact.'],
  },
  '/company/press': {
    files: ['apps/web/src/screens/public/company.tsx'],
    keys: ['site.company.press.', 'site.meta.company.press.'],
  },
};

// Every `'key': 'value'` / `"key": "value"` entry in a catalog module, flattened
// to one line each so the hash is stable against reflowing (Prettier moves a long
// value onto its own line when a comment above it grows, and that must not read
// as a copy change).
//
// A REGEX, NOT A PARSER, and that is a deliberate limit rather than an oversight:
// the catalogs are generated in one fixed shape — flat, single-quoted or
// double-quoted, one entry per key — so a regex sees all of them, and anything it
// misses is caught by the same test that catches drift, because the digest simply
// stops matching. It never invents an entry that is not there.
const CATALOG_ENTRY = /^\s*(['"])((?:site|settings)\.[A-Za-z0-9._]+)\1\s*:\s*([\s\S]*?),\n(?=\s*(?:\/\/|['"]|\}))/gm;

function catalogEntries(rel) {
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const out = new Map();
  for (const m of src.matchAll(CATALOG_ENTRY)) {
    out.set(m[2], m[3].replace(/\s+/g, ' ').trim());
  }
  return out;
}

// The content fingerprint the drift test recomputes. Keep this in step with the
// copy in spa-routes.test.ts — the duplication is deliberate (the test must not
// import a generator that could be wrong in the same way), and a divergence
// fails that test loudly rather than passing quietly.
//
// Files hash whole; catalogs contribute ONLY the entries whose key matches one of
// the route's prefixes, sorted so catalog order cannot move a digest. That is
// what keeps one shared catalog from restamping every page it serves.
function digestFor({ files, keys }) {
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(REPO_ROOT, rel)));
    h.update('\0');
  }
  const matched = [];
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

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Committer date (%cs, YYYY-MM-DD) rather than author date: it is when the
// content actually landed on the branch, and it survives a rebase meaningfully.
function committedDate(rel) {
  const out = git(['log', '-1', '--format=%cs', '--', rel]);
  return out === '' ? null : out;
}

// A file with uncommitted edits changed TODAY — that is a modification date, not
// a build date, and it is the date the commit about to be made will carry. This
// is what keeps generate-then-commit self-consistent: run the generator as part
// of the change that edits a page, and the recorded date matches the commit that
// lands it. A clean tree never reaches this branch.
function isDirty(rel) {
  return git(['status', '--porcelain', '--', rel]) !== '';
}

function lastmodFor(files) {
  const today = new Date().toISOString().slice(0, 10);
  const dates = [];
  for (const rel of [...files, ...CATALOGS]) {
    if (isDirty(rel)) {
      dates.push(today);
      continue;
    }
    const committed = committedDate(rel);
    if (committed !== null) dates.push(committed);
  }
  // Newest wins when a route is backed by more than one file. No date at all
  // (no git, or a file git has never seen) omits <lastmod> for that URL rather
  // than inventing one — an absent lastmod is ignored, a wrong one is believed.
  return dates.length === 0 ? null : dates.sort().at(-1);
}

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERATED FILE — do not edit by hand. Run \`pnpm gen:sitemap\` (scripts/sitemap.mjs).

  The public, crawlable routes — exactly the set matched by isPublicContentPath()
  in apps/web/src/main.tsx, plus "/" itself. Authenticated routes are deliberately
  absent; they are also Disallow-ed in /robots.txt.

  Absolute URLs on the canonical apex origin (docs/33): www and truecairn.xyz
  301 to it at the Cloudflare edge, so listing either here would advertise a URL
  that redirects.

  <lastmod> is the git commit date of the source file holding that page's prose —
  never the build date, which would restamp all seventeen pages on every deploy
  and teach crawlers our dates mean nothing. A route whose date cannot be
  established gets no lastmod at all rather than a guess: an omitted lastmod is
  ignored by crawlers, a wrong one is believed. Same reasoning as /status
  refusing to publish an unearned uptime figure.

  No <changefreq> or <priority>: Google has stated it ignores both.

  Kept in sync by apps/api/src/spa-routes.test.ts, which fails if a public route
  exists in the app but not in this file, and if any recorded date is stale
  relative to the source it was taken from.
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">`;

// ── Languages (docs/40 Phase 2) ──────────────────────────────────────────────
//
// A plain .mjs script cannot import the TypeScript in packages/shared, so the two
// facts it needs are read out of that file rather than restated: which languages
// are OFFERED, and which routes are published in only the source language. A
// regex over source is not elegant, but the alternative is a fourth copy of the
// same lists, and the failure mode of a stale copy here is a sitemap advertising
// URLs the build never produced — the exact soft-404 this repo already refuses.
// spa-routes.test.ts fails if the sitemap and the route table disagree.
const LOCALE_TS = readFileSync(join(REPO_ROOT, 'packages/shared/src/locale.ts'), 'utf8');

function readStringArray(name) {
  const m = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(LOCALE_TS);
  if (m === null) throw new Error(`sitemap: could not read ${name} from packages/shared/src/locale.ts`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const OFFERED_LOCALES = readStringArray('OFFERED_LOCALES');
const DEFAULT_LOCALE = /DEFAULT_LOCALE: Locale = '([^']+)'/.exec(LOCALE_TS)?.[1] ?? 'en';
const SOURCE_LANGUAGE_ONLY_ROUTES = readStringArray('SOURCE_LANGUAGE_ONLY_ROUTES');

const localizePath = (route, locale) =>
  locale === DEFAULT_LOCALE ? route : route === '/' ? `/${locale}` : `/${locale}${route}`;

const localesForRoute = (route) =>
  SOURCE_LANGUAGE_ONLY_ROUTES.includes(route) ? [DEFAULT_LOCALE] : OFFERED_LOCALES;

function main() {
  const routes = Object.keys(ROUTE_SOURCES);
  const sidecar = {};
  const lines = [];

  // The dates already published. A route whose digest is unchanged KEEPS its
  // recorded date rather than taking a fresh one, and that stickiness is what
  // makes the whole mechanism idempotent: lastmodFor() reads the git date of the
  // catalog files, which move whenever ANY page's copy is edited, so without this
  // every regeneration would restamp all eighteen URLs. The digest decides
  // whether a page changed; the date only moves when it did.
  const previous = existsSync(SIDECAR_PATH)
    ? JSON.parse(readFileSync(SIDECAR_PATH, 'utf8')).routes
    : {};

  for (const route of routes) {
    const { files, keys } = ROUTE_SOURCES[route];
    const digest = digestFor({ files, keys });
    const before = previous[route];
    const lastmod =
      before !== undefined && before.digest === digest ? before.lastmod : lastmodFor(files);
    sidecar[route] = { lastmod, sources: files, keys, digest };

    const locales = localesForRoute(route);
    for (const locale of locales) {
      const loc = `<loc>${SITE_ORIGIN}${localizePath(route, locale)}</loc>`;
      // xhtml:link alternates: every language version of a page names every
      // other AND itself, which is what the spec asks for. Emitted only when
      // there is more than one — a lone self-referential alternate says nothing.
      // Without these a search engine treats the two URLs as competing pages
      // rather than two versions of one, and may index only whichever it judged
      // stronger — losing the Spanish page for the Spanish reader it exists for.
      const alternates =
        locales.length > 1
          ? locales
              .map(
                (alt) =>
                  `<xhtml:link rel="alternate" hreflang="${alt}" href="${SITE_ORIGIN}${localizePath(route, alt)}"/>`,
              )
              .join('')
          : '';
      const mod = lastmod === null ? '' : `<lastmod>${lastmod}</lastmod>`;
      lines.push(`  <url>${loc}${mod}${alternates}</url>`);
    }
  }

  writeFileSync(SITEMAP_PATH, `${HEADER}\n${lines.join('\n')}\n</urlset>\n`, 'utf8');
  writeFileSync(
    SIDECAR_PATH,
    `${JSON.stringify(
      {
        note: 'GENERATED by scripts/sitemap.mjs — do not edit by hand. Run `pnpm gen:sitemap`.',
        why: 'Lets apps/api/src/spa-routes.test.ts verify every sitemap lastmod is current without shelling out to git, which CI’s depth-1 checkout cannot answer.',
        routes: sidecar,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const dated = Object.values(sidecar).filter((e) => e.lastmod !== null).length;
  console.log(
    `[sitemap] ${routes.length} public routes → apps/web/public/sitemap.xml (${dated} with lastmod)`,
  );
}

main();
