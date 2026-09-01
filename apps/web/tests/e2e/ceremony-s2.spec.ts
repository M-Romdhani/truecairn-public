import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The S2 Shamir release, end-to-end, in real browsers (CEREMONY_COMPLETION B) —
// three actors: an owner splits the S2 tier key across two contacts of distinct
// roles (capturing the release passphrase at this first higher-tier assignment,
// Q8 deferred), goes silent, both contacts affirm and re-seal their shares to
// the recipient contact's ceremony ephemeral key, and the recipient combines
// the 2-of-3 threshold subset to decrypt the owner's real S2 item.
//
// The REAL worker (global-setup) drives every stage. DB writes arrange only the
// approved preconditions: the add_contact cooldown fast-forward and the engine
// at release_review with zeroed stage timers (so limited→staged→full advance on
// worker ticks instead of weeks — config-driven compression, no test-mode code).
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

test('S2 ceremony: split across two roles → both seal shares → recipient reconstructs the real item', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ownerCtx = await browser.newContext();
  const c1Ctx = await browser.newContext();
  const c2Ctx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-s2-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    const c1 = await onboard(c1Ctx, `sister-s2-${Date.now()}@example.com`);
    const c2 = await onboard(c2Ctx, `lawyer-s2-${Date.now()}@example.com`);

    // ── C4: two contacts of DISTINCT roles (the diverse-role rule's shape) ────
    await inviteAndEnroll(owner, c1, 'personal', 'My sister');
    await inviteAndEnroll(owner, c2, 'professional', 'Our lawyer');

    // ── C3: a known S2 item ───────────────────────────────────────────────────
    const SECRET = `estate-notes-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Tier', { exact: true }).selectOption('s2');
    await owner.getByLabel('Title', { exact: true }).fill('Estate notes');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Estate notes' })).toBeVisible({ timeout: 30_000 });

    // ── B: the S2 split — release-passphrase capture + two sealed assignments ─
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
    // Both step-up enqueues accepted (passkey taps) → the pending banner.
    await expect(owner.getByTestId('tier-pending')).toBeVisible({ timeout: 60_000 });

    // The release-passphrase slot was recorded immediately (salt only).
    const [slot] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM release_shares WHERE user_id = ${ou!.id} AND tier = 's2' AND share_type = 'release_passphrase'`;
    expect(slot!.n).toBe(1);

    // Fast-forward the two add_contact cooldowns; the worker applies the REAL
    // contact-share rows (each sealed to its contact's X25519 key).
    await sql`UPDATE sensitive_actions SET effective_at = now() - interval '1 minute' WHERE action_type = 'add_contact' AND status = 'pending'`;
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM release_shares WHERE user_id = ${ou!.id} AND tier = 's2' AND share_type = 'contact'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(2);

    // ── Owner silent → release_review; stage timers zeroed so the ladder can
    // climb to staged_release (the S2 outer-key gate) on worker ticks. ─────────
    await sql`INSERT INTO engine_states (user_id, state, s1_to_s2_timer_days, s2_to_s3_timer_days) VALUES (${ou!.id}, 'release_review', 0, 0)`;

    // The worker opens the S2 ceremony; both contacts see it.
    await c1.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c1.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });

    // The recipient (an affirming contact — the B decision) registers this
    // device's ceremony ephemeral key BEFORE anyone seals.
    await c1.getByRole('button', { name: 'Receive on this device' }).click();
    await expect(c1.getByTestId('receiving')).toBeVisible({ timeout: 30_000 });

    // PROPERTY — the Shamir temporal gate is CLOSED while collecting.
    const [cer] = await sql<{ id: string }[]>`SELECT id FROM release_ceremonies WHERE user_id = ${ou!.id} AND tier = 's2' LIMIT 1`;
    const blocked = await c1.request.get(`/v1/ceremonies/${cer!.id}/shares`);
    expect(blocked.status()).toBe(403);

    // Both contacts affirm and contribute: unwrap own share → re-seal to the
    // registered recipient → upload with the Ed25519 binding signature.
    await c1.getByRole('button', { name: 'Affirm release' }).click();
    await c1.getByTestId('affirm-confirm-btn').click();
    await expect(c1.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
    await c1.getByRole('button', { name: 'Provide your share' }).click();
    await expect(c1.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });

    await c2.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c2.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await c2.getByRole('button', { name: 'Affirm release' }).click();
    await c2.getByTestId('affirm-confirm-btn').click();
    await expect(c2.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
    await c2.getByRole('button', { name: 'Provide your share' }).click();
    await expect(c2.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });

    // Worker: commits (compressed window) → diverse 2-of-3 consensus → engine
    // limited→staged (zeroed timers) → outer key released → reconstructing.
    await expect(c1.getByRole('button', { name: 'Reconstruct' })).toBeVisible({ timeout: 120_000 });
    await c1.getByRole('button', { name: 'Reconstruct' }).click();

    // PROPERTY — the recipient reconstructed the REAL S2 tier key from the
    // threshold subset and decrypted the known item across the release
    // boundary. The server only ever held sealed boxes + inner ciphertext.
    await expect(c1.getByTestId('released-content')).toHaveText(SECRET, { timeout: 60_000 });

    // The ceremony released; the engine had reached at least staged_release.
    const [eng] = await sql<{ state: string }[]>`SELECT state FROM engine_states WHERE user_id = ${ou!.id} LIMIT 1`;
    expect(['staged_release', 'full_release']).toContain(eng!.state);
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
  }
});
