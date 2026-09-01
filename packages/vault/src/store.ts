// Vault item storage: the server-applied OUTER temporal-gate layer (PHASE3_3 §c).
//
// The client computes the inner form (content ciphertext + wrapped-per-item-key,
// both opaque to us). On store we seal that inner bundle inside the per-tier
// outer-layer key (packages/keys applyOuterLayerWrap) and persist only the
// envelope; on fetch we remove the wrap and hand the client back its EXACT inner
// bytes. The server never sees plaintext — the outer key is a temporal gate, not
// a confidentiality key; the inner wraps still need the master passphrase we
// never hold. The wrap is byte-honest: removeOuterLayerWrap∘applyOuterLayerWrap
// is the identity, proven in the round-trip integration test.
//
// This logic lives in @truecairn/vault (not the API) so the API routes AND the
// worker's set_vault_item_tier handler share one implementation — the tier-move
// re-wrap is the same provision/unwrap/wrap composition as an initial store.

import { schema, type Database } from '@truecairn/db';
import {
  applyOuterLayerWrap,
  buildOuterLayerAad,
  generateOuterLayerKey,
  ITEM_AAD_VERSION_CURRENT,
  makeInnerVaultBundle,
  removeOuterLayerWrap,
  type ItemContentCiphertext,
  type ItemKeyWrappedByTier,
  type OuterWrappedVaultBundle,
  type UnwrappedOuterLayerKey,
} from '@truecairn/keys';
import type { UserId, VaultCategory, VaultTier } from '@truecairn/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { KekProvider } from './kek.js';

// The inner bundle in raw bytes, as it crosses the API boundary (request on
// store, response on fetch). Opaque to the server.
export interface InnerBytes {
  contentCiphertext: Uint8Array;
  contentNonce: Uint8Array;
  wrappedPerItemKey: Uint8Array;
  wrappedPerItemKeyNonce: Uint8Array;
}

export interface CreateVaultItemInput {
  // Chosen by the CLIENT before it encrypts anything, because both AAD layers
  // bind it (F3). The server used to assign this, which is precisely why the
  // binding did not exist.
  id: string;
  userId: UserId;
  tier: VaultTier;
  // Bounded by migration 0065's CHECK, mirrored by the route schema. Typed here
  // rather than `string` so a caller that invents a category fails at compile
  // time instead of at the database — same treatment `tier` already gets.
  category: VaultCategory;
  inner: InnerBytes;
  titleCiphertext: Uint8Array;
  titleNonce: Uint8Array;
  contentSizeBytes: number;
  clientOrdinal: number | null;
  now: Date;
}

// The new envelope + binding columns a tier-move produces, for the handler to
// persist atomically with the tier flip.
export interface RewrappedEnvelope {
  outerCiphertext: Uint8Array;
  outerNonce: Uint8Array;
  outerLayerKeyId: string;
  outerKekId: string;
  outerGeneration: number;
}

// OuterKekUnavailableError moved to kek.ts (raised by KekProviders); still
// re-exported from @truecairn/vault via the package index.

// Create a vault item: provision-or-load the tier's outer key, seal the inner
// bundle inside it, persist the envelope. Runs in one transaction so a failed
// insert rolls back any just-provisioned outer key (no orphan).
export async function createVaultItem(
  db: Database,
  provider: KekProvider,
  input: CreateVaultItemInput,
): Promise<{ id: string; createdAt: Date }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const outer = await loadOrProvisionOuterKey(tx, provider, input.userId, input.tier);
    const envelope = sealInner(input.inner, input.tier, outer.key);

    const [row] = await tx
      .insert(schema.vaultItems)
      .values({
        id: input.id,
        userId: input.userId,
        tier: input.tier,
        category: input.category,
        outerCiphertext: envelope.ciphertext,
        outerNonce: envelope.nonce,
        outerLayerKeyId: outer.id,
        outerKekId: outer.kekId,
        outerGeneration: outer.generation,
        contentSizeBytes: input.contentSizeBytes,
        titleCiphertext: input.titleCiphertext,
        titleNonce: input.titleNonce,
        // Every write is v2. There is no path that produces a v1 row.
        aadVersion: ITEM_AAD_VERSION_CURRENT,
        clientOrdinal: input.clientOrdinal,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: schema.vaultItems.id, createdAt: schema.vaultItems.createdAt });
    if (!row) throw new Error('vault_items insert returned no row');
    return row;
  });
}

