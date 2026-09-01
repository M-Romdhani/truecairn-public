import { defineConfig, devices } from '@playwright/test';

// End-to-end gate (PHASE4 C2). This is the ONLY place the real-browser runtime is
// exercised: real WASM libsodium + the Web Worker Argon2id + a real API
// provisioning the material. jsdom can't do either faithfully, so the enrollment
// ceremony is the must-have E2E.
//
// HOW TO RUN (needs a browser + a database):
//   1. A Postgres with the migrations applied; export DATABASE_URL.
//   2. pnpm --filter @truecairn/web exec playwright install chromium
//   3. pnpm --filter @truecairn/web e2e
// The webServer block boots the API and a preview build of the app; the app
// proxies /v1 to the API (same-origin, so the session cookie works).
//
// NOTE: in the review sandbox the browser binary cannot be installed
// (cdn.playwright.dev is not in the network allowlist — `playwright install`
// returns 403), so this suite is written + runnable but must be executed where a
// browser is available; the trace is pasted from that run.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  // The HTML report makes a trace browsable without a local browser.
  reporter: [['list'], ['html', { open: 'never' }]],
  // Establish a logged-in session once (CDP virtual authenticator), then reuse it.
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:4173',
    storageState: 'tests/e2e/.auth/state.json',
    // 'retain-on-failure', NOT 'on'. This was 'on' so a trace existed for every
    // test, pass or fail — deliberate, and ci.yml documented the cost: a failing
    // run uploaded 51 files when only the 2 failures needed one. That comment
    // called the tradeoff and left the decision open.
    //
    // The decision came due on 2026-08-22. The artifact storage quota filled, and
    // the upload began failing with "Artifact storage quota has been hit". The
    // step still reported SUCCESS, because ci.yml sets continue-on-error on it —
    // correctly, since an artifact problem must not stand in front of a test
    // result. The combined effect was that CI silently stopped capturing traces
    // while looking entirely healthy, and the intermittent ceremony failures
    // (3, then 4, then 2 specs across consecutive runs) could not be diagnosed
    // because the one artifact that would explain them was never stored.
    //
    // Traces for PASSING tests are the thing being given up. That is the right
    // trade while the alternative is traces for nothing at all: a trace you
    // cannot upload is worth less than a trace you can.
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @truecairn/api start',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @truecairn/web build && pnpm --filter @truecairn/web exec vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
