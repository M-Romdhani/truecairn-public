import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// The soft-404 fix, at the HTTP boundary that actually faces crawlers.
//
// Before this, EVERY non-/v1 GET returned the SPA shell with an implicit 200 —
// so a typo, a dead inbound link, a vulnerability scanner probing /wp-admin and
// a genuine page were indistinguishable to anything automated. The shell still
// renders (a human at a bad URL gets a usable page); only the status changes.
//
// DB-less on purpose: this is pure app wiring, like the SPA-serving tests in
// routes/hardening.test.ts.

describe('unknown client routes are hard 404s, not soft ones', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'tc-dist-404-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="truecairn-spa"></div>');
    writeFileSync(join(distDir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  });
  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  function boot() {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    return buildApp({
      ...config,
      logLevel: 'silent',
      databaseUrl: undefined,
      webDistDir: distDir,
    });
  }

  it('serves real public routes with 200', async () => {
    const app = boot();
    await app.ready();
    try {
      for (const url of ['/', '/status', '/security/threat-model', '/legal/wind-down', '/guide']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${url} should be 200`).toBe(200);
        expect(res.body).toContain('truecairn-spa');
      }
    } finally {
      await app.close();
    }
  });

  it('serves real authenticated routes with 200', async () => {
    // They are Disallow-ed in robots.txt, but they exist — a 404 here would
    // break the app for signed-in users, which is the failure mode this whole
    // change has to avoid.
    const app = boot();
    await app.ready();
    try {
      for (const url of ['/vault', '/settings', '/engine', '/vault/some-item', '/admin/system']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${url} should be 200`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('returns 404 — with the shell still rendered — for paths that do not exist', async () => {
    const app = boot();
    await app.ready();
    try {
      for (const url of ['/nope', '/security/made-up', '/legal', '/wp-admin', '/vault/a/b']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${url} should be 404`).toBe(404);
        // The body is unchanged: machines read the status, people read the page.
        expect(res.body).toContain('truecairn-spa');
        expect(res.headers['content-type']).toContain('text/html');
      }
    } finally {
      await app.close();
    }
  });

  it('keeps the SPA content-security-policy on a 404', async () => {
    // The shell still has to boot and render, so it needs the SPA policy — not
    // the locked-down API one that would blank the page.
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/definitely-not-a-page' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");
    } finally {
      await app.close();
    }
  });

  it('leaves API, health and readiness 404s as problem+json', async () => {
    const app = boot();
    await app.ready();
    try {
      const api = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
      expect(api.statusCode).toBe(404);
      expect(api.headers['content-type']).toContain('application/problem+json');
      // A POST to an unknown path is not a client route under any reading.
      const post = await app.inject({ method: 'POST', url: '/not-a-route' });
      expect(post.statusCode).toBe(404);
      expect(post.headers['content-type']).toContain('application/problem+json');
    } finally {
      await app.close();
    }
  });

  it('still serves real files, so robots.txt and the sitemap are reachable', async () => {
    // These are static files in dist/, resolved before the not-found handler —
    // a regression here would 404 the very file that advertises the sitemap.
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('User-agent');
    } finally {
      await app.close();
    }
  });

  it('serves a prerendered public page when the build produced one', async () => {
    // The web build writes dist/<route>/index.html for the public routes so
    // crawlers that never run JS get real HTML. This fixture dist has one.
    const preDir = mkdtempSync(join(tmpdir(), 'tc-dist-pre-'));
    writeFileSync(join(preDir, 'index.html'), '<!doctype html><div id="root">LANDING</div>');
    writeFileSync(join(preDir, 'app-shell.html'), '<!doctype html><div id="root"></div>');
    mkdirSync(join(preDir, 'security'), { recursive: true });
    writeFileSync(
      join(preDir, 'security', 'index.html'),
      '<!doctype html><div id="root"><p>PRERENDERED SECURITY</p></div>',
    );
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    const app = buildApp({
      ...config,
      logLevel: 'silent',
      databaseUrl: undefined,
      webDistDir: preDir,
    });
    await app.ready();
    try {
      const pre = await app.inject({ method: 'GET', url: '/security' });
      expect(pre.statusCode).toBe(200);
      expect(pre.body).toContain('PRERENDERED SECURITY');

      // An authenticated route must get the PRISTINE shell — never the
      // prerendered landing, or /vault would paint the marketing page for a
      // frame before React replaced it.
      const authed = await app.inject({ method: 'GET', url: '/vault' });
      expect(authed.statusCode).toBe(200);
      expect(authed.body).not.toContain('LANDING');
      expect(authed.body).toContain('<div id="root"></div>');

      // And an unknown path gets the shell too, still with a 404.
      const missing = await app.inject({ method: 'GET', url: '/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain('LANDING');
    } finally {
      await app.close();
      rmSync(preDir, { recursive: true, force: true });
    }
  });

  it('falls back to index.html when no prerender output exists', async () => {
    // Backwards compatibility: a dist built before prerendering (or by a
    // partial build) has no app-shell.html, and must still serve the SPA.
    const res = await boot().inject({ method: 'GET', url: '/vault' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('truecairn-spa');
  });

  it('404s a missing static asset instead of handing back HTML', async () => {
    // The other half of the soft-404 bug: a missing bundle used to return the
    // HTML shell with 200, which surfaces as a confusing MIME-type error in the
    // browser rather than an honest missing-file error.
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/assets/does-not-exist.js' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
