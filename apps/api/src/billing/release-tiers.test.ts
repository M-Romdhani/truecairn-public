import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, TIER_CONTACT_COUNT, releaseTiersFor, type VaultTier } from '@truecairn/shared';

// A plan must not advertise a release tier its own contact cap cannot reach.
//
// Found QA 2026-08-10. S3's nested scheme (docs/24) needs exactly three
// contacts; Free caps contacts at two. So S3 has never been assignable on Free,
// while the landing page, the upgrade page and the docs/28 plan table all listed
// "All release tiers (S1–S3)" as something Free includes — on the three surfaces
// someone reads while deciding whether to pay.
//
// The reason this needed a gate rather than a correction is the same reason
// withdrawn-channels.test.ts exists: COPY reads nothing. `PLAN_LIMITS` was
// already shared and already enforced, but TIER_CONTACT_COUNT lived in
// apps/web's Contacts screen, so the two numbers whose COMPARISON makes the
// claim true or false were never in the same place. Both are now in
// @truecairn/shared and the copy renders `releaseTiersFor`.
//
// What makes this worse than an unavailable feature, and why the gate is here
// rather than in a lint rule: filing an item into S3 is NOT blocked (the tier is
// an item attribute, and gating it would strand items existing accounts already
// hold). Only the share split is. An S3 item on a two-contact plan is therefore
// stored, sealed and permanently unreleasable, silently, on the most sensitive
// rung of the ladder.

// This file lives at apps/api/src/billing/, so the repo root is four up.
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

// Surfaces that tell a prospective or current buyer what a PLAN includes.
// Enumerated, not scanned: "S1–S3" appears legitimately in the guide, the
// ceremony portal and the changelog, which describe the ladder itself rather
// than what a tier of the price list buys.
const PLAN_SURFACES = [
  'apps/web/src/screens/Landing.tsx',
  'apps/web/src/screens/plans/Upgrade.tsx',
  'apps/web/src/billing/pricing.ts',
];

const DOCS_28_TABLE = { file: 'docs/28-billing.md', from: '| | Free | Personal |', lines: 10 };

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

// Only what a user can read counts — a comment explaining why a tier is absent
// is the honest record, not an advertisement. Same stripper as the withdrawn-
// channels gate, and the same reasoning.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('release tiers a plan cannot reach are not advertised as included', () => {
  it('S3 is out of reach on Free and reachable on Personal — the case that motivated this', () => {
    expect(TIER_CONTACT_COUNT.s3).toBe(3);
    expect(PLAN_LIMITS.free.maxContacts).toBe(2);
    expect(releaseTiersFor('free')).toEqual(['s1', 's2']);
    expect(releaseTiersFor('pro')).toEqual(['s1', 's2', 's3']);
  });

  it('releaseTiersFor never claims a tier the plan cap cannot satisfy', () => {
    for (const plan of ['free', 'pro'] as const) {
      const cap = PLAN_LIMITS[plan].maxContacts;
      for (const tier of releaseTiersFor(plan)) {
        expect(
          cap === null || TIER_CONTACT_COUNT[tier] <= cap,
          `${plan} claims ${tier}, which needs ${TIER_CONTACT_COUNT[tier]} contacts against a cap of ${String(cap)}`,
        ).toBe(true);
      }
    }
  });

  // The literal the old copy used. If a surface hardcodes the full ladder again
  // it is asserting something about EVERY plan, which is only true while every
  // plan can reach every tier.
  it('no plan surface hardcodes the full ladder while a plan cannot reach it', () => {
    const everyPlanHasEveryTier = (['free', 'pro'] as const).every(
      (p) => releaseTiersFor(p).length === (['s1', 's2', 's3'] satisfies VaultTier[]).length,
    );
    if (everyPlanHasEveryTier) return; // nothing to protect against
    for (const file of PLAN_SURFACES) {
      const text = withoutComments(read(file));
      for (const literal of ['S1–S3', 'S1-S3', 'All release tiers']) {
        expect(
          text.includes(literal),
          `${file} hardcodes "${literal}" while Free reaches only ${releaseTiersFor('free').join(', ')} — render releaseTiersLabel(plan) instead`,
        ).toBe(false);
      }
    }
  });

  it('the docs/28 plan table does not claim the full ladder for Free', () => {
    const lines = read(DOCS_28_TABLE.file).split('\n');
    const start = lines.findIndex((l) => l.includes(DOCS_28_TABLE.from));
    expect(start, `${DOCS_28_TABLE.file} no longer contains the plan table header`).toBeGreaterThan(-1);
    const table = lines.slice(start, start + DOCS_28_TABLE.lines).join('\n');
    const tierRow = table.split('\n').find((l) => l.toLowerCase().includes('release tiers'));
    expect(tierRow, 'the docs/28 plan table no longer has a release-tiers row').toBeDefined();
    // The Free cell must not promise S3 while Free cannot assign it.
    if (!releaseTiersFor('free').includes('s3')) {
      const freeCell = (tierRow ?? '').split('|')[2] ?? '';
      expect(
        /s3|s1[–-]s3/i.test(freeCell),
        `the docs/28 table's Free cell claims S3 ("${freeCell.trim()}") but Free caps contacts at ${String(PLAN_LIMITS.free.maxContacts)}`,
      ).toBe(false);
    }
  });

  it('the Contacts share form reads the shared constant, not a local copy', () => {
    // The local Record<'s2'|'s3', number> is what made the mismatch invisible.
    const contacts = read('apps/web/src/screens/contacts/Contacts.tsx');
    expect(contacts).toContain('TIER_CONTACT_COUNT');
    expect(withoutComments(contacts)).not.toMatch(/const\s+TIER_CONTACT_COUNT\s*[:=]/);
  });

  it('the gate is not vacuous', () => {
    // If a future plan change lets every plan reach every tier, the copy
    // assertions above pass trivially. Correct — and said out loud, so a green
    // run is not mistaken for coverage.
    expect(TIER_CONTACT_COUNT.s1).toBeLessThan(TIER_CONTACT_COUNT.s3);
    expect(releaseTiersFor('free').length).toBeLessThan(3);
  });
});
