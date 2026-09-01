import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// QA 2026-07-21 D9 (the C2 regression, retest): after the FIRST recipient
// reconstructs and the ceremony flips to `released`, the SECOND recipient must
// still complete their own independent retrieval. The bug was that the second
// recipient's Reconstruct control vanished once the ceremony was globally
// `released`. This spec proves both recipients retrieve the real item, with the
// second one acting AFTER the ceremony is already `released`.
//
// Both contacts register their OWN ceremony ephemeral ("Receive on this device")
// and both provide their shares, so each recipient holds a full 2-of-3 subset
// sealed to their own device key — the model where "the first recovery can't
// lock out the rest". The real worker drives every stage; DB writes arrange only
// the approved preconditions (add_contact fast-forward, zeroed stage timers).
test.use({ storageState: { cookies: [], origins: [] } });

const PASSPHRASE = 'correct horse battery staple';
const RELEASE_PASSPHRASE = 'offline release passphrase';

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

async function inviteAndEnroll(
  owner: Page,
  contact: Page,
  role: 'personal' | 'professional',
  label: string,
): Promise<void> {
  await owner.getByRole('link', { name: 'Contacts' }).click();
  // The form takes a recipient TYPE now and derives the role from it (docs/03).
  // These specs care about the ROLE — diversity is what they exercise — so map to
  // the representative type for each, matching migration 0066's backfill.
  await owner
    .getByLabel('Kind of recipient')
    .selectOption(
      role === 'personal'
        ? 'spouse_family_executor'
        : role === 'professional'
          ? 'cofounder_business_partner'
          : 'recovery_contact',
    );
  await owner.getByLabel('Label', { exact: true }).fill(label);
  await owner.getByRole('button', { name: 'Create invitation' }).click();
  await expect(owner.getByTestId('invite-token')).toBeVisible({ timeout: 30_000 });
  const token = (await owner.getByTestId('invite-token').locator('code').textContent())?.trim();
  expect(token).toBeTruthy();
  await contact.getByRole('link', { name: 'Accept invite' }).click();
  await contact.getByLabel('Invite token').fill(token!);
  await contact.getByRole('button', { name: 'Accept and enrol' }).click();
  await expect(contact.getByTestId('enroll-done')).toBeVisible({ timeout: 30_000 });
}

// Register this device's ceremony ephemeral ("Receive on this device"). BOTH
// recipients must do this BEFORE either contributes: a share is sealed only to
// the recipients registered at provide-time, so out-of-order preparation would
// leave the second recipient missing the first's share.
async function receiveOnDevice(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Ceremony' }).click();
  await expect(page.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', {
    timeout: 40_000,
  });
  await page.getByRole('button', { name: 'Receive on this device' }).click();
  await expect(page.getByTestId('receiving')).toBeVisible({ timeout: 30_000 });
}

// Affirm and contribute the share — seals this contact's share to EVERY
// registered recipient (so, run after both have registered, to both of them).
async function affirmAndProvide(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Affirm release' }).click();
  await page.getByTestId('affirm-confirm-btn').click();
  await expect(page.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Provide your share' }).click();
  await expect(page.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });
}

test('S2 D9: after the first recipient reconstructs (released), the second recipient still retrieves', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ownerCtx = await browser.newContext();
  const c1Ctx = await browser.newContext();
  const c2Ctx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-d9-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    const c1 = await onboard(c1Ctx, `sister-d9-${Date.now()}@example.com`);
    const c2 = await onboard(c2Ctx, `lawyer-d9-${Date.now()}@example.com`);

    await inviteAndEnroll(owner, c1, 'personal', 'My sister');
    await inviteAndEnroll(owner, c2, 'professional', 'Our lawyer');

    const SECRET = `estate-notes-d9-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Tier', { exact: true }).selectOption('s2');
    await owner.getByLabel('Title', { exact: true }).fill('Estate notes');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Estate notes' })).toBeVisible({ timeout: 30_000 });

    const [ou] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email_lower = ${ownerEmail.toLowerCase()} LIMIT 1`;
    await owner.getByRole('link', { name: 'Contacts' }).click();
    // Confirm each contact's security code first — since 2026-08-09 the share
    // affordances do not exist until the owner has done that (docs/15 Path E).
    await confirmAllContactKeys(owner);
    await expect(owner.getByRole('checkbox', { name: 'My sister (personal)' })).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('checkbox', { name: 'My sister (personal)' }).check();
    await owner.getByRole('checkbox', { name: 'Our lawyer (professional)' }).check();
    await owner.getByLabel('Release passphrase', { exact: true }).fill(RELEASE_PASSPHRASE);
    await owner.getByLabel('Confirm release passphrase', { exact: true }).fill(RELEASE_PASSPHRASE);
    await owner.getByRole('button', { name: 'Assign S2 shares' }).click();
    await expect(owner.getByTestId('tier-pending')).toBeVisible({ timeout: 60_000 });

    await sql`UPDATE sensitive_actions SET effective_at = now() - interval '1 minute' WHERE action_type = 'add_contact' AND status = 'pending'`;
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM release_shares WHERE user_id = ${ou!.id} AND tier = 's2' AND share_type = 'contact'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(2);

    await sql`INSERT INTO engine_states (user_id, state, s1_to_s2_timer_days, s2_to_s3_timer_days) VALUES (${ou!.id}, 'release_review', 0, 0)`;

    // BOTH recipients register FIRST, then both contribute — so each contact's
    // share is sealed to both recipients and each holds a full subset sealed to
    // their own device key.
    await receiveOnDevice(c1);
    await receiveOnDevice(c2);
    await affirmAndProvide(c1);
    await affirmAndProvide(c2);

    const [cer] = await sql<{ id: string }[]>`SELECT id FROM release_ceremonies WHERE user_id = ${ou!.id} AND tier = 's2' LIMIT 1`;

    // First recipient reconstructs → ceremony flips to `released`.
    await expect(c1.getByRole('button', { name: 'Reconstruct' })).toBeVisible({ timeout: 120_000 });
    await c1.getByRole('button', { name: 'Reconstruct' }).click();
    await expect(c1.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });
    await expect
      .poll(
        async () => (await sql<{ status: string }[]>`SELECT status FROM release_ceremonies WHERE id = ${cer!.id}`)[0]!.status,
        { timeout: 30_000 },
      )
      .toBe('released');

    // THE D9 REGRESSION: the ceremony is now globally `released`, yet the second
    // recipient must STILL see a working Reconstruct control and pull their own
    // independent copy of the real item.
    await c2.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c2.getByRole('button', { name: 'Reconstruct' })).toBeVisible({ timeout: 60_000 });
    await c2.getByRole('button', { name: 'Reconstruct' }).click();
    await expect(c2.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });

    // Both recipients' rows are now `released` — each retrieved independently.
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ceremony_recipients WHERE ceremony_id = ${cer!.id} AND status = 'released'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(2);
  } finally {
    await sql.end({ timeout: 5 });
    await ownerCtx.close();
    await c1Ctx.close();
    await c2Ctx.close();
  }
});
