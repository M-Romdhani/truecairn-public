// The database refuses an out-of-range stall bound (2026-08-08 re-audit, N-9).
//
// notification_stall_max_days shipped in migration 0053 as a plain integer with
// no constraint. No route writes it yet, so this is defence in depth — but the
// column now has TWO readers, and both fail badly at the extremes:
//
//   * NOTIFICATION_STALLED (0053's own reason): an unbounded stall guarantees a
//     wrongful NON-release — the owner dies, their channels fail because they
//     died, and the vault is never delivered;
//   * lockStall() (the 2026-08-07 account-lock fix): a NEGATIVE value makes the
//     stall condition false immediately, silently disabling the defence that
//     stops an attacker faking an owner's death by holding their account locked.
//
// Migration 0060 makes both unrepresentable rather than merely undocumented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import { eq } from 'drizzle-orm';

type Sql = ReturnType<typeof createClient>['sql'];

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

describeIfDb('notification_stall_max_days is bounded at the database', () => {
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
    await sql`TRUNCATE engine_state_history, engine_states, users CASCADE`;
  });

  async function seedOwner(): Promise<string> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `stall-${Date.now()}-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    await db.insert(schema.engineStates).values({ userId: u!.id, state: 'active' });
    return u!.id;
  }

  // Drizzle wraps the driver error, so its own message is only "Failed query: …".
  // The constraint NAME is what proves the database refused this and not something
  // incidental, and that lives on the postgres.js error underneath.
  async function rejectedConstraint(days: number): Promise<string | undefined> {
    const userId = await seedOwner();
    try {
      await db
        .update(schema.engineStates)
        .set({ notificationStallMaxDays: days })
        .where(eq(schema.engineStates.userId, userId));
      return undefined; // accepted — the constraint is missing
    } catch (err) {
      const cause = (err as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name;
    }
  }

  it('refuses a NEGATIVE stall bound — the fail-open that disables the lock stall', async () => {
    expect(await rejectedConstraint(-1)).toBe('engine_states_stall_bound');
  });

  it('refuses an ABSURD stall bound — the permanent release-blocker', async () => {
    expect(await rejectedConstraint(3651)).toBe('engine_states_stall_bound');
  });

  it('allows 0 and the endpoints — "never stall" is a coherent operator choice', async () => {
    const userId = await seedOwner();
    for (const days of [0, 30, 3650]) {
      await db
        .update(schema.engineStates)
        .set({ notificationStallMaxDays: days })
        .where(eq(schema.engineStates.userId, userId));
      const [row] = await db
        .select({ d: schema.engineStates.notificationStallMaxDays })
        .from(schema.engineStates)
        .where(eq(schema.engineStates.userId, userId));
      expect(row!.d).toBe(days);
    }
  });
});