// Re-seal an item's (possibly new) inner bundle under its EXISTING outer key —
// a content PATCH. Same tier + outer key, so the binding columns are unchanged.
export async function rewrapInnerForUpdate(
  db: Database,
  provider: KekProvider,
  item: typeof schema.vaultItems.$inferSelect,
  inner: InnerBytes,
): Promise<OuterWrappedVaultBundle> {
  const outerKey = await unwrapItemOuterKey(db, provider, item);
  return sealInner(inner, item.tier, outerKey);
}

// Apply a tier move: re-wrap the item's inner bundle from its current tier's
// outer key to NEW tier's outer key. The content ciphertext is UNCHANGED (the
// per-item key didn't change); only the per-item-key wrapping (client-supplied,
// re-wrapped under the new tier key) and the server outer layer change. The
// destination tier's outer key is provisioned if this is the first item to land
// there — the same path as an initial store. Runs in the handler's transaction.
export async function applyTierMove(
  tx: Database,
  provider: KekProvider,
  item: typeof schema.vaultItems.$inferSelect,
  newTier: VaultTier,
  newWrappedPerItemKey: Uint8Array,
  newWrappedPerItemKeyNonce: Uint8Array,
): Promise<RewrappedEnvelope> {
  // Recover the existing content ciphertext (NOT re-derived) by removing the
  // old tier's outer wrap.
  const old = await decryptOuterEnvelope(tx, provider, item);
  const outer = await loadOrProvisionOuterKey(tx, provider, item.userId as UserId, newTier);
  const envelope = sealInner(
    {
      contentCiphertext: old.contentCiphertext,
      contentNonce: old.contentNonce,
      wrappedPerItemKey: newWrappedPerItemKey,
      wrappedPerItemKeyNonce: newWrappedPerItemKeyNonce,
    },
    newTier,
    outer.key,
  );
  return {
    outerCiphertext: envelope.ciphertext,
    outerNonce: envelope.nonce,
    outerLayerKeyId: outer.id,
    outerKekId: outer.kekId,
    outerGeneration: outer.generation,
  };
}

// Remove the outer wrap and return the client's exact inner bytes.
export async function decryptOuterEnvelope(
  db: Database,
  provider: KekProvider,
  item: typeof schema.vaultItems.$inferSelect,
): Promise<InnerBytes> {
  const outerKey = await unwrapItemOuterKey(db, provider, item);
  const envelope = {
    ciphertext: item.outerCiphertext,
    nonce: item.outerNonce,
  } as unknown as OuterWrappedVaultBundle;
  const inner = removeOuterLayerWrap(envelope, outerKey);
  return {
    contentCiphertext: inner.contentCiphertext.ciphertext,
    contentNonce: inner.contentCiphertext.nonce,
    wrappedPerItemKey: inner.wrappedItemKey.ciphertext,
    wrappedPerItemKeyNonce: inner.wrappedItemKey.nonce,
  };
}

function sealInner(inner: InnerBytes, tier: VaultTier, outerKey: UnwrappedOuterLayerKey): OuterWrappedVaultBundle {
  const bundle = makeInnerVaultBundle(
    asContentCiphertext(inner.contentCiphertext, inner.contentNonce),
    asWrappedItemKey(inner.wrappedPerItemKey, inner.wrappedPerItemKeyNonce, tier),
  );
  return applyOuterLayerWrap(bundle, outerKey);
}

