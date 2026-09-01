import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

export const STORAGE_STATE = 'tests/e2e/.auth/state.json';

// Establishes a real logged-in session for the enrollment E2E (PHASE4 C2). A CDP
// VIRTUAL AUTHENTICATOR makes the passkey ceremony work headlessly, so this
// drives the real Register screen (register → login) and saves the resulting
// session cookie as storageState. The enrollment spec then starts already
// signed-in and runs the ceremony itself.
//
// Runs only where a browser is installed — NOT in the review sandbox
// (cdn.playwright.dev is outside the network allowlist).
export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir('tests/e2e/.auth', { recursive: true });

  // Boot the REAL worker for the ceremony E2E (CEREMONY_COMPLETION A). The capstone
  // is fundamentally the worker driving the multi-stage progression, so the strongest
  // proof runs the real worker against the real path; the test only arranges the
  // precondition + compresses time via env (CEREMONY_* / WORKER_POLL_INTERVAL_MS),
  // never via a branch in the engine/ceremony logic. The worker shares the API's
  // SERVER_AUDIT_SIGNING_KEY so both write ONE audit chain (the add_contact apply
  // links audit_id_terminal → audit_log.id, so a real signed entry is required).
  //
  // `detached: true` puts the worker in its OWN process group so teardown can
  // reap the whole tree. `pnpm … start` execs a child `node`, and signalling the
  // pnpm PID alone left that node process alive and polling the database after
  // the run ended. Four such orphans accumulated across runs and made a later
  // @truecairn/notifications run fail spuriously (QA 2026-08-09) — a suite that
  // sabotages whoever runs the next one, and the failures land nowhere near the
  // cause. The same thing bit this session: two api specs (ready, narration)
  // failed against a leftover worker and looked like real regressions.
  const worker = spawn('pnpm', ['--filter', '@truecairn/worker', 'start'], {
    env: process.env,
    stdio: 'inherit',
    detached: true,
  });
  const teardown = async (): Promise<void> => {
    // Negative PID = the whole process group. Guarded because the group may
    // already be gone (a crashed worker, or a second teardown), and an ESRCH
    // thrown here would fail an otherwise-green run.
    const { pid } = worker;
    if (pid === undefined) return;
    // `number | Signals`, because 0 is the existence probe below and is not a
    // member of NodeJS.Signals even though process.kill accepts it.
    const signal = (sig: NodeJS.Signals | 0): boolean => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false; // ESRCH — the group is gone, which is the goal.
      }
    };

    signal('SIGTERM');

    // Then CONFIRM it died, and escalate if it did not. SIGTERM alone is a
    // request: `pnpm` execs `sh -c tsx src/main.ts`, and a worker mid-poll can
    // outlive the signal — one did, for 25 minutes, and it polled the database
    // through an entire vitest workspace run. The damage is not the stray
    // process, it is that the next suite fails in ways that look like real
    // regressions: a LIVE heartbeat breaks ready.test.ts's "503s on a stale
    // tick" by making the tick genuinely fresh. Cost this session twice before
    // it was understood.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      // Signal 0 tests for existence without delivering anything.
      if (!signal(0)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    signal('SIGKILL');
  };

  // Everything past the spawn runs inside this guard. Playwright only gets the
  // teardown callback if globalSetup RETURNS, so anything that throws here —
  // a browser that will not launch, a register flow that changed shape — used to
  // abandon the worker with no way left to reap it. That is the same orphan as
  // above arriving by a different door, and it is the likelier door: setup
  // failures are exactly when nobody is watching the process table.
  try {
    return await establishSession(teardown);
  } catch (err) {
    await teardown();
    throw err;
  }
}

async function establishSession(
  teardown: () => Promise<void>,
): Promise<() => Promise<void>> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
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

    const email = `e2e-${Date.now()}@example.com`;
    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: /create account/i }).click();
    // register → login → onboarding: a successful session lands on the ceremony.
    await page.getByRole('heading', { name: 'Set up Truecairn' }).waitFor({ timeout: 30_000 });

    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
  return teardown;
}
