import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// The two public statements of app identity that let a native client use
// passkeys for truecairn.app (docs/35 §4). Neither carries a secret; both fail
// SILENTLY when wrong, which is the whole reason they are pinned here.
//
// DB-less, like the other SPA-serving tests: this is app wiring.

const REPO_WELL_KNOWN = join(import.meta.dirname, '../../web/public/.well-known');

describe('/.well-known app association files', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'tc-dist-wk-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="truecairn-spa"></div>');
    // Copy the REAL files the web build ships, so this exercises the shipped
    // content rather than a fixture that could drift from it.
    mkdirSync(join(distDir, '.well-known'), { recursive: true });
    for (const name of ['assetlinks.json', 'apple-app-site-association']) {
      writeFileSync(join(distDir, '.well-known', name), readFileSync(join(REPO_WELL_KNOWN, name)));
    }
  });
  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  function boot() {
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 7).toString('base64') });
    return buildApp({ ...config, logLevel: 'silent', databaseUrl: undefined, webDistDir: distDir });
  }

  it('serves assetlinks.json as JSON, whatever it currently authorises', async () => {
    // The route wiring is the invariant here — the file must be reachable and
    // typed as JSON even when it authorises nobody, because Android reads it
    // before it has anything to compare against. What it CONTAINS is asserted
    // separately below, against the repo file.
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(Array.isArray(JSON.parse(res.body))).toBe(true);
    } finally {
      await app.close();
    }
  });

  // Apple serves this file extensionless, so content-type-by-extension makes it
  // application/octet-stream and iOS declines to associate the app without ever
  // naming the reason.
  it('serves apple-app-site-association as application/json despite having no extension', async () => {
    const app = boot();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/apple-app-site-association',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body)).toHaveProperty('webcredentials.apps');
    } finally {
      await app.close();
    }
  });

  // EMPTY, and deliberately so as of 2026-08-09.
  //
  // From 2026-08-03 this file carried one fingerprint, and it was a DEBUG
  // keystore's — Android's debug keystore is protected by the literal password
  // `android`, so it is not a credential, and anyone holding that file could
  // build an APK declaring package `app.truecairn` that Android trusts for
  // credential sharing on truecairn.app. It was an acceptable development
  // unblock while the swap to a release key had a date attached.
  //
  // It does not. A console check on 2026-08-08 found there is no Play developer
  // account at all, so no app-signing key and no upload key exist to swap TO,
  // and the exposure was open-ended. An undistributed app is worth less than a
  // production domain vouching for a key whose password is public, so the entry
  // is removed until a release identity exists (docs/35 §5).
  //
  // The known cost, accepted: Android DEBUG builds cannot use passkeys until a
  // fingerprint returns. That is the only consumer — the app is not distributed.
  it('authorises no Android app: the debug fingerprint was removed (docs/35 §5)', () => {
    const links = JSON.parse(readFileSync(join(REPO_WELL_KNOWN, 'assetlinks.json'), 'utf8')) as {
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(links).toEqual([]);
  });

  // Kept live for the day a release key exists, because the value it protects is
  // not "is there a fingerprint" but "is the fingerprint the right SHAPE" — and
  // every wrong value here fails SILENTLY on a device, with an error naming the
  // domain rather than the fingerprint. Two pastes it catches, both of which look
  // right at a glance:
  //   - a SHA-1 fingerprint (20 octets), which sits directly above the SHA-256
  //     one in keytool's output;
  //   - the `android:apk-key-hash:` origin, which is the SAME identity in
  //     base64url and belongs in WEBAUTHN_NATIVE_ORIGINS, not in this file.
  // Vacuous while the list is empty; that is the point — it survives the removal
  // instead of being deleted alongside it.
  it('validates any Android statement that IS present', () => {
    const links = JSON.parse(readFileSync(join(REPO_WELL_KNOWN, 'assetlinks.json'), 'utf8')) as {
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    for (const statement of links) {
      // The applicationId in apps/mobile/android/app/build.gradle.kts. A
      // mismatch here is invisible until a device refuses the ceremony.
      expect(statement.target.package_name).toBe('app.truecairn');
      expect(statement.relation).toContain('delegate_permission/common.get_login_creds');
      // Deliberately NOT handle_all_urls: that claims every truecairn.app link
      // for the app, which would hijack web links into a client that cannot open
      // a vault. Passkeys need only the login-credentials delegation.
      expect(statement.relation).not.toContain('delegate_permission/common.handle_all_urls');
      expect(statement.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
      for (const fp of statement.target.sha256_cert_fingerprints) {
        expect(fp, `${fp} is not 32 colon-separated hex octets`).toMatch(
          /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/,
        );
      }
    }
  });

  // Still empty, and correct: there is no apple-app-site-association entry
  // without an Apple Developer Team ID (docs/35 §5), which is an owner action
  // with an external clock. iOS passkeys stay unavailable until it lands.
  it('authorises no iOS app yet (owner action, docs/35 §5)', () => {
    const aasa = JSON.parse(
      readFileSync(join(REPO_WELL_KNOWN, 'apple-app-site-association'), 'utf8'),
    ) as { webcredentials: { apps: string[] } };
    expect(aasa.webcredentials.apps).toEqual([]);
  });
});
