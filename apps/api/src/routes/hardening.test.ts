import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { IP_MAX_FAILURES } from '../auth/rate-limit.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// Security-hardening properties (posture-review follow-ups): logout actually
// revokes server-side; revoke-others is gated on a fresh second factor; the
// step-up TOTP verifier is throttled (a stolen session cannot brute-force the
// 6-digit space); mutating non-JSON requests die at 415 (the CSRF backstop
// behind SameSite=Strict); and every response carries the security headers.
describeIfDb('security hardening (sessions, throttle, headers)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE auth_attempts, sessions, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function seedSession(): Promise<{ userId: UserId; cookie: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `h${Date.now()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token };
  }
  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });

  it('logout revokes the session server-side and clears the cookie', async () => {
    const { cookie } = await seedSession();
    // The session works…
    const before = await app.inject({ method: 'GET', url: '/v1/ceremonies', cookies: as(cookie) });
    expect(before.statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: as(cookie) });
    expect(out.statusCode).toBe(200);
    const cleared = out.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');

    // …and is dead afterwards even if the cookie is replayed (server-side truth).
    const after = await app.inject({ method: 'GET', url: '/v1/ceremonies', cookies: as(cookie) });
    expect(after.statusCode).toBe(401);
  });

  it('revoke-others requires a fresh second factor, then revokes every OTHER session', async () => {
    const { userId, cookie } = await seedSession();
    const other = await createSession(db, { userId, now: new Date() });

    // No fresh factor on the session → the gate refuses.
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-others',
      cookies: as(cookie),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().type).toBe('https://truecairn.app/problems/second-factor-required');

    // Stamp a fresh factor directly (the TOTP/WebAuthn flows are proven in their
    // own suites; this test is about the revocation semantics). Stamping every
    // session is fine — the gate reads only the CALLING session's stamp.
    await db
      .update(schema.sessions)
      .set({ lastStepupAt: new Date() })
      .where(eq(schema.sessions.userId, userId));

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-others',
      cookies: as(cookie),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revoked).toBe(1);

    // The other session is dead; the calling one survives.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ceremonies', cookies: as(other.token) })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ceremonies', cookies: as(cookie) })).statusCode,
    ).toBe(200);
  });

  it('the step-up TOTP verifier is IP-throttled: failures hit 429, not an infinite guess space', async () => {
    const { cookie } = await seedSession();
    // No TOTP enrolled → every code fails (and is recorded). Exhaust the window.
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/auth/step-up/second-factor',
        cookies: as(cookie),
        payload: { method: 'totp', code: '000000' },
      });
      expect(r.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: as(cookie),
      payload: { method: 'totp', code: '000000' },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
  });

  it('mutating non-JSON requests are refused 415 before any handler (CSRF backstop)', async () => {
    const { cookie } = await seedSession();
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: as(cookie),
      headers: { 'content-type': 'text/plain' },
      payload: 'x=1',
    });
    expect(forged.statusCode).toBe(415);
    // A bodyless POST (no content-type) still works — many routes post no body.
    const ok = await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: as(cookie) });
    expect(ok.statusCode).toBe(200);
  });

  it('a browser-reported cross-origin mutation is refused even with no body (audit finding 4)', async () => {
    // The hole the 415 guard could not cover: a bodyless POST carries no
    // content-type, so `contentType === undefined` exempted it — and so does a
    // cross-origin fetch with no body. SameSite=Strict stops a genuinely
    // cross-SITE attacker, but it is site-scoped: an XSS or takeover on any
    // *.truecairn.app subdomain is same-site, sends the cookie, and left this
    // guard as the last layer.
    const { cookie } = await seedSession();
    for (const site of ['cross-site', 'same-site']) {
      const forged = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        cookies: as(cookie),
        headers: { 'sec-fetch-site': site },
      });
      expect(forged.statusCode).toBe(403);
    }
  });

  it('same-origin and native clients are unaffected', async () => {
    // The Flutter app and any non-browser caller send no Sec-Fetch-* headers at
    // all; requiring the header rather than rejecting a bad one would have
    // locked the mobile client out of every mutation.
    const { cookie } = await seedSession();
    const sameOrigin = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: as(cookie),
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(sameOrigin.statusCode).toBe(200);

    const { cookie: c2 } = await seedSession();
    const native = await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: as(c2) });
    expect(native.statusCode).toBe(200);
  });

  it('every response carries the security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    // The isolation/permission trio rides the same hook, so it is on API
    // responses too — assertPermissionsPolicy pins the autoplay carve-out.
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    assertPermissionsPolicy(r.headers['permissions-policy']);
  });
});

// Shared by the API-response and SPA-response assertions below, so the two
// cannot drift into checking different things about the same header.
//
// autoplay=(self) is the ONE allowance in an otherwise fully-denied policy and
// it is load-bearing: the landing hero video (apps/web/src/screens/Landing.tsx)
// ships with no `src` and no `autoPlay` attribute — both are assigned from an
// effect, deferred for LCP — so the loop begins with a script-initiated play()
// and no user gesture behind it. autoplay=() blocks exactly that, and the
// component already swallows the rejection (`p.catch(() => {})`), so the hero
// would go still with nothing logged and no test failing. Hence the explicit
// negative: tightening this to autoplay=() is a silent regression, not a hardening.
//
// `unknown` rather than string: Fastify types an injected header as
// OutgoingHttpHeader, which admits number — narrowing here would be a cast
// with no reader, and the assertions below are string assertions anyway.
function assertPermissionsPolicy(value: unknown): void {
  const policy = String(value);
  expect(policy).toContain('autoplay=(self)');
  expect(policy).not.toContain('autoplay=()');
  for (const denied of [
    'accelerometer=()',
    'camera=()',
    'display-capture=()',
    'encrypted-media=()',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'usb=()',
    'xr-spatial-tracking=()',
  ]) {
    expect(policy).toContain(denied);
  }
}

