#!/usr/bin/env node
// Emit dist/build-manifest.json: a SHA-256 for every shipped asset.
//
// WHY (docs/BUILDING.md, and the 2026-07-25 RC audit). Truecairn's central claim
// is that the server never sees plaintext — but every byte of the crypto that
// makes that true is JavaScript the server itself hands the browser. Nothing
// stops a compromised (or coerced) origin from serving ONE targeted user a
// modified bundle that exfiltrates their master key. That is the structural
// weakness of all browser-delivered end-to-end encryption, and it is not a
// hypothetical: it is the cheapest attack on this product.
//
// This manifest does not eliminate that. Nothing served from the same origin
// can, because the checker is served by the thing it checks. What it changes is
// the ECONOMICS: with per-release digests published and attested in CI, a
// tampered bundle has to survive comparison against an artifact signed by a
// build that ran from public source. Silent, targeted, deniable tampering
// becomes tampering that leaves evidence somewhere the attacker does not
// control. That is a real reduction in attack surface and an honest one to
// describe — see /security/build, which says exactly this to users.
//
// The manifest is NOT self-covering (a file cannot contain its own hash). The
// trust anchor is the CI attestation over dist/, not this file.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const MANIFEST_NAME = 'build-manifest.json';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = (await walk(DIST))
  .filter((f) => relative(DIST, f) !== MANIFEST_NAME)
  .sort();

const assets = {};
for (const f of files) {
  assets[relative(DIST, f).split('\\').join('/')] = createHash('sha256')
    .update(await readFile(f))
    .digest('hex');
}

// A single digest over the sorted (path, hash) pairs, so a human can compare ONE
// short string against the attestation instead of a table of forty.
const bundleDigest = createHash('sha256')
  .update(Object.entries(assets).map(([p, h]) => `${p} ${h}`).join('\n'))
  .digest('hex');

const manifest = {
  // Provenance identity, in preference order:
  //   GITHUB_SHA / GITHUB_REF_NAME  — the release workflow (the attested build)
  //   RAILWAY_GIT_*                 — the production deploy, set by the platform
  //   BUILD_COMMIT / BUILD_REF      — explicit override for any other builder
  //   'unknown'                     — a local build, reported honestly
  //
  // The Railway fallbacks matter: without them the DEPLOYED site shipped a
  // provenance page reading "Source commit: unknown", i.e. provenance with no
  // provenance in it — the one field that makes the digest checkable was the one
  // field missing. Railway injects these automatically, so this needs no config.
  commit:
    process.env['GITHUB_SHA'] ??
    process.env['RAILWAY_GIT_COMMIT_SHA'] ??
    process.env['BUILD_COMMIT'] ??
    'unknown',
  ref:
    process.env['GITHUB_REF_NAME'] ??
    process.env['RAILWAY_GIT_BRANCH'] ??
    process.env['BUILD_REF'] ??
    'unknown',
  builtAt: new Date().toISOString(),
  // Reproducibility is the point of publishing these: the same source at the
  // same commit should produce the same digests. Where it does not, docs/BUILDING
  // records the known sources of nondeterminism.
  bundleDigest,
  assetCount: Object.keys(assets).length,
  assets,
};

await writeFile(join(DIST, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(
  `[build-manifest] ${manifest.assetCount} assets, bundleDigest=${bundleDigest}\n`,
);
