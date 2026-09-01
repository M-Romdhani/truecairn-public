import { expect, test } from '@playwright/test';

// Enrollment ceremony in a REAL browser (PHASE4 C2) — the must-have E2E the
// reviewer named. It exercises what jsdom can't: real WASM libsodium + the Web
// Worker Argon2id, deriving material a real API provisions. The global-setup
// (CDP virtual authenticator) has already registered + logged the user in, so
// this starts with a session (storageState) and runs the ceremony itself.
//
// HOW TO RUN (needs a browser + a migrated database — see playwright.config.ts):
//   pnpm --filter @truecairn/web exec playwright install chromium
//   DATABASE_URL=… pnpm --filter @truecairn/web e2e
//
// STATUS: written + runnable, but NOT executed in the review sandbox — chromium
// cannot be installed there (cdn.playwright.dev is outside the network
// allowlist; `playwright install` returns 403). Run where a browser is available
// and paste the trace.

test('a new user completes the enrollment ceremony and the vault ends unlocked', async ({ page }) => {
  await page.goto('/onboarding');

  await page.getByRole('button', { name: 'Begin' }).click();
  // exact: true — `getByLabel('Master passphrase')` otherwise also matches the
  // section labelled "Choose your master passphrase" (aria-labelledby region).
  await page.getByLabel('Master passphrase', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Confirm passphrase', { exact: true }).fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Real WASM + Web Worker Argon2id derive the key material here, then the client
  // uploads the wrapped forms to the real API (provision). The recovery code
  // appearing proves the whole chain ran in the browser runtime.
  await expect(page.getByLabel('recovery code', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'I have saved it' }).click();

  await expect(page.getByTestId('lock-status')).toHaveText('unlocked');
  await expect(page.getByRole('heading', { name: 'You are all set' })).toBeVisible();
});