// DB-less on purpose: SPA serving is pure app wiring (docs/23 single-origin
// deploy). index.html gets the SPA CSP (libsodium needs 'wasm-unsafe-eval'),
// INCLUDING on a 304 revalidation (a browser refresh) where no content-type is
// sent; API paths keep the locked-down policy and problem+json 404s.
describe('single-origin SPA serving (docs/23)', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'tc-dist-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="truecairn-spa"></div>');
    writeFileSync(join(distDir, 'app.js'), 'console.log("spa")');
  });
  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  it('serves the SPA with its CSP; client routes fall back; API 404s stay problem+json', async () => {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    const app = buildApp({
      ...config,
      logLevel: 'silent',
      databaseUrl: undefined, // DB-less: static serving must not depend on it
      webDistDir: distDir,
    });
    await app.ready();
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");

      // Regression: a browser refresh re-validates index.html and gets a 304 Not
      // Modified, which carries NO content-type. The document must STILL receive
      // the SPA policy — a content-type check would fall through to API_CSP
      // (default-src 'none') and blank the SPA on every reload.
      const etag = root.headers.etag;
      expect(etag).toBeDefined();
      const revalidated = await app.inject({
        method: 'GET',
        url: '/',
        headers: { 'if-none-match': String(etag) },
      });
      expect(revalidated.statusCode).toBe(304);
      expect(revalidated.headers['content-type']).toBeUndefined();
      expect(revalidated.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");

      // A client-side route (no such file) falls back to index.html.
      const route = await app.inject({ method: 'GET', url: '/vault/some-item' });
      expect(route.statusCode).toBe(200);
      expect(route.body).toContain('truecairn-spa');

      // Static SPA sub-resources share the SPA policy now (CSP is keyed off the
      // request path; a sub-resource's own CSP header is browser-ignored anyway,
      // so this is security-neutral and keeps the 304 fix simple).
      const asset = await app.inject({ method: 'GET', url: '/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");

      // Unknown API paths NEVER become HTML.
      const api = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
      expect(api.statusCode).toBe(404);
      expect(api.headers['content-type']).toContain('application/problem+json');
      expect(api.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    } finally {
      await app.close();
    }
  });

  // DB-less like the rest of this block, so the trio is covered on both response
  // shapes even when DATABASE_URL is unset and the suite above skips.
  it('carries COOP/CORP/Permissions-Policy on the SPA document and on an API response', async () => {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    const app = buildApp({
      ...config,
      logLevel: 'silent',
      databaseUrl: undefined,
      webDistDir: distDir,
    });
    await app.ready();
    try {
      // The SPA document — the response that actually renders the hero video.
      const spa = await app.inject({ method: 'GET', url: '/' });
      expect(spa.statusCode).toBe(200);
      expect(spa.headers['content-type']).toContain('text/html');
      expect(spa.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(spa.headers['cross-origin-resource-policy']).toBe('same-origin');
      assertPermissionsPolicy(spa.headers['permissions-policy']);

      // And an API response (problem+json), which takes the other CSP branch.
      const api = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
      expect(api.statusCode).toBe(404);
      expect(api.headers['content-type']).toContain('application/problem+json');
      expect(api.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(api.headers['cross-origin-resource-policy']).toBe('same-origin');
      assertPermissionsPolicy(api.headers['permissions-policy']);

      // Deliberately absent: COEP require-corp. It only pays off combined with
      // COOP to reach crossOriginIsolated, which needs a SharedArrayBuffer this
      // app does not have, and it makes every future cross-origin subresource
      // fail closed. See the WHY-comment on the hook in app.ts before adding it.
      expect(spa.headers['cross-origin-embedder-policy']).toBeUndefined();
      expect(api.headers['cross-origin-embedder-policy']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('without WEB_DIST_DIR the app behaves exactly as before (no static, 404s everywhere)', async () => {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    const app = buildApp({ ...config, logLevel: 'silent', databaseUrl: undefined });
    await app.ready();
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(404);
      expect(root.headers['content-type']).toContain('application/problem+json');
    } finally {
      await app.close();
    }
  });
});

describe('production refuses ephemeral secrets (config guard)', () => {
  const durable = {
    TOTP_KEK: Buffer.alloc(32, 1).toString('base64'),
    OUTER_LAYER_KEK: Buffer.alloc(32, 2).toString('base64'),
    IP_HASH_PEPPER: Buffer.alloc(32, 3).toString('base64'),
    // Also required in production since 2026-08-07 (audit finding 9): the session
    // cookie's Secure flag is derived from this value's scheme, so an http://
    // origin silently downgrades the transport.
    WEBAUTHN_ORIGIN: 'https://truecairn.app',
  };

  it('throws when a durable secret is missing in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ...durable, TOTP_KEK: undefined })).toThrow(
      /TOTP_KEK must be set in production/,
    );
    expect(() =>
      loadConfig({ NODE_ENV: 'production', ...durable, OUTER_LAYER_KEK: undefined }),
    ).toThrow(/OUTER_LAYER_KEK must be set in production/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', ...durable, IP_HASH_PEPPER: undefined }),
    ).toThrow(/IP_HASH_PEPPER must be set in production/);
  });

  it('boots with all durable secrets set in production, and stays lenient in dev', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ...durable })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
  });
});
