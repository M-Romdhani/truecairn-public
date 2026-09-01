import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The import fence + grep gate (plan docs/25 §3.1 / §9). The repo has no ESLint
// toolchain, so the plan's `no-restricted-imports` rule is realised here as a
// filesystem-scanning test — same guarantee, runs in the existing vitest gate.
//
// GUARANTEE 1 (import fence): nothing under an AI code path imports the engine,
// ceremony, or sensitive-actions packages directly. Every AI side effect must go
// through @truecairn/ai-authority (the chokepoint), which is the ONLY module that
// may reach those capabilities.
//
// GUARANTEE 2 (grep gate): the forward engine event
// `release_review_verification_passed` never appears in any AI code path — the AI
// can emit only the fail-closed `review_required` direction.

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..'); // apps/api/src
const repoRoot = join(apiRoot, '..', '..', '..');

// AI code paths to police. The worker guardian module (Phase 3) is included
// pre-emptively; missing directories are simply skipped.
const AI_DIRS = [
  join(apiRoot, 'ai'),
  join(repoRoot, 'apps', 'worker', 'src', 'guardian'),
];
const GUARDIAN_FILE = join(repoRoot, 'apps', 'worker', 'src', 'guardian.ts');

// The chokepoint package itself legitimately references these capabilities (it IS
// the single door). Everything else in the AI paths must not.
const FORBIDDEN_IMPORTS = [
  '@truecairn/engine',
  '@truecairn/ceremony',
  '@truecairn/sensitive-actions',
];

function collectTsFiles(path: string): string[] {
  let entries: string[];
  try {
    if (statSync(path).isFile()) return path.endsWith('.ts') ? [path] : [];
    entries = readdirSync(path);
  } catch {
    return []; // directory/file does not exist yet — nothing to police
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) files.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

// The fence polices PRODUCTION AI code. Test files and the eval-corpus fixtures
// legitimately name the forbidden imports/strings in order to PROVE they are
// rejected — excluding them keeps the gate about product code, not test data.
function aiSourceFiles(): string[] {
  const files = new Set<string>();
  for (const dir of AI_DIRS) for (const f of collectTsFiles(dir)) files.add(f);
  for (const f of collectTsFiles(GUARDIAN_FILE)) files.add(f);
  return [...files].filter(
    (f) => !f.endsWith('.test.ts') && !f.includes(`${sep}evals${sep}`),
  );
}

describe('AI authority import fence', () => {
  it('finds AI source files to police (self-check)', () => {
    expect(aiSourceFiles().length).toBeGreaterThan(0);
  });

  it('no AI code path imports engine / ceremony / sensitive-actions directly', () => {
    const offenders: string[] = [];
    for (const file of aiSourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const pkg of FORBIDDEN_IMPORTS) {
        // Match an actual import/from specifier, not a mention in a comment.
        const re = new RegExp(`from\\s+['"]${pkg.replace(/[/-]/g, '\\$&')}['"]`);
        if (re.test(src)) offenders.push(`${file} imports ${pkg}`);
      }
    }
    expect(offenders, 'route AI effects through @truecairn/ai-authority instead').toEqual([]);
  });

  it('the forward event release_review_verification_passed never appears in AI code', () => {
    const offenders: string[] = [];
    for (const file of aiSourceFiles()) {
      if (readFileSync(file, 'utf8').includes('release_review_verification_passed')) {
        offenders.push(file);
      }
    }
    expect(offenders, 'AI may emit only the fail-closed review_required direction').toEqual([]);
  });
});
