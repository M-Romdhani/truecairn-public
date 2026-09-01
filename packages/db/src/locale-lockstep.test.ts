import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@truecairn/shared';

// The language vocabulary is stated TWICE — once as LOCALES in
// packages/shared/src/locale.ts, once as the users_locale_vocabulary CHECK in
// migration 0067 — and the two must not drift (docs/40 Phase 1).
//
// The failure mode if they do is nasty and one-directional. Add a language to
// the code and forget the constraint, and everything typechecks, every test that
// does not touch Postgres passes, the picker offers it — and the first real user
// who selects it gets a 500 from a constraint violation on their settings page.
// The reverse (a value legal in the database and unknown to the code) is milder
// but still wrong: a stored locale nothing can render.
//
// Same shape as the enums.ts ↔ 0001_enums.sql lockstep the schema package
// already relies on, and the same reason docs-truth.test.ts exists: a rule
// written in a comment is not a control.
const MIGRATION = resolve(
  process.cwd(),
  process.cwd().endsWith('packages/db') ? 'migrations' : 'packages/db/migrations',
  '0067_user_locale.sql',
);

describe('locale vocabulary lockstep: LOCALES <-> migration 0067 CHECK', () => {
  it('lists exactly the same languages in both places', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    // The IN (...) list of the CHECK constraint.
    const match = /CHECK\s*\(\s*locale IS NULL OR locale IN \(([^)]*)\)\s*\)/i.exec(sql);
    expect(match, 'the users_locale_vocabulary CHECK could not be found').not.toBeNull();

    const inDatabase = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(inDatabase).toEqual([...LOCALES].sort());
  });

  // NULL has to stay legal: it is how "never expressed a preference" is recorded,
  // and a NOT NULL DEFAULT would silently restate every existing account as
  // having chosen English.
  it('still permits NULL', () => {
    expect(readFileSync(MIGRATION, 'utf8')).toMatch(/locale IS NULL OR/);
  });
});
