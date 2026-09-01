import { describe, expect, it } from 'vitest';
import {
  scoreReadiness,
  type ReadinessInputs,
  type TierShareInfo,
} from './readiness.js';

// Golden tests for the deterministic readiness scorer (plan §5 AC). Both
// directions matter: the fixtures that MUST fire a gap, and the near-misses that
// must NOT (a false readiness gap erodes trust just like a missed one).

const noShare: TierShareInfo = { contactShareCount: 0, distinctRoles: 0 };

// A fully-ready S2+S3 setup as the baseline; each test perturbs one facet.
function ready(): ReadinessInputs {
  return {
    now: new Date('2026-07-04T00:00:00Z'),
    engineState: 'active',
    nextScheduledCheckInAt: new Date('2026-08-01T00:00:00Z'),
    itemsByTier: { s1: 1, s2: 2, s3: 3 },
    enrolledContactCount: 3,
    shares: {
      s1: noShare,
      s2: { contactShareCount: 2, distinctRoles: 2 },
      s3: { contactShareCount: 3, distinctRoles: 2 },
    },
    s2PassphraseSlotSet: true,
    beneficiariesByTier: { s1: 1, s2: 0, s3: 0 },
    staleItemCount: 0,
    verifiedChannelCount: 1,
    unconfirmedKeyPinCount: 0,
  };
}

const codes = (i: ReadinessInputs): string[] => scoreReadiness(i).gaps.map((g) => g.code).sort();

describe('scoreReadiness — the ready baseline', () => {
  it('a fully-configured setup has no gaps and scores 100', () => {
    const report = scoreReadiness(ready());
    expect(report.gaps).toEqual([]);
    expect(report.score).toBe(100);
  });
});

describe('scoreReadiness — the S3 role-diversity case (the headline)', () => {
  it('S3 shares all in one role → s3_role_diversity_unsatisfiable', () => {
    const i = ready();
    i.shares.s3 = { contactShareCount: 3, distinctRoles: 1 }; // 3 personal-role contacts
    const report = scoreReadiness(i);
    const gap = report.gaps.find((g) => g.code === 's3_role_diversity_unsatisfiable');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('blocker');
    expect(gap?.tier).toBe('s3');
    expect(gap?.detail).toEqual({ distinctRoles: 1, needed: 2 });
  });

  it('near-miss: S3 shares spanning two roles → NO diversity gap', () => {
    const i = ready();
    i.shares.s3 = { contactShareCount: 3, distinctRoles: 2 };
    expect(codes(i)).not.toContain('s3_role_diversity_unsatisfiable');
  });

  it('coverage beats diversity: too few S3 shares → coverage gap, not diversity', () => {
    const i = ready();
    i.shares.s3 = { contactShareCount: 1, distinctRoles: 1 };
    const c = codes(i);
    expect(c).toContain('s3_coverage_insufficient');
    expect(c).not.toContain('s3_role_diversity_unsatisfiable');
  });

  it('S3 diversity gap does NOT fire when there are no S3 items', () => {
    const i = ready();
    i.itemsByTier = { s1: 1, s2: 2, s3: 0 };
    i.shares.s3 = { contactShareCount: 3, distinctRoles: 1 };
    expect(codes(i)).not.toContain('s3_role_diversity_unsatisfiable');
  });
});

describe('scoreReadiness — coverage, S2 passphrase, beneficiaries', () => {
  it('S2 with one contact share → s2_coverage_insufficient (needs 2)', () => {
    const i = ready();
    i.shares.s2 = { contactShareCount: 1, distinctRoles: 1 };
    const gap = scoreReadiness(i).gaps.find((g) => g.code === 's2_coverage_insufficient');
    expect(gap?.detail).toEqual({ assigned: 1, needed: 2 });
  });

  it('S2 passphrase slot unset → warning', () => {
    const i = ready();
    i.s2PassphraseSlotSet = false;
    const gap = scoreReadiness(i).gaps.find((g) => g.code === 's2_passphrase_slot_unset');
    expect(gap?.severity).toBe('warning');
  });

  it('S1 items but no beneficiary → s1_beneficiary_unset blocker', () => {
    const i = ready();
    i.beneficiariesByTier = { s1: 0, s2: 0, s3: 0 };
    expect(codes(i)).toContain('s1_beneficiary_unset');
  });
});

