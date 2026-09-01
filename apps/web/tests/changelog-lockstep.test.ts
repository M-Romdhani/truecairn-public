import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The lockstep rule (CLAUDE.md) says a user-visible change updates BOTH
// CHANGELOG.md and the /changelog page in the same change-set. Nothing enforced
// it, so it was honour-system — and it drifted: #147 regrouped to one entry per
// date at the owner's request, then #149 landed afterwards and appended a SECOND
// 2026-07-31 entry, which sat in production until 2026-08-01.
//
// Deliberately does NOT compare prose. The markdown and the JSX say the same
// things in different shapes (bold markers, nested bullets), and a test
// demanding character equality would be abandoned the first time someone
// reflowed a line. Dates are what must agree and what no human can eyeball
// across two files.
//
// SCOPE. The two files are per-date only for recent history. Older CHANGELOG.md
// entries are summarised — one `## 2026-07-04 → 07-10` range covering the AI
// Guardian round, then an undated `## Earlier — V1 core` catch-all — while the
// page still lists those weeks individually. That is an editorial choice made
// before the lockstep rule existed, not a drift to fix, and rewriting either
// side to match would mean inventing history. So the comparison runs from the
// oldest SINGLE-DATE markdown heading forward, which is exactly the region where
// both files claim to be per-date, and where a change-set that updates one and
// not the other actually lands.
const root = resolve(process.cwd(), '../..');
const md = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const page = readFileSync(resolve(root, 'apps/web/src/screens/public/Changelog.tsx'), 'utf8');

// `## YYYY-MM-DD —` only. A range heading (`## YYYY-MM-DD → MM-DD —`) is the
// summarised form and is excluded by requiring the em-dash straight after.
const mdDates = [...md.matchAll(/^## (\d{4}-\d{2}-\d{2}) —/gm)].map((m) => m[1]!);
const pageDates = [...page.matchAll(/iso: '(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]!);

const oldestPerDate = mdDates[mdDates.length - 1]!;
const pageInScope = pageDates.filter((d) => d >= oldestPerDate);

describe('changelog lockstep: CHANGELOG.md <-> the public /changelog page', () => {
  it('publishes exactly one entry per date, in both files', () => {
    // The owner's rule, ratified 2026-07-31: the page had shown "July 30, 2026"
    // six times running, an artefact of the lockstep rule appending per
    // change-set rather than per day.
    expect(mdDates).toEqual([...new Set(mdDates)]);
    expect(pageDates).toEqual([...new Set(pageDates)]);
  });

  it('agrees on every date in the per-date range', () => {
    // The real failure mode: a change-set updating one file and not the other.
    // An entry in only one of them is a public page that disagrees with the
    // repo about what shipped.
    expect(pageInScope).toEqual(mdDates);
  });

  it('is ordered newest first, in both files', () => {
    expect(mdDates).toEqual([...mdDates].sort().reverse());
    expect(pageDates).toEqual([...pageDates].sort().reverse());
  });
});
