import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
// react-router 7 removed the `react-router-dom/server` subpath; StaticRouter now
// lives on the `react-router` main entry, which react-router-dom re-exports
// wholesale (`export * from "react-router"`). Imported from react-router-dom so
// the app keeps ONE router import specifier — react-router is only a transitive
// dependency here, and importing it directly would work by hoisting accident.
import { StaticRouter } from 'react-router-dom';
import {
  DEFAULT_LOCALE,
  OFFERED_LOCALES,
  localePathPrefix,
  localizePath,
  type Locale,
} from '@truecairn/shared';
import PublicPages from './PublicPages.js';
import { setLocale } from './i18n/index.js';
import { HERO_POSTER_SRC, Landing } from './screens/Landing.js';
import {
  canonicalFor,
  descriptionFor,
  jsonLdFor,
  localesForRoute,
  ogImageFor,
  titleFor,
  PAGE_META,
} from './site/page-meta.js';

// ── Build-time prerendering of the public routes (2026-07-30) ────────────────
//
// WHY. The served HTML was <div id="root"></div> and nothing else. Googlebot
// renders JavaScript on a second pass and eventually sees the page; GPTBot,
// ClaudeBot, Claude-SearchBot, OAI-SearchBot and PerplexityBot do NOT execute
// JavaScript at all, so to them every page on this site was blank. For a product
// whose entire public case is made in prose — the threat model, the wind-down
// playbook, what the AI may and may not do — being invisible to the crawlers
// that answer questions about products is a real loss.
//
// WHY react-dom/server AND NOT A PRERENDER PLUGIN. react-snap and
// vite-plugin-prerender both inject an inline <script> carrying hydration state,
// and the SPA is served with `script-src 'self' 'wasm-unsafe-eval'` and no
// 'unsafe-inline' — so they would work in local preview and be silently blocked
// in production. renderToString emits markup and nothing else. It also needs no
// browser, which matters because this repo's sandboxes usually cannot run
// Chromium (CLAUDE.md).
//
// WHY ONLY THESE ROUTES. main.tsx already splits the app: "/" renders <Landing>
// eagerly, the public pages live in a lazy chunk importing NONE of the
// authenticated graph, and everything else sits behind AuthedApp. So the routes
// below are already free of session state, crypto and libsodium. Prerendering an
// authenticated route would risk baking user state into a static file that gets
// served to everyone — a direct violation of the zero-knowledge invariant, and
// the reason this list is explicit rather than derived from "every route".
//
// HYDRATION. main.tsx keeps createRoot (not hydrateRoot). A crawler gets the
// prerendered HTML; a browser discards it and re-renders. The trade-off is a
// brief flash on first paint instead of a hydration-mismatch class of bug, and
// it is deliberate: /status renders live data that is BY DESIGN different at
// build time than at view time, so a hydrating build would mismatch on every
// load. Revisit only with a way to guarantee markup equality.

interface RenderTarget {
  route: string;
  locale: Locale;
  // Where the file lands under dist/. '/' is special: see writeTarget.
  outPath: string;
}

const PUBLIC_ROUTES: readonly string[] = Object.keys(PAGE_META);

// ONE FILE PER ROUTE PER OFFERED LANGUAGE (docs/40 Phase 2).
//
// OFFERED_LOCALES, not LOCALES. A language that exists in code but is not
// offered must not be published: emitting /es/* would put those URLs in front of
// search engines and give a Spanish reader a Spanish public page followed by an
// English app — the coverage cliff OFFERED_LOCALES exists to prevent. Turning
// the language on starts emitting these files and listing them in the sitemap,
// from the same one constant.
function renderRoute(route: string, locale: Locale): string {
  // '/' is the landing, rendered directly by main.tsx rather than through the
  // PublicPages router — mirror that here or it would render as a 404 redirect.
  const tree = route === '/' ? <Landing /> : <PublicPages />;
  // The basename mirrors main.tsx, so a <Link to="/security"> renders as
  // /es/security in the static Spanish file exactly as it does in the browser.
  return renderToString(
    <StaticRouter location={localizePath(route, locale)} basename={localePathPrefix(locale)}>
      {tree}
    </StaticRouter>,
  );
}

