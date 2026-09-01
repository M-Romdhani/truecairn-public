import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The rule is old and was written down; nothing enforced it, so it drifted
// (2026-08-08 re-audit, N-7). `apps/web/src/lib/dates.ts` opens with:
//
//   "Every screen formats dates through these helpers — never a bare
//    toLocale*() call."
//
// That rule came out of an earlier audit (M11 / F-3) for two reasons. The app is
// English-only, so a bare toLocale*() renders in the VISITOR's locale and a
// French or German browser gets a date in a shape nothing else on the page uses.
// And it makes any date string environment-dependent, which quietly breaks
// string-based assertions in CI versus a laptop.
//
// It drifted anyway: `company.tsx` — the PUBLIC status page, the one place a
// stranger is most likely to land — rendered "measuring since" with
// `toLocaleDateString(undefined, …)`. A comment is not a control. This is, and it
// costs one filesystem walk.
//
// Deliberately scoped to src/: a test file asserting on a locale-formatted string
// is a legitimate thing to write.

const SRC = resolve(process.cwd(), 'src');
const LIB_DATES = resolve(SRC, 'lib/dates.ts');
const BARE_TO_LOCALE = /\.toLocale(?:String|DateString|TimeString)\s*\(/;

async function tsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tsFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('date formatting goes through lib/dates.ts', () => {
  it('no screen calls toLocaleString/DateString/TimeString directly', async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(SRC)) {
      // dates.ts is where the pinned-locale calls are SUPPOSED to live.
      if (file === LIB_DATES) continue;
      const source = await readFile(file, 'utf8');
      if (BARE_TO_LOCALE.test(source)) offenders.push(relative(SRC, file));
    }
    // Named rather than counted, so a failure says which file to fix.
    expect(offenders).toEqual([]);
  });
});
