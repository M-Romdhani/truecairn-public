// The database refuses a vault category outside docs/03's vocabulary, and the
// vocabulary itself cannot drift from the document it was taken from.
//
// Two guards, because the failure modes are different and only one of them is
// visible at runtime:
//
//   * The CHECK (migration 0065) stops an out-of-vocabulary value being stored at
//     all. Route validation mirrors it, but the constraint is what makes it true —
//     a raw insert, a hand-edit in psql, or a future writer that forgets the
//     schema all go through the database and none of them go through Fastify.
//   * The drift test stops `VAULT_CATEGORIES` and
//     docs/03-release-policy-matrix.md disagreeing. That matrix is the reason the
//     vocabulary is typed at all, and a matrix keyed on rows that no longer exist
//     is worse than no matrix — it would silently stop offering guidance for a
//     category while still looking complete. Same reasoning as the
//     whatsapp-templates drift test: copy that lives in two places drifts, and
//     here one of the two is a document nobody executes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { VAULT_CATEGORIES, type UserId, type VaultCategory } from '@truecairn/shared';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describe('vault category vocabulary matches docs/03', () => {
  it('the typed set is exactly the matrix rows, in matrix order', () => {
    const doc = readFileSync(
      join(__dirname, '../../../docs/03-release-policy-matrix.md'),
      'utf8',
    );
    // The matrix rows are the table lines between the header separator and the
    // blank line that ends the table. Row label is the first cell.
    const rows = doc
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('|---') && !l.includes('Vault category'))
      .map((l) => l.split('|')[1]!.trim())
      .filter((label) => label.length > 0)
      .map((label) => label.toLowerCase().replace(/[ /]+/g, '_'));

    expect(rows).toEqual([...VAULT_CATEGORIES]);
  });
});

describeIfDb('the database refuses an unknown vault category', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE vault_items, outer_layer_keys, users CASCADE`;
  });

  async function seed(): Promise<{ userId: UserId; keyId: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `cat-${Date.now()}-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const [k] = await db
      .insert(schema.outerLayerKeys)
      .values({
        userId: u!.id as UserId,
        tier: 's1',
        kekId: 'k',
        outerKeyEncrypted: Buffer.alloc(32, 9),
        outerKeyNonce: Buffer.alloc(24, 9),
        outerKeyEncryptionAad: Buffer.alloc(8, 9),
        generation: 1,
      })
      .returning({ id: schema.outerLayerKeys.id });
    return { userId: u!.id as UserId, keyId: k!.id };
  }

  function envelope() {
    return {
      outerCiphertext: Buffer.alloc(8, 1),
      outerNonce: Buffer.alloc(24, 2),
      titleCiphertext: Buffer.alloc(8, 3),
      titleNonce: Buffer.alloc(24, 4),
      contentSizeBytes: 8,
      outerKekId: 'k',
      outerGeneration: 1,
    };
  }

  // Drizzle wraps the driver error, so its own message is only "Failed query: …".
  // The constraint NAME is what proves the database refused this and not something
  // incidental, and that lives on the postgres.js error underneath — same
  // technique as engine/stall-bound.integration.test.ts.
  async function rejectedConstraint(category: string): Promise<string | undefined> {
    const { userId, keyId } = await seed();
    try {
      await db.insert(schema.vaultItems).values({
        userId,
        tier: 's1',
        // Deliberately bypassing the `$type<VaultCategory>` guard: the point of
        // this test is what happens when TypeScript is not in the room.
        category: category as VaultCategory,
        outerLayerKeyId: keyId,
        ...envelope(),
      });
      return undefined; // accepted — the constraint is missing
    } catch (err) {
      const cause = (err as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name;
    }
  }

  it('refuses a plausible-looking category that is not in the vocabulary', async () => {
    expect(await rejectedConstraint('passwords')).toBe('vault_items_category_vocabulary');
  });

  it('refuses an empty category', async () => {
    expect(await rejectedConstraint('')).toBe('vault_items_category_vocabulary');
  });

  it('accepts every category in the vocabulary', async () => {
    for (const category of VAULT_CATEGORIES) {
      const { userId, keyId } = await seed();
      await db.insert(schema.vaultItems).values({
        userId,
        tier: 's1',
        category,
        outerLayerKeyId: keyId,
        ...envelope(),
      });
      const [row] = await db
        .select({ c: schema.vaultItems.category })
        .from(schema.vaultItems)
        .limit(1);
      expect(row!.c).toBe(category);
      await sql`TRUNCATE vault_items, outer_layer_keys, users CASCADE`;
    }
  });
});
