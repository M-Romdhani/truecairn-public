import { defineConfig } from 'vitest/config';

// Several API suites run real 256 MiB / 4-ops Argon2id derivations (password
// login, rate-limit lockout, step-up, and the PHASE4 key-material provision/
// bootstrap, which does up to four per test). Under full-suite setup load these
// land just over vitest's 5 s default and flake on timeout — not hung, just slow.
// Raise the ceiling suite-wide so the green bar is deterministic. Fast tests are
// unaffected (the timeout is only a ceiling).
export default defineConfig({
  test: {
    testTimeout: 30_000,

    // 47 of this package's 68 test files share ONE Postgres and wipe shared
    // tables in beforeEach (`TRUNCATE … CASCADE`). Vitest runs files in parallel
    // by default, which makes that state global: two files truncating the same
    // tables at once deadlock, and one file's TRUNCATE deletes the rows another
    // is mid-test with (FK violations on audit_log.user_id, assertions against
    // rows that vanished). Measured on 2026-08-09 — parallel: 119 of 535 failed
    // in 247 s; serial: 0 of 535 in 241 s. Serialising costs nothing because
    // Postgres, not the CPU, is the bottleneck, so there is no tradeoff to weigh.
    //
    // This lives in config rather than in the `--no-file-parallelism` flag on the
    // test script it replaced, so it also covers `vitest` invoked directly, watch
    // mode, and IDE runners — the paths a package.json flag silently misses.
    fileParallelism: false,
  },
});
