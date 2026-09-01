import {
  fromBase64,
  randomSecretboxNonce,
  secretboxDecrypt,
  secretboxEncrypt,
  toBase64,
  wipe,
} from '@truecairn/crypto';
import { withTierKey } from '@truecairn/client-crypto';
import {
  assertSupportedItemAadVersion,
  buildItemTitleAad,
  decryptItemContent,
  encryptItemContent,
  generateItemKey,
  ITEM_AAD_VERSION_CURRENT,
  unwrapItemKey,
  wrapItemKey,
  type ItemAadVersion,
  type ItemContentCiphertext,
  type ItemKeyWrappedByTier,
} from '@truecairn/keys';
import type { VaultTier } from '@truecairn/shared';

// Client-side vault item crypto (PHASE4 C3) — the CLIENT half of the
// zero-knowledge guarantee. A random per-item key encrypts the content; the item
// key is wrapped under the (session-held) tier key; the title is encrypted under
// the tier key so the list can show titles from the session alone, without
// fetching each item or its per-item key. Only ciphertext + nonces ever leave the
// browser. Every unwrapped key is zeroized after use (derive-on-demand, §a/Q4).

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface WrappedItem {
  contentCiphertext: string;
  contentNonce: string;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
  contentSizeBytes: number;
}

// The item id is chosen HERE, on the client, before anything is encrypted —
// that is what makes it available to bind into the AAD (F3). The server used to
// assign it, which is the whole reason the binding did not exist.
export function newItemId(): string {
  return crypto.randomUUID();
}

export function wrapItem(
  itemId: string,
  tier: VaultTier,
  title: string,
  content: string,
): WrappedItem {
  const contentBytes = enc.encode(content);
  const titleBytes = enc.encode(title);
  return withTierKey(tier, (tierKey) => {
    const itemKey = generateItemKey();
    try {
      const contentCt = encryptItemContent(contentBytes, itemKey);
      const wrappedKey = wrapItemKey(itemKey, tierKey, itemId);
      const titleNonce = randomSecretboxNonce();
      const titleCt = secretboxEncrypt({
        key: tierKey,
        nonce: titleNonce,
        plaintext: titleBytes,
        additionalData: buildItemTitleAad({ tier, itemId }),
      });
      return {
        contentCiphertext: toBase64(contentCt.ciphertext),
        contentNonce: toBase64(contentCt.nonce),
        wrappedPerItemKey: toBase64(wrappedKey.ciphertext),
        wrappedPerItemKeyNonce: toBase64(wrappedKey.nonce),
        titleCiphertext: toBase64(titleCt),
        titleNonce: toBase64(titleNonce),
        contentSizeBytes: contentCt.ciphertext.length,
      };
    } finally {
      wipe(itemKey);
    }
  });
}

export interface FetchedItem {
  id: string;
  tier: VaultTier;
  aadVersion: ItemAadVersion;
  contentCiphertext: string;
  contentNonce: string;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
}

export function unwrapItem(item: FetchedItem): { title: string; content: string } {
  return withTierKey(item.tier, (tierKey) => {
    const wrappedKey = {
      ciphertext: fromBase64(item.wrappedPerItemKey),
      nonce: fromBase64(item.wrappedPerItemKeyNonce),
      tier: item.tier,
    } as ItemKeyWrappedByTier;
    const itemKey = unwrapItemKey(wrappedKey, tierKey, {
      version: item.aadVersion,
      itemId: item.id,
    });
    try {
      const contentCt = {
        ciphertext: fromBase64(item.contentCiphertext),
        nonce: fromBase64(item.contentNonce),
      } as ItemContentCiphertext;
      const content = dec.decode(decryptItemContent(contentCt, itemKey));
      const title = decryptTitle(item);
      return { title, content };
    } finally {
      wipe(itemKey);
    }
  });
}

// What decrypting a title needs to know. The id is as load-bearing as the
// ciphertext, and the version is asserted rather than branched on — see
// assertSupportedItemAadVersion.
export interface TitleRef {
  id: string;
  tier: VaultTier;
  aadVersion: ItemAadVersion;
  titleCiphertext: string;
  titleNonce: string;
}

// List view: decrypt just the title (tier key only — no per-item key, no content).
export function decryptTitle(ref: TitleRef): string {
  assertSupportedItemAadVersion(ref.aadVersion);
  return withTierKey(ref.tier, (tierKey) =>
    dec.decode(
      secretboxDecrypt({
        key: tierKey,
        nonce: fromBase64(ref.titleNonce),
        ciphertext: fromBase64(ref.titleCiphertext),
        additionalData: buildItemTitleAad({ tier: ref.tier, itemId: ref.id }),
      }),
    ),
  );
}

// Tier move: re-key everything the OLD tier key protected, for the new tier.
// The CONTENT ciphertext is unchanged (same per-item key) — only the wrapping
// moves. This is what POST /v1/vault/items/tier carries.
//
// The TITLE has to move too, and until 2026-08-09 it did not. The title is
// encrypted under the tier key, the move rewrote `tier` and left
// `title_ciphertext` alone, and the reader then tried the NEW tier key against
// a title sealed under the old one: every tier-moved item threw on read, taking
// the whole list down with it. The content was fine the entire time — the title
// failure is what buried it. Anything the tier key protects has to be listed
// here; there are exactly two things, and it was one for a long while.
//
// A moved item also comes out as v2 regardless of what it was, because both
// values are being re-sealed anyway and there is no reason to rebuild a
// superseded binding.
export interface RewrappedForTier {
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
  aadVersion: ItemAadVersion;
}

export function rewrapItemForTier(input: {
  itemId: string;
  oldTier: VaultTier;
  newTier: VaultTier;
  aadVersion: ItemAadVersion;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
}): RewrappedForTier {
  const { itemId, oldTier, newTier } = input;

  // Read both under the OLD tier key before touching the new one.
  const title = decryptTitle({
    id: itemId,
    tier: oldTier,
    aadVersion: input.aadVersion,
    titleCiphertext: input.titleCiphertext,
    titleNonce: input.titleNonce,
  });
  const itemKey = withTierKey(oldTier, (oldKey) =>
    unwrapItemKey(
      {
        ciphertext: fromBase64(input.wrappedPerItemKey),
        nonce: fromBase64(input.wrappedPerItemKeyNonce),
        tier: oldTier,
      } as ItemKeyWrappedByTier,
      oldKey,
      { version: input.aadVersion, itemId },
    ),
  );

  try {
    return withTierKey(newTier, (newKey) => {
      const rewrapped = wrapItemKey(itemKey, newKey, itemId);
      const titleNonce = randomSecretboxNonce();
      const titleCt = secretboxEncrypt({
        key: newKey,
        nonce: titleNonce,
        plaintext: enc.encode(title),
        additionalData: buildItemTitleAad({ tier: newTier, itemId }),
      });
      return {
        wrappedPerItemKey: toBase64(rewrapped.ciphertext),
        wrappedPerItemKeyNonce: toBase64(rewrapped.nonce),
        titleCiphertext: toBase64(titleCt),
        titleNonce: toBase64(titleNonce),
        aadVersion: ITEM_AAD_VERSION_CURRENT,
      };
    });
  } finally {
    wipe(itemKey);
  }
}
