import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import {
  buildOuterLayerAad,
  generateOuterLayerKey,
  wrapOuterLayerKey,
  type OuterLayerKek,
} from '@truecairn/keys';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { envKekProvider, type KekProvider } from './kek.js';
import { applyTierMove, createVaultItem, decryptOuterEnvelope, type InnerBytes } from './store.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// Two KEKs in the ring so the AAD test can retarget kek_id to a real-but-wrong
// key (proving the binding), not just an absent one.
const KEK_A = { id: 'outer_layer-aaaaaaaaaaaa', key: new Uint8Array(32).fill(1) };
const KEK_B = { id: 'outer_layer-bbbbbbbbbbbb', key: new Uint8Array(32).fill(2) };
// The env-backed KEK provider (the historical default). Two KEKs in the ring so
// the AAD test can retarget kek_id to a real-but-wrong key.
const keks: KekProvider = envKekProvider({
  currentId: KEK_A.id,
  byId: new Map([
    [KEK_A.id, KEK_A],
    [KEK_B.id, KEK_B],
  ]),
});

// A representative inner bundle. Nonces MUST be 24 bytes (the secretbox nonce
// length the bundle (de)serializer asserts); the ciphertext bodies are arbitrary.
function inner(seed: number): InnerBytes {
  return {
    contentCiphertext: new Uint8Array([seed, seed + 1, seed + 2, 250, 251, 252]),
    contentNonce: new Uint8Array(24).fill(seed),
    wrappedPerItemKey: new Uint8Array([seed + 10, seed + 11, seed + 12]),
    wrappedPerItemKeyNonce: new Uint8Array(24).fill(seed + 5),
  };
}

