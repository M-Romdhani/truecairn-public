import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { claimChallenge, createChallenge } from './challenges.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('auth challenges (integration)', () => {
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
    await sql`TRUNCATE auth_challenges, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'pending' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('claims a fresh challenge exactly once — replay returns null', async () => {
    const userId = await makeUser('a@example.com');
    const now = new Date('2026-05-01T00:00:00Z');
    const { id } = await createChallenge(db, {
      userId,
      purpose: 'webauthn_register',
      challenge: new Uint8Array([1, 2, 3]),
      expiresAt: new Date(now.getTime() + 300_000),
      now,
    });

    const first = await claimChallenge(db, {
      id,
      purpose: 'webauthn_register',
      now: new Date(now.getTime() + 1000),
    });
    expect(first).not.toBeNull();
    expect(first!.userId).toBe(userId);
    expect([...first!.challenge]).toEqual([1, 2, 3]);

    const replay = await claimChallenge(db, {
      id,
      purpose: 'webauthn_register',
      now: new Date(now.getTime() + 2000),
    });
    expect(replay).toBeNull();
  });

  it('does not claim an expired challenge', async () => {
    const userId = await makeUser('b@example.com');
    const now = new Date('2026-05-01T00:00:00Z');
    const { id } = await createChallenge(db, {
      userId,
      purpose: 'webauthn_auth',
      challenge: new Uint8Array([9]),
      expiresAt: new Date(now.getTime() + 1000),
      now,
    });
    const claimed = await claimChallenge(db, {
      id,
      purpose: 'webauthn_auth',
      now: new Date(now.getTime() + 5000),
    });
    expect(claimed).toBeNull();
  });

  it('does not claim under the wrong purpose', async () => {
    const userId = await makeUser('c@example.com');
    const now = new Date('2026-05-01T00:00:00Z');
    const { id } = await createChallenge(db, {
      userId,
      purpose: 'webauthn_register',
      challenge: new Uint8Array([1]),
      expiresAt: new Date(now.getTime() + 300_000),
      now,
    });
    const claimed = await claimChallenge(db, {
      id,
      purpose: 'webauthn_auth',
      now: new Date(now.getTime() + 1000),
    });
    expect(claimed).toBeNull();
  });

  it('supports a null user binding (discoverable login)', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const { id } = await createChallenge(db, {
      userId: null,
      purpose: 'webauthn_auth',
      challenge: new Uint8Array([7]),
      expiresAt: new Date(now.getTime() + 300_000),
      now,
    });
    const claimed = await claimChallenge(db, {
      id,
      purpose: 'webauthn_auth',
      now: new Date(now.getTime() + 1000),
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.userId).toBeNull();
  });
});
