import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import {
  VAULT_ATTACHMENT_DTO_FIELDS,
  VAULT_ATTACHMENT_SUMMARY_DTO_FIELDS,
  VAULT_ITEM_DTO_FIELDS,
  VAULT_LIST_DTO_FIELDS,
  VAULT_LIST_ITEM_DTO_FIELDS,
  type UserId,
} from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE RESPONSE-CONTRACT GATE (runtime half — see packages/shared/src/contracts.ts
// for the type half and the reasoning).
//
// What this closes. Three shipped defects had one shape: the server stopped
// serializing a field the client needs and nothing failed, because the API tests
// assert the DATABASE and the web tests mock the SERVER. Nothing in 1,547 tests
// looked at the bytes on the wire. `aadVersion` disappeared from the list route
// and every vault title read "Title unavailable" in production (#171);
// `pendingDeleteAt` is written by the delete route and returned by nothing.
//
// The assertion is EXACT key-set equality, in both directions, and both
// directions are load-bearing:
//   - missing key  → the client silently loses a field it parses (the #171 bug);
//   - extra key    → the server publishes metadata nobody decided to publish,
//                    which on a zero-knowledge product is a boundary question,
//                    not a tidiness one.
//
// It asserts KEYS, not values — the value assertions already live in vault.test.ts
// and vault-attachments.test.ts. Duplicating them here would make this file
// expensive to keep and easy to weaken.
//
// Fixtures are written straight to the database rather than driven through the
// sensitive-action lane. That is the house DB-precondition style (CLAUDE.md:
// tests compress time via CONFIG and DB writes, never via `if (test)`), and it
// keeps the gate pinned to the SERIALIZER rather than to the flow that happens
// to populate the row.
// ─────────────────────────────────────────────────────────────────────────────

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const N24 = (fill: number): string => Buffer.from(new Uint8Array(24).fill(fill)).toString('base64');
const b64 = (arr: number[]): string => Buffer.from(new Uint8Array(arr)).toString('base64');

// Sorted so the diff on failure names the field, rather than reporting that two
// shuffled arrays are unequal.
function keysOf(o: unknown): string[] {
  return Object.keys(o as Record<string, unknown>).sort();
}
function contract(fields: readonly string[]): string[] {
  return [...fields].sort();
}

describeIfDb('response contracts (what the API serializes IS what the client consumes)', () => {
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
    await sql`TRUNCATE attachments, vault_items, outer_layer_keys, engine_states, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeOwner(email: string): Promise<{ userId: UserId; cookie: string }> {
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
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token };
  }
  function as(cookie: string): { [k: string]: string } {
    return { [SESSION_COOKIE]: cookie };
  }

  async function createItem(cookie: string, tier: 's1' | 's2' | 's3' = 's2'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/items',
      cookies: as(cookie),
      payload: {
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
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function addAttachment(
    userId: UserId,
    itemId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const [a] = await db
      .insert(schema.attachments)
      .values({
        vaultItemId: itemId,
        userId,
        sizeBytes: 181,
        status: 'stored',
        storagePath: `test/${randomUUID()}`,
        ...over,
      })
      .returning({ id: schema.attachments.id });
    return a!.id;
  }

  // ── GET /v1/vault/items/:id ────────────────────────────────────────────────

  it('serializes the full item contract on GET /v1/vault/items/:id', async () => {
    const { cookie } = await makeOwner('item-contract@example.com');
    const id = await createItem(cookie);

    const res = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    expect(keysOf(res.json())).toEqual(contract(VAULT_ITEM_DTO_FIELDS));
  });

  // The regression that made this gate necessary. A scheduled deletion is
  // cancellable for seven days and fully readable meanwhile, so the serialized
  // field is the ONLY way the item it will destroy can say so.
  it('returns pendingDeleteAt with its value once a deletion is scheduled', async () => {
    const { cookie } = await makeOwner('pending-delete@example.com');
    const id = await createItem(cookie);
    const effectiveAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.vaultItems)
      .set({ pendingDeleteAt: effectiveAt })
      .where(eq(schema.vaultItems.id, id));

    const res = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    const body = res.json();
    expect(keysOf(body)).toEqual(contract(VAULT_ITEM_DTO_FIELDS));
    expect(body.pendingDeleteAt).toBe(effectiveAt.toISOString());
    // Scheduled, NOT applied — the item is still live and readable.
    expect(body.deletedAt).toBeNull();
  });

  it('serializes null pendingDeleteAt (present, not absent) on an item with nothing scheduled', async () => {
    const { cookie } = await makeOwner('no-pending@example.com');
    const id = await createItem(cookie);

    const res = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    const body = res.json();
    // `toBeNull` alone would pass on an absent key, which is the exact bug —
    // JSON drops an `undefined` value and the field vanishes without a trace.
    expect(Object.hasOwn(body, 'pendingDeleteAt')).toBe(true);
    expect(body.pendingDeleteAt).toBeNull();
  });

  // ── Embedded attachment summaries ──────────────────────────────────────────

  it('serializes the attachment-summary contract inside an item', async () => {
    const { userId, cookie } = await makeOwner('att-summary@example.com');
    const id = await createItem(cookie);
    await addAttachment(userId, id);

    const res = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    const body = res.json();
    expect(body.attachments).toHaveLength(1);
    expect(keysOf(body.attachments[0])).toEqual(contract(VAULT_ATTACHMENT_SUMMARY_DTO_FIELDS));
  });

  // A purge sets pending_delete_at and LEAVES status on 'stored', so status
  // cannot stand in for it: without the field the client shows a live row and a
  // "Remove (7-day)" button for a file already scheduled for destruction.
  it('surfaces a pending attachment purge in the embedded summary', async () => {
    const { userId, cookie } = await makeOwner('att-purge@example.com');
    const id = await createItem(cookie);
    const effectiveAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await addAttachment(userId, id, { pendingDeleteAt: effectiveAt });

    const res = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    const att = res.json().attachments[0];
    expect(att.status).toBe('stored');
    expect(att.pendingDeleteAt).toBe(effectiveAt.toISOString());
  });

  // ── GET /v1/vault/items ────────────────────────────────────────────────────

  it('serializes the list envelope and row contracts on GET /v1/vault/items', async () => {
    const { cookie } = await makeOwner('list-contract@example.com');
    await createItem(cookie, 's1');
    await createItem(cookie, 's3');

    const res = await app.inject({ method: 'GET', url: '/v1/vault/items', cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(keysOf(body)).toEqual(contract(VAULT_LIST_DTO_FIELDS));
    expect(body.items).toHaveLength(2);
    for (const row of body.items) {
      expect(keysOf(row)).toEqual(contract(VAULT_LIST_ITEM_DTO_FIELDS));
    }
  });

  // The list is where #171 landed, and it is the screen an owner sees first —
  // so the row has to carry the pending state too, not just the detail view.
  it('returns pendingDeleteAt on a list row for an item scheduled for deletion', async () => {
    const { cookie } = await makeOwner('list-pending@example.com');
    const id = await createItem(cookie);
    const effectiveAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.vaultItems)
      .set({ pendingDeleteAt: effectiveAt })
      .where(eq(schema.vaultItems.id, id));

    const res = await app.inject({ method: 'GET', url: '/v1/vault/items', cookies: as(cookie) });
    const row = res.json().items[0];
    expect(row.pendingDeleteAt).toBe(effectiveAt.toISOString());
  });

  // The detail view and the list row must agree about the item they describe.
  // `vault-list-aad` made this argument for aadVersion after the two drifted;
  // the same drift is what let pendingDeleteAt exist on neither.
  it('agrees between the list row and the single-item GET on every shared field', async () => {
    const { cookie } = await makeOwner('list-vs-detail@example.com');
    const id = await createItem(cookie);

    const listRes = await app.inject({ method: 'GET', url: '/v1/vault/items', cookies: as(cookie) });
    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/vault/items/${id}`,
      cookies: as(cookie),
    });
    const row = listRes.json().items[0] as Record<string, unknown>;
    const detail = detailRes.json() as Record<string, unknown>;

    const shared = Object.keys(row).filter((k) => Object.hasOwn(detail, k));
    // Guard the guard: if the two DTOs stopped overlapping, this loop would
    // vacuously pass.
    expect(shared.length).toBeGreaterThanOrEqual(VAULT_LIST_ITEM_DTO_FIELDS.length - 1);
    for (const key of shared) {
      expect({ [key]: row[key] }).toEqual({ [key]: detail[key] });
    }
  });

  // ── GET /v1/vault/items/:id/attachments/:attachmentId ──────────────────────

  // POSITIVE CONTROL. This route already served pendingDeleteAt before the
  // contract existed — it is the pattern the item routes were meant to follow.
  // A gate that only ever fires on known-broken routes cannot be distinguished
  // from a gate whose expectations are simply wrong.
  it('serializes the standalone attachment contract', async () => {
    const { userId, cookie } = await makeOwner('att-contract@example.com');
    const itemId = await createItem(cookie);
    const attachmentId = await addAttachment(userId, itemId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}`,
      cookies: as(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(keysOf(res.json())).toEqual(contract(VAULT_ATTACHMENT_DTO_FIELDS));
  });
});
