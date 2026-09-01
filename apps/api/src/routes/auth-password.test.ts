import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { initCrypto } from '@truecairn/crypto';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/password.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_KEK_B64 = Buffer.alloc(32, 7).toString('base64');
const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const PASSWORD = 'correct horse battery staple';
const TEST_CONFIG = loadConfig({ TOTP_KEK: TOTP_KEK_B64 });
const CURRENT_KEK = TEST_CONFIG.totpKeks.byId.get(TEST_CONFIG.totpKeks.currentId)!;

describeIfDb('password + TOTP login (integration)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;

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
    await sql`TRUNCATE password_credentials, totp_credentials, webauthn_credentials, sessions, users CASCADE`;
    app = buildApp({ ...TEST_CONFIG, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // Seeds a user with a password + confirmed TOTP (and optionally a passkey).
  async function seedUser(email: string, opts: { passkey?: boolean } = {}): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    await db.insert(schema.passwordCredentials).values({ userId: u.id, argon2Phc: hashPassword(PASSWORD) });
    const enc = encryptTotpSecret(CURRENT_KEK.key, TOTP_SECRET);
    await db.insert(schema.totpCredentials).values({
      userId: u.id,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: CURRENT_KEK.id,
      confirmedAt: new Date(),
    });
    if (opts.passkey === true) {
      await db.insert(schema.webauthnCredentials).values({
        userId: u.id,
        credentialId: new Uint8Array([1, 2, 3, 4]),
        publicKey: new Uint8Array([9, 9, 9]),
        signCount: 0,
      });
    }
    return u.id as UserId;
  }

  function login(email: string, password: string, totp: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login/password',
      payload: { email, password, totp },
    });
  }

  it('mints a session for a correct password + TOTP (no passkey)', async () => {
    const userId = await seedUser('a@example.com');
    const res = await login('a@example.com', PASSWORD, totpCode(TOTP_SECRET, new Date()));
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(userId);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
  });

  it('rejects a wrong password with a generic 401', async () => {
    await seedUser('b@example.com');
    const res = await login('b@example.com', 'wrong', totpCode(TOTP_SECRET, new Date()));
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe('about:blank');
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });

  it('rejects a wrong TOTP with a generic 401', async () => {
    await seedUser('c@example.com');
    const res = await login('c@example.com', PASSWORD, '000000');
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe('about:blank');
  });

  it('rejects an unknown email with the same generic 401', async () => {
    const res = await login('nobody@example.com', PASSWORD, totpCode(TOTP_SECRET, new Date()));
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe('about:blank');
    expect(res.json().title).toBe('Unauthorized');
  });

  it('Q9: when a passkey exists, password+TOTP is refused (no downgrade)', async () => {
    await seedUser('d@example.com', { passkey: true });
    const res = await login('d@example.com', PASSWORD, totpCode(TOTP_SECRET, new Date()));
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe('https://truecairn.app/problems/password-blocked-by-passkey');
    // The hard-block mints no session.
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });

  it('constant-time: unknown-email and wrong-password timings are indistinguishable', async () => {
    await seedUser('known@example.com');
    const valid = () => totpCode(TOTP_SECRET, new Date());

    async function median(fn: () => Promise<unknown>, runs: number): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await fn();
        samples.push(performance.now() - t);
      }
      samples.sort((x, y) => x - y);
      return samples[Math.floor(samples.length / 2)]!;
    }

    const unknown = await median(() => login('ghost@example.com', PASSWORD, valid()), 4);
    const wrongPassword = await median(() => login('known@example.com', 'nope', valid()), 4);

    // Both must have done the full Argon2id verify (a fast path for unknown
    // email would be sub-millisecond, not tens of ms).
    expect(unknown).toBeGreaterThan(5);
    expect(wrongPassword).toBeGreaterThan(5);
    // ...and be close: the only difference is a couple of DB lookups, dwarfed by
    // the constant Argon2id cost. A leak would be a large multiplicative gap.
    const lo = Math.min(unknown, wrongPassword);
    expect(Math.abs(unknown - wrongPassword)).toBeLessThan(lo * 0.5);
  });
});