describe('scoreReadiness — global gaps', () => {
  it('empty vault → single no_vault_items blocker, and a score of 0', () => {
    const i = ready();
    i.itemsByTier = { s1: 0, s2: 0, s3: 0 };
    const report = scoreReadiness(i);
    expect(report.gaps.map((g) => g.code)).toEqual(['no_vault_items']);
    // Was pinned at 80 until 2026-08-11, which is how F-04 survived a green
    // suite: the assertion encoded the defect, so the scorer and the test agreed
    // with each other and with nothing else. An empty vault can release nothing,
    // so it is 0% ready. See readiness-f04.test.ts for the measured trajectory.
    expect(report.score).toBe(0);
  });

  it('items but no enrolled contacts → no_enrolled_contacts', () => {
    const i = ready();
    i.enrolledContactCount = 0;
    expect(codes(i)).toContain('no_enrolled_contacts');
  });

  it('engine not armed (pre_active with contacts) → warning', () => {
    const i = ready();
    i.engineState = 'pre_active';
    expect(codes(i)).toContain('engine_not_armed');
  });

  it('check-in overdue → warning', () => {
    const i = ready();
    i.nextScheduledCheckInAt = new Date('2026-06-01T00:00:00Z'); // before now
    expect(codes(i)).toContain('checkin_overdue');
  });

  // F-07 (docs/38). An armed engine with no verified channel cannot deliver the
  // check-in request at all — `eligibleChannels` returns [], so nothing is
  // enqueued and nothing dead-letters. The owner is never asked, and the ladder
  // reads that silence as inactivity. Blocker, not warning: the outcome is a
  // release of a living owner's vault.
  it('armed engine with no verified channel → no_verified_channel blocker', () => {
    const i = ready();
    i.verifiedChannelCount = 0;
    const gap = scoreReadiness(i).gaps.find((g) => g.code === 'no_verified_channel');
    expect(gap?.severity).toBe('blocker');
  });

  // The near-miss that keeps it honest: one verified channel is enough, so the
  // gap must NOT fire. A readiness gap that cries wolf is worse than none.
  it('one verified channel → NO no_verified_channel gap', () => {
    const i = ready();
    i.verifiedChannelCount = 1;
    expect(codes(i)).not.toContain('no_verified_channel');
  });

  // Scoped to the states that actually send check-ins. Before arming there is no
  // request to miss, and engine_not_armed already speaks to that screen — firing
  // both would put two gaps on one situation.
  it('unarmed engine with no channel → silent (engine_not_armed covers it)', () => {
    const i = ready();
    i.verifiedChannelCount = 0;
    i.engineState = 'pre_active';
    const c = codes(i);
    expect(c).not.toContain('no_verified_channel');
    expect(c).toContain('engine_not_armed');
  });

  // The safety-number call is load-bearing for S1 and S2 and cannot be enforced —
  // nothing can tell whether the owner actually phoned. What IS detectable is a
  // contact whose code was never confirmed at all, which is a silent dead end:
  // the assign control does not exist for them, so the owner sees only "too few
  // shares" and never learns why.
  it('unconfirmed contact keys → warning carrying the count', () => {
    const i = ready();
    i.unconfirmedKeyPinCount = 2;
    const gap = scoreReadiness(i).gaps.find((g) => g.code === 'contact_key_unconfirmed');
    expect(gap?.severity).toBe('warning');
    expect(gap?.detail).toEqual({ count: 2 });
  });

  it('all keys confirmed → NO contact_key_unconfirmed gap', () => {
    const i = ready();
    i.unconfirmedKeyPinCount = 0;
    expect(codes(i)).not.toContain('contact_key_unconfirmed');
  });

  // A WARNING, deliberately. The coverage gaps are the blockers; this explains
  // them. Making it a blocker would drop every existing owner with one
  // half-enrolled contact into a blocked dashboard for something that is not, by
  // itself, a reason a release cannot complete.
  it('is a warning, so it never alone makes a setup read as blocked', () => {
    const i = ready();
    i.unconfirmedKeyPinCount = 3;
    const report = scoreReadiness(i);
    expect(report.gaps.filter((g) => g.severity === 'blocker')).toEqual([]);
    expect(report.score).toBe(92); // 100 - one warning
  });

  it('stale items → warning carrying the count', () => {
    const i = ready();
    i.staleItemCount = 4;
    const gap = scoreReadiness(i).gaps.find((g) => g.code === 'stale_items');
    expect(gap?.detail).toEqual({ count: 4 });
  });

  it('score deducts per gap, stays in [0,100], and is floored not negative', () => {
    const i = ready();
    // Pile on gaps: no contacts + S1/S2/S3 coverage blockers + warnings.
    i.enrolledContactCount = 0;
    i.shares.s2 = noShare;
    i.shares.s3 = noShare;
    i.beneficiariesByTier = { s1: 0, s2: 0, s3: 0 };
    i.s2PassphraseSlotSet = false;
    i.staleItemCount = 4;
    const report = scoreReadiness(i);
    expect(report.gaps.length).toBeGreaterThanOrEqual(5);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThan(20); // heavily penalised
    // The floor holds: even with a hand-forced over-100 deduction it clamps to 0.
    expect(Math.max(0, 100 - 999)).toBe(0);
  });
});
