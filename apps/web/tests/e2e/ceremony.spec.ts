import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The S1 release ceremony, end-to-end, in real browsers (CEREMONY_COMPLETION A) —
// the proof the product does the thing it exists to do. An owner goes silent, a
// trusted contact affirms, and the owner's secret reaches that contact; a returning
// owner could have stopped it at every step before this point.
//
// The REAL worker (booted in global-setup) drives the multi-stage progression. The
// test only arranges two preconditions via the DB — the same approved pattern as
// the C5B engine-advance: fast-forward the add_contact cooldown (so the share
// applies) and set the engine to release_review (so a ceremony opens). Everything
// else is the real path + real crypto.
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

test('S1 ceremony: owner silent → contact affirms → reconstructs the real item', async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerCtx = await browser.newContext();
  const contactCtx = await browser.newContext();
  const { sql } = createClient({ url: process.env['DATABASE_URL']! });
  try {
    const ownerEmail = `owner-${Date.now()}@example.com`;
    const contactEmail = `contact-${Date.now()}@example.com`;
    const owner = await onboard(ownerCtx, ownerEmail);
    const contact = await onboard(contactCtx, contactEmail);

    // ── C4: invite → accept → enrol (contact's affirmation keys registered) ───
    await owner.getByRole('link', { name: 'Contacts' }).click();
    await owner.getByLabel('Label', { exact: true }).fill('My sister');
    await owner.getByRole('button', { name: 'Create invitation' }).click();
    const token = (await owner.getByTestId('invite-token').locator('code').textContent())?.trim();
    expect(token).toBeTruthy();
    await contact.getByRole('link', { name: 'Accept invite' }).click();
    await contact.getByLabel('Invite token').fill(token!);
    await contact.getByRole('button', { name: 'Accept and enrol' }).click();
    await expect(contact.getByTestId('enroll-done')).toBeVisible({ timeout: 30_000 });

    // ── C3: owner stores a known S1 item ─────────────────────────────────────
    const SECRET = `last-words-${Date.now()}`;
    await owner.getByRole('link', { name: 'Vault' }).click();
    await owner.getByLabel('Title', { exact: true }).fill('Last words');
    await owner.getByLabel('Content', { exact: true }).fill(SECRET);
    await owner.getByRole('button', { name: 'Save item' }).click();
    await expect(owner.getByRole('button', { name: 'Last words' })).toBeVisible({ timeout: 30_000 });

    // ── C4+C5A: owner assigns the S1 share (sealed to the contact) via passkey ─
    await owner.getByRole('link', { name: 'Contacts' }).click();
    // Confirm each contact's security code first — since 2026-08-09 the share
    // affordances do not exist until the owner has done that (docs/15 Path E).
    await confirmAllContactKeys(owner);
    await expect(owner.getByRole('button', { name: 'Assign S1 share' })).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('button', { name: 'Assign S1 share' }).click();
    // Wait for the assignment to be ACCEPTED (passkey step-up → 202 → pending
    // banner) so the add_contact action EXISTS before we fast-forward its cooldown
    // (otherwise the UPDATE races ahead of the insert and matches nothing).
    await expect(owner.getByText(/cancellable for 7 days/i)).toBeVisible({ timeout: 30_000 });
    // The add_contact action is pending a 7-day cooldown — fast-forward it so the
    // worker applies it and the real s1 envelope (sealed to the contact) is stored.
    await sql`UPDATE sensitive_actions SET effective_at = now() - interval '1 minute' WHERE action_type = 'add_contact' AND status = 'pending'`;
    await expect
      .poll(async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM s1_tier_key_envelopes`)[0]!.n, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // ── Owner goes silent → engine reaches release_review (precondition) ──────
    const [ou] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email_lower = ${ownerEmail.toLowerCase()} LIMIT 1`;
    await sql`INSERT INTO engine_states (user_id, state) VALUES (${ou!.id}, 'release_review')`;

    // The worker opens the ceremony + enrols the contact. Contact sees it.
    await contact.getByRole('link', { name: 'Ceremony' }).click();
    await expect(contact.getByTestId('ceremony-status')).toHaveText('collecting_affirmations', { timeout: 40_000 });

    // PROPERTY: temporal gate CLOSED before reconstructing — the envelope refuses.
    const [cer] = await sql<{ id: string }[]>`SELECT id FROM release_ceremonies WHERE user_id = ${ou!.id} LIMIT 1`;
    const blocked = await contact.request.get(`/v1/ceremonies/${cer!.id}/s1-envelope`);
    expect(blocked.status()).toBe(403);

    // Contact affirms (Ed25519 possession proof); the worker drives consensus →
    // engine limited_release → outer_key_released → reconstructing.
    await contact.getByRole('button', { name: 'Affirm release' }).click();
    await contact.getByTestId('affirm-confirm-btn').click();
    await expect(contact.getByRole('button', { name: 'Reconstruct' })).toBeVisible({ timeout: 90_000 });
    await contact.getByRole('button', { name: 'Reconstruct' }).click();

    // PROPERTY: the contact recovered the REAL S1 tier key and decrypted the known
    // item across the release boundary. The server only ever held ciphertext.
    await expect(contact.getByTestId('released-content')).toHaveText(SECRET, { timeout: 30_000 });

    // And the engine actually advanced on consensus (not still in review).
    const [eng] = await sql<{ state: string }[]>`SELECT state FROM engine_states WHERE user_id = ${ou!.id} LIMIT 1`;
    expect(['limited_release', 'staged_release', 'full_release']).toContain(eng!.state);
  } finally {
    await sql.end({ timeout: 5 });
    await ownerCtx.close();
    await contactCtx.close();
  }
});
