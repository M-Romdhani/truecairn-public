import { expect, type Page } from '@playwright/test';

// Confirm every enrolled-but-unconfirmed contact currently on the Contacts page.
//
// Since 2026-08-09 the owner must compare a security code with each contact out
// of band before a release share can be sealed to them (docs/15 Path E). The
// share-assignment affordances do not exist until that happens: no "Assign S1
// share" button, and the S2/S3 share-holder checkboxes are disabled.
//
// What this helper does and does NOT stand in for: it drives the client-side
// mechanism — the pin is sealed under the owner's tier key, stored, and the
// state flips to verified — which is what the assignment flows below need. It
// cannot exercise the part that actually establishes anything, because that part
// is two people on a phone call. The security property lives there; the code
// path is what a browser test can reach. The unit suite
// (apps/web/tests/contact-key-verification.test.ts) pins the refusals.
// A row that is not yet confirmable: 'unverified' has keys waiting to be
// compared, 'no_keys' is a contact whose enrolment has not landed in THIS
// client's copy of the list yet. Both must be gone before the caller can pick
// share holders, and only the first can be acted on — the second has no
// security code to show until the keys arrive.
const UNCONFIRMED = '[data-testid^="key-unverified-"], [data-testid^="key-no_keys-"]';

export async function confirmAllContactKeys(page: Page): Promise<void> {
  // Retry rather than snapshot. The original version listed the unconfirmed
  // badges once and confirmed exactly that set, on the reasoning that every row
  // arrives in one listContacts response and paints in a single commit. That
  // holds WITHIN a response and not across two: a contact who finishes enrolling
  // a moment later lands on the next refetch, after the snapshot was taken, and
  // was then never confirmed at all.
  //
  // It went unnoticed because the other ceremony specs create a vault item
  // between enrolling contacts and opening this page, which is enough delay for
  // every row to be there already. ceremony-s2-negative goes straight from
  // enrolment to Contacts, so its second contact arrived late, kept a disabled
  // checkbox, and burned the full 420s test budget — every CI run since the
  // gate landed.
  //
  // Reloading would be the obvious way to force a fresh list, and it is exactly
  // wrong here: the pin is sealed under the owner's S1 tier key, which lives in
  // memory and is wiped on reload. Polling keeps the unlock.
  await expect(page.locator('[data-testid^="key-"]').first()).toBeVisible({ timeout: 30_000 });

  await expect(async () => {
    // Collect ids first: confirming re-renders the row, which would invalidate a
    // live locator part-way through the loop.
    const ids: string[] = [];
    for (const el of await page.locator('[data-testid^="key-unverified-"]').all()) {
      const testId = await el.getAttribute('data-testid');
      if (testId !== null) ids.push(testId.replace('key-unverified-', ''));
    }

    for (const id of ids) {
      await page.getByTestId(`security-code-${id}`).click();
      await page.getByTestId(`confirm-code-${id}`).click();
      await expect(page.getByTestId(`key-verified-${id}`)).toBeVisible({ timeout: 30_000 });
    }

    // The terminal condition is the absence of unconfirmable rows, not the
    // success of one pass — a row that appeared during this pass is caught by
    // the next one.
    expect(await page.locator(UNCONFIRMED).count()).toBe(0);
    expect(await page.locator('[data-testid^="key-verified-"]').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 120_000, intervals: [500, 1_000, 2_000] });
}
