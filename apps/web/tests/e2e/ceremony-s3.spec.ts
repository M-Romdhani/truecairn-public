import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The S3 nested Shamir release (docs/24): four actors. The owner splits the S3
// tier key across THREE contacts (personal + professional + recovery) as a 2-of-3
// over the key MASKED by the offline release passphrase — so any 2 contacts PLUS
// the passphrase reconstruct, and colluding contacts alone never can. The owner
// goes silent, all three affirm and seal their shares to the recipient, and the
// recipient supplies the owner's release passphrase together with the shares to
// decrypt the owner's real S3 item. Same compression + DB-precondition pattern as
// the S2 spec.
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
  // The screen clears the previous token on submit, so the testid reappearing
  // means THIS invitation's one-time token is shown (not a stale one).
  await expect(owner.getByTestId('invite-token')).toBeVisible({ timeout: 30_000 });
  const token = (await owner.getByTestId('invite-token').locator('code').textContent())?.trim();
  expect(token).toBeTruthy();
  await contact.getByRole('link', { name: 'Accept invite' }).click();
  await contact.getByLabel('Invite token').fill(token!);
  await contact.getByRole('button', { name: 'Accept and enrol' }).click();
  await expect(contact.getByTestId('enroll-done')).toBeVisible({ timeout: 30_000 });
}

async function affirmAndProvide(contact: Page): Promise<void> {
  await contact.getByRole('link', { name: 'Ceremony' }).click();
  await expect(contact.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', {
    timeout: 40_000,
  });
  await contact.getByRole('button', { name: 'Affirm release' }).click();
  await contact.getByTestId('affirm-confirm-btn').click();
  await expect(contact.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
  await contact.getByRole('button', { name: 'Provide your share' }).click();
  await expect(contact.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });
}

test('S3 ceremony: 3-of-4 across three roles → recipient reconstructs the real item', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const ownerCtx = await browser.newContext();
  const c1Ctx = await browser.newContext();
  const c2Ctx = await browser.newContext();
  const c3Ctx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-s3-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    // Three contacts is above the free plan's cap of two (docs/28), so this
    // owner is a Personal subscriber — entitlement is derived from a live
    // billing_subscriptions row. Same DB-precondition lane as the timer
    // fast-forwards below; the cap itself is proven by plan-limits.test.ts.
    await sql`INSERT INTO billing_subscriptions (user_id, ls_subscription_id, status) SELECT id, ${`e2e-${ownerEmail}`}, 'active' FROM users WHERE email_lower = ${ownerEmail.toLowerCase()}`;
    const c1 = await onboard(c1Ctx, `sister-s3-${Date.now()}@example.com`);
    const c2 = await onboard(c2Ctx, `lawyer-s3-${Date.now()}@example.com`);
    const c3 = await onboard(c3Ctx, `steward-s3-${Date.now()}@example.com`);

    await inviteAndEnroll(owner, c1, 'personal', 'My sister');
    await inviteAndEnroll(owner, c2, 'professional', 'Our lawyer');
    await inviteAndEnroll(owner, c3, 'recovery', 'The steward');

    // A known S3 item — the deepest tier.
    const SECRET = `letters-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Tier', { exact: true }).selectOption('s3');
    await owner.getByLabel('Title', { exact: true }).fill('Letters');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Letters' })).toBeVisible({ timeout: 30_000 });

    // The S3 nested split: three contact shares (a 2-of-3 over the masked key);
    // the release passphrase is the mandatory mask, not a distributed share. Three
    // step-up enqueues.
    const [ou] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email_lower = ${ownerEmail.toLowerCase()} LIMIT 1`;
    await owner.getByRole('link', { name: 'Contacts' }).click();
    // The share tier is a segmented control in the card header now, not a
    // <select> in its body. (The Vault item's Tier above is still a select.)
    await owner.getByRole('button', { name: 'S3', exact: true }).click();
    // Confirm each contact's security code first — since 2026-08-09 the share
    // affordances do not exist until the owner has done that (docs/15 Path E).
    await confirmAllContactKeys(owner);
    await expect(owner.getByRole('checkbox', { name: 'My sister (personal)' })).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('checkbox', { name: 'My sister (personal)' }).check();
    await owner.getByRole('checkbox', { name: 'Our lawyer (professional)' }).check();
    await owner.getByRole('checkbox', { name: 'The steward (recovery)' }).check();
    await owner.getByLabel('Release passphrase', { exact: true }).fill(RELEASE_PASSPHRASE);
    await owner.getByLabel('Confirm release passphrase', { exact: true }).fill(RELEASE_PASSPHRASE);
    await owner.getByRole('button', { name: 'Assign S3 shares' }).click();
    await expect(owner.getByTestId('tier-pending')).toBeVisible({ timeout: 90_000 });

    await sql`UPDATE sensitive_actions SET effective_at = now() - interval '1 minute' WHERE action_type = 'add_contact' AND status = 'pending'`;
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM release_shares WHERE user_id = ${ou!.id} AND tier = 's3' AND share_type = 'contact'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(3);

    // Owner silent; zeroed stage timers let the engine climb to full_release
    // (the S3 outer-key gate) on worker ticks after consensus.
    await sql`INSERT INTO engine_states (user_id, state, s1_to_s2_timer_days, s2_to_s3_timer_days) VALUES (${ou!.id}, 'release_review', 0, 0)`;

    // Recipient registers first so every contribution covers this device.
    await c1.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c1.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await c1.getByRole('button', { name: 'Receive on this device' }).click();
    await expect(c1.getByTestId('receiving')).toBeVisible({ timeout: 30_000 });

    // Gate closed pre-consensus.
    const [cer] = await sql<{ id: string }[]>`SELECT id FROM release_ceremonies WHERE user_id = ${ou!.id} AND tier = 's3' LIMIT 1`;
    expect((await c1.request.get(`/v1/ceremonies/${cer!.id}/shares`)).status()).toBe(403);

    // All three affirm + seal to the recipient.
    await c1.getByRole('button', { name: 'Affirm release' }).click();
    await c1.getByTestId('affirm-confirm-btn').click();
    await expect(c1.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
    await c1.getByRole('button', { name: 'Provide your share' }).click();
    await expect(c1.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });
    await affirmAndProvide(c2);
    await affirmAndProvide(c3);

    // Worker: 3 commits → diverse consensus (any 2 of 3) → ladder to full_release
    // → outer key → reconstructing. S3 is nested: the recipient MUST supply the
    // owner's offline release passphrase together with the contacts' shares; there
    // is no contacts-only reconstruct button for S3.
    await expect(c1.getByTestId('s3-release-pass')).toBeVisible({ timeout: 150_000 });
    await c1.getByTestId('s3-release-pass').fill(RELEASE_PASSPHRASE);
    await c1.getByTestId('s3-reconstruct').click();
    await expect(c1.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });

    const [eng] = await sql<{ state: string }[]>`SELECT state FROM engine_states WHERE user_id = ${ou!.id} LIMIT 1`;
    expect(eng!.state).toBe('full_release');
    // The recovered content renders before the device's reconstructed REPORT
    // lands server-side — poll the terminal status rather than racing it.
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
    await c3Ctx.close();
  }
});
