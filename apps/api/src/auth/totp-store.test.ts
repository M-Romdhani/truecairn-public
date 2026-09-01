import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { TotpKekSet } from '../config.js';
import { totpCode } from './totp.js';
import { confirmTotp, setupTotp, verifyUserTotp } from './totp-store.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

function kek(id: string, fill: number): { id: string; key: Uint8Array } {
  return { id, key: new Uint8Array(32).fill(fill) };
}

describeIfDb('TOTP store + KEK versioning (integration)', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE totp_credentials, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  const k1 = kek('totp-k1', 0x11);
  const k2 = kek('totp-k2', 0x22);
  const single: TotpKekSet = { currentId: k1.id, byId: new Map([[k1.id, k1]]) };
  // After rotation: k2 is current, k1 retained only to decrypt not-yet-migrated rows.
  const rotated: TotpKekSet = {
    currentId: k2.id,
    byId: new Map([
      [k2.id, k2],
      [k1.id, k1],
    ]),
  };

  it('setup → confirm → verify against the current KEK', async () => {
    const userId = await makeUser('a@example.com');
    const { secret } = await setupTotp(db, single, userId, new Date());
    const now = new Date('2026-05-29T12:00:00Z');

    // Unconfirmed: a login-style verify refuses until confirmed.
    expect(await verifyUserTotp(db, single, userId, totpCode(secret, now), now)).toBe(false);
    expect(await confirmTotp(db, single, userId, totpCode(secret, now), now)).toBe(true);
    expect(await verifyUserTotp(db, single, userId, totpCode(secret, now), now)).toBe(true);

    const [row] = await db.select().from(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId));
    expect(row!.kekId).toBe(k1.id);
  });

  it('a successful verify under a rotated KEK re-wraps the secret to the current KEK', async () => {
    const userId = await makeUser('b@example.com');
    const { secret } = await setupTotp(db, single, userId, new Date());
    const now = new Date('2026-05-29T12:00:00Z');
    await confirmTotp(db, single, userId, totpCode(secret, now), now);

    // The stored row is on k1; the server has rotated so k2 is current.
    const before = (
      await db.select().from(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId))
    )[0];
    expect(before!.kekId).toBe(k1.id);
    const cipherBefore = Buffer.from(before!.secretCiphertext);

    // A correct code verifies (k1 is still available to decrypt)...
    expect(await verifyUserTotp(db, rotated, userId, totpCode(secret, now), now)).toBe(true);

    // ...and the row was transparently re-wrapped to k2.
    const after = (
      await db.select().from(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId))
    )[0];
    expect(after!.kekId).toBe(k2.id);
    expect(Buffer.from(after!.secretCiphertext)).not.toEqual(cipherBefore);

    // The re-wrapped secret still verifies with only k2 present (migration complete).
    const onlyK2: TotpKekSet = { currentId: k2.id, byId: new Map([[k2.id, k2]]) };
    expect(await verifyUserTotp(db, onlyK2, userId, totpCode(secret, now), now)).toBe(true);
  });

  it('fails closed when the row references an unknown KEK', async () => {
    const userId = await makeUser('c@example.com');
    const { secret } = await setupTotp(db, single, userId, new Date());
    const now = new Date('2026-05-29T12:00:00Z');
    await confirmTotp(db, single, userId, totpCode(secret, now), now);

    // A KEK set that no longer contains k1 cannot decrypt the row.
    const orphan: TotpKekSet = { currentId: k2.id, byId: new Map([[k2.id, k2]]) };
    expect(await verifyUserTotp(db, orphan, userId, totpCode(secret, now), now)).toBe(false);
  });
});
