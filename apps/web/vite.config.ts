import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

// Vite app config + the jsdom component-test gate (PHASE4 C2). Component tests
// run in the normal `vitest` gate with a real (simulated) DOM; the Playwright
// E2E (real browser, real WASM + Web Worker) lives under tests/e2e and is run
// separately via `pnpm e2e`. testTimeout is raised because the crypto-session
// integration tests run real 256 MiB Argon2id on the Node path.
export default defineConfig({
  plugins: [react()],
  // Ship NO source maps. This is a zero-knowledge client: the bundle is the
  // published client, and a .js.map would hand out readable original source,
  // file structure, and comments to anyone who fetches it — the exact leak that
  // has bitten private-repo apps whose bundler shipped maps by default. Vite
  // already defaults this to false, but state it so the decision is reviewable
  // and can't be flipped to true (or 'hidden', which still emits the .map file)
  // in a one-line change without someone noticing this note.
  build: { sourcemap: false },
  resolve: {
    alias: {
      // ⚠️ DO NOT REMOVE THIS ALIAS — it is load-bearing for the browser build.
      // libsodium-wrappers-sumo 0.7.16's ESM dist is broken (its published .mjs
      // imports ./libsodium-sumo.mjs, a file the package does NOT ship), so a
      // browser `import()` of the package fails to bundle and the deployed app
      // never loads. We resolve it to its working CJS build (require.resolve picks
      // `main`); esbuild handles the CJS interop. It is the SAME library the server
      // loads via createRequire — identical primitives, so the client/server crypto
      // interop guarantees still hold. A future libsodium bump may fix the ESM dist;
      // only then is it safe to drop this, and ONLY after `pnpm --filter
      // @truecairn/web build` succeeds without it (the CI e2e job will also catch a
      // regression). Re-verify; do not "clean up" on sight.
      'libsodium-wrappers-sumo': require.resolve('libsodium-wrappers-sumo'),
    },
  },
  // Same-origin in dev + preview: proxy the API so the session cookie works and
  // there's no CORS. Production serves the app behind the same host as /v1.
  server: { proxy: { '/v1': 'http://localhost:3001' } },
  preview: { proxy: { '/v1': 'http://localhost:3001' } },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    testTimeout: 30_000,
    css: false,
  },
});
