import { VAULT_CATEGORIES, type VaultCategory } from '@truecairn/shared';

// Coerce an untrusted category to the vocabulary, for the ONE path where the
// value does not come from this app: filing a vault capture (docs/34). The
// category is chosen on the phone, sealed there, and opened here — so it may
// predate this vocabulary, or come from a client that never had it.
//
// Falling back is deliberate and the direction is not arbitrary. fileCapture's
// own comment states the rule this obeys: "a duplicate item is visible and
// fixable; a lost capture is neither." Refusing to file over a *label* would
// discard content the owner deliberately captured, to enforce a taxonomy they
// can fix in one click afterwards. So an unrecognised label files as
// personal_archive — the narrowest distribution docs/03 offers, matching the
// backfill in migration 0065 — and the owner re-categorises if they care.
export function coerceCategory(value: string): VaultCategory {
  return (VAULT_CATEGORIES as readonly string[]).includes(value)
    ? (value as VaultCategory)
    : 'personal_archive';
}
