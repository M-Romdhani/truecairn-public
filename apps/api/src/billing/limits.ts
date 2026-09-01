import { schema, type Database } from '@truecairn/db';
import { PLAN_LIMITS, type UserId } from '@truecairn/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../errors.js';
import { getEntitlement } from './entitlement.js';

// Per-plan resource caps (docs/28), enforced at CREATE time. The paywall is now
// a real difference between tiers — contacts, vault items, and storage — not
// just the SMS/WhatsApp channels. Over-cap creates fail closed with 402
// upgrade-required (the same problem type the channel gate uses), carrying
// machine-readable extensions so the client can render an exact upgrade nudge.
//
// Note on atomicity: the count-then-create for contacts/items is not a single
// transaction, so a burst of concurrent creates could slip one past the cap.
// That is a benign billing boundary (never a security gate), so we accept it;
// the storage budget, which CAN be abused, stays atomic (reserveUserStorage).

export const UPGRADE_REQUIRED_TYPE = 'https://truecairn.app/problems/upgrade-required';

export function upgradeRequired(
  detail: string,
  extensions: { resource: string; limit: number; plan: string },
): ApiError {
  return new ApiError(402, 'Upgrade Required', detail, UPGRADE_REQUIRED_TYPE, extensions);
}

// Live trusted-contact count — the rows /v1/contacts lists (not removed).
export async function countContacts(db: Database, userId: UserId): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.ownerUserId, userId), isNull(schema.contacts.removedAt)));
  return Number(row?.n ?? 0);
}

// Live (non-deleted) vault-item count.
export async function countVaultItems(db: Database, userId: UserId): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.vaultItems)
    .where(and(eq(schema.vaultItems.userId, userId), isNull(schema.vaultItems.deletedAt)));
  return Number(row?.n ?? 0);
}

// Throw 402 if the plan's contact cap is already met.
export async function assertCanAddContact(db: Database, userId: UserId, now: Date): Promise<void> {
  const { plan } = await getEntitlement(db, userId, now);
  const max = PLAN_LIMITS[plan].maxContacts;
  if (max === null) return;
  if ((await countContacts(db, userId)) >= max) {
    throw upgradeRequired(
      `the Free plan includes up to ${max} trusted contacts — upgrade to Personal for unlimited`,
      { resource: 'contacts', limit: max, plan },
    );
  }
}

// Unfiled captures (docs/34). They count against the item cap: a capture is an
// item the owner has already decided to keep, and leaving them uncounted would
// make the cap avoidable by capturing from a phone and filing later — the plan
// boundary would then depend on which client you happened to use.
export async function countVaultCaptures(db: Database, userId: UserId): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.vaultCaptures)
    .where(eq(schema.vaultCaptures.userId, userId));
  return Number(row?.n ?? 0);
}

// Throw 402 if the plan's vault-item cap is already met.
export async function assertCanAddVaultItem(db: Database, userId: UserId, now: Date): Promise<void> {
  const { plan } = await getEntitlement(db, userId, now);
  const max = PLAN_LIMITS[plan].maxVaultItems;
  if (max === null) return;
  const used = (await countVaultItems(db, userId)) + (await countVaultCaptures(db, userId));
  if (used >= max) {
    throw upgradeRequired(
      `the Free plan includes up to ${max} vault items — upgrade to Personal for unlimited`,
      { resource: 'vault_items', limit: max, plan },
    );
  }
}

// The effective attachment-storage cap for a user: the plan budget, never above
// the global hard ceiling an operator may set (VAULT_MAX_USER_TOTAL_BYTES).
export async function storageCapBytes(
  db: Database,
  userId: UserId,
  now: Date,
  ceilingBytes: number,
): Promise<number> {
  const { plan } = await getEntitlement(db, userId, now);
  return Math.min(PLAN_LIMITS[plan].maxStorageBytes, ceilingBytes);
}
