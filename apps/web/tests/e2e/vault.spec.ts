import { expect, test } from '@playwright/test';

// The zero-knowledge vault round-trip in a REAL browser (PHASE4 C3) — the C3
// analogue of the enrollment E2E. It registers + onboards its OWN fresh user (so
// it doesn't share the global-setup session that enrollment.spec enrolls), then:
// unlock → create an item (client wraps) → confirm the SERVER stored only
// ciphertext → fetch → client unwraps → original plaintext recovered.
//
// STATUS: runs in CI (the e2e job). Not runnable in the review sandbox — chromium
// can't be installed there (cdn.playwright.dev outside the allowlist).
test.use({ storageState: { cookies: [], origins: [] } });

test('zero-knowledge vault round-trip: create → server stores ciphertext → fetch → unwrap', async ({
  page,
  context,
}) => {
  // Own virtual authenticator for this fresh user.
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  // Register → onboard (enroll + unlock). Leaves the vault unlocked in-browser.
  await page.goto('/register');
  await page.getByLabel('Email').fill(`vault-${Date.now()}@example.com`);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.getByRole('button', { name: 'Begin' }).click();
  await page.getByLabel('Master passphrase', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Confirm passphrase', { exact: true }).fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('recovery code', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.getByTestId('lock-status')).toHaveText('unlocked');

  // Create an item — the client wraps content + title before upload. Navigate
  // CLIENT-SIDE to the vault (a full page reload would drop the in-memory unlock).
  const SECRET = `vault-secret-${Date.now()}`;
  await page.getByRole('button', { name: 'Go to your vault' }).click();
  await page.getByLabel('Title', { exact: true }).fill('My Title');
  await page.getByLabel('Content', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: 'Save item' }).click();

  // The list shows the client-decrypted title; open the item → it round-trips.
  await page.getByRole('button', { name: 'My Title' }).click();
  await expect(page.getByLabel('item content')).toHaveText(SECRET);

  // The SERVER stored only ciphertext: fetch the raw API response (same session
  // cookie, via the /v1 proxy) and assert the plaintext is nowhere in it.
  const id = page.url().split('/vault/')[1];
  const raw = await page.request.get(`/v1/vault/items/${id}`);
  const body = await raw.text();
  expect(body).not.toContain(SECRET);
  expect(JSON.parse(body).contentCiphertext).toBeTruthy();
});
