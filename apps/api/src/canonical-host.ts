// ── Non-canonical host: suppress crawling, change nothing else (2026-08-11) ──
//
// `api.truecairn.app` and `truecairn.app` are the SAME Railway service on two
// custom domains (docs/33), so the API host serves a byte-identical copy of the
// prerendered marketing site — including `robots.txt`, which says `Allow: /`
// with no host restriction because it is a static file from `apps/web/public`
// and a static file cannot know which host asked for it. Both hosts sit inside
// the one `sc-domain:truecairn.app` Search Console property, so every public
// page exists twice as far as a crawler is concerned.
//
// The canonical <link> already points at the apex, and that is enough to
// consolidate INDEXING. It does not refund the CRAWLING: a duplicate has to be
// fetched before its canonical can be read. On a site whose crawl budget is not
// currently covering the pages that matter, spending it twice is the cost.
//
// ── A HEADER, NOT A REDIRECT ─────────────────────────────────────────────────
// Redirecting the API host to the apex is the obvious move and it is wrong here
// on three counts, each of which breaks something real:
//
//   • `/v1` is the entire reason this host exists. The Flutter client and every
//     browser session talk to it.
//   • `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`
//     must be SERVED from the host being asked about (docs/35 §4). An OS
//     resolving a passkey association does not chase a redirect to find them.
//   • A 301 turns a POST into a GET with no body — the exact quiet failure
//     docs/33 records for the vendor webhooks, where the edge looks healthy and
//     the handler never runs.
//
// A response header changes what a crawler does with a page and nothing at all
// about what a client can reach. That asymmetry is the whole point.
//
// ── FAIL OPEN, DELIBERATELY ──────────────────────────────────────────────────
// Every predicate below answers "should this response be suppressed?" with
// `false` whenever it cannot be certain. The two outcomes are not symmetric: a
// bug that lets a duplicate get crawled costs some crawl budget, while a bug
// that suppresses the APEX removes the product from search entirely — and does
// it silently, because nothing a human can see on the page changes. So the
// uncertain case always resolves to doing nothing.

/**
 * The canonical public host, or `undefined` to apply no restriction.
 *
 * MUST be derived from an explicitly-set `PUBLIC_BASE_URL` and never from
 * `config.publicBaseUrl`, which falls back through `WEBAUTHN_ORIGIN` to
 * `http://localhost:3001`. That default is the trap: it would make the
 * canonical host `localhost`, every request on a deployed host non-canonical,
 * and the whole apex `noindex` — the precise failure the fail-open rule above
 * exists to prevent, arrived at by way of a helpful default.
 */
export function canonicalHostFrom(publicBaseUrl: string | undefined): string | undefined {
  if (publicBaseUrl === undefined) return undefined;
  let hostname: string;
  try {
    hostname = new URL(publicBaseUrl).hostname;
  } catch {
    // Unparseable is indistinguishable from unset, and both mean "we do not
    // know what the canonical host is", which means we must not judge any host
    // against it.
    return undefined;
  }
  return hostname === '' ? undefined : hostname.toLowerCase();
}

/**
 * Strip the port from a Host header value. IPv6 literals are bracketed
 * (`[::1]:8080`), so the port separator is the first colon AFTER the closing
 * bracket, not the first colon in the string.
 */
function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Did this request arrive on a host that is not the canonical one?
 *
 * `false` — meaning "do nothing" — for a missing canonical host (no
 * `PUBLIC_BASE_URL`) and for a missing or empty `Host` header. Compared without
 * the port and case-insensitively, because a Host header carries both and
 * neither distinguishes one site from another.
 */
export function isNonCanonicalHost(
  hostHeader: string | undefined,
  canonicalHost: string | undefined,
): boolean {
  if (canonicalHost === undefined) return false;
  if (hostHeader === undefined) return false;
  const host = stripPort(hostHeader.trim().toLowerCase());
  if (host === '') return false;
  return host !== canonicalHost;
}

/**
 * Paths the suppression must never touch, whatever host they arrive on.
 *
 * `/v1` is the API — the reason the non-canonical host exists at all. The
 * `/.well-known/*` files are how an OS asks whether this app may hold passkeys
 * for `truecairn.app` (docs/35 §4); a `noindex` header on them would in fact be
 * inert, but excluding them here means no future edit to this lane can reach
 * them at all, which is the guarantee worth having. `/health` and `/ready` are
 * probed by the platform on whatever host it pleases.
 */
export function isHostSuppressionExempt(path: string): boolean {
  return (
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path === '/health' ||
    path === '/ready' ||
    path.startsWith('/.well-known/')
  );
}

/**
 * What `robots.txt` says on a non-canonical host: nothing here is meant to be
 * crawled. Served INSTEAD of the apex file, which `@fastify/static` would
 * otherwise hand out verbatim from `dist/` — `Allow: /`, no host restriction,
 * and a `Sitemap:` line advertising the apex's URLs from the duplicate host.
 *
 * No `Sitemap:` line of its own, on purpose: pointing a crawler at the apex
 * sitemap from here would re-introduce the duplicate crawl this is closing.
 */
export const NON_CANONICAL_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** The one path whose BODY changes on a non-canonical host. */
export const ROBOTS_PATH = '/robots.txt';
