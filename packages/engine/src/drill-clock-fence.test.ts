import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The drill clock is an OPERATOR tool. It exists so a docs/29 drill can walk an
// account down the real ladder without waiting 30 real days — and it is exactly
// the kind of affordance that, if a product path ever reached for it, would
// become the test-mode branch CLAUDE.md invariant 3 forbids. Something that can
// move an account's clock must never be reachable from a request handler or the
// worker's poll loop; the only callers are scripts/ceremony-drill.ts and tests.
//
// Same shape as apps/worker/src/ai-free-release-path.test.ts. A "fix" that adds
// a product file to the allowed set is a bug: the drill writes DB preconditions
// from outside, which is what keeps it out of the product's own reasoning.

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const ROOTS = [
  join(repoRoot, 'apps', 'api', 'src'),
  join(repoRoot, 'apps', 'worker', 'src'),
  join(repoRoot, 'packages'),
];

// The module itself, and the barrel that re-exports it, are not violations.
const SELF = ['drill-clock.ts', 'index.ts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const MARKERS = ['computeDrillShift', 'applyDrillShift', 'drill-clock'];

describe('drill clock is not reachable from any product path (import fence)', () => {
  it('no API, worker or package source outside the module itself references it', () => {
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (SELF.some((s) => file.endsWith(join('engine', 'src', s)))) continue;
        const src = readFileSync(file, 'utf8');
        for (const marker of MARKERS) {
          expect(src.includes(marker), `${file} references '${marker}'`).toBe(false);
        }
      }
    }
  });
});
