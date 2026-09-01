import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  canonicalHostFrom,
  isHostSuppressionExempt,
  isNonCanonicalHost,
} from './canonical-host.js';
import { loadConfig } from './config.js';

// Crawl suppression on the duplicate site served by api.truecairn.app.
//
// THE NEGATIVE CASES ARE THE POINT. Setting a header on the wrong host would
// deindex the product silently — nothing a human can see on the page changes —
// so most of what follows asserts that the header is ABSENT, that /v1 and
// /.well-known are untouched, and that an unset PUBLIC_BASE_URL leaves the app
// byte-for-byte as it was.
//
// DB-less, like spa-404.test.ts: this is pure app wiring.

const APEX = 'https://truecairn.app';
const CANONICAL = 'truecairn.app';
const NON_CANONICAL = 'api.truecairn.app';

const APEX_ROBOTS = 'User-agent: *\nAllow: /\n\nSitemap: https://truecairn.app/sitemap.xml\n';

describe('deriving the canonical host', () => {
  it('reads the host out of a well-formed PUBLIC_BASE_URL', () => {
    expect(canonicalHostFrom(APEX)).toBe(CANONICAL);
    expect(canonicalHostFrom('https://truecairn.app/')).toBe(CANONICAL);
    expect(canonicalHostFrom('http://localhost:3001')).toBe('localhost');
  });

  it('lowercases, because a Host header is case-insensitive', () => {
    expect(canonicalHostFrom('https://TrueCairn.APP')).toBe(CANONICAL);
  });

  it('fails open on anything it cannot parse', () => {
    // Unparseable is indistinguishable from unset: both mean "we do not know
    // what the canonical host is", and judging a host against a guess is the
    // failure that takes the apex out of search.
    for (const value of [undefined, '', 'truecairn.app', 'not a url', '://nope']) {
      expect(canonicalHostFrom(value), `${String(value)} should not yield a host`).toBeUndefined();
    }
  });
});

describe('deciding whether a request is on a non-canonical host', () => {
  it('says yes only for a different host', () => {
    expect(isNonCanonicalHost(NON_CANONICAL, CANONICAL)).toBe(true);
    expect(isNonCanonicalHost(CANONICAL, CANONICAL)).toBe(false);
  });

  it('ignores port and case, which never distinguish one site from another', () => {
    expect(isNonCanonicalHost('TrueCairn.app:443', CANONICAL)).toBe(false);
    expect(isNonCanonicalHost('  truecairn.app  ', CANONICAL)).toBe(false);
    expect(isNonCanonicalHost('localhost:8080', 'localhost')).toBe(false);
  });

  it('strips an IPv6 port after the bracket, not at the first colon', () => {
    expect(isNonCanonicalHost('[::1]:8080', '[::1]')).toBe(false);
  });

  it('fails open when either side is unknown', () => {
    expect(isNonCanonicalHost(NON_CANONICAL, undefined)).toBe(false);
    expect(isNonCanonicalHost(undefined, CANONICAL)).toBe(false);
    expect(isNonCanonicalHost('', CANONICAL)).toBe(false);
    expect(isNonCanonicalHost('   ', CANONICAL)).toBe(false);
  });
});

describe('paths the suppression must never touch', () => {
  it('exempts the API, the health probes and the well-known files', () => {
    for (const path of [
      '/v1',
      '/v1/status',
      '/v1/auth/login',
      '/health',
      '/ready',
      '/.well-known/assetlinks.json',
      '/.well-known/apple-app-site-association',
    ]) {
      expect(isHostSuppressionExempt(path), `${path} must be exempt`).toBe(true);
    }
  });

  it('does not exempt the public site', () => {
    for (const path of ['/', '/security', '/robots.txt', '/sitemap.xml', '/v1x', '/healthz']) {
      expect(isHostSuppressionExempt(path), `${path} must not be exempt`).toBe(false);
    }
  });
});

