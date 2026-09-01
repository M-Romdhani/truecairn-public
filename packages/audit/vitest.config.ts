import { defineConfig } from 'vitest/config';

// Only one test file in this package truncates shared tables today, so nothing
// races yet — this is here so that the second one cannot introduce a race
// silently. Vitest runs files in parallel by default, and `TRUNCATE … CASCADE`
// against a shared Postgres is global mutable state: concurrent truncates
// deadlock, and one file's wipe deletes the rows another is mid-test with.
//
// It lives in config rather than in a `--no-file-parallelism` flag on the test
// script so it also covers `vitest` invoked directly, watch mode, and IDE
// runners — the paths a package.json flag silently misses. See
// apps/api/vitest.config.ts for the measurement behind it.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