// The woff2 files for the faces the landing paints above the fold, resolved from
// the emitted assets by their stable prefix. Latin subset only — the landing's
// visible copy is Latin, and preloading latin-ext would spend the budget on a
// file that page never uses.
function aboveTheFoldFonts(): string[] {
  const assets = join(resolve(process.cwd(), 'dist'), 'assets');
  if (!existsSync(assets)) return [];
  const files = readdirSync(assets);
  const pick = (prefix: string): string | undefined =>
    files.find((f) => f.startsWith(prefix) && f.endsWith('.woff2'));
  return ['poppins-latin-600-normal-', 'figtree-latin-400-normal-']
    .map((p) => pick(p))
    .filter((f): f is string => f !== undefined)
    .map((f) => `/assets/${f}`);
}

// Build the <head> for a route from the SAME table the runtime hook uses, so a
// crawler that never runs JS and a browser that does see identical metadata.
function headFor(route: string, locale: Locale): string {
  const meta = PAGE_META[route];
  if (meta === undefined) return '';
  const tags: string[] = [];
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  tags.push(`<link rel="canonical" href="${esc(canonicalFor(route, locale))}">`);

  // hreflang: the set of languages this page exists in, each pointing at the
  // other. Without it a search engine treats /security and /es/security as
  // competing pages rather than two versions of one, and may index only whichever
  // it judged stronger — which is exactly the Spanish reader we are publishing
  // for losing the Spanish page.
  //
  // Emitted only when there is more than one language to point at: a lone
  // self-referential alternate says nothing, and x-default with no alternatives
  // is noise. Every page in the set names EVERY page including itself, which is
  // what the spec asks for.
  const alternates = localesForRoute(route);
  if (alternates.length > 1) {
    for (const alt of alternates) {
      tags.push(
        `<link rel="alternate" hreflang="${alt}" href="${esc(canonicalFor(route, alt))}">`,
      );
    }
    // x-default is where a reader whose language we do not publish should land.
    tags.push(
      `<link rel="alternate" hreflang="x-default" href="${esc(canonicalFor(route, DEFAULT_LOCALE))}">`,
    );
  }

  // The landing's largest paint is the hero poster — measured, Chromium reports
  // the LCP element as the <video> with the poster as its resource. Without this
  // the browser only learns the url after it has parsed the markup and started
  // the CSS, which on a throttled link is most of the wait.
  //
  // Emitted HERE and not in index.html, because index.html is the template for
  // every route: on /security, /legal and the rest the poster is never used, and
  // a preload nobody consumes is a wasted fetch plus a console warning. This
  // function is already the one place a route's <head> is decided.
  if (route === '/') {
    tags.push(
      `<link rel="preload" as="image" href="${esc(HERO_POSTER_SRC)}" type="image/webp" fetchpriority="high">`,
    );
    // The two faces used above the fold — the display face for the hero heading
    // and the 400 body face. Everything else can arrive with the rest of the CSS.
    //
    // The hrefs are READ FROM THE BUILD, never written down: @fontsource emits
    // content-hashed filenames, so a hardcoded preload would silently become a
    // wasted fetch of a file that no longer exists the first time the font is
    // bumped. If a face is not found the preload is simply omitted — the CSS
    // still requests it, so the failure mode is "slightly slower", not "broken".
    //
    // `crossorigin` is required on font preloads even same-origin: without it
    // the preload and the CSS request are treated as different fetches and the
    // file is downloaded twice, which is worse than not preloading at all.
    for (const href of aboveTheFoldFonts()) {
      tags.push(`<link rel="preload" as="font" type="font/woff2" href="${esc(href)}" crossorigin>`);
    }
  }
  const description = descriptionFor(route, locale);
  if (description !== undefined) {
    tags.push(`<meta name="description" content="${esc(description)}">`);
    tags.push(`<meta property="og:description" content="${esc(description)}">`);
    tags.push(`<meta name="twitter:description" content="${esc(description)}">`);
  }
  tags.push(`<meta property="og:title" content="${esc(titleFor(route, locale))}">`);
  tags.push(`<meta property="og:type" content="website">`);
  tags.push(`<meta property="og:site_name" content="Truecairn">`);
  tags.push(`<meta property="og:url" content="${esc(canonicalFor(route, locale))}">`);
  tags.push(`<meta property="og:image" content="${esc(ogImageFor())}">`);
  tags.push(`<meta name="twitter:card" content="summary_large_image">`);
  tags.push(`<meta name="twitter:title" content="${esc(titleFor(route, locale))}">`);
  // JSON-LD is a data block, never prepared as executable script, so script-src
  // does not apply. Verified in Chromium under the production policy.
  //
  // EVERY route with a table entry, not just '/'. jsonLdFor() decides what a
  // route deserves (the landing carries Organization/WebSite/SoftwareApplication;
  // nested pages carry a breadcrumb; all of them carry a WebPage), so this and
  // usePageMeta() emit the same nodes without either one holding a route list.
  const jsonLd = jsonLdFor(route, locale);
  if (jsonLd !== undefined) {
    // `<` escaped so a value can never close this <script> early. JSON.stringify
    // does not do it, \u003c is valid JSON, and the parsed data is identical.
    tags.push(
      `<script type="application/ld+json">${jsonLd.replace(/</g, '\\u003c')}</script>`,
    );
  }
  return tags.join('\n    ');
}

