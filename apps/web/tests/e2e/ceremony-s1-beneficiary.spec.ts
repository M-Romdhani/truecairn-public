import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The S1 designated beneficiary (backlog #4), end-to-end in real browsers. S1 has
// no Shamir shares — each holder holds a full sealed envelope of the S1 tier key.
// The owner assigns the S1 envelope to ONE holder and names a SECOND contact —
// who never affirms — as the S1 beneficiary (the owner seals THEM their own
// envelope at designation; a step-up + 7-day, fast-forwarded). The owner goes
// silent; the holder affirms (S1 consensus is a single contact); once the gate
// opens the non-affirming beneficiary opens their OWN envelope and reconstructs
// the owner's real S1 item. Consensus stays with the holder — the beneficiary is
// purely a recipient.
//
// STATUS: runs in CI (the e2e job). Not runnable in the review sandbox.
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

test('S1 beneficiary: owner names a non-affirming heir → holder affirms → the heir opens their own envelope', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const ownerCtx = await browser.newContext();
  const holderCtx = await browser.newContext();
  const benCtx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-s1ben-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    const holder = await onboard(holderCtx, `s1holder-${Date.now()}@example.com`);
    const ben = await onboard(benCtx, `s1heir-${Date.now()}@example.com`);

    await inviteAndEnroll(owner, holder, 'personal', 'My sister');
    await inviteAndEnroll(owner, ben, 'recovery', 'The heir');

    // A known S1 item — the soft tier (recovery instructions / continuity).
    const SECRET = `s1-letter-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Tier', { exact: true }).selectOption('s1');
    await owner.getByLabel('Title', { exact: true }).fill('Letter');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Letter' })).toBeVisible({ timeout: 30_000 });

    const [ou] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email_lower = ${ownerEmail.toLowerCase()} LIMIT 1`;

    // Assign the S1 envelope to the HOLDER (scope the per-row button to her row;
    // the heir's row also shows one but receives via the designation below).
    await owner.getByRole('link', { name: 'Contacts' }).click();
    // Confirm each contact's security code first — since 2026-08-09 the share
    // affordances do not exist until the owner has done that (docs/15 Path E).
    await confirmAllContactKeys(owner);
    await expect(owner.getByRole('button', { name: 'Assign S1 share' }).first()).toBeVisible({ timeout: 30_000 });
    await owner
      .getByRole('listitem')
      .filter({ hasText: 'My sister' })
      .getByRole('button', { name: 'Assign S1 share' })
      .click();

    // Designate the heir as the S1 beneficiary (Tier = S1). The owner seals the
    // heir their own envelope of the S1 tier key as part of this request.
    await owner.getByLabel('Beneficiary tier', { exact: true }).selectOption('s1');
    await owner.getByLabel('Beneficiary', { exact: true }).selectOption({ label: 'The heir (recovery)' });
    await owner.getByRole('button', { name: 'Designate beneficiary' }).click();
    await expect(owner.getByTestId('beneficiary-pending')).toBeVisible({ timeout: 60_000 });

    // Fast-forward both cooldowns; the worker applies the holder envelope AND the
    // beneficiary designation (which seals the heir their OWN envelope).
    await sql`UPDATE sensitive_actions SET effective_at = now() - interval '1 minute' WHERE status = 'pending' AND action_type IN ('add_contact', 'designate_beneficiary')`;
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM s1_tier_key_envelopes WHERE user_id = ${ou!.id} AND revoked_at IS NULL`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(2); // holder + beneficiary
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM release_beneficiaries WHERE user_id = ${ou!.id} AND tier = 's1' AND revoked_at IS NULL`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(1);

    // Owner silent → the worker opens the S1 ceremony: the holder as an affirmer,
    // the beneficiary as a recipient with NO affirmation row.
    await sql`INSERT INTO engine_states (user_id, state, s1_to_s2_timer_days, s2_to_s3_timer_days) VALUES (${ou!.id}, 'release_review', 0, 0)`;

    // The heir sees the ceremony but NEVER an Affirm control — not a consensus party.
    await ben.getByRole('link', { name: 'Ceremony' }).click();
    await expect(ben.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await expect(ben.getByRole('button', { name: 'Affirm release' })).toHaveCount(0);

    // The holder affirms — S1 consensus is a single contact.
    await holder.getByRole('link', { name: 'Ceremony' }).click();
    await expect(holder.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await holder.getByRole('button', { name: 'Affirm release' }).click();
    await holder.getByTestId('affirm-confirm-btn').click();
    await expect(holder.getByTestId('affirmed')).toBeVisible({ timeout: 30_000 });

    // The gate opens → the NON-affirming heir opens their own envelope + decrypts.
    await expect(ben.getByRole('button', { name: 'Reconstruct', exact: true })).toBeVisible({ timeout: 150_000 });
    await ben.getByRole('button', { name: 'Reconstruct', exact: true }).click();
    await expect(ben.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });

    const [cer] = await sql<{ id: string }[]>`SELECT id FROM release_ceremonies WHERE user_id = ${ou!.id} AND tier = 's1' LIMIT 1`;
    await expect
      .poll(
        async () => (await sql<{ status: string }[]>`SELECT status FROM release_ceremonies WHERE id = ${cer!.id}`)[0]!.status,
        { timeout: 30_000 },
      )
      .toBe('released');
  } finally {
    await sql.end({ timeout: 5 });
    await ownerCtx.close();
    await holderCtx.close();
    await benCtx.close();
  }
});
