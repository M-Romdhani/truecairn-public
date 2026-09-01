import { describe, expect, it } from 'vitest';
import { scoreReadiness, type ReadinessInputs, type TierShareInfo } from './readiness.js';

// ── F-04: the readiness score moved the wrong way on the new-user path ────────
//
// FIXED 2026-08-11. This file is kept as the regression pin and the record of how
// the defect was settled — by running the scorer, not by reading it. The claim had
// been made twice from reading before anyone executed it.
//
// Measured over a brand-new account, changing one facet at a time:
//
//                                     before    after
//   0. empty vault, nothing set up    score= 80  →   0  [no_vault_items]
//   1. + first S1 item                score= 60  →  60  [no_enrolled_contacts, s1_beneficiary_unset]
//   2. + one item in every tier       score= 12  →  12  [+ s2/s3 coverage, s2_passphrase_slot_unset]
//   3. one S1 item + 1 contact        score= 72  →  72  [s1_beneficiary_unset, engine_not_armed]
//   4. + S1 beneficiary designated    score= 92  →  92  [engine_not_armed]
//   5. + engine armed                 score=100  → 100  []
//
// Steps 3–5 were already correct, which is what narrowed the fix: the scorer
// recovers properly once a setup is under way, so only the empty-vault baseline
// changed and the gap logic was not touched. `readiness.ts` still returns early
// after `no_vault_items` — right for GAP SUPPRESSION — but no longer scores that
// state through the uniform deduction model, which had left a completely
// unconfigured account reading 80/100 when it is the one state that can never
// release anything at all.
//
// The consequence that made it worth fixing: the owner's first correct action —
// adding an item — used to COST 20 points. Real progress rendered as regression
// is worse than a merely wrong number, because it teaches the owner to distrust
// the ring at exactly the moment it is meant to guide them.
//
// Step 2 still scores below step 1 and that is CORRECT, not a residual bug:
// putting items into S2/S3 without assigning shares genuinely creates gaps those
// items cannot be released through. The difference from F-04 is that those
// deductions describe real, nameable gaps the owner can act on, whereas the 80
// described nothing at all.

const noShare: TierShareInfo = { contactShareCount: 0, distinctRoles: 0 };

// A brand-new account: signed up, nothing configured. Deliberately NOT the
// `ready()` fixture in readiness.test.ts — that one is fully configured and each
// test perturbs a single facet, which is why the existing 14 tests are all green
// and none of them can see this. The gap was in the fixture, not the assertions.
function newUser(): ReadinessInputs {
  return {
    now: new Date('2026-07-04T00:00:00Z'),
    engineState: 'pre_active',
    nextScheduledCheckInAt: null,
    itemsByTier: { s1: 0, s2: 0, s3: 0 },
    enrolledContactCount: 0,
    shares: { s1: noShare, s2: noShare, s3: noShare },
    s2PassphraseSlotSet: false,
    beneficiariesByTier: { s1: 0, s2: 0, s3: 0 },
    staleItemCount: 0,
    // A verified channel, so the F-04 trajectory measures ONLY the vault/contact
    // path. Leaving this at 0 would add the no_verified_channel blocker to the
    // armed step and change the numbers this file exists to pin.
    verifiedChannelCount: 1,
    // No unconfirmed keys either — same reasoning: this file pins the vault/contact
    // trajectory, and an unrelated warning would shift every number in it.
    unconfirmedKeyPinCount: 0,
  };
}

describe('readiness scoring — F-04 (fixed 2026-08-11, regression pin)', () => {
  // The invariant. An empty vault cannot release anything, so it must not outrank
  // an account that has started filling one.
  //
  // These two carried `it.fails` markers between the finding and the fix — green
  // because the assertion failed, red the moment the scorer was corrected, which
  // is what retired them. They are ordinary pins now. Do not re-weaken them into
  // an assertion about the CURRENT numbers: the property is what matters, and a
  // property survives a future change to SEVERITY_DEDUCTION that an exact number
  // would not.
  it('an empty vault must not score higher than a vault with an item in it', () => {
    const empty = scoreReadiness(newUser());

    const oneItem = newUser();
    oneItem.itemsByTier = { s1: 1, s2: 0, s3: 0 };

    expect(scoreReadiness(oneItem).score).toBeGreaterThanOrEqual(empty.score);
  });

  // The same invariant from the other side, and the sharper case: the score must
  // not collapse because the owner used more of the product.
  it('populating all three tiers must not cost the owner points against empty', () => {
    const empty = scoreReadiness(newUser());

    const populated = newUser();
    populated.itemsByTier = { s1: 1, s2: 1, s3: 1 };

    expect(empty.score - scoreReadiness(populated).score).toBeLessThanOrEqual(0);
  });

  // Not part of the defect — proof that the scorer is sound once setup is under
  // way, so a fix is scoped to the empty-vault baseline and need not touch the
  // gap logic. This is an ordinary passing pin.
  //
  // It asserts the PROPERTY (each real step raises the score, a complete setup
  // reaches 100 with no gaps) rather than the exact intermediate numbers, which
  // are recorded in the header comment instead. Pinning 72 and 92 here would make
  // any future change to SEVERITY_DEDUCTION look like a regression in a file whose
  // subject is the empty-vault baseline — and a test that cries wolf about the
  // thing it is not testing gets its numbers edited to match, which is how a pin
  // stops being evidence.
  it('every real setup step raises the score, ending at 100 with no gaps', () => {
    const i = newUser();
    i.itemsByTier = { s1: 1, s2: 0, s3: 0 };

    const afterItem = scoreReadiness(i).score;

    i.enrolledContactCount = 1;
    const afterContact = scoreReadiness(i).score;
    expect(afterContact).toBeGreaterThan(afterItem);

    i.beneficiariesByTier = { s1: 1, s2: 0, s3: 0 };
    const afterBeneficiary = scoreReadiness(i).score;
    expect(afterBeneficiary).toBeGreaterThan(afterContact);

    i.engineState = 'active';
    i.nextScheduledCheckInAt = new Date('2026-08-01T00:00:00Z');
    const done = scoreReadiness(i);
    expect(done.score).toBeGreaterThan(afterBeneficiary);
    expect(done.gaps).toEqual([]);
    expect(done.score).toBe(100);
  });
});