function pageFor(template: string, route: string, locale: Locale): string {
  const markup = renderRoute(route, locale);
  const meta = PAGE_META[route];
  let html = template.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
  if (meta !== undefined) {
    html = html.replace('<title>TrueCairn</title>', `<title>${titleFor(route, locale)}</title>`);
  }
  // index.html hardcodes lang="en". A crawler and a screen reader both take the
  // page's language from this attribute, and on a Spanish page the hardcoded
  // value is simply wrong — it is what decides pronunciation and hyphenation for
  // someone listening rather than reading.
  html = html.replace('<html lang="en">', `<html lang="${locale}">`);
  return html.replace('</head>', `  ${headFor(route, locale)}\n  </head>`);
}

async function main(): Promise<void> {
  const dist = resolve(process.cwd(), 'dist');
  const templatePath = join(dist, 'index.html');
  const template = readFileSync(templatePath, 'utf8');

  if (!template.includes('<div id="root"></div>')) {
    throw new Error('prerender: dist/index.html has no empty #root to fill — did the build change?');
  }

  // The pristine shell, kept as its own file. The not-found handler serves THIS
  // for authenticated routes and unknown paths, never the prerendered landing:
  // otherwise every /vault load would paint the marketing page for a frame
  // before React replaced it.
  writeFileSync(join(dist, 'app-shell.html'), template, 'utf8');

  const targets: RenderTarget[] = OFFERED_LOCALES.flatMap((locale) =>
    PUBLIC_ROUTES.filter((route) => localesForRoute(route).includes(locale)).map((route) => {
      // The default language keeps the bare paths it already publishes; every
      // other language nests under its prefix. '/' overwrites dist/index.html
      // (what the static server returns for the root), and '/es' becomes
      // dist/es/index.html.
      const localized = localizePath(route, locale);
      return {
        route,
        locale,
        outPath:
          localized === '/' ? join(dist, 'index.html') : join(dist, localized.slice(1), 'index.html'),
      };
    }),
  );

  let bytes = 0;
  for (const { route, locale, outPath } of targets) {
    // renderToString is synchronous, so the language has to be settled BEFORE it
    // runs — awaiting per route rather than per locale keeps the loop one shape
    // and costs nothing (changeLanguage on a bundled catalog resolves at once).
    await setLocale(locale);
    const html = pageFor(template, route, locale);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, 'utf8');
    bytes += Buffer.byteLength(html);
  }
  await setLocale(DEFAULT_LOCALE);

  const langs = OFFERED_LOCALES.join(', ');
  console.log(
    `[prerender] ${PUBLIC_ROUTES.length} public routes × ${OFFERED_LOCALES.length} language(s) [${langs}] ` +
      `= ${targets.length} files → dist/ (${Math.round(bytes / 1024)} KiB), shell kept at app-shell.html`,
  );
}

// NOT top-level await: the SSR bundle is built for the same browser target as
// the app (chrome87/es2020), which does not have it, and esbuild fails the whole
// build rather than downlevelling. Explicit exit(1) so a prerender failure stops
// the build instead of leaving a dist/ with silently missing pages.
main().catch((err: unknown) => {
  console.error('[prerender] failed', err);
  process.exit(1);
});
