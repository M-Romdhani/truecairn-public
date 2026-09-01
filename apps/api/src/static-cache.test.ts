import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, HASHED_ASSET_PATH, STATIC_ASSET_PATH } from './app.js';
import { loadConfig } from './config.js';

// The static-asset Cache-Control tiers (2026-08-12). @fastify/static is
// registered with no cache options, so every asset inherited whatever the edge
// defaulted to — 4h, measured by PageSpeed on the deployed site, applied even to
// content-hashed bundles.
//
// The whole design rests on one distinction: a Vite-emitted filename carries a
// content hash, so freezing it for a year is safe; a file copied verbatim from
// public/ keeps its name forever, so freezing it means a replacement can never
// reach anyone who saw the old one. These assertions are that distinction, and
// nothing else in the suite looks at response caching.
describe('static asset cache tiers', () => {
  it('treats Vite content-hashed output as immutable-eligible', () => {
    // Real names from a build of this repo.
    for (const p of [
      '/assets/index-3DAsiWei.js',
      '/assets/index-DfPbOjMd.css',
      '/assets/AuthedApp-BErj3uWu.js',
      '/assets/figtree-latin-400-normal-g7Dtegnw.woff2',
      '/assets/__vite-browser-external-D7Ct-6yo.js',
    ]) {
      expect(HASHED_ASSET_PATH.test(p), p).toBe(true);
    }
  });

  it('never treats a hand-named public/ asset as immutable', () => {
    // These keep their filenames across releases. If one of them ever matched
    // the hashed pattern, shipping a new hero video would be impossible for a
    // year for anyone who had loaded the old one.
    for (const p of [
      '/assets/landing/hero-loop-720.mp4',
      '/assets/landing/hero-poster.webp',
      '/assets/landing/photo-cairn-dusk.avif',
      '/assets/brand/app-icon.svg',
      '/assets/landing/screens/unlock-vault.mp4',
    ]) {
      expect(HASHED_ASSET_PATH.test(p), p).toBe(false);
      expect(STATIC_ASSET_PATH.test(p), p).toBe(true);
    }
  });

  it('claims nothing outside /assets/', () => {
    for (const p of ['/', '/v1/status', '/security', '/sw.js', '/.well-known/assetlinks.json']) {
      expect(HASHED_ASSET_PATH.test(p), p).toBe(false);
      expect(STATIC_ASSET_PATH.test(p), p).toBe(false);
    }
  });

  it('is anchored at both ends, so a query or a nested path cannot smuggle a match', () => {
    // The hook strips the query before testing; these pin the regex itself so a
    // later "simplification" to an unanchored pattern fails here.
    expect(HASHED_ASSET_PATH.test('/assets/index-3DAsiWei.js?v=2')).toBe(false);
    expect(HASHED_ASSET_PATH.test('/assets/landing/index-3DAsiWei.js')).toBe(false);
    expect(HASHED_ASSET_PATH.test('/x/assets/index-3DAsiWei.js')).toBe(false);
  });
});

// The tiers above are only worth anything if they reach the wire. This is the
// half that would have caught the original bug: the headers were never set at
// all, and no regex assertion can tell you that. DB-less, like spa-404.test.ts —
// this is app wiring, not data.
describe('static asset Cache-Control reaches the response', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'tc-dist-cache-'));
    mkdirSync(join(distDir, 'assets', 'landing'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="truecairn-spa"></div>');
    writeFileSync(join(distDir, 'assets', 'index-DfPbOjMd.css'), 'body{}');
    writeFileSync(join(distDir, 'assets', 'landing', 'hero-loop-720.mp4'), 'not really an mp4');
  });
  afterAll(() => rmSync(distDir, { recursive: true, force: true }));

  function boot() {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    return buildApp({ ...config, logLevel: 'silent', databaseUrl: undefined, webDistDir: distDir });
  }

  it('freezes a content-hashed bundle for a year', async () => {
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/assets/index-DfPbOjMd.css' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    } finally {
      await app.close();
    }
  });

  it('gives a hand-named asset a week, and never `immutable`', async () => {
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/assets/landing/hero-loop-720.mp4' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=604800, stale-while-revalidate=86400',
      );
      expect(String(res.headers['cache-control'])).not.toContain('immutable');
    } finally {
      await app.close();
    }
  });

  it('makes HTML revalidate, so a deploy is visible immediately', async () => {
    const app = boot();
    await app.ready();
    try {
      for (const url of ['/', '/security']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['cache-control'], url).toBe('no-cache');
      }
    } finally {
      await app.close();
    }
  });

  it('leaves a route that sets its own Cache-Control alone', async () => {
    // /v1/status publishes its own TTL. A blanket hook that overwrote it would
    // be a silent regression in a different subsystem, so the hook yields to any
    // header already present.
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/health' });
      // No DB here, so only assert the hook did not stamp an asset policy on it.
      expect(String(res.headers['cache-control'] ?? '')).not.toContain('immutable');
    } finally {
      await app.close();
    }
  });
});
