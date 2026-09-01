import { defineConfig } from 'vitest/config';

// The interop and session suites run production-params Argon2id (256 MiB / 4 ops)
// during enrollment, unlock, and recovery — several per test. Raise the timeout
// ceiling above vitest's 5 s default so these are deterministic under load. Fast
// tests are unaffected (the timeout is only a ceiling).
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
