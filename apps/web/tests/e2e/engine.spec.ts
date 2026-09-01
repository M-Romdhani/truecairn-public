import { createClient } from '@truecairn/db';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Cancel-release in a REAL browser (PHASE4 C5B) — the C5B analogue of C5A's proof:
// the most user-protective action, reachable for real on the passkey step-up
// primitive. The engine can't be driven into a release by waiting (the worker is
// the sole release driver and the E2E webServer doesn't boot it), so we arrange the
// precondition the SAME way the server's own engine tests do — a direct insert into
// engine_states (engine.test.ts:54). That ships no production code, adds no HTTP
// affordance, and leaves the worker as production's only real-release driver; we
// then exercise the REAL cancel-release endpoint + REAL passkey fresh-factor tap.
//
// STATUS: runs in CI (the e2e job, which sets DATABASE_URL). Not runnable in the
// review sandbox — chromium can't be installed there.
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

test('cancel-release: DB-set a release state → real passkey tap → engine back to active', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const email = `engine-${Date.now()}@example.com`;
    const page = await registerOnboardUnlock(context, email);

    // ── Test-only precondition: put the engine in a release state ─────────────
    // Mirrors engine.test.ts:54 (db.insert(engineStates)). No production code path.
    const dbUrl = process.env['DATABASE_URL'];
    expect(dbUrl, 'DATABASE_URL must be set for the engine E2E').toBeTruthy();
    const { sql } = createClient({ url: dbUrl! });
    try {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE email_lower = ${email.toLowerCase()} LIMIT 1`;
      expect(rows.length).toBe(1);
      await sql`INSERT INTO engine_states (user_id, state) VALUES (${rows[0]!.id}, 'limited_release')`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    // PROPERTY 1 — the gate is real. A direct cancel-release, with no fresh second
    // factor, is refused 403 second-factor-required. So it's the tap that unlocks it.
    const blocked = await page.request.post('/v1/engine/cancel-release');
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).type).toBe('https://truecairn.app/problems/second-factor-required');

    // ── Drive the REAL cancel-release through the UI ──────────────────────────
    await page.getByRole('link', { name: 'Engine' }).click();
    // The pill renders the owner-facing name, not the enum (the enum is still
    // what the DB holds and what the assertions above check).
    await expect(page.getByTestId('engine-state')).toHaveText('Limited release');
    await expect(page.getByTestId('release-warning')).toBeVisible();
    // Click Cancel → cancelRelease sees 403 → proveStepUpWithPasskey (the virtual
    // authenticator performs the UV assertion → last_stepup_at stamped) → retry → 200.
    await page.getByRole('button', { name: 'Cancel release' }).click();

    // PROPERTY 2 — the protective action TOOK EFFECT: the engine is active again.
    // Asserted against server truth (GET status), not just a 200.
    await expect
      .poll(
        async () => {
          const s = await page.request.get('/v1/engine/status');
          return (await s.json()).state as string;
        },
        { timeout: 30_000 },
      )
      .toBe('active');
  } finally {
    await context.close();
  }
});
