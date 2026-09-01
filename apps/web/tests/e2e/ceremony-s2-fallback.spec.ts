import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The release-passphrase FALLBACK (the +1 factor), end-to-end in real browsers
// (backlog #1). Same three-actor S2 setup as ceremony-s2.spec, but one contact
// goes silent AFTER affirming: both contacts affirm (so diverse 2-of-3 consensus
// opens the gate), yet only the recipient seals a share. With a single contact
// share in hand the recipient is below threshold — so they supply the owner's
// OFFLINE release passphrase, the client re-derives the reserved release share
// (passphrase + the server-served KDF salt), and the 2-of-3 subset reconstructs
// the owner's real S2 item. Consensus is untouched: the passphrase is purely a
// crypto fallback, never a consensus party.
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

test('S2 fallback: one contact affirms but never seals → recipient reconstructs with the release passphrase', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ownerCtx = await browser.newContext();
  const c1Ctx = await browser.newContext();
  const c2Ctx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-fb-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    const c1 = await onboard(c1Ctx, `sister-fb-${Date.now()}@example.com`);
    const c2 = await onboard(c2Ctx, `lawyer-fb-${Date.now()}@example.com`);

    await inviteAndEnroll(owner, c1, 'personal', 'My sister');
    await inviteAndEnroll(owner, c2, 'professional', 'Our lawyer');

    const SECRET = `fallback-secret-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Tier', { exact: true }).selectOption('s2');
    await owner.getByLabel('Title', { exact: true }).fill('Estate notes');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Estate notes' })).toBeVisible({ timeout: 30_000 });

    // The S2 split: release-passphrase capture + two sealed contact assignments.
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

    // The recipient registers this device's ephemeral key, then affirms AND seals.
    await c1.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c1.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await c1.getByRole('button', { name: 'Receive on this device' }).click();
    await expect(c1.getByTestId('receiving')).toBeVisible({ timeout: 30_000 });
    await c1.getByRole('button', { name: 'Affirm release' }).click();
    await c1.getByTestId('affirm-confirm-btn').click();
    await expect(c1.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
    await c1.getByRole('button', { name: 'Provide your share' }).click();
    await expect(c1.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });

    // The second contact AFFIRMS (so consensus reaches the diverse 2-of-3) but
    // never provides a share — the "missing contact" the fallback exists for.
    await c2.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c2.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await c2.getByRole('button', { name: 'Affirm release' }).click();
    await c2.getByTestId('affirm-confirm-btn').click();
    await expect(c2.getByTestId('affirmed')).toBeVisible({ timeout: 30_000 });

    // Consensus opens the gate; the recipient sees the Reconstruct control.
    await expect(c1.getByRole('button', { name: 'Reconstruct', exact: true })).toBeVisible({ timeout: 120_000 });

    // PROPERTY — a single contact share is BELOW threshold: the plain reconstruct
    // cannot succeed (one of the two 2-of-3 shares is missing).
    await c1.getByRole('button', { name: 'Reconstruct', exact: true }).click();
    await expect(c1.getByRole('alert')).toBeVisible({ timeout: 30_000 });
    await expect(c1.getByTestId('released-content')).toHaveCount(0);

    // The +1 fallback: supply the owner's offline release passphrase. The client
    // fetches the KDF salt, re-derives the reserved release share, and the 2-of-3
    // subset [contact, release] reconstructs the real item across the boundary.
    await c1.getByTestId('use-release-passphrase').click();
    await c1.getByLabel('Release passphrase', { exact: true }).fill(RELEASE_PASSPHRASE);
    await c1.getByRole('button', { name: 'Reconstruct with release passphrase' }).click();
    await expect(c1.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });

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
  }
});