describe('serving the site on two hosts', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'tc-dist-host-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="root">LANDING</div>');
    writeFileSync(join(distDir, 'app-shell.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(distDir, 'robots.txt'), APEX_ROBOTS);
    writeFileSync(join(distDir, 'sitemap.xml'), '<?xml version="1.0"?><urlset/>');
    mkdirSync(join(distDir, '.well-known'), { recursive: true });
    writeFileSync(join(distDir, '.well-known', 'assetlinks.json'), '[]');
  });
  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  function boot(env: NodeJS.ProcessEnv) {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64'), ...env });
    return buildApp({ ...config, logLevel: 'silent', databaseUrl: undefined, webDistDir: distDir });
  }

  const configured = () => boot({ PUBLIC_BASE_URL: APEX });

  it('leaves the canonical host completely alone', async () => {
    const app = configured();
    await app.ready();
    try {
      for (const url of ['/', '/security', '/sitemap.xml']) {
        const res = await app.inject({ method: 'GET', url, headers: { host: CANONICAL } });
        expect(res.headers['x-robots-tag'], `${url} must not be suppressed`).toBeUndefined();
      }
      // And its robots.txt is the real file, unchanged — including the Sitemap
      // line, which is the whole reason the apex file exists.
      const robots = await app.inject({
        method: 'GET',
        url: '/robots.txt',
        headers: { host: CANONICAL },
      });
      expect(robots.statusCode).toBe(200);
      expect(robots.body).toBe(APEX_ROBOTS);
    } finally {
      await app.close();
    }
  });

  it('marks the duplicate site noindex', async () => {
    const app = configured();
    await app.ready();
    try {
      for (const url of ['/', '/security', '/sitemap.xml']) {
        const res = await app.inject({ method: 'GET', url, headers: { host: NON_CANONICAL } });
        expect(res.headers['x-robots-tag'], `${url} should be suppressed`).toBe('noindex');
        // The BODY is untouched. This is a crawling instruction, not a block:
        // anyone who reaches the page still gets the page.
        expect(res.statusCode).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  it('serves a Disallow-everything robots.txt on the duplicate host', async () => {
    const app = configured();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/robots.txt',
        headers: { host: NON_CANONICAL },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toBe('User-agent: *\nDisallow: /\n');
      // No Sitemap: line — pointing a crawler at the apex sitemap from the
      // duplicate host would re-open the very crawl this closes.
      expect(res.body).not.toContain('Sitemap');
      expect(res.body).not.toContain('Allow: /');
    } finally {
      await app.close();
    }
  });

  it('never touches /v1 — the reason the API host exists', async () => {
    const app = configured();
    await app.ready();
    try {
      for (const url of ['/v1/does-not-exist', '/health', '/ready']) {
        const res = await app.inject({ method: 'GET', url, headers: { host: NON_CANONICAL } });
        expect(res.headers['x-robots-tag'], `${url} must be untouched`).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('never touches /.well-known — passkey association is resolved on this host', async () => {
    // docs/35 §4. An OS asking whether this app may hold passkeys for
    // truecairn.app does not chase a redirect and must not meet a changed body;
    // this lane is kept away from those paths entirely.
    const app = configured();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/assetlinks.json',
        headers: { host: NON_CANONICAL },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('[]');
      expect(res.headers['x-robots-tag']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('is a header, never a redirect', async () => {
    // A 301 on this host would turn every vendor webhook POST into a bodyless
    // GET and break the well-known lookups. If this ever starts failing because
    // someone reached for a redirect, that is the bug, not this test.
    const app = configured();
    await app.ready();
    try {
      for (const url of ['/', '/security', '/robots.txt', '/v1/does-not-exist']) {
        const res = await app.inject({ method: 'GET', url, headers: { host: NON_CANONICAL } });
        expect(res.statusCode, `${url} must not redirect`).not.toBe(301);
        expect(res.statusCode).not.toBe(302);
        expect(res.headers['location']).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('does nothing at all when PUBLIC_BASE_URL is unset', async () => {
    // The fail-open guarantee, stated as a test: with no canonical host
    // configured, every host is treated as canonical and the app behaves exactly
    // as it did before this existed.
    const app = boot({});
    await app.ready();
    try {
      for (const host of [CANONICAL, NON_CANONICAL, 'anything.example']) {
        const page = await app.inject({ method: 'GET', url: '/', headers: { host } });
        expect(page.headers['x-robots-tag'], `${host} must be untouched`).toBeUndefined();
        const robots = await app.inject({ method: 'GET', url: '/robots.txt', headers: { host } });
        expect(robots.body, `${host} must get the real robots.txt`).toBe(APEX_ROBOTS);
      }
    } finally {
      await app.close();
    }
  });

  it('does nothing when PUBLIC_BASE_URL is set to something unparseable', async () => {
    const app = boot({ PUBLIC_BASE_URL: 'truecairn.app' }); // no scheme ⇒ not a URL
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/', headers: { host: NON_CANONICAL } });
      expect(res.headers['x-robots-tag']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
