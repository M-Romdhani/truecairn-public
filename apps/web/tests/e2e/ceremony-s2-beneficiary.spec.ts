import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The designated beneficiary (backlog #2), end-to-end in real browsers. Four
// actors: an owner splits the S2 tier key across two holder contacts AND names a
// THIRD contact — who holds no share and never affirms — as the beneficiary
// (a step-up + 7-day, fast-forwarded). The owner goes silent; the two holders
// affirm (consensus) and re-seal their shares to the beneficiary's ceremony
// ephemeral key; the non-affirming beneficiary reconstructs the owner's real S2
// item. Consensus stays with the holders — the beneficiary is purely a recipient.
//
// STATUS: runs in CI (the e2e job). Not runnable in the review sandbox.
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
  role: 'personal' | 'professional' | 'recovery',
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

async function affirmAndProvide(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Ceremony' }).click();
  await expect(page.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
  await page.getByRole('button', { name: 'Affirm release' }).click();
  await page.getByTestId('affirm-confirm-btn').click();
  await expect(page.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Provide your share' }).click();
  await expect(page.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });
}

test('designated beneficiary: owner names a non-affirming heir → holders affirm → the heir reconstructs', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const ownerCtx = await browser.newContext();
  const c1Ctx = await browser.newContext();
  const c2Ctx = await browser.newContext();
  const benCtx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-ben-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    // Two holders + a beneficiary = three contacts, above the free plan's cap
    // of two (docs/28), so this owner is a Personal subscriber — entitlement
    // is derived from a live billing_subscriptions row. Same DB-precondition
    // lane as the timer fast-forwards below; the cap itself is proven by
    // plan-limits.test.ts.
    await sql`INSERT INTO billing_subscriptions (user_id, ls_subscription_id, status) SELECT id, ${`e2e-${ownerEmail}`}, 'active' FROM users WHERE email_lower = ${ownerEmail.toLowerCase()}`;
    const c1 = await onboard(c1Ctx, `holder1-${Date.now()}@example.com`);
    const c2 = await onboard(c2Ctx, `holder2-${Date.now()}@example.com`);
    const ben = await onboard(benCtx, `heir-${Date.now()}@example.com`);

    await inviteAndEnroll(owner, c1, 'personal', 'My sister');
    await inviteAndEnroll(owner, c2, 'professional', 'Our lawyer');
    await inviteAndEnroll(owner, ben, 'recovery', 'The heir');

    const SECRET = `inheritance-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Tier', { exact: true }).selectOption('s2');
    await owner.getByLabel('Title', { exact: true }).fill('Estate notes');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Estate notes' })).toBeVisible({ timeout: 30_000 });

    // The S2 split across the two holders.
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

    // Designate the third contact as the S2 beneficiary (step-up + 7-day). The
    // beneficiary card's Tier defaults to S2.
    await owner.getByLabel('Beneficiary', { exact: true }).selectOption({ label: 'The heir (recovery)' });
    await owner.getByRole('button', { name: 'Designate beneficiary' }).click();
    await expect(owner.getByTestId('beneficiary-pending')).toBeVisible({ timeout: 60_000 });

    // Fast-forward BOTH cooldowns; the worker applies the contact shares + the
    // beneficiary designation.
    await sql`UPDATE sensitive_actions SET effective_at = now() - interval '1 minute' WHERE status = 'pending' AND action_type IN ('add_contact', 'designate_beneficiary')`;
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM release_shares WHERE user_id = ${ou!.id} AND tier = 's2' AND share_type = 'contact'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(2);
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM release_beneficiaries WHERE user_id = ${ou!.id} AND tier = 's2' AND revoked_at IS NULL`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(1);

    // Owner silent → the worker opens the S2 ceremony, enrolling the beneficiary
    // as a recipient (no affirmation row).
    await sql`INSERT INTO engine_states (user_id, state, s1_to_s2_timer_days, s2_to_s3_timer_days) VALUES (${ou!.id}, 'release_review', 0, 0)`;

    // The beneficiary receives on THIS device before anyone seals.
    await ben.getByRole('link', { name: 'Ceremony' }).click();
    await expect(ben.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await ben.getByRole('button', { name: 'Receive on this device' }).click();
    await expect(ben.getByTestId('receiving')).toBeVisible({ timeout: 30_000 });
    // The beneficiary never sees an Affirm control — they are not a consensus party.
    await expect(ben.getByRole('button', { name: 'Affirm release' })).toHaveCount(0);

    // The two holders affirm and seal their shares to the beneficiary's device.
    await affirmAndProvide(c1);
    await affirmAndProvide(c2);

    // Consensus opens the gate; the NON-affirming beneficiary reconstructs.
    await expect(ben.getByRole('button', { name: 'Reconstruct', exact: true })).toBeVisible({ timeout: 120_000 });
    await ben.getByRole('button', { name: 'Reconstruct', exact: true }).click();
    await expect(ben.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });

    const [cer] = await sql<{ id: string }[]>`SELECT id FROM release_ceremonies WHERE user_id = ${ou!.id} AND tier = 's2' LIMIT 1`;
    await expect
      .poll(
        async () => (await sql<{ status: string }[]>`SELECT status FROM release_ceremonies WHERE id = ${cer!.id}`)[0]!.status,
        { timeout: 30_000 },
      )
      .toBe('released');
  } finally {
    await sql.end({ timeout: 5 });
    await ownerCtx.close();
    await c1Ctx.close();
    await c2Ctx.close();
    await benCtx.close();
  }
});
