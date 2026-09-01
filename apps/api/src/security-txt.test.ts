import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// /.well-known/security.txt (RFC 9116) — QA 2026-08-26 F5.
//
// The address was already published on /security/disclosure, but only as prose
// on an HTML page. Researchers and automated tooling look HERE first, and the
// page was additionally serving `[email protected]` at the time (F6), so
// there was no machine-readable route to a contact at all.
//
// DB-less, like the other SPA-serving tests: this is app wiring.

const REPO_FILE = join(import.meta.dirname, '../../web/public/.well-known/security.txt');

describe('/.well-known/security.txt', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'tc-dist-sec-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="truecairn-spa"></div>');
    mkdirSync(join(distDir, '.well-known'), { recursive: true });
    // Copy the REAL shipped file, so this tests what deploys rather than a
    // fixture that could drift from it.
    writeFileSync(join(distDir, '.well-known', 'security.txt'), readFileSync(REPO_FILE));
  });
  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  function boot() {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    return buildApp({ ...config, logLevel: 'silent', databaseUrl: undefined, webDistDir: distDir });
  }

  it('is reachable and served as text/plain', async () => {
    // Not HTML: a client that gets the SPA fallback here reads an HTML 404 as
    // the policy, which is how this looked before it existed.
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('Contact:');
    } finally {
      await app.close();
    }
  });

  it('carries the two fields RFC 9116 requires', () => {
    const text = readFileSync(REPO_FILE, 'utf8');
    expect(text).toMatch(/^Contact:\s*\S+/m);
    expect(text).toMatch(/^Expires:\s*\S+/m);
  });

  it('names a contact that is actually ours', () => {
    const text = readFileSync(REPO_FILE, 'utf8');
    expect(text).toContain('mailto:security@truecairn.app');
    expect(text).toContain('https://truecairn.app/security/disclosure');
  });

  // ── The self-retiring part ────────────────────────────────────────────────
  //
  // A LAPSED security.txt is worse than none: consumers are told to disregard
  // the file once Expires has passed, so the contact silently stops being
  // discoverable on a date nobody has diarised. This is the same shape as the
  // repo's other date-bearing markers — the gate goes red while there is still
  // time to act, rather than after the fact.
  it('does not expire within the next 60 days', () => {
    const text = readFileSync(REPO_FILE, 'utf8');
    const match = /^Expires:\s*(\S+)/m.exec(text);
    expect(match, 'security.txt has no Expires field').not.toBeNull();
    const expires = new Date(match?.[1] ?? '');
    expect(Number.isNaN(expires.getTime()), 'Expires is not a valid date').toBe(false);
    const daysLeft = (expires.getTime() - Date.now()) / 86_400_000;
    expect(
      daysLeft,
      `security.txt expires in ${Math.round(daysLeft)} days — renew the Expires date ` +
        'in apps/web/public/.well-known/security.txt',
    ).toBeGreaterThan(60);
  });
});