// Rebuild the wrap AAD from the item's denormalised binding columns and unwrap
// the per-tier outer key. The AAD binds (user_id, tier, kek_id, generation);
// tampering any of those columns makes the rebuilt AAD diverge from the one the
// outer key was sealed with, and the unwrap fails — that's the integrity gate.
async function unwrapItemOuterKey(
  db: Database,
  provider: KekProvider,
  item: typeof schema.vaultItems.$inferSelect,
): Promise<UnwrappedOuterLayerKey> {
  const [olk] = await db
    .select()
    .from(schema.outerLayerKeys)
    .where(eq(schema.outerLayerKeys.id, item.outerLayerKeyId))
    .limit(1);
  if (!olk) throw new Error('outer_layer_keys row missing for vault item');

  // The AAD is rebuilt from the item's authoritative binding columns (user_id,
  // tier, kek_id, generation); the provider AEAD-binds it on unwrap, so tampering
  // any of those columns makes the binding diverge and the unwrap fails.
  const aad = buildOuterLayerAad({
    userId: item.userId,
    tier: item.tier,
    kekId: item.outerKekId,
    generation: item.outerGeneration,
  });
  return (await provider.unwrap(
    item.outerKekId,
    { ciphertext: olk.outerKeyEncrypted, nonce: olk.outerKeyNonce },
    aad,
  )) as UnwrappedOuterLayerKey;
}

export interface OuterKeyHandle {
  key: UnwrappedOuterLayerKey;
  id: string;
  kekId: string;
  generation: number;
}

// Load the active outer key for (user, tier), provisioning one on first use.
// MUST run in a transaction. The partial-unique index on (user_id, tier) WHERE
// active guarantees at most one active key; a rare concurrent first-store loses
// the insert race and the request retries (then finds the existing key).
//
// Exported so enrollment key-material provisioning (PHASE4 C1) can create the
// per-tier outer keys eagerly — user_tier_keys.outer_layer_key_id is NOT NULL,
// so a tier key needs its outer key to exist at provision time. The vault store
// path then finds it via the load branch on first item store. One implementation.
export async function loadOrProvisionOuterKey(
  tx: Database,
  provider: KekProvider,
  userId: UserId,
  tier: VaultTier,
): Promise<OuterKeyHandle> {
  const existing = await tx
    .select()
    .from(schema.outerLayerKeys)
    .where(
      and(
        eq(schema.outerLayerKeys.userId, userId),
        eq(schema.outerLayerKeys.tier, tier),
        isNull(schema.outerLayerKeys.releasedAt),
        isNull(schema.outerLayerKeys.rotatedAt),
      ),
    )
    .for('update')
    .limit(1);

  const row = existing[0];
  if (row) {
    const aad = buildOuterLayerAad({
      userId,
      tier,
      kekId: row.kekId,
      generation: row.generation,
    });
    const key = (await provider.unwrap(
      row.kekId,
      { ciphertext: row.outerKeyEncrypted, nonce: row.outerKeyNonce },
      aad,
    )) as UnwrappedOuterLayerKey;
    return { key, id: row.id, kekId: row.kekId, generation: row.generation };
  }

  const kekId = provider.currentKekId;
  const generation = 1;
  const key = generateOuterLayerKey();
  // The AAD binds the kekId the provider will use (known upfront via currentKekId),
  // so the binding is fixed before the wrap. The provider raises
  // OuterKekUnavailableError if the current KEK isn't usable (env: empty ring).
  const aad = buildOuterLayerAad({ userId, tier, kekId, generation });
  const sealed = await provider.wrap(key, aad);
  const [inserted] = await tx
    .insert(schema.outerLayerKeys)
    .values({
      userId,
      tier,
      kekId,
      outerKeyEncrypted: sealed.ciphertext,
      outerKeyNonce: sealed.nonce,
      outerKeyEncryptionAad: aad,
      generation,
    })
    .returning({ id: schema.outerLayerKeys.id });
  if (!inserted) throw new Error('outer_layer_keys insert returned no row');
  return { key, id: inserted.id, kekId, generation };
}

function asContentCiphertext(ciphertext: Uint8Array, nonce: Uint8Array): ItemContentCiphertext {
  return { ciphertext, nonce } as unknown as ItemContentCiphertext;
}

function asWrappedItemKey(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  tier: VaultTier,
): ItemKeyWrappedByTier {
  return { ciphertext, nonce, tier } as unknown as ItemKeyWrappedByTier;
}
