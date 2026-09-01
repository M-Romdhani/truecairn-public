import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/password.js';
import { ACCOUNT_MAX_FAILURES, IP_MAX_FAILURES } from '../auth/rate-limit.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_KEK_B64 = Buffer.alloc(32, 7).toString('base64');
const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const PASSWORD = 'correct horse battery staple';
const CONFIG = loadConfig({ TOTP_KEK: TOTP_KEK_B64 });
const KEK = CONFIG.totpKeks.byId.get(CONFIG.totpKeks.currentId)!;

describeIfDb('auth rate limiting (route-level wire shapes)', () => {
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
    await sql`TRUNCATE auth_attempts, password_credentials, totp_credentials, sessions, users CASCADE`;
    // CLIENT_IP_HEADER is what distinguishes one caller from another since QA
    // 2026-08-26 F1. It used to be the leftmost `x-forwarded-for` entry — which
    // the CALLER supplies, so anyone could mint a fresh bucket per request and
    // none of the throttles below actually bound them. Production sets this to
    // `cf-connecting-ip`; the tests use the same mechanism rather than a
    // test-only path (CLAUDE.md invariant 3).
    app = buildApp(
      { ...CONFIG, logLevel: 'silent', clientIpHeader: 'cf-connecting-ip' },
      { db, sql },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function seedUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    await db
      .insert(schema.passwordCredentials)
      .values({ userId: u!.id, argon2Phc: hashPassword(PASSWORD) });
    const enc = encryptTotpSecret(KEK.key, TOTP_SECRET);
    await db.insert(schema.totpCredentials).values({
      userId: u!.id,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: KEK.id,
      confirmedAt: new Date(),
    });
    return u!.id as UserId;
  }

  // A caller identified the way the trusted edge identifies one.
  function login(email: string, password: string, ip: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login/password',
      headers: { 'cf-connecting-ip': ip },
      payload: { email, password, totp: totpCode(TOTP_SECRET, new Date()) },
    });
  }

  // The real attack shape. The caller cannot change what the edge writes, so
  // `cf-connecting-ip` still carries their true address; what they CAN do is add
  // an `x-forwarded-for` of their choosing on top and hope it is believed. Under
  // the pre-fix code it was, and it won.
  function loginForgingXff(email: string, password: string, realIp: string, claimedIp: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login/password',
      headers: { 'cf-connecting-ip': realIp, 'x-forwarded-for': claimedIp },
      payload: { email, password, totp: totpCode(TOTP_SECRET, new Date()) },
    });
  }

  it('locks the account after the per-account threshold; returns 403 account-locked', async () => {
    await seedUser('lock@example.com');
    const ip = '198.51.100.20';

    // ACCOUNT_MAX_FAILURES wrong-password attempts from one IP (well under the
    // per-IP cap) trip the per-account lock.
    let last;
    for (let i = 0; i < ACCOUNT_MAX_FAILURES; i++) {
      last = await login('lock@example.com', 'wrong', ip);
    }
    // The attempt that crosses the threshold surfaces the lock.
    expect(last!.statusCode).toBe(403);
    expect(last!.json().type).toBe('https://truecairn.app/problems/account-locked');
    expect(last!.headers['retry-after']).toBeDefined();
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    expect(last!.json().retryAfterSeconds).toBeGreaterThan(0);

    // Even the CORRECT password is now refused with 403 (account is locked).
    const blocked = await login('lock@example.com', PASSWORD, ip);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().type).toBe('https://truecairn.app/problems/account-locked');
  });

  it('throttles per-IP with a 429 problem + Retry-After (fast-probe-many-emails)', async () => {
    const ip = '198.51.100.30';
    // Distinct unknown emails, one try each — no per-account lock ever fires, but
    // the per-IP counter trips at IP_MAX_FAILURES.
    let res;
    for (let i = 0; i <= IP_MAX_FAILURES; i++) {
      res = await login(`probe${i}@example.com`, 'whatever', ip);
    }
    expect(res!.statusCode).toBe(429);
    expect(res!.headers['content-type']).toContain('application/problem+json');
    expect(res!.json().type).toBe('https://truecairn.app/problems/rate-limited');
    expect(res!.headers['retry-after']).toBeDefined();
    expect(res!.json().retryAfterSeconds).toBeGreaterThan(0);
  }, 30_000);

  it('a different IP is unaffected by another IP being throttled', async () => {
    const badIp = '198.51.100.40';
    for (let i = 0; i <= IP_MAX_FAILURES; i++) {
      await login(`x${i}@example.com`, 'whatever', badIp);
    }
    // The bad IP is now throttled...
    expect((await login('x@example.com', 'whatever', badIp)).statusCode).toBe(429);
    // ...but a fresh IP with an unknown email still gets the normal generic 401.
    const res = await login('someone@example.com', 'whatever', '203.0.113.99');
    expect(res.statusCode).toBe(401);
    // ~30+ sequential Argon2id verifies through the route; generous timeout.
  }, 30_000);

  // ── The F1 regression, pinned at the route rather than in a unit ───────────
  //
  // The test above proves per-IP isolation works. This one proves it cannot be
  // BOUGHT by the caller — which is the half that was broken. Before the fix,
  // `x-forwarded-for` was read leftmost, so an attacker rotating that header
  // escaped the throttle entirely: the assertion below would have returned 401
  // forever instead of 429, and the per-IP ceiling would have bounded nobody.
  //
  // This matters most for step-up TOTP, which by design has NO per-account lock
  // (so the owner cannot be locked out of protective actions) and therefore had
  // no working application-layer brake at all while this was broken.
  it('a throttled caller cannot escape by forging X-Forwarded-For', async () => {
    const realIp = '198.51.100.50';
    for (let i = 0; i <= IP_MAX_FAILURES; i++) {
      await login(`y${i}@example.com`, 'whatever', realIp);
    }
    expect((await login('y@example.com', 'whatever', realIp)).statusCode).toBe(429);

    // Same caller, now ALSO sending an `x-forwarded-for` of their choosing. The
    // edge still writes their true address, so the only question is whether we
    // believe the header they added. We must not: still 429.
    const forged = await loginForgingXff('y@example.com', 'whatever', realIp, '203.0.113.77');
    expect(forged.statusCode).toBe(429);

    // And rotating the forged value does not mint fresh buckets either — the
    // actual attack, which was unlimited before the fix.
    for (const claimed of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      const attempt = await loginForgingXff('y@example.com', 'whatever', realIp, claimed);
      expect(attempt.statusCode, `forged XFF ${claimed} escaped the throttle`).toBe(429);
    }
  }, 30_000);
});
