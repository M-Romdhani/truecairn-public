import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { PLAN_LIMITS, type UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { storageCapBytes } from '../billing/limits.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

// Per-plan resource caps (docs/28): contacts, vault items, and storage are the
// REAL difference between Free and Personal — not just SMS/WhatsApp. Over-cap
// creates fail closed with 402 upgrade-required; a paid (pro) account lifts them.

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const b64 = (arr: number[]): string => Buffer.from(new Uint8Array(arr)).toString('base64');
const N24 = (fill: number): string => Buffer.from(new Uint8Array(24).fill(fill)).toString('base64');

function itemBody(): Record<string, unknown> {
  return {
    // Client-chosen since F3 — both AAD layers bind it.
    id: randomUUID(),
    tier: 's1',
    category: 'personal_archive',
    contentCiphertext: b64([1, 2, 3, 4]),
    contentNonce: N24(7),
    wrappedPerItemKey: b64([5, 6, 7]),
    wrappedPerItemKeyNonce: N24(8),
    titleCiphertext: b64([9, 9]),
    titleNonce: b64([3, 3]),
    contentSizeBytes: 4,
  };
}

function contactBody(): Record<string, unknown> {
  return { role: 'personal', displayLabelCiphertext: b64([1, 2]), displayLabelNonce: b64([3, 4]) };
}

describeIfDb('per-plan resource limits (Free vs Personal)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({
    TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
    OUTER_LAYER_KEK: Buffer.alloc(32, 5).toString('base64'),
  });

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
    await sql`TRUNCATE billing_subscriptions, contacts, vault_items, outer_layer_keys, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeOwner(email: string, pro = false): Promise<{ userId: UserId; cookie: { [k: string]: string } }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const ph = new Uint8Array(16);
    await db.insert(schema.userKeyMaterial).values({
      userId,
      masterPassphraseSalt: ph,
      masterKeyWrappedByPassphrase: ph,
      masterKeyPassphraseNonce: ph,
      recoveryCodeSalt: ph,
      masterKeyWrappedByRecovery: ph,
      masterKeyRecoveryNonce: ph,
      releasePassphraseSalt: ph,
      auditSigningPubkey: new Uint8Array(32),
    });
    if (pro) {
      await db
        .insert(schema.billingSubscriptions)
        .values({ userId, lsSubscriptionId: `sub-${email}`, status: 'active' });
    }
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: { [SESSION_COOKIE]: token } };
  }

  const addContact = (cookie: { [k: string]: string }) =>
    app.inject({ method: 'POST', url: '/v1/contacts', cookies: cookie, payload: contactBody() });
  const addItem = (cookie: { [k: string]: string }) =>
    app.inject({ method: 'POST', url: '/v1/vault/items', cookies: cookie, payload: itemBody() });

  it('Free: caps trusted contacts at 2, then 402 upgrade-required', async () => {
    const { cookie } = await makeOwner('free-contacts@example.com');
    expect((await addContact(cookie)).statusCode).toBe(200);
    expect((await addContact(cookie)).statusCode).toBe(200);
    const third = await addContact(cookie);
    expect(third.statusCode).toBe(402);
    const problem = third.json();
    expect(problem.type).toBe('https://truecairn.app/problems/upgrade-required');
    expect(problem.resource).toBe('contacts');
    expect(problem.limit).toBe(PLAN_LIMITS.free.maxContacts);
  });

  it('Personal (pro): trusted-contact cap is lifted', async () => {
    const { cookie } = await makeOwner('pro-contacts@example.com', true);
    for (let i = 0; i < 4; i++) expect((await addContact(cookie)).statusCode).toBe(200);
  });

  it('Free: caps vault items at 5, then 402 upgrade-required', async () => {
    const { cookie } = await makeOwner('free-items@example.com');
    for (let i = 0; i < 5; i++) expect((await addItem(cookie)).statusCode).toBe(201);
    const sixth = await addItem(cookie);
    expect(sixth.statusCode).toBe(402);
    expect(sixth.json().resource).toBe('vault_items');
    expect(sixth.json().limit).toBe(PLAN_LIMITS.free.maxVaultItems);
  });

  it('Personal (pro): vault-item cap is lifted', async () => {
    const { cookie } = await makeOwner('pro-items@example.com', true);
    for (let i = 0; i < 7; i++) expect((await addItem(cookie)).statusCode).toBe(201);
  });

  it('storage cap follows the plan (Free small, Personal large)', async () => {
    const free = await makeOwner('free-storage@example.com');
    const pro = await makeOwner('pro-storage@example.com', true);
    const ceiling = 10 * 1024 * 1024 * 1024; // above both plans
    expect(await storageCapBytes(db, free.userId, new Date(), ceiling)).toBe(
      PLAN_LIMITS.free.maxStorageBytes,
    );
    expect(await storageCapBytes(db, pro.userId, new Date(), ceiling)).toBe(
      PLAN_LIMITS.pro.maxStorageBytes,
    );
    // A tighter operator ceiling wins over the (larger) plan budget.
    expect(await storageCapBytes(db, pro.userId, new Date(), 1024)).toBe(1024);
  });

  it('usage endpoint reports counts vs the plan limits', async () => {
    const { cookie } = await makeOwner('usage@example.com');
    await addContact(cookie);
    await addItem(cookie);
    await addItem(cookie);
    const res = await app.inject({ method: 'GET', url: '/v1/account/usage', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plan: 'free',
      contacts: { used: 1, limit: PLAN_LIMITS.free.maxContacts },
      vaultItems: { used: 2, limit: PLAN_LIMITS.free.maxVaultItems },
      storageBytes: { used: 0, limit: PLAN_LIMITS.free.maxStorageBytes },
    });

    const proUser = await makeOwner('usage-pro@example.com', true);
    const proRes = await app.inject({
      method: 'GET',
      url: '/v1/account/usage',
      cookies: proUser.cookie,
    });
    expect(proRes.json()).toMatchObject({
      plan: 'pro',
      contacts: { limit: null },
      vaultItems: { limit: null },
      storageBytes: { limit: PLAN_LIMITS.pro.maxStorageBytes },
    });
  });
});
