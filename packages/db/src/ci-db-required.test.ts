import { describe, expect, it } from 'vitest';

// Audit finding F-3 (2026-08-01). Seventy-two test files across this workspace
// guard themselves with
//
//   const describeIfDb = url ? describe : describe.skip;
//
// which is good local ergonomics — you can run the suite without Postgres — and
// a genuinely dangerous default in CI. With DATABASE_URL unset those 72 files do
// not fail and do not report as skipped in a marker audit: they simply contain
// no tests, and the run is INDISTINGUISHABLE from a full pass. Everything this
// product's safety rests on — the engine ladder, ceremony consensus, the audit
// chain, channel enrolment — lives behind that flag.
//
// CI does set DATABASE_URL today (.github/workflows/ci.yml, both jobs), so this
// is insurance rather than a live bug. It is the cheapest possible guard against
// the specific failure of a green tick that means nothing: a renamed service, a
// typo'd env key, or a new job copied from the Flutter one. Because CI runs
// every workspace package, this single assertion failing anywhere turns the run
// red, which is all it needs to do.
//
// It must NOT be the describeIfDb pattern itself — that would skip in exactly
// the case it exists to catch.
describe('CI must not report green having run no database tests', () => {
  it('has DATABASE_URL when CI=true', () => {
    if (process.env['CI'] !== 'true') return; // local runs stay optional, by design
    expect(
      process.env['DATABASE_URL'],
      'DATABASE_URL is unset in CI: every describeIfDb suite (72 files) would silently no-op and the run would still pass. Set it in .github/workflows/ci.yml.',
    ).toBeTruthy();
  });
});