describeIfDb('vault outer-layer wrap (integration)', () => {
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
    await sql`TRUNCATE vault_items, outer_layer_keys, users CASCADE`;
  });

  async function makeOwner(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function store(userId: UserId, tier: 's1' | 's2' | 's3', body: InnerBytes): Promise<string> {
    const { id } = await createVaultItem(db, keks, {
      id: randomUUID(),
      userId,
      tier,
      category: 'recovery_instructions',
      inner: body,
      titleCiphertext: new Uint8Array([9, 9, 9]),
      titleNonce: new Uint8Array(24).fill(3),
      contentSizeBytes: body.contentCiphertext.length,
      clientOrdinal: null,
      now: new Date(),
    });
    return id;
  }
  async function loadItem(id: string): Promise<typeof schema.vaultItems.$inferSelect> {
    const [row] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, id));
    if (!row) throw new Error('item not found');
    return row;
  }

  // PROPERTY (a) — the load-bearing one: store → outer-wrap → DB → fetch →
  // outer-unwrap → byte-identical to what the client sent. Nothing re-derived.
  it('round-trips the exact inner bytes through the outer wrap', async () => {
    const userId = await makeOwner('owner@example.com');
    const body = inner(40);
    const id = await store(userId, 's2', body);

    const item = await loadItem(id);
    expect(Buffer.from(item.outerCiphertext)).not.toEqual(Buffer.from(body.contentCiphertext));
    expect(item.outerKekId).toBe(KEK_A.id);
    expect(item.outerGeneration).toBe(1);

    const got = await decryptOuterEnvelope(db, keks, item);
    expect(Buffer.from(got.contentCiphertext)).toEqual(Buffer.from(body.contentCiphertext));
    expect(Buffer.from(got.contentNonce)).toEqual(Buffer.from(body.contentNonce));
    expect(Buffer.from(got.wrappedPerItemKey)).toEqual(Buffer.from(body.wrappedPerItemKey));
    expect(Buffer.from(got.wrappedPerItemKeyNonce)).toEqual(Buffer.from(body.wrappedPerItemKeyNonce));
  });

  // PROPERTY (b) — AAD binding: changing the (user_id, tier, kek_id, generation)
  // the AAD binds, between wrap and unwrap, must fail.
  it('fails the unwrap when the bound generation is tampered', async () => {
    const userId = await makeOwner('gen@example.com');
    const id = await store(userId, 's2', inner(50));
    await db.update(schema.vaultItems).set({ outerGeneration: 2 }).where(eq(schema.vaultItems.id, id));
    const item = await loadItem(id);
    await expect(decryptOuterEnvelope(db, keks, item)).rejects.toThrow();
  });

  it('fails the unwrap when the bound kek_id is retargeted to a different real KEK', async () => {
    const userId = await makeOwner('kek@example.com');
    const id = await store(userId, 's2', inner(60));
    await db.update(schema.vaultItems).set({ outerKekId: KEK_B.id }).where(eq(schema.vaultItems.id, id));
    const item = await loadItem(id);
    await expect(decryptOuterEnvelope(db, keks, item)).rejects.toThrow();
  });

  // PROPERTY (c) — generation rotation: an item sealed under generation N stays
  // readable after the active key rotates to N+1.
  it('still unwraps an item after its outer key generation is rotated', async () => {
    const userId = await makeOwner('rot@example.com');
    const bodyOld = inner(70);
    const oldId = await store(userId, 's2', bodyOld);

    const [g1] = await db
      .select()
      .from(schema.outerLayerKeys)
      .where(and(eq(schema.outerLayerKeys.userId, userId), eq(schema.outerLayerKeys.tier, 's2')));
    await db
      .update(schema.outerLayerKeys)
      .set({ rotatedAt: new Date() })
      .where(eq(schema.outerLayerKeys.id, g1!.id));

    const gen2 = generateOuterLayerKey();
    const aad2 = buildOuterLayerAad({ userId, tier: 's2', kekId: KEK_A.id, generation: 2 });
    const sealed2 = wrapOuterLayerKey(gen2, KEK_A.key as unknown as OuterLayerKek, aad2);
    await db.insert(schema.outerLayerKeys).values({
      userId,
      tier: 's2',
      kekId: KEK_A.id,
      outerKeyEncrypted: sealed2.ciphertext,
      outerKeyNonce: sealed2.nonce,
      outerKeyEncryptionAad: sealed2.aad,
      generation: 2,
    });

    const bodyNew = inner(80);
    const newId = await store(userId, 's2', bodyNew);
    const newItem = await loadItem(newId);
    expect(newItem.outerGeneration).toBe(2);
    expect(Buffer.from((await decryptOuterEnvelope(db, keks, newItem)).contentCiphertext)).toEqual(
      Buffer.from(bodyNew.contentCiphertext),
    );

    const oldItem = await loadItem(oldId);
    expect(oldItem.outerGeneration).toBe(1);
    expect(Buffer.from((await decryptOuterEnvelope(db, keks, oldItem)).contentCiphertext)).toEqual(
      Buffer.from(bodyOld.contentCiphertext),
    );
  });

  // Tier-move re-wrap (the worker handler's core): the content ciphertext is
  // byte-identical before/after; only the per-item-key wrap + the outer layer
  // (now the destination tier's key) change.
  it('re-wraps an item to a new tier with byte-identical content ciphertext', async () => {
    const userId = await makeOwner('move@example.com');
    const body = inner(90);
    const id = await store(userId, 's3', body);
    const before = await loadItem(id);

    const newWrappedKey = new Uint8Array([7, 7, 7, 7]);
    const newWrappedKeyNonce = new Uint8Array(24).fill(15);
    const rewrapped = await applyTierMove(db, keks, before, 's1', newWrappedKey, newWrappedKeyNonce);
    await db
      .update(schema.vaultItems)
      .set({
        tier: 's1',
        outerCiphertext: rewrapped.outerCiphertext,
        outerNonce: rewrapped.outerNonce,
        outerLayerKeyId: rewrapped.outerLayerKeyId,
        outerKekId: rewrapped.outerKekId,
        outerGeneration: rewrapped.outerGeneration,
      })
      .where(eq(schema.vaultItems.id, id));

    const after = await loadItem(id);
    expect(after.tier).toBe('s1');
    // The destination tier got its own (newly provisioned) outer key.
    expect(after.outerLayerKeyId).not.toBe(before.outerLayerKeyId);
    const got = await decryptOuterEnvelope(db, keks, after);
    // Content ciphertext is byte-identical; the wrapped item key is the new one.
    expect(Buffer.from(got.contentCiphertext)).toEqual(Buffer.from(body.contentCiphertext));
    expect(Buffer.from(got.contentNonce)).toEqual(Buffer.from(body.contentNonce));
    expect(Buffer.from(got.wrappedPerItemKey)).toEqual(Buffer.from(newWrappedKey));
  });
});
