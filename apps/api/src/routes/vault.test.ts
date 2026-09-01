import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const N24 = (fill: number): string => Buffer.from(new Uint8Array(24).fill(fill)).toString('base64');
const b64 = (arr: number[]): string => Buffer.from(new Uint8Array(arr)).toString('base64');

function createBody(tier: 's1' | 's2' | 's3', over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Client-chosen since F3 — both AAD layers bind it.
    id: randomUUID(),
    tier,
    category: 'recovery_instructions',
    contentCiphertext: b64([1, 2, 3, 4]),
    contentNonce: N24(7),
    wrappedPerItemKey: b64([5, 6, 7]),
    wrappedPerItemKeyNonce: N24(8),
    titleCiphertext: b64([9, 9]),
    titleNonce: b64([3, 3]),
    contentSizeBytes: 4,
    ...over,
  };
}

describeIfDb('vault item CRUD (route, end-to-end)', () => {
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
    await sql`TRUNCATE vault_items, outer_layer_keys, engine_states, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  // An owner = a user WITH master-key material (passes requireVaultOwner).
  async function makeOwner(email: string): Promise<{ userId: UserId; cookie: string }> {
    const userId = await makeUser(email);
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
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token };
  }
  function as(cookie: string): { [k: string]: string } {
    return { [SESSION_COOKIE]: cookie };
  }

  it('refuses a vault route for a contact-only account (no master-key material) with 409', async () => {
    const userId = await makeUser('contact-only@example.com');
    const { token } = await createSession(db, { userId, now: new Date() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/items',
      cookies: as(token),
      payload: createBody('s2'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-owner-required');
  });

  it('creates an item and fetches it back with byte-identical inner ciphertext', async () => {
    const { cookie } = await makeOwner('owner@example.com');
    const body = createBody('s2', { contentCiphertext: b64([200, 201, 202, 1, 2]), contentSizeBytes: 5 });
    const create = await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: body });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const get = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    expect(get.statusCode).toBe(200);
    const item = get.json();
    expect(item.tier).toBe('s2');
    expect(item.category).toBe('recovery_instructions');
    // The inner ciphertext the client sent comes back exactly (server stored the
    // OUTER envelope, removed the wrap on fetch).
    expect(item.contentCiphertext).toBe(body['contentCiphertext']);
    expect(item.contentNonce).toBe(body['contentNonce']);
    expect(item.wrappedPerItemKey).toBe(body['wrappedPerItemKey']);
    expect(item.titleCiphertext).toBe(body['titleCiphertext']);
    expect(item.attachments).toEqual([]);
  });

  it('lists items with a tier filter and excludes soft-deleted by default', async () => {
    const { userId, cookie } = await makeOwner('list@example.com');
    await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s1') });
    const second = await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s2') });
    await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s2') });

    const all = await app.inject({ method: 'GET', url: '/v1/vault/items', cookies: as(cookie) });
    expect(all.json().items).toHaveLength(3);
    // list returns metadata + titles, never content.
    expect(all.json().items[0].contentCiphertext).toBeUndefined();
    expect(all.json().items[0].titleCiphertext).toBeDefined();

    const s2only = await app.inject({ method: 'GET', url: '/v1/vault/items?tier=s2', cookies: as(cookie) });
    expect(s2only.json().items).toHaveLength(2);

    // Soft-delete one and confirm it drops from the default list but appears with includeDeleted.
    await db
      .update(schema.vaultItems)
      .set({ deletedAt: new Date() })
      .where(eq(schema.vaultItems.id, second.json().id));
    expect((await app.inject({ method: 'GET', url: '/v1/vault/items', cookies: as(cookie) })).json().items).toHaveLength(2);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/vault/items?includeDeleted=true', cookies: as(cookie) })).json().items,
    ).toHaveLength(3);
    void userId;
  });

  // The list row is the ONLY input the client has when it decrypts a title: it
  // rebuilds the AAD from (tier, id) and asserts the version first, so a missing
  // aadVersion is not a cosmetic gap — it fails every title in the vault closed.
  // The field was selected from the table and then dropped on the way out, which
  // the web unit tests could not see because they mock the response with the
  // field already present. Assert it against the item GET so the two cannot drift.
  it('carries aadVersion on every list row (the client needs it to rebuild the title AAD)', async () => {
    const { cookie } = await makeOwner('aad-list@example.com');
    const create = await app.inject({
      method: 'POST',
      url: '/v1/vault/items',
      cookies: as(cookie),
      payload: createBody('s2'),
    });
    expect(create.statusCode).toBe(201);

    const one = await app.inject({
      method: 'GET',
      url: `/v1/vault/items/${create.json().id}`,
      cookies: as(cookie),
    });
    const list = await app.inject({ method: 'GET', url: '/v1/vault/items', cookies: as(cookie) });
    const [row] = list.json().items;

    expect(row.aadVersion).toBe(2);
    expect(row.aadVersion).toBe(one.json().aadVersion);
  });

  it('patches metadata immediately and re-wraps replaced content', async () => {
    const { cookie } = await makeOwner('patch@example.com');
    const { id } = (
      await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s2') })
    ).json();

    // Metadata-only patch.
    const meta = await app.inject({
      method: 'PATCH',
      url: `/v1/vault/items/${id}`,
      cookies: as(cookie),
      payload: { category: 'crypto_wallets' },
    });
    expect(meta.statusCode).toBe(200);

    // Content replacement.
    const newContent = b64([42, 43, 44, 45, 46, 47]);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/vault/items/${id}`,
      cookies: as(cookie),
      payload: {
        contentCiphertext: newContent,
        contentNonce: N24(11),
        wrappedPerItemKey: b64([1, 1, 1]),
        wrappedPerItemKeyNonce: N24(12),
        contentSizeBytes: 6,
      },
    });
    expect(patch.statusCode).toBe(200);

    const item = (await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) })).json();
    expect(item.category).toBe('crypto_wallets');
    expect(item.contentCiphertext).toBe(newContent);
    expect(item.contentNonce).toBe(N24(11));
  });

  it('refuses a tier change via PATCH with 422 (it is a sensitive action)', async () => {
    const { cookie } = await makeOwner('tier@example.com');
    const { id } = (
      await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s2') })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/vault/items/${id}`,
      cookies: as(cookie),
      payload: { tier: 's1' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-tier-change-is-sensitive');
  });

  it('refuses writes while the engine is in a release state (409 vault-locked)', async () => {
    const { userId, cookie } = await makeOwner('locked@example.com');
    const { id } = (
      await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s2') })
    ).json();
    await db.insert(schema.engineStates).values({ userId, state: 'release_review' });

    const create = await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s1') });
    expect(create.statusCode).toBe(409);
    expect(create.json().type).toBe('https://truecairn.app/problems/vault-locked-during-release');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/vault/items/${id}`,
      cookies: as(cookie),
      payload: { category: 'personal_archive' },
    });
    expect(patch.statusCode).toBe(409);
  });

  it('an owner read during a release state pauses the ladder (→ returning) and is still served', async () => {
    const { userId, cookie } = await makeOwner('returning@example.com');
    // Create while writable, then drop into a release state.
    const { id } = (
      await app.inject({ method: 'POST', url: '/v1/vault/items', cookies: as(cookie), payload: createBody('s3') })
    ).json();
    await db.insert(schema.engineStates).values({ userId, state: 'limited_release' });

    const get = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    expect(get.statusCode).toBe(200); // the read is served — it's the owner's data
    expect(get.json().contentCiphertext).toBe(b64([1, 2, 3, 4]));

    // The engine paused: limited_release → returning.
    const [es] = await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, userId));
    expect(es!.state).toBe('returning');

    // The release-state read is audited.
    const events = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId))
    ).map((e) => e.eventType);
    expect(events).toContain('vault.fetched_during_release');
    expect(events).toContain('engine.entered_returning');
  });
});
