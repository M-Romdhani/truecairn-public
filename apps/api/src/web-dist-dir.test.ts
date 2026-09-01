import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveWebDistDir } from './app.js';

// Restore-drill finding F-3 (2026-08-10). WEB_DIST_DIR was resolved with a bare
// resolve() against process.cwd(), and the production start command is
// `pnpm --filter @truecairn/api start` — so the cwd is apps/api. The documented
// `../web/dist` worked; the repo-root-relative `apps/web/dist` that anyone
// standing up a second instance from a variable list would reach for produced
//
//     "root" path "/app/apps/api/apps/web/dist" must exist
//
// which names the joined path and nothing about why it was joined that way.
//
// Both readings now work, cwd first so production's resolution is unchanged, and
// a value that resolves to nothing throws here — naming every path tried —
// rather than at @fastify/static's register() with the message above.

const repoRoot = resolve(join(import.meta.dirname, '..', '..', '..'));

describe('WEB_DIST_DIR resolution (drill F-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tc-webdist-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('takes an absolute path as given', () => {
    expect(resolveWebDistDir(tmp)).toBe(tmp);
  });

  it('resolves a repo-root-relative value — the one that used to fail', () => {
    // apps/api exists at the repo root and does NOT exist under apps/api/, so
    // this can only resolve via the repo-root candidate. If someone reverts to
    // the bare cwd resolve, this throws.
    expect(resolveWebDistDir('apps/api')).toBe(join(repoRoot, 'apps', 'api'));
  });

  it('still resolves a cwd-relative value, which is what production uses', () => {
    // The documented production value is `../web/dist`, relative to apps/api.
    // Modelled with a directory that exists relative to the cwd this suite runs
    // in (apps/api) and would NOT be found from the repo root.
    const found = resolveWebDistDir('src/routes');
    expect(found).toBe(resolve(process.cwd(), 'src/routes'));
  });

  it('prefers the cwd candidate when a name exists under both', () => {
    // The ordering is what makes this additive rather than a silent change to a
    // working deployment: an ambiguous value keeps resolving where it always did.
    //
    // ONLY CLEAN UP WHAT THIS TEST CREATED (2026-08-25). `docs` is the ambiguous
    // name because it really exists at the repo root, and the cleanup below used
    // to run unconditionally. Under `pnpm -r test` the cwd is apps/api, where no
    // `docs` exists, so create-then-delete was harmless — but run this suite with
    // the cwd at the REPO ROOT (a bare `vitest --root apps/api`, or an IDE runner
    // that does not chdir) and mkdirSync is a no-op on the real directory while
    // rmSync recursively deletes it. It removed all 56 files in docs/ exactly
    // once, which is how this note came to be written.
    //
    // Nothing about the assertion changes; the test simply no longer deletes a
    // directory it did not make.
    const collide = join(process.cwd(), 'docs');
    const preexisting = existsSync(collide);
    mkdirSync(collide, { recursive: true });
    try {
      expect(resolveWebDistDir('docs')).toBe(resolve(process.cwd(), 'docs'));
    } finally {
      if (!preexisting) rmSync(collide, { recursive: true, force: true });
    }
  });

  it('throws naming every path it tried, instead of leaving that to fastify-static', () => {
    let err: unknown;
    try {
      resolveWebDistDir('no/such/dist');
    } catch (e) {
      err = e;
    }
    const message = (err as Error | undefined)?.message ?? '';
    expect(message).toContain('WEB_DIST_DIR=no/such/dist');
    // Both candidates named, so the operator can see which base was assumed.
    expect(message).toContain(resolve(process.cwd(), 'no/such/dist'));
    expect(message).toContain(join(repoRoot, 'no', 'such', 'dist'));
  });
});
