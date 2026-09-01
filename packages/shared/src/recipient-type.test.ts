// The recipient-type axis must never become the security axis, and the matrix
// must never drift from the document it was transcribed from.
//
// These are permanent. A "fix" that flips one is a bug, in the same sense as the
// AI asymmetry tests and the mobile no-passive-check-in test.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTACT_ROLES,
  RECIPIENT_TYPES,
  RECIPIENT_TYPE_ROLE,
  VAULT_CATEGORIES,
  type ContactRole,
  type RecipientType,
  type VaultCategory,
  type VaultTier,
} from './enums.js';
import { RELEASE_POLICY_MATRIX, recipientsForCategory, suggestedTierFor } from './release-policy.js';

describe('recipient types map down to security roles', () => {
  it('the mapping is total — every type has a role', () => {
    for (const t of RECIPIENT_TYPES) {
      expect(RECIPIENT_TYPE_ROLE[t], `no role for ${t}`).toBeDefined();
    }
    expect(Object.keys(RECIPIENT_TYPE_ROLE).sort()).toEqual([...RECIPIENT_TYPES].sort());
  });

  it('every mapped role is a real CONTACT_ROLE', () => {
    for (const t of RECIPIENT_TYPES) {
      expect(CONTACT_ROLES).toContain(RECIPIENT_TYPE_ROLE[t]);
    }
  });

  // THE invariant. docs/14: a conspiracy must span "both personal and
  // professional life". If the five types ever became the role enum, a lawyer and
  // a cofounder would read as two roles and satisfy diversity — while sitting in
  // the same sphere of the owner's life, possibly the same firm. The bar would
  // keep its letter and lose its purpose.
  it('two professional types collapse to ONE role, so they cannot satisfy diversity between them', () => {
    expect(RECIPIENT_TYPE_ROLE['lawyer_accountant']).toBe('professional');
    expect(RECIPIENT_TYPE_ROLE['cofounder_business_partner']).toBe('professional');
    expect(RECIPIENT_TYPE_ROLE['lawyer_accountant']).toBe(
      RECIPIENT_TYPE_ROLE['cofounder_business_partner'],
    );
  });

  it('the two personal types likewise collapse to one role', () => {
    expect(RECIPIENT_TYPE_ROLE['spouse_family_executor']).toBe('personal');
    expect(RECIPIENT_TYPE_ROLE['designated_heir']).toBe('personal');
  });

  // Stated as a property rather than a list, so a SIXTH type added later is
  // covered without anyone remembering to extend this file: whatever roles exist,
  // the set of distinct roles reachable from the types must never exceed the set
  // of real roles. A type inventing its own role fails here.
  it('the types reach no role that CONTACT_ROLES does not define', () => {
    const reached = new Set<ContactRole>(RECIPIENT_TYPES.map((t) => RECIPIENT_TYPE_ROLE[t]));
    for (const r of reached) expect(CONTACT_ROLES).toContain(r);
    expect(reached.size).toBeLessThanOrEqual(CONTACT_ROLES.length);
  });
});

describe('the release policy matrix matches docs/03', () => {
  const doc = readFileSync(join(__dirname, '../../../docs/03-release-policy-matrix.md'), 'utf8');
  const tableLines = doc
    .split('\n')
    .filter((l) => l.trimStart().startsWith('|') && !l.includes('|---'));

  const slug = (s: string): string => s.trim().toLowerCase().replace(/[ /]+/g, '_');
  const cells = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

  it('the column order is the recipient types, in order', () => {
    const header = cells(tableLines[0]!).slice(1).map(slug);
    expect(header).toEqual([...RECIPIENT_TYPES]);
  });

  it('the row order is the vault categories, in order', () => {
    const rows = tableLines.slice(1).map((l) => slug(cells(l)[0]!));
    expect(rows).toEqual([...VAULT_CATEGORIES]);
  });

  it('every cell agrees — all 40 of them', () => {
    const header = cells(tableLines[0]!).slice(1).map(slug) as RecipientType[];
    let checked = 0;
    for (const line of tableLines.slice(1)) {
      const row = cells(line);
      const category = slug(row[0]!) as VaultCategory;
      row.slice(1).forEach((cell, i) => {
        const type = header[i]!;
        // The document writes "S1" / "S2" / "S3", or an em dash for "never".
        const expected = /^S[123]$/.test(cell) ? (cell.toLowerCase() as VaultTier) : null;
        expect(
          suggestedTierFor(category, type),
          `${category} × ${type} — doc says ${cell}`,
        ).toBe(expected);
        checked += 1;
      });
    }
    // 8 categories × 5 types. If the doc grows, this number must move deliberately.
    expect(checked).toBe(40);
  });

  it('every category is covered for every type, with no holes', () => {
    for (const c of VAULT_CATEGORIES) {
      for (const t of RECIPIENT_TYPES) {
        expect(RELEASE_POLICY_MATRIX[c][t], `${c} × ${t}`).not.toBeUndefined();
      }
    }
  });
});

describe('recipientsForCategory', () => {
  it('splits a category into who receives it when, and who never does', () => {
    const legal = recipientsForCategory('legal_documents');
    // The one row where the fiduciary is served before the family.
    expect(legal.byTier.s1).toEqual(['lawyer_accountant']);
    expect(legal.byTier.s2).toEqual(['spouse_family_executor', 'designated_heir']);
    expect(legal.excluded).toEqual(['cofounder_business_partner', 'recovery_contact']);
  });

  it('a recovery contact receives recovery instructions and nothing else', () => {
    for (const c of VAULT_CATEGORIES) {
      const tier = suggestedTierFor(c, 'recovery_contact');
      if (c === 'recovery_instructions') expect(tier).toBe('s1');
      else expect(tier, `recovery_contact should not receive ${c}`).toBeNull();
    }
  });
});
