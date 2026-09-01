import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The S2 Shamir SAFETY properties in real browsers (CEREMONY_COMPLETION B):
// three rounds against one owner + two contacts, each ending with the gate
// still shut and nothing decryptable.
//
//   1. Same-role consensus rejection: two committed affirmations of ONE role
//      never advance the ceremony; the sync window fails it closed (engine →
//      review_required). The same-role condition is staged via the DB (the UI
//      itself refuses a single-role pick — the server is the enforcer proven
//      here).
//   2. Threshold-minus-one: a single committed affirmation (of two required)
//      never advances; window expiry fails closed again.
//   3. Abandon-on-cancel: a sealed share is already uploaded, the owner
//      cancels the release (real passkey fresh factor) — the ceremony dies,
//      the sealed share is released to NO ONE.
//
// Same compression + DB-precondition pattern as the happy-path specs; window
// expiry is forced by aging sync_window_expires_at (the cooldown fast-forward
// pattern applied to the ceremony's own clock).
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

// UN-QUARANTINED 2026-08-09, same change-set that fixed the race it caught.
//
// It was fixme'd earlier the same day because the round-3 assertion below ("the
// ceremony died with the release") was failing for the right reason: an
// in-flight worker tick could recreate a ceremony the owner had just cancelled,
// leaving an active engine owning a live collecting_affirmations ceremony.
// createReleaseReviewCeremonies now re-reads engine_states with SELECT … FOR
// UPDATE inside its insert transaction and bails when the release is over, so
// the cancel wins. packages/ceremony/src/bridges.integration.test.ts pins the
// same interleaving deterministically at the package level; this spec is the
// end-to-end half, and it stays on so the same-role and threshold-1 rounds
// keep running.
test('S2 safety: same-role rejected, threshold-1 fails closed, cancel abandons sealed shares', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const ownerCtx = await browser.newContext();
  const c1Ctx = await browser.newContext();
  const c2Ctx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-neg-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    const c1 = await onboard(c1Ctx, `sister-neg-${Date.now()}@example.com`);
    const c2 = await onboard(c2Ctx, `lawyer-neg-${Date.now()}@example.com`);
    await inviteAndEnroll(owner, c1, 'personal', 'Sister A');
    await inviteAndEnroll(owner, c2, 'professional', 'Lawyer B');

    // Assign the S2 split (diverse pick — the UI requires it; round 1 stages
    // the same-role world afterwards, where the SERVER must hold the line).
    const [ou] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email_lower = ${ownerEmail.toLowerCase()} LIMIT 1`;
    await owner.getByRole('link', { name: 'Contacts' }).click();
    // Confirm each contact's security code first — since 2026-08-09 the share
    // affordances do not exist until the owner has done that (docs/15 Path E).
    await confirmAllContactKeys(owner);
    await expect(owner.getByRole('checkbox', { name: 'Sister A (personal)' })).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('checkbox', { name: 'Sister A (personal)' }).check();
    await owner.getByRole('checkbox', { name: 'Lawyer B (professional)' }).check();
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

    async function ceremonyRow(): Promise<{ id: string; status: string }> {
      const rows = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM release_ceremonies WHERE user_id = ${ou!.id} AND tier = 's2'
        ORDER BY created_at DESC LIMIT 1`;
      expect(rows.length).toBe(1);
      return rows[0]!;
    }
    async function engineState(): Promise<string> {
      const [e] = await sql<{ state: string }[]>`SELECT state FROM engine_states WHERE user_id = ${ou!.id}`;
      return e!.state;
    }
    async function receiveAffirmProvide(page: Page): Promise<void> {
      await page.getByRole('link', { name: 'Ceremony' }).click();
      await expect(page.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
      // Register THIS device as a recipient BEFORE affirming/providing. Every
      // round is a fresh ceremony, so the button is always present; a hard
      // click() auto-waits for it to render — exactly what the happy-path specs
      // (ceremony-s2/s3/fallback/beneficiary) do. The old point-in-time
      // isVisible() check could miss the just-rendered button, skip registration,
      // and leave provideShares() sealing to ZERO recipients — the intermittent
      // "sealedCount stays 0" failure this spec hit.
      await page.getByRole('button', { name: 'Receive on this device' }).click();
      await expect(page.getByTestId('receiving')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Affirm release' }).click();
      await page.getByTestId('affirm-confirm-btn').click();
      await expect(page.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Provide your share' }).click();
      await expect(page.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });
    }

    // ══ ROUND 1 — same-role: threshold COUNT without role DIVERSITY ══════════
    // Stage the same-role world BEFORE the ceremony opens (consensus reads the
    // live contact roles at commit time).
    // recipient_type moves WITH the role: 0066's CHECK refuses a professional
    // type on a personal row, and the pair is not cosmetic — `role` is what
    // diverseRoleSatisfied reads. Same inference the change_contact_role handler
    // makes (REPRESENTATIVE_TYPE_FOR_ROLE), written out here because this is
    // deliberately a raw UPDATE that bypasses the handler.
    await sql`UPDATE contacts SET role = 'personal', recipient_type = 'spouse_family_executor' WHERE owner_user_id = ${ou!.id} AND role = 'professional'`;
    await sql`INSERT INTO engine_states (user_id, state) VALUES (${ou!.id}, 'release_review')`;

    await receiveAffirmProvide(c1);
    const round1 = await ceremonyRow();
    await c2.getByRole('link', { name: 'Ceremony' }).click();
    await expect(c2.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });
    await c2.getByRole('button', { name: 'Affirm release' }).click();
    await c2.getByTestId('affirm-confirm-btn').click();
    await expect(c2.getByRole('button', { name: 'Provide your share' })).toBeVisible({ timeout: 30_000 });
    await c2.getByRole('button', { name: 'Provide your share' }).click();
    await expect(c2.getByTestId('share-provided')).toBeVisible({ timeout: 30_000 });

    // Both affirmations COMMIT (compressed revocation window)…
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ceremony_affirmations WHERE ceremony_id = ${round1.id} AND status = 'committed'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(2);
    // …yet several worker ticks later the ceremony has NOT advanced (a single
    // role does not constitute consensus) and the engine sits in review.
    await c1.waitForTimeout(4_000);
    expect((await ceremonyRow()).status).toBe('collecting_affirmations');
    expect(await engineState()).toBe('release_review');

    // Force the sync window past → the ceremony fails CLOSED.
    await sql`UPDATE release_ceremonies SET sync_window_expires_at = now() - interval '1 second' WHERE id = ${round1.id}`;
    await expect.poll(async () => (await ceremonyRow()).status, { timeout: 30_000 }).toBe('failed');
    expect(await engineState()).toBe('review_required');
    expect((await c1.request.get(`/v1/ceremonies/${round1.id}/shares`)).status()).toBe(403);

    // ══ ROUND 2 — threshold-minus-one ═════════════════════════════════════════
    // recipient_type moves with the role — see the note on round 1's UPDATE.
    await sql`UPDATE contacts SET role = 'professional', recipient_type = 'cofounder_business_partner' WHERE owner_user_id = ${ou!.id} AND id IN (SELECT contact_id FROM release_shares WHERE user_id = ${ou!.id} AND share_index = 2 AND share_type = 'contact')`;
    await sql`UPDATE engine_states SET state = 'release_review' WHERE user_id = ${ou!.id}`;
    await expect
      .poll(async () => (await ceremonyRow()).id, { timeout: 40_000 })
      .not.toBe(round1.id); // the worker opened a fresh ceremony (round 1 is terminal)
    const round2 = await ceremonyRow();

    await receiveAffirmProvide(c1); // ONLY c1 — one of two required
    await expect
      .poll(
        async () =>
          (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ceremony_affirmations WHERE ceremony_id = ${round2.id} AND status = 'committed'`)[0]!.n,
        { timeout: 30_000 },
      )
      .toBe(1);
    await c1.waitForTimeout(4_000);
    expect((await ceremonyRow()).status).toBe('collecting_affirmations'); // 1 < 2: no advance
    expect(await engineState()).toBe('release_review');

    await sql`UPDATE release_ceremonies SET sync_window_expires_at = now() - interval '1 second' WHERE id = ${round2.id}`;
    await expect.poll(async () => (await ceremonyRow()).status, { timeout: 30_000 }).toBe('failed');
    expect(await engineState()).toBe('review_required');
    expect((await c1.request.get(`/v1/ceremonies/${round2.id}/shares`)).status()).toBe(403);

    // ══ ROUND 3 — abandon-on-cancel with a sealed share already uploaded ══════
    await sql`UPDATE engine_states SET state = 'release_review' WHERE user_id = ${ou!.id}`;
    await expect
      .poll(async () => (await ceremonyRow()).id, { timeout: 40_000 })
      .not.toBe(round2.id);
    const round3 = await ceremonyRow();
    await receiveAffirmProvide(c1);

    const sealedCount = async (): Promise<number> =>
      (
        await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ceremony_affirmation_shares s
          JOIN ceremony_affirmations a ON a.id = s.affirmation_id
          WHERE a.ceremony_id = ${round3.id}`
      )[0]!.n;
    // Poll rather than a single read: the seal is committed by the time "Provide
    // your share" flips (postSealedShare has resolved), but this cross-connection
    // DB read can still race that commit. It was the one count assertion in this
    // spec not already polling — the cause of the intermittent E2E failure. The
    // fail-closed safety checks below (the 403s + released = 0) are untouched.
    await expect.poll(sealedCount, { timeout: 30_000 }).toBeGreaterThan(0); // a share IS sealed server-side

    // The owner returns and cancels the release (real passkey fresh factor).
    await owner.getByRole('link', { name: 'Engine' }).click();
    await expect(owner.getByTestId('release-warning')).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('button', { name: 'Cancel release' }).click();
    await expect
      .poll(async () => (await (await owner.request.get('/v1/engine/status')).json()).state as string, {
        timeout: 30_000,
      })
      .toBe('active');

    // The ceremony died with the release; the sealed share reached NO ONE.
    await expect.poll(async () => (await ceremonyRow()).status, { timeout: 30_000 }).toBe('cancelled');
    expect(await sealedCount()).toBeGreaterThan(0); // still recorded…
    expect((await c1.request.get(`/v1/ceremonies/${round3.id}/shares`)).status()).toBe(403); // …never served
    const [rel] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ceremony_recipients WHERE ceremony_id IN (${round1.id}, ${round2.id}, ${round3.id}) AND status = 'released'`;
    expect(rel!.n).toBe(0);
  } finally {
    await sql.end({ timeout: 5 });
    await ownerCtx.close();
    await c1Ctx.close();
    await c2Ctx.close();
  }
});
