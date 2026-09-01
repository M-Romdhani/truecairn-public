import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// QA 2026-07-21 Finding A4: removing a VERIFIED channel reportedly 403s with no
// passkey ceremony ever shown. This spec drives the exact user path in a real
// browser (virtual authenticator): onboard → add email channel → (DB-verify, the
// code round-trip needs a live mail provider) → click Remove → expect the
// "Removal scheduled" note and the pending remove_channel action on /engine.
// The second-factor stamp is cleared first so the STALE path runs — the full
// R1 → options → assertion → second-factor → signed R2 handshake, which is the
// lane the QA report says never triggers.
//
// Navigation stays inside the SPA (Link clicks): a full page load would wipe the
// in-memory master key and lock the vault, and the step-up SIGNATURE needs that
// key. That is exactly why the flow uses in-app navigation, not page.goto.
test.use({ storageState: { cookies: [], origins: [] } });

const PASSPHRASE = 'correct horse battery staple';

async function onboard(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
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
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.getByRole('button', { name: 'Begin' }).click();
  await page.getByLabel('Master passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('recovery code', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.getByTestId('lock-status')).toHaveText('unlocked');
  return page;
}

// Reach /settings via in-app navigation so the master key survives (a full load
// would lock the vault). Vault → Settings both exist as Links in the shell.
async function gotoSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Vault' }).first().click();
  await expect(page).toHaveURL(/\/vault$/);
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page).toHaveURL(/\/settings$/);
}

test('A4: removing a VERIFIED channel runs the step-up ceremony and schedules the 7-day removal', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  const failures: string[] = [];
  try {
    const email = `owner-a4-${Date.now()}@example.com`;
    const page = await onboard(ctx, email);

    // Diagnostics: unexpected 4xx/5xx API responses, so a FAIL names the exact
    // step. Three responses are EXPECTED by design and filtered out: the step-up
    // R1 opener (403 → issues the challenge), the CV verification-status probe
    // (404 when CV_REPORT_ENABLED is off — the panel hides), and the capture
    // filing-queue probe (404 when VAULT_CAPTURE_ENABLED is off — same shape,
    // docs/34). Anything else is a real regression. (Console errors are just the
    // browser's mirror of these same fetch failures, so we don't double-count.)
    //
    // The capture probe is allowed ONCE per page, not per visit to the vault:
    // `listCaptures` remembers a flag-off server for the page's lifetime, so a
    // second occurrence here means that memo regressed and the app is retrying
    // work that cannot succeed.
    let captureProbes = 0;
    page.on('response', (res) => {
      if (!res.url().includes('/v1/') || res.status() < 400) return;
      const path = new URL(res.url()).pathname;
      const line = `${res.request().method()} ${path} → ${res.status()}`;
      if (path === '/v1/vault/captures' && res.status() === 404) {
        captureProbes += 1;
        if (captureProbes === 1) return;
      }
      const expected =
        line === 'POST /v1/settings/channels/remove → 403' ||
        (path === '/v1/engine/verification-status' && res.status() === 404);
      if (!expected) failures.push(line);
    });

    // Add an email channel from Settings.
    await gotoSettings(page);
    await page.getByTestId('channel-add-destination').fill(`a4-dest-${Date.now()}@example.com`);
    await page.getByTestId('channel-add').click();
    await expect(page.getByText('A verification code was sent — enter it below.')).toBeVisible({
      timeout: 30_000,
    });

    // Verify it directly in the DB — the code round-trip needs a mail provider
    // this environment doesn't have. This mirrors the repo's DB-precondition
    // idiom: state the product COULD reach, arranged without test-mode code.
    const [u] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email_lower = ${email.toLowerCase()} LIMIT 1`;
    await sql`
      UPDATE notification_channels
      SET verified = true, verified_at = now(),
          verification_code_hash = NULL, verification_expires_at = NULL
      WHERE user_id = ${u!.id}`;

    // Force the STALE second-factor path — the QA report's scenario, minutes or
    // more after sign-in — so proveStepUpWithPasskey must actually run.
    await sql`UPDATE sessions SET last_stepup_at = NULL WHERE user_id = ${u!.id}`;

    // Re-enter Settings via the SPA so the channels query refetches (the row now
    // reads "Verified") WITHOUT a reload that would lock the vault.
    await gotoSettings(page);
    await expect(page.getByText('Verified email channel')).toBeVisible({ timeout: 30_000 });

    // The lane under test: Remove on the VERIFIED channel.
    await page.getByRole('button', { name: 'Remove', exact: true }).click();

    // PASS: the scheduled-removal note appears and the channel row stays.
    await expect(
      page.getByText(/Removal scheduled — applies .*; cancel from the Engine page\./),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Verified email channel')).toBeVisible();

    // The pending action is cancellable from the Engine page (QA step A5).
    await page.getByRole('link', { name: 'Engine' }).first().click();
    await expect(page.getByText('Remove a notification channel')).toBeVisible({ timeout: 30_000 });

    expect(failures, `unexpected failures:\n${failures.join('\n')}`).toEqual([]);
  } finally {
    await sql.end();
    await ctx.close();
  }
});
