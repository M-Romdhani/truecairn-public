import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute as isAbsolutePath, join as joinPath, resolve as resolvePath } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { initCrypto } from '@truecairn/crypto';
import { createClient, type Database } from '@truecairn/db';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  createWebAuthnVerifier,
  type WebAuthnConfig,
  type WebAuthnVerifier,
} from './auth/webauthn.js';
import type { ApiConfig } from './config.js';
import { ApiError, PROBLEM_CONTENT_TYPE, type ProblemDetails } from './errors.js';
import { loggerOptions, registerRequestLogging } from './logging.js';
import { clientIpIsDistinguishing, registerClientIp } from './auth/client-ip.js';
import { registerOriginGuard } from './origin-guard.js';
import { REQUEST_TIMEOUT_MS } from './upload-windows.js';
import { hardwareKeyRoutes } from './routes/auth-hardware-key.js';
import { logoutRoutes } from './routes/auth-logout.js';
import { passwordSetupRoutes } from './routes/auth-password-setup.js';
import { ceremonyRoutes } from './routes/ceremonies.js';
import { contactManagementRoutes } from './routes/contact-management.js';
import { contactRoutes } from './routes/contacts.js';
import { passwordLoginRoutes } from './routes/auth-password.js';
import { stepUpSecondFactorRoutes } from './routes/auth-stepup.js';
import { totpRoutes } from './routes/auth-totp.js';
import { webauthnRoutes } from './routes/auth-webauthn.js';
import { accountRoutes } from './routes/account.js';
import { keyMaterialRoutes } from './routes/account-key-material.js';
import { aiRoutes } from './routes/ai.js';
import { aiProposalRoutes } from './routes/ai-proposals.js';
import { briefingRoutes } from './routes/briefing.js';
import { readinessRoutes } from './routes/readiness.js';
import type { BriefingGenerator } from './ai/gemini.js';
import { billingRoutes } from './routes/billing.js';
import { channelRoutes } from './routes/channels.js';
import { continuityRoutes } from './routes/continuity.js';
import { auditRoutes } from './routes/audit.js';
import { opsRoutes } from './routes/ops.js';
import { statusRoutes } from './routes/status.js';
import { engineRoutes } from './routes/engine.js';
import { healthRoutes } from './routes/health.js';
import { notificationsWebhookRoutes } from './routes/notifications-webhook.js';
import { readyRoutes } from './routes/ready.js';
import { vaultAttachmentRoutes } from './routes/vault-attachments.js';
import { vaultCaptureKeyRoutes, vaultCaptureRoutes } from './routes/vault-captures.js';
import { vaultRoutes } from './routes/vault.js';
import { isKnownClientRoute, PUBLIC_CLIENT_ROUTES } from './spa-routes.js';
import {
  isHostSuppressionExempt,
  isNonCanonicalHost,
  NON_CANONICAL_ROBOTS_TXT,
  ROBOTS_PATH,
} from './canonical-host.js';

type Sql = ReturnType<typeof createClient>['sql'];

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Apple's app-association file, which the OS fetches from this exact path.
const APPLE_APP_SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';

// Static-asset cache tiers — see the onSend hook that uses them. Hoisted so the
// regexes compile once rather than per response, and so the test can import the
// same two patterns instead of restating them (a copy would drift).
export const HASHED_ASSET_PATH = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
export const STATIC_ASSET_PATH = /^\/assets\//;

// API responses carry no markup and load nothing — lock everything.
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
// The served SPA: everything self-hosted; 'wasm-unsafe-eval' is required for
// libsodium's WebAssembly instantiation; data: images cover inline assets.
const SPA_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'";

// Optional injected dependencies. Tests pass a ready-made DB connection (and own
// its lifecycle) plus a fake WebAuthn verifier; in production buildApp creates
// the client from config.databaseUrl and the real @simplewebauthn verifier.
export interface AppDeps {
  db?: Database;
  sql?: Sql;
  webauthnVerifier?: WebAuthnVerifier;
  // Test seam: inject a fake AI generator so the guard path (rate-limit, breaker,
  // opt-out, usage) is exercised without real Gemini credentials. The master kill
  // switch still wins — AI_ENABLED=false disables even an injected generator.
  aiGenerator?: BriefingGenerator;
}

