import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { confirmAllContactKeys } from './confirm-contact-keys.js';

// The two-actor contact ceremony in REAL browsers (PHASE4 C4). Two independent
// BrowserContexts, each with its OWN CDP virtual authenticator, model the two
// humans faithfully — an inviter and a contact who never share a session.
//
// What this proves end-to-end:
//   • PROPERTY #2 — enrolment possession proof: the contact's client drives the
//     REAL /v1/contacts/enroll/options + /verify to 200. The server (enroll.ts)
//     only flips the row to 'enrolled' if the Ed25519 signature AND the X25519
//     unseal both check, so a 200 here IS the server accepting the client's proof.
//   • The status gate: GET /v1/contacts withholds the contact's X25519 pubkey
//     while 'invited' (null) and releases it once 'enrolled' — so the owner can
//     only ever seal a share to a VERIFIED key.
//   • The step-up bootstrap (PHASE4 C5A): the inviter ACTUALLY assigns the S1
//     share. Pre-step-up the gate refuses a direct attempt (403); then the UI
//     click drives the interceptor's R1→403→passkey-assertion (the virtual
//     authenticator performs the UV tap → last_stepup_at stamped)→R2-signs→202,
//     and the pending banner shows. This is the proof a fresh passkey-only user
//     can complete a sensitive action end-to-end — the gap C4 surfaced, closed.
//
// STATUS: runs in CI (the e2e job). Not runnable in the review sandbox — chromium
// can't be installed there (cdn.playwright.dev is outside the network allowlist).
test.use({ storageState: { cookies: [], origins: [] } });

const PASSPHRASE = 'correct horse battery staple';

async function registerOnboardUnlock(context: BrowserContext, email: string): Promise<Page> {
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

test('two-actor enrolment: invite → accept → real possession-proof enrol → status-gated pubkey', async ({
  browser,
}) => {
  // Two onboarding ceremonies (each runs the real Argon2id provision) + enrolment
  // + the passkey step-up + the share assignment.
  test.setTimeout(150_000);

  const inviterCtx = await browser.newContext();
  const contactCtx = await browser.newContext();
  try {
    const inviter = await registerOnboardUnlock(inviterCtx, `inviter-${Date.now()}@example.com`);
    const contact = await registerOnboardUnlock(contactCtx, `contact-${Date.now()}@example.com`);

    // ── Inviter: create an invitation, read the one-time token ────────────────
    await inviter.getByRole('link', { name: 'Contacts' }).click();
    await inviter.getByLabel('Label', { exact: true }).fill('My sister');
    await inviter.getByRole('button', { name: 'Create invitation' }).click();
    const token = (await inviter.getByTestId('invite-token').locator('code').textContent())?.trim();
    expect(token).toBeTruthy();

    // Before enrolment the server WITHHOLDS the pubkey (status invited → null).
    const before = await inviter.request.get('/v1/contacts');
    const beforeRows = (await before.json()).contacts as Array<{ status: string; x25519Pubkey: string | null }>;
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]!.status).toBe('invited');
    expect(beforeRows[0]!.x25519Pubkey).toBeNull();

    // ── Contact: accept + enrol (drives the REAL enroll/options + /verify) ────
    await contact.getByRole('link', { name: 'Accept invite' }).click();
    await contact.getByLabel('Invite token').fill(token!);
    await contact.getByRole('button', { name: 'Accept and enrol' }).click();
    // 'enrolled' only renders if /v1/contacts/enroll/verify returned 200 — i.e.
    // the server accepted BOTH the Ed25519 signature and the X25519 unseal.
    await expect(contact.getByTestId('enroll-done')).toBeVisible({ timeout: 30_000 });

    // ── Inviter: the status gate now RELEASES the contact's X25519 pubkey ─────
    const after = await inviter.request.get('/v1/contacts');
    const afterRows = (await after.json()).contacts as Array<{
      contactId: string;
      status: string;
      x25519Pubkey: string | null;
    }>;
    expect(afterRows[0]!.status).toBe('enrolled');
    expect(afterRows[0]!.x25519Pubkey).not.toBeNull();
    const contactId = afterRows[0]!.contactId;

    // PROPERTY 1 — the gate is REAL. A direct share-assignment attempt, on a
    // session that has NOT proven a fresh second factor, is refused with 403
    // step-up-required. So it's the assertion that unlocks it, not an open door.
    const blocked = await inviter.request.post('/v1/contacts/shares', {
      data: { contactId, tier: 's1' },
    });
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).type).toBe('https://truecairn.app/problems/step-up-required');

    // PROPERTY 2 — drive the assignment THROUGH THE UI. Remount Contacts so it
    // refetches the now-enrolled contact, then click Assign. The interceptor's
    // R1→403→proveSecondFactor fires the passkey step-up (the virtual authenticator
    // performs the UV assertion → last_stepup_at stamped), then R2 signs and resends
    // → 202. The pending banner shows — the C4 honesty property, now reached for real.
    await inviter.getByRole('link', { name: 'Vault' }).click();
    await inviter.getByRole('link', { name: 'Contacts' }).click();
    // Confirm each contact's security code first — since 2026-08-09 the share
    // affordances do not exist until the owner has done that (docs/15 Path E).
    await confirmAllContactKeys(inviter);
    await expect(inviter.getByRole('button', { name: 'Assign S1 share' })).toBeVisible({
      timeout: 30_000,
    });
    await inviter.getByRole('button', { name: 'Assign S1 share' }).click();

    const pending = inviter.getByTestId(`pending-${contactId}`);
    await expect(pending).toBeVisible({ timeout: 30_000 });
    await expect(pending).toContainText('cancellable for 7 days');
  } finally {
    await inviterCtx.close();
    await contactCtx.close();
  }
});
