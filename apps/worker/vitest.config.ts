import { defineConfig } from 'vitest/config';

// These test files share ONE Postgres and wipe shared tables in beforeEach
// (`TRUNCATE … CASCADE`). Vitest runs files in parallel by default, which turns
// that into global mutable state: two files truncating the same tables at once
// deadlock, and one file's TRUNCATE deletes the rows another is mid-test with.
// Serialising files is the isolation boundary, and it costs nothing here because
// Postgres, not the CPU, is the bottleneck.
//
// This lives in config rather than in the `--no-file-parallelism` flag on the
// test script it replaced, so it also covers `vitest` invoked directly, watch
// mode, and IDE runners — the paths a package.json flag silently misses. See
// apps/api/vitest.config.ts for the measurement behind it.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
