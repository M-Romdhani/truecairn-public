// The database refuses a recipient_type that disagrees with the contact's role.
//
// Lives in packages/ceremony rather than packages/db because this constraint
// exists to protect something ceremony owns: `diverseRoleSatisfied`, the release
// gate that docs/14 justifies as making a conspiracy span "both personal and
// professional life".
//
// RECIPIENT_TYPE_ROLE keeps the mapping honest in TypeScript, and
// packages/shared/src/recipient-type.test.ts pins it. But TypeScript is not in
// the room for a hand-edit in psql, a repair script, or a future writer that
// builds an INSERT by hand — and the consequence of getting it wrong there is not
// a wrong label. Put `lawyer_accountant` on a row whose role is `personal` and
// that contact now counts toward the personal side of a diverse-role threshold
// while the owner believes they are the professional one. The bar would still be
// "satisfied"; it would just be measuring something else.
//
// So migration 0066 states the mapping twice: once as a vocabulary CHECK, once as
// a role-agreement CHECK. This test is about the second.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { RECIPIENT_TYPES, RECIPIENT_TYPE_ROLE, type RecipientType } from '@truecairn/shared';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('recipient_type must agree with role, at the database', () => {
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
    await sql`TRUNCATE contacts, users CASCADE`;
  });

  async function owner(): Promise<string> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `rt-${Date.now()}-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id;
  }

  async function insertContact(
    role: 'personal' | 'professional' | 'recovery',
    recipientType: RecipientType,
  ): Promise<string | undefined> {
    const ownerUserId = await owner();
    try {
      await db.insert(schema.contacts).values({
        ownerUserId,
        role,
        // Deliberately bypassing the `$type<RecipientType>` guard where the pair
        // is illegal: the point is what happens when TypeScript is not in the room.
        recipientType,
        status: 'active',
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array(24),
      });
      return undefined; // accepted
    } catch (err) {
      const cause = (err as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name;
    }
  }

  it('refuses a professional type on a personal-role row', async () => {
    expect(await insertContact('personal', 'lawyer_accountant')).toBe(
      'contacts_recipient_type_matches_role',
    );
  });

  it('refuses a personal type on a professional-role row', async () => {
    expect(await insertContact('professional', 'spouse_family_executor')).toBe(
      'contacts_recipient_type_matches_role',
    );
  });

  it('refuses the recovery type anywhere but the recovery role', async () => {
    expect(await insertContact('personal', 'recovery_contact')).toBe(
      'contacts_recipient_type_matches_role',
    );
    expect(await insertContact('recovery', 'designated_heir')).toBe(
      'contacts_recipient_type_matches_role',
    );
  });

  // The positive half, driven from the mapping itself rather than a hand-written
  // list — so a sixth recipient type is covered here the day it is added.
  it('accepts every (type, its own role) pair', async () => {
    for (const t of RECIPIENT_TYPES) {
      const constraint = await insertContact(RECIPIENT_TYPE_ROLE[t], t);
      expect(constraint, `${t} on role ${RECIPIENT_TYPE_ROLE[t]} should be accepted`).toBeUndefined();
    }
  });

  it('still accepts a null recipient_type — "not chosen yet" is a real state', async () => {
    const ownerUserId = await owner();
    await db.insert(schema.contacts).values({
      ownerUserId,
      role: 'personal',
      status: 'active',
      displayLabelCiphertext: new Uint8Array([1]),
      displayLabelNonce: new Uint8Array(24),
    });
    const [row] = await db
      .select({ rt: schema.contacts.recipientType })
      .from(schema.contacts)
      .limit(1);
    expect(row!.rt).toBeNull();
  });
});
