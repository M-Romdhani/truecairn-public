// docs/03-release-policy-matrix.md, as data.
//
// The matrix answers one question per cell: if this owner goes silent, at which
// stage of the release ladder should THIS kind of material reach THIS kind of
// person — and should it reach them at all? It was ratified in July 2026 and has
// never been anything but prose, because until VAULT_CATEGORIES and
// RECIPIENT_TYPES existed there was nothing to key the rows and columns on.
//
// ADVISORY. Nothing in packages/engine or packages/ceremony reads this, and the
// release path never consults it. It exists to answer "who is this for?" at the
// moment the owner assigns a tier, where the alternative is an unguided guess
// whose consequences arrive when the owner is not there to correct them.
//
// Enforcement was considered and deliberately rejected: it would change release
// semantics, and it would give an owner a way to be locked out of their own
// intent by a table someone else wrote. The matrix advises; the owner decides.
//
// `null` is the matrix's em dash — "this type should not receive this category at
// any stage", which is a real answer and not a missing one.

import type { RecipientType } from './enums.js';
import type { VaultCategory, VaultTier } from './enums.js';

export type SuggestedTier = VaultTier | null;

export const RELEASE_POLICY_MATRIX: Readonly<
  Record<VaultCategory, Readonly<Record<RecipientType, SuggestedTier>>>
> = {
  // Recovery first: the safest thing to leak and the thing most likely to be
  // needed immediately, so nearly everyone gets it at S1.
  recovery_instructions: {
    spouse_family_executor: 's1',
    cofounder_business_partner: 's1',
    lawyer_accountant: null,
    recovery_contact: 's1',
    designated_heir: 's1',
  },
  // The only category scoped to one recipient type: a cofounder needs the
  // playbooks to keep the business running, and nobody else has a use for them.
  operational_playbooks: {
    spouse_family_executor: null,
    cofounder_business_partner: 's1',
    lawyer_accountant: null,
    recovery_contact: null,
    designated_heir: null,
  },
  asset_inventory: {
    spouse_family_executor: 's1',
    cofounder_business_partner: 's1',
    lawyer_accountant: 's2',
    recovery_contact: null,
    designated_heir: 's2',
  },
  identity_documents: {
    spouse_family_executor: 's2',
    cofounder_business_partner: null,
    lawyer_accountant: 's2',
    recovery_contact: null,
    designated_heir: 's2',
  },
  financial_accounts: {
    spouse_family_executor: 's2',
    cofounder_business_partner: null,
    lawyer_accountant: 's2',
    recovery_contact: null,
    designated_heir: 's2',
  },
  // The one row where the fiduciary is served EARLIER than the family: legal
  // documents are what a lawyer acts on, and acting late is the failure mode.
  legal_documents: {
    spouse_family_executor: 's2',
    cofounder_business_partner: null,
    lawyer_accountant: 's1',
    recovery_contact: null,
    designated_heir: 's2',
  },
  // S3, and only to the two types with a personal claim. Crypto because a leaked
  // seed phrase is irreversible and instantaneous, so it waits out the full ladder.
  crypto_wallets: {
    spouse_family_executor: 's3',
    cofounder_business_partner: null,
    lawyer_accountant: null,
    recovery_contact: null,
    designated_heir: 's3',
  },
  personal_archive: {
    spouse_family_executor: 's3',
    cofounder_business_partner: null,
    lawyer_accountant: null,
    recovery_contact: null,
    designated_heir: 's3',
  },
};

// The suggestion for one (category, recipient type) pair. `null` means the matrix
// says this recipient should not receive this category at all.
export function suggestedTierFor(
  category: VaultCategory,
  recipientType: RecipientType,
): SuggestedTier {
  return RELEASE_POLICY_MATRIX[category][recipientType];
}

// Which recipient types the matrix places at a given tier for a category, and
// which it excludes entirely. This is the shape the UI needs: when an owner picks
// a tier for an item, it can say who that choice reaches and who it does not.
export function recipientsForCategory(category: VaultCategory): {
  byTier: Readonly<Record<VaultTier, RecipientType[]>>;
  excluded: RecipientType[];
} {
  const byTier: Record<VaultTier, RecipientType[]> = { s1: [], s2: [], s3: [] };
  const excluded: RecipientType[] = [];
  for (const [type, tier] of Object.entries(RELEASE_POLICY_MATRIX[category]) as [
    RecipientType,
    SuggestedTier,
  ][]) {
    if (tier === null) excluded.push(type);
    else byTier[tier].push(type);
  }
  return { byTier, excluded };
}
