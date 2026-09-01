import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The docs-truth gate (Gap plan §10, lightweight): every `*_ENABLED` capability
// flag a PUBLIC document mentions must exist in code, and every flag code reads
// must be documented. A doc describing a capability whose flag doesn't exist is
// vaporware; a flag no doc mentions is an undocumented capability — both fail
// the build. Same source-scan style as the D2 no-open-tracking gate.

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

function collect(dir: string, pred: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'test-results', 'playwright-report'].includes(entry.name)) continue;
      collect(rel, pred, out);
    } else if (pred(entry.name)) out.push(rel);
  }
  return out;
}

const FLAG_RE = /\b[A-Z][A-Z0-9_]*_ENABLED\b/g;
// env['X_ENABLED'] reads in product source — the flags that actually exist.
const ENV_READ_RE = /env\[['"]([A-Z][A-Z0-9_]*_ENABLED)['"]\]/g;

function flagsIn(text: string, re: RegExp): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[1] ?? m[0]);
  return found;
}

describe('docs-truth: capability flags in public docs match the code (Gap plan §10)', () => {
  const codeFiles = [
    ...collect('apps/api/src', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
    ...collect('apps/worker/src', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
  ];
  const codeFlags = new Set<string>();
  for (const f of codeFiles) {
    for (const flag of flagsIn(readFileSync(join(repoRoot, f), 'utf8'), ENV_READ_RE)) {
      codeFlags.add(flag);
    }
  }

  const docFiles = [
    ...collect('docs', (n) => n.endsWith('.md')),
    'CHANGELOG.md',
    'README.md',
    '.env.example',
    'CLAUDE.md',
  ];
  const docFlags = new Map<string, string[]>();
  for (const f of docFiles) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, f), 'utf8');
    } catch {
      continue; // optional files (README may not exist)
    }
    for (const flag of flagsIn(text, FLAG_RE)) {
      docFlags.set(flag, [...(docFlags.get(flag) ?? []), f]);
    }
  }

  it('every flag a public doc references exists in code', () => {
    for (const [flag, files] of docFlags) {
      expect(codeFlags.has(flag), `${flag} (mentioned in ${files.join(', ')}) is not read by any code`).toBe(true);
    }
  });

  it('every capability flag the code reads is documented', () => {
    for (const flag of codeFlags) {
      expect(docFlags.has(flag), `${flag} is read by code but no public doc mentions it`).toBe(true);
    }
  });

  it('the gate is not vacuous', () => {
    expect(codeFlags.size).toBeGreaterThanOrEqual(8);
  });

  // ── What this gate CANNOT see, stated so nobody assumes otherwise ──────────
  //
  // QA 2026-08-10 §6. CLAUDE.md said the three AI_*_ENABLED flags were "off in
  // production" while they had been explicitly ON since 2026-08-06. Everything
  // above stayed green, correctly: the flags exist in code and are documented.
  // Existence is all a repo can check. A flag's VALUE in production lives in the
  // Railway service, and no test in this repository can read it — so a sentence
  // asserting a deployed value is unverifiable here by construction, and the
  // rule is that it carries a date and a source or is not written.
  //
  // The DEFAULT is a different thing, and it is checkable. Pinning it is what
  // keeps "off unless someone deliberately turned it on" true of the code, which
  // is the half of the doc's claim that a build can defend: if a default flips,
  // this fails and the sentence has to be rewritten with it.
  it('every AI capability flag still defaults to OFF in code', () => {
    const config = readFileSync(join(repoRoot, 'apps/api/src/config.ts'), 'utf8');
    for (const flag of ['AI_PROPOSER_ENABLED', 'AI_AUTONOMY_ENABLED', 'AI_GUARDIAN_ENABLED']) {
      const m = new RegExp(`parseBoolFlag\\(env\\['${flag}'\\],\\s*(true|false)\\)`).exec(config);
      expect(m, `${flag} is not read through parseBoolFlag with a literal default`).not.toBeNull();
      expect(m?.[1], `${flag} must default to false — a capability flag is opt-in`).toBe('false');
    }
  });
});

// ── .env.example is the whole configuration surface (2026-08-09, QA P3-2) ────
//
// The flag gate above only covers `*_ENABLED`. Seven variables the code actually
// reads were missing from .env.example — including WEBAUTHN_NATIVE_ORIGINS and
// the two OUTER_LAYER_KEK_PROVIDER / OUTER_LAYER_KMS_KEY knobs, where the cost
// is not cosmetic: an operator setting up native passkeys or the HSM-backed KEK
// could not DISCOVER that the variable exists. .env.example is the only place
// anyone looks, so a variable absent from it is a feature nobody can turn on.
//
// Adding the seven rows fixed that instance. This gate is what stops the eighth.
describe('docs-truth: every env var the code reads is discoverable in .env.example', () => {
  // `env['NAME']` and `process.env['NAME']` in product source. The codebase reads
  // env exclusively through bracket notation (noPropertyAccessFromIndexSignature),
  // so this catches every read.
  const ENV_ANY_RE = /(?:process\.)?env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;

  // Supplied by the platform or a toolchain, never by an operator editing a
  // .env file — documenting them as if they were ours would be its own lie.
  const NOT_OURS = new Set([
    'CI', // the CI provider
    'NODE_ENV', // node/vitest
    'GOOGLE_APPLICATION_CREDENTIALS', // ADC standard; set externally, and
    // GOOGLE_SERVICE_ACCOUNT_JSON (which IS documented) exists to populate it
    'RAILWAY_GIT_COMMIT_SHA', // injected by the deploy platform
    'RAILWAY_GIT_BRANCH',
    'GITHUB_SHA',
    'GITHUB_REF_NAME',
  ]);

  const sourceDirs = ['apps/api/src', 'apps/worker/src'];
  for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (pkg.isDirectory()) sourceDirs.push(join('packages', pkg.name, 'src'));
  }

  const read = new Map<string, string>();
  for (const dir of sourceDirs) {
    let files: string[];
    try {
      files = collect(dir, (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
    } catch {
      continue; // a package with no src/
    }
    for (const f of files) {
      for (const m of readFileSync(join(repoRoot, f), 'utf8').matchAll(ENV_ANY_RE)) {
        const name = m[1];
        if (name !== undefined && !read.has(name)) read.set(name, f);
      }
    }
  }

  // A row counts as documented whether or not it is commented out — the point is
  // that a reader can find the name and its explanation.
  const documented = new Set<string>();
  for (const m of readFileSync(join(repoRoot, '.env.example'), 'utf8').matchAll(
    /^#?\s*([A-Z][A-Z0-9_]*)=/gm,
  )) {
    if (m[1] !== undefined) documented.add(m[1]);
  }

  it('names every operator-settable variable the code reads', () => {
    const missing = [...read]
      .filter(([name]) => !NOT_OURS.has(name) && !documented.has(name))
      .map(([name, file]) => `${name} (read in ${file})`);
    expect(missing, `absent from .env.example:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('the gate is not vacuous', () => {
    expect(read.size).toBeGreaterThanOrEqual(40);
    expect(documented.size).toBeGreaterThanOrEqual(40);
  });
});