// Builds the Fastify app WITHOUT starting to listen, so it is fully exercisable
// via app.inject() in tests. index.ts calls this then listens.
export function buildApp(config: ApiConfig, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, ...loggerOptions },
    genReqId: () => randomUUID(),
    // Don't trust client-supplied request ids by default.
    requestIdHeader: false,
    // Behind a PaaS edge / LB (docs/23) X-Forwarded-* carries the real client;
    // off by default so a direct deployment can't be header-spoofed.
    trustProxy: config.trustProxy,
    // Cap how long a request may take to ARRIVE (2026-08-08 re-audit, N-2).
    // Fastify defaults this to 0 and then assigns server.requestTimeout = 0
    // unconditionally, which DISABLES Node's own 300s default — so without this
    // line a request can live forever. The streamed upload routes depend on it:
    // their stale-claim window is derived from this value so a claim can only go
    // stale after the request holding it is provably dead. See upload-windows.ts.
    requestTimeout: REQUEST_TIMEOUT_MS,
  });

  registerRequestLogging(app);

  // The origin lock runs FIRST: a request that did not come through the trusted
  // edge should be refused before anything else looks at it — including before
  // the client-IP resolver believes that edge's header (QA 2026-08-26 F1).
  // Inert unless ORIGIN_GUARD_SECRET is set.
  registerOriginGuard(app, config);
  // Decide the client address once, for every per-IP control.
  registerClientIp(app, config);
  if (!clientIpIsDistinguishing(config)) {
    // Not an error — the per-IP controls still fail closed — but behind an edge
    // every visitor now shares one bucket, so a few failures anywhere can
    // throttle everyone. Say so at boot rather than let it be found in prod.
    app.log.warn(
      'client_ip.not_distinguishing: TRUST_PROXY is on but CLIENT_IP_HEADER is unset — ' +
        'per-IP throttles will bucket all traffic behind the edge together. ' +
        'Set CLIENT_IP_HEADER (cf-connecting-ip) together with ORIGIN_GUARD_SECRET.',
    );
  }

  // ── Security response headers (posture review) ────────────────────────────
  // Two CSPs: API responses (JSON/problem+json/octet-stream) get the maximally
  // restrictive policy; the served SPA (docs/23 single-origin deploy) gets the
  // policy the app actually needs — self-hosted scripts/styles plus
  // 'wasm-unsafe-eval', which libsodium's WASM instantiation requires. HSTS
  // only in production (it is meaningless — and sticky — on dev http origins).
  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    // CSP is chosen by REQUEST PATH (+ JSON content-type), NOT by the response's
    // text/html content-type. A browser refresh re-validates index.html and gets
    // a 304 Not Modified, which carries no content-type — a content-type check
    // then misfiles the cached HTML document under API_CSP (default-src 'none')
    // and blanks the whole SPA on every reload. API surfaces (/v1, /health,
    // /ready) and any JSON/octet-stream body keep the locked-down policy;
    // everything else is the SPA, whose HTML document needs SPA_CSP (a static
    // sub-resource's own CSP header is not enforced by the browser, so giving
    // assets SPA_CSP is security-neutral).
    const path = request.url.split('?')[0] ?? request.url;
    const contentType = String(reply.getHeader('content-type') ?? '');
    const isApi =
      path === '/health' ||
      path === '/ready' ||
      path === '/v1' ||
      path.startsWith('/v1/') ||
      contentType.includes('application/json') ||
      contentType.includes('application/problem+json') ||
      contentType.includes('application/octet-stream');
    void reply.header('content-security-policy', isApi ? API_CSP : SPA_CSP);
    // COOP severs this document from any cross-origin opener/openee, so a window
    // that navigated here (or that we open) cannot reach into our globals. It is
    // free: apps/web opens no windows and reads no `window.opener` — its only
    // `target="_blank"` links already carry rel="noopener" — and it posts no
    // messages. The paid checkout is a full-page redirect, which COOP does not
    // touch. CORP keeps our bytes from being embedded as a no-cors subresource by
    // another origin; same-origin is right because every consumer of this server
    // IS this origin (docs/23 single-origin deploy).
    void reply.header('cross-origin-opener-policy', 'same-origin');
    void reply.header('cross-origin-resource-policy', 'same-origin');
    // Deliberately NOT cross-origin-embedder-policy: require-corp. It is the
    // third leg of the crossOriginIsolated set, and isolation is the ONLY thing
    // it buys — SharedArrayBuffer and high-resolution timers, neither of which
    // this app uses (no SharedArrayBuffer anywhere in apps/web; libsodium's WASM
    // needs 'wasm-unsafe-eval', not isolation). What it would cost is real: every
    // cross-origin subresource we ever add starts failing CLOSED unless that
    // origin serves CORP/CORS headers back, and the failure is a blank image or a
    // dead script, not an error anyone reads. Do not "complete the set".
    //
    // Permissions-Policy denies the sensor/media/payment surface outright; the
    // SPA calls none of it (no getUserMedia, no navigator.geolocation). autoplay
    // is the one exception and MUST stay (self), NOT (): the landing hero video
    // in apps/web/src/screens/Landing.tsx deliberately ships with no `src` and no
    // `autoPlay` in the markup and supplies both from an effect for LCP, so the
    // loop starts from a script-initiated play() with no user gesture — exactly
    // what autoplay=() blocks. That play() rejection is already swallowed
    // (`p.catch(() => {})`), so denying it here would kill the hero loop SILENTLY.
    void reply.header(
      'permissions-policy',
      'accelerometer=(), camera=(), display-capture=(), encrypted-media=(), ' +
        'geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), ' +
        'payment=(), usb=(), xr-spatial-tracking=(), autoplay=(self)',
    );
    if (config.nodeEnv === 'production') {
      void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    }
    return payload;
  });

  // ── Non-canonical host: suppress crawling, change nothing else ────────────
  //
  // See canonical-host.ts for why this is a header rather than a redirect, and
  // why every branch fails open. Both hooks are complete no-ops unless
  // PUBLIC_BASE_URL names a host AND this request arrived on a different one —
  // which, with the variable unset, is never.
  const { canonicalHost } = config;

  // robots.txt is the one path whose BODY differs. It has to be intercepted at
  // onRequest, because @fastify/static registers a route for the real file at
  // boot and would otherwise serve the apex's `Allow: /` verbatim.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    const path = request.url.split('?')[0] ?? request.url;
    if (path !== ROBOTS_PATH) return;
    if (!isNonCanonicalHost(request.headers.host, canonicalHost)) return;
    await reply
      .status(200)
      .header('content-type', 'text/plain; charset=utf-8')
      .send(NON_CANONICAL_ROBOTS_TXT);
  });

  // Everything else keeps its body and gains one header. Scoped by PATH rather
  // than by content-type on purpose: a browser revalidating a cached page gets a
  // 304, which carries no content-type at all, and that is exactly the response
  // a crawler-facing rule must not miss. The header is inert on a JS or CSS
  // asset, so covering them costs nothing and needs no special case.
  app.addHook('onSend', async (request, reply) => {
    if (!isNonCanonicalHost(request.headers.host, canonicalHost)) return;
    const path = request.url.split('?')[0] ?? request.url;
    if (isHostSuppressionExempt(path)) return;
    void reply.header('x-robots-tag', 'noindex');
  });

  // ── Mutating requests must be JSON (CSRF backstop) ─────────────────────────
  // The session cookie is SameSite=Strict; this guard is the second line: a
  // cross-site <form> can only emit text/plain / urlencoded / multipart, none
  // of which is accepted, so a forged mutation dies at 415 before any handler.
  // Bodyless mutations (several routes POST with no body) carry no content-type
  // and pass; the attachment upload's octet-stream is the one binary exception
  // (its route schema + raw-stream parser own that shape).
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    // Positive same-origin signal first (2026-08-07 audit, finding 4). The
    // content-type guard below EXEMPTS a request with no content-type, because
    // several routes POST with no body — and a cross-origin `fetch(..., {method:
    // 'POST', mode: 'no-cors'})` with no body sends no content-type either, so
    // the exemption covered attacker requests too. Bodyless mutations include
    // /dispute, /revoke, /engine/arm and /auth/logout.
    //
    // SameSite=Strict is what actually stops a genuinely CROSS-SITE attacker —
    // the cookie is not sent at all — so this is depth, not the primary control.
    // The gap it closes is that SameSite is site-scoped, not origin-scoped: an
    // XSS or takeover on any *.truecairn.app subdomain is same-SITE, sends the
    // cookie, and left this guard as the only remaining layer.
    //
    // Sec-Fetch-Site is set by the browser and cannot be forged from page JS. We
    // reject only when it is PRESENT and says the request came from elsewhere;
    // absent means a non-browser client (the Flutter app, curl, tests), which
    // never had a victim's cookie to ride in the first place.
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      const problem: ProblemDetails = {
        type: 'https://truecairn.app/problems/cross-origin-mutation',
        title: 'Forbidden',
        status: 403,
        detail: 'mutating requests must originate from this origin',
        instance: request.id,
      };
      await reply.status(403).header('content-type', PROBLEM_CONTENT_TYPE).send(problem);
      return;
    }

    const contentType = request.headers['content-type'];
    if (contentType === undefined) return;
    if (
      contentType.startsWith('application/json') ||
      contentType.startsWith('application/octet-stream')
    ) {
      return;
    }
    // Twilio posts status callbacks form-encoded. This is safe to exempt for
    // the webhook path only: it is HMAC-authenticated (X-Twilio-Signature),
    // never cookie-authenticated, so the CSRF backstop has nothing to protect.
    const requestPath = request.url.split('?')[0] ?? request.url;
    if (
      contentType.startsWith('application/x-www-form-urlencoded') &&
      requestPath.startsWith('/v1/notifications/webhook/')
    ) {
      return;
    }
    const problem: ProblemDetails = {
      type: 'https://truecairn.app/problems/unsupported-media-type',
      title: 'Unsupported Media Type',
      status: 415,
      detail: 'mutating requests must be application/json',
      instance: request.id,
    };
    await reply.status(415).header('content-type', PROBLEM_CONTENT_TYPE).send(problem);
  });

  // ── Cookie parsing (session transport, Q3) ─────────────────────────────────
  void app.register(cookie);

  // ── Database wiring (the 3.0 scaffold deferred this) ───────────────────────
  // Use an injected connection if provided (tests own its lifecycle); otherwise
  // create one from config.databaseUrl and close it on shutdown. The app runs
  // DB-less when neither is present: /health still answers, /ready reports
  // not_ready, and session-gated routes fail closed.
  let db: Database | null = deps.db ?? null;
  let sql: Sql | null = deps.sql ?? null;
  let ownsConnection = false;
  if (db === null && config.databaseUrl !== undefined) {
    const conn = createClient({ url: config.databaseUrl });
    db = conn.db;
    sql = conn.sql;
    ownsConnection = true;
  }
  app.decorate('db', db);
  app.decorate('sql', sql);
  app.decorateRequest('session', null);
  app.decorateRequest('stepUp', null);
  if (ownsConnection && sql !== null) {
    const ownedSql = sql;
    app.addHook('onClose', async () => {
      await ownedSql.end({ timeout: 5 });
    });
  }

  // ── Auth wiring: audit port + WebAuthn verifier ────────────────────────────
  // The audit port is built in onReady because resolving the server signing key
  // is async; it is in place before the server accepts a request. The WebAuthn
  // verifier is the DI seam — production uses the @simplewebauthn adapter; tests
  // inject a fake so the orchestration is exercised without a real authenticator.
  app.decorate('audit', null);
  app.decorate('auditKeyLineage', null);
  // libsodium loads asynchronously; initialise it before the server serves so
  // password (Argon2id) and TOTP-secret (XChaCha20-Poly1305) ops are ready.
  app.addHook('onReady', async () => {
    await initCrypto();
  });
  const webauthnConfig: WebAuthnConfig = {
    rpId: config.webauthnRpId,
    rpName: config.webauthnRpName,
    origin: config.webauthnOrigin,
    nativeOrigins: config.webauthnNativeOrigins,
  };
  const webauthnVerifier: WebAuthnVerifier | null =
    deps.webauthnVerifier ?? (db !== null ? createWebAuthnVerifier(webauthnConfig) : null);
  if (db !== null) {
    const readyDb = db;
    app.addHook('onReady', async () => {
      const signer = await resolveServerSigner(readyDb);
      app.audit = new AuditLogWriter(signer);
      app.auditKeyLineage = signer.lineage ?? null;
    });
  }

  // ── Error shape: RFC 7807 problem details (application/problem+json) ──────
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const instance = request.id;

    if (error instanceof ApiError) {
      sendProblem(reply, error.toProblem(instance), error.status);
      return;
    }

    // Fastify JSON Schema validation failures arrive with `.validation`.
    if (error.validation) {
      sendProblem(
        reply,
        {
          type: 'about:blank',
          title: 'Validation Failed',
          status: 400,
          detail: error.message,
          instance,
        },
        400,
      );
      return;
    }

    // A thrown error with an explicit 4xx statusCode (e.g. from a plugin) is
    // surfaced with its message; anything else is an unexpected 500 whose
    // internals we log but never leak to the client.
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      sendProblem(
        reply,
        { type: 'about:blank', title: error.message || 'Request Error', status, instance },
        status,
      );
      return;
    }

    request.log.error({ err: error, reqId: instance }, 'request.unhandled_error');
    sendProblem(
      reply,
      {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        instance,
      },
      500,
    );
  });

  // 404s use the same problem shape rather than Fastify's default JSON.
  // ── Single-origin SPA serving (docs/23) ────────────────────────────────────
  // When WEB_DIST_DIR points at the built frontend, serve its files and fall
  // back to index.html for client-side routes — keeping WebAuthn's rpId and the
  // SameSite=Strict session cookie on ONE origin. /v1, /health and /ready stay
  // pure API: an unknown API path is a problem+json 404, never an HTML page.
  const webDistDir =
    config.webDistDir !== undefined ? resolveWebDistDir(config.webDistDir) : undefined;
  if (webDistDir !== undefined) {
    void app.register(fastifyStatic, {
      root: webDistDir,
      wildcard: false,
      index: 'index.html',
      // `wildcard: false` makes the plugin enumerate the root at boot and
      // register one route per file — and that glob skips dot-directories
      // unless told otherwise. Without this, `/.well-known/*` is not served at
      // all: the request falls through to the SPA handler and an OS asking
      // whether this app may use passkeys for truecairn.app receives an HTML
      // 404. Nothing else in dist/ is dot-prefixed, so this opens exactly the
      // one directory it needs to (docs/35 §4).
      serveDotFiles: true,
    });

    // Apple requires the association file to be served as JSON, and it is
    // served EXTENSIONLESS — so content-type-by-extension makes it
    // `application/octet-stream` and iOS declines to associate the app without
    // ever naming the reason (docs/35 §4).
    //
    // It has to be an onSend hook, not @fastify/static's `setHeaders`: that
    // callback writes to the raw response and the plugin then applies `send`'s
    // own header set over the top, so the octet-stream wins. onSend is the last
    // word before the bytes go out.
    //
    // Scoped narrowly on both axes: matched without allocating a split on every
    // response, and only on a 200 — if the file is ever missing from the build,
    // the SPA handler answers with an HTML shell, and labelling that JSON would
    // turn a visible 404 into a confusing parse error.
    app.addHook('onSend', async (request, reply) => {
      const url = request.url;
      if (
        reply.statusCode === 200 &&
        (url === APPLE_APP_SITE_ASSOCIATION_PATH ||
          url.startsWith(`${APPLE_APP_SITE_ASSOCIATION_PATH}?`))
      ) {
        void reply.header('content-type', 'application/json');
      }
    });

    // Cache-Control for the built SPA. @fastify/static is registered above with
    // no cache options at all, so the only TTL in play was whatever the edge
    // defaults to — measured 2026-08-12 by PageSpeed on the deployed site as 4h,
    // applied even to content-hashed bundles that can never change under their
    // own name. That is ~9 MB of needless revalidation for a returning visitor.
    //
    // TWO TIERS, because only one of them is content-addressed:
    //   dist/assets/<name>-<hash>.<ext>  — Vite output. A change to the file
    //     changes its URL, so it is safe to freeze for a year.
    //   dist/assets/landing/…, /brand/…  — copied verbatim from public/ and keep
    //     their filenames forever. `immutable` here would be a BUG: a new hero
    //     video could not reach anyone who had seen the old one.
    // The subdirectory is what separates them — `[^/]+` cannot cross a slash.
    //
    // HTML is `no-cache`, which means revalidate, not "do not store": the client
    // still gets a 304 when nothing changed, and a deploy is visible immediately
    // rather than up to a week later.
    //
    // onSend rather than @fastify/static's `setHeaders`, for the reason recorded
    // above the apple-app-site-association hook: send() applies its own header
    // set over the top, so a setHeaders version looks right and silently loses.
    app.addHook('onSend', async (request, reply) => {
      if (reply.statusCode !== 200 && reply.statusCode !== 304) return;
      const path = request.url.split('?')[0] ?? request.url;
      // The API sets its own caching policy — /v1/status publishes a TTL — so
      // this hook must never reach it. Guarding by PATH and not by "is a
      // cache-control header already present": send() sets its own
      // `public, max-age=0` on every static file, so the header-presence check
      // is always true exactly where this hook is supposed to act, and the
      // whole thing silently does nothing. That is the same lesson as the
      // setHeaders note above, and static-cache.test.ts caught it.
      if (path.startsWith('/v1') || path === '/health' || path === '/ready') return;
      if (HASHED_ASSET_PATH.test(path)) {
        void reply.header('cache-control', 'public, max-age=31536000, immutable');
      } else if (STATIC_ASSET_PATH.test(path)) {
        void reply.header('cache-control', 'public, max-age=604800, stale-while-revalidate=86400');
      } else if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
        // By content-type, not by path shape: every SPA route (/security,
        // /legal/wind-down, …) is HTML with no extension and no trailing slash,
        // so a path test would have covered '/' and missed all seventeen
        // prerendered pages.
        void reply.header('cache-control', 'no-cache');
      }
    });
  }

  // ── Prerendered public pages (2026-07-30) ──────────────────────────────────
  //
  // The web build prerenders the public routes to dist/<route>/index.html so
  // crawlers that do not execute JavaScript — GPTBot, ClaudeBot, PerplexityBot
  // and friends — receive real HTML instead of an empty <div id="root">.
  //
  // It also writes dist/app-shell.html: the PRISTINE shell, with #root still
  // empty. The fallback below serves that rather than dist/index.html, which is
  // now the prerendered LANDING — otherwise every /vault load would paint the
  // marketing page for a frame before React replaced it.
  //
  // Both lookups are resolved once at boot. Doing it per request would stat the
  // filesystem on every 404, which is exactly the path a crawler or a scanner
  // hammers.
  const shellFile =
    webDistDir !== undefined && existsSync(joinPath(webDistDir, 'app-shell.html'))
      ? 'app-shell.html'
      : 'index.html';
  const prerendered = new Map<string, string>();
  if (webDistDir !== undefined) {
    for (const route of PUBLIC_CLIENT_ROUTES) {
      if (route === '/') continue; // served as dist/index.html by the static plugin
      const rel = `${route.slice(1)}/index.html`;
      if (existsSync(joinPath(webDistDir, rel))) prerendered.set(route, rel);
    }
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (
      webDistDir !== undefined &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !path.startsWith('/v1') &&
      path !== '/health' &&
      path !== '/ready'
    ) {
      // A prerendered public page when we have one: real HTML for crawlers that
      // never run JS, and a faster first paint for everyone else.
      const pre = prerendered.get(path.length > 1 ? path.replace(/\/+$/, '') : path);
      if (pre !== undefined) {
        void reply.sendFile(pre);
        return;
      }
      // Otherwise the pristine shell either way — the app renders a usable page
      // for a human at an unknown URL. What changes is the STATUS: a path that is
      // not a real client route gets 404, because answering 200 for every typo is
      // a soft 404 that tells crawlers and link-checkers we found something we
      // did not. See spa-routes.ts; the route list is drift-guarded by its test.
      if (!isKnownClientRoute(path)) void reply.status(404);
      void reply.sendFile(shellFile);
      return;
    }
    sendProblem(
      reply,
      {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Route ${request.method} ${path} not found`,
        instance: request.id,
      },
      404,
    );
  });

  // ── Routes ───────────────────────────────────────────────────────────────
  healthRoutes(app);
  readyRoutes(app);
  if (db !== null && webauthnVerifier !== null) {
    webauthnRoutes(app, db, webauthnVerifier, webauthnConfig, config.ipHashPepper);
    hardwareKeyRoutes(app, db, webauthnVerifier, webauthnConfig);
    // Step-up second factor (TOTP + the WebAuthn method, PHASE4 C5A). In the
    // verifier block because the WebAuthn branch needs the verifier — which is
    // always present when db is (the real adapter, unless a test injects a fake).
    stepUpSecondFactorRoutes(app, db, config, webauthnVerifier, webauthnConfig);
  }
  if (db !== null) {
    logoutRoutes(app, db);
    passwordLoginRoutes(app, db, config);
    totpRoutes(app, db, config);
    passwordSetupRoutes(app, db);
    contactRoutes(app, db);
    contactManagementRoutes(app, db);
    ceremonyRoutes(app, db, config);
    vaultRoutes(app, db, config);
    vaultAttachmentRoutes(app, db, config);
    // Publishing the capture pubkey is unflagged (it is a public value, and
    // pre-publishing means flipping the flag later strands nobody); the capture
    // transport itself is flagged off by default (docs/34).
    vaultCaptureKeyRoutes(app, db);
    if (config.vaultCaptureEnabled) vaultCaptureRoutes(app, db, config);
    engineRoutes(app, db);
    auditRoutes(app, db);
    opsRoutes(app, db, config);
    // Public, unauthenticated — the reduced projection behind /status. Always
    // registered (unlike opsRoutes, which is absent without OPS_ADMIN_EMAILS):
    // a status page that disappears when unconfigured is worse than none.
    statusRoutes(app, db, config);
    channelRoutes(app, db, config);
    continuityRoutes(app, db, config, deps.aiGenerator);
    billingRoutes(app, db, config.billing);
    briefingRoutes(app, db, config, deps.aiGenerator);
    aiRoutes(app, db, config, deps.aiGenerator);
    readinessRoutes(app, db, config, deps.aiGenerator);
    aiProposalRoutes(app, db, config);
    accountRoutes(app, db);
    keyMaterialRoutes(app, db, config);
    // Provider-delivery webhook: HMAC-authed (not session-gated), mounted only
    // when at least one provider's verification material is configured
    // (PHASE3_5 §d; CV-2 adds Twilio's X-Twilio-Signature scheme, CV-3 Meta's
    // X-Hub-Signature-256 + its GET subscription handshake).
    if (
      config.notificationsWebhookSecret !== undefined ||
      config.twilioAuthToken !== undefined ||
      config.metaAppSecret !== undefined ||
      config.metaVerifyToken !== undefined
    ) {
      notificationsWebhookRoutes(app, db, {
        secret: config.notificationsWebhookSecret,
        twilioAuthToken: config.twilioAuthToken,
        metaAppSecret: config.metaAppSecret,
        metaVerifyToken: config.metaVerifyToken,
        publicBaseUrl: config.publicBaseUrl,
      });
    }
  }

  return app;
}

function sendProblem(
  reply: Parameters<Parameters<FastifyInstance['setErrorHandler']>[0]>[2],
  problem: ProblemDetails,
  status: number,
): void {
  void reply.status(status).header('content-type', PROBLEM_CONTENT_TYPE).send(problem);
}

// WEB_DIST_DIR, resolved so that both plausible readings of a relative value
// work (restore-drill finding F-3, 2026-08-10).
//
// It used to be a bare resolve() against process.cwd(), and the cwd is
// apps/api — the production start command is `pnpm --filter @truecairn/api
// start`. So the documented `../web/dist` worked and the repo-root-relative
// `apps/web/dist` that anyone standing a second instance up from a variable list
// would reach for produced:
//
//     "root" path "/app/apps/api/apps/web/dist" must exist
//
// which names the joined path and nothing about why it was joined that way. A
// variable that only works if you already know the answer is not documentation,
// so this takes the first candidate that EXISTS rather than making the operator
// guess the base.
//
// cwd is tried FIRST, deliberately: it is what production already resolves
// against, and the ordering is what makes this additive rather than a silent
// change to a working deployment. An absolute path is used as given.
//
// If nothing exists, throw here naming every path tried. @fastify/static would
// otherwise fail at register() with the message above — same outcome, no clue.
export function resolveWebDistDir(configured: string): string {
  const candidates = [resolvePath(configured)];
  if (!isAbsolutePath(configured)) {
    // The repo root relative to this module (apps/api/src/app.ts → up three).
    const repoRoot = resolvePath(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    candidates.push(resolvePath(repoRoot, configured));
  }
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) {
    throw new Error(
      `WEB_DIST_DIR=${configured} does not resolve to an existing directory. Tried: ` +
        `${candidates.join(', ')}. Relative values are resolved against the working directory ` +
        '(apps/api under the production start command) and then against the repo root; ' +
        'an absolute path avoids the question entirely.',
    );
  }
  return found;
}
