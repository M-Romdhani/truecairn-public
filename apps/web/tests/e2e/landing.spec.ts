import { expect, test } from '@playwright/test';

// The public landing in a real browser (PHASE4 C6). It loads anonymously (no
// crypto, no auth — the authed chunk is lazy), and its primary CTA crosses the lazy
// boundary into the app at /register (which proves the split actually loads the
// authed bundle on navigation, not before).
//
// STATUS: runs in CI (the e2e job). Not runnable in the review sandbox — chromium
// can't be installed there.
test.use({ storageState: { cookies: [], origins: [] } });

test('landing renders and the primary CTA enters the app at /register', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: /Digital continuity for your most important/i }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: /An engineered system/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /We engineer for the day/i })).toBeVisible();

  await page.getByRole('link', { name: 'Get started', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible({
    timeout: 30_000,
  });
});
