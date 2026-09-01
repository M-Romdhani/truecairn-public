import { lengthPrefixedConcat } from '@truecairn/crypto';
import type { VaultTier } from '@truecairn/shared';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// AAD format for the outer-layer key wrap. Per Q4 in PROPOSAL.md:
//
//   aad = u32_be(len(user_id))   || user_id_utf8
//       || u32_be(tier_index)
//       || u32_be(len(kek_id))   || kek_id_utf8
//       || u32_be(generation)
//
// Length-prefixed because UUIDs and kek_ids are variable-length strings;
// raw concatenation would create canonicalisation ambiguity. Each field gets
// its own big-endian uint32, so two distinct logical (user_id, kek_id) pairs
// always serialise to distinct AAD bytes.

// 1, 2, 3 matches the s1/s2/s3 naming. Avoids any "is index 0 s1 or s2?"
// confusion if we ever read the AAD back.
const TIER_INDEX: Record<VaultTier, number> = {
  s1: 1,
  s2: 2,
  s3: 3,
};

export interface OuterLayerAadInput {
  userId: string;       // UUID, hyphenated
  tier: VaultTier;
  kekId: string;        // HSM KEK identifier
  generation: number;   // outer-layer key generation (uint32)
}

export function buildOuterLayerAad(input: OuterLayerAadInput): Uint8Array {
  if (input.generation < 0 || input.generation > 0xffffffff) {
    throw new Error('generation must fit in a uint32');
  }
  const userIdBytes = new TextEncoder().encode(input.userId);
  const kekIdBytes = new TextEncoder().encode(input.kekId);
  if (userIdBytes.length > 0xffffffff) throw new Error('userId too long');
  if (kekIdBytes.length > 0xffffffff) throw new Error('kekId too long');

  const total =
    4 + userIdBytes.length +
    4 +
    4 + kekIdBytes.length +
    4;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;

  view.setUint32(off, userIdBytes.length, false);
  off += 4;
  buf.set(userIdBytes, off);
  off += userIdBytes.length;

  view.setUint32(off, TIER_INDEX[input.tier], false);
  off += 4;

  view.setUint32(off, kekIdBytes.length, false);
  off += 4;
  buf.set(kekIdBytes, off);
  off += kekIdBytes.length;

  view.setUint32(off, input.generation, false);
  off += 4;

  if (off !== total) {
    throw new Error(`internal AAD assembly bug: wrote ${off} of ${total} bytes`);
  }
  return buf;
}

// ── Item-identity binding (F3, 2026-08-09) ──────────────────────────────────
//
// Before v2, the per-item key was AAD-bound to its TIER only ('I','K',tier) and
// the title had no AAD at all. Nothing bound either to the item they belonged
// to, so a server with write access could permute titles and contents freely
// among same-tier items of the same owner: swap the outer envelopes of two S2
// items and each decrypts perfectly, under the wrong title. Not a
// confidentiality break — the server reads neither — but an authenticity one,
// and it lands at RELEASE, delivered to a recipient with no way to tell that
// "Bank details" is holding what it says.
//
// v2 binds both layers to the item id. The client picks that id before
// encrypting (the server used to assign it, which is why this was not done
// originally), so the value is fixed at the moment the AAD is built.
//
// Length-prefixed rather than the fixed 3-byte v1 shape because a UUID is
// variable-length text: raw concatenation of (tier, itemId) would let a
// different (tier, itemId) pair serialise identically. Distinct domain strings
// for the two layers so a title ciphertext can never be accepted in the
// item-key slot, or the reverse.

// A version number is recorded per item so a FUTURE format change has a
// mechanism. There is deliberately no compatibility path for any version but
// the current one: when this landed there were 36 items in the world, all of
// them test data, so carrying a v1 reader — and its permanent doubled test
// matrix — would have been maintenance for a population that never existed.
//
// The column is READ and asserted, not merely written. A row whose version this
// client does not understand fails loudly with that as the reason, rather than
// being handed to the wrong AAD builder and surfacing as a generic decryption
// failure. (An always-written, never-read column is the trap that
// outer_key_encryption_aad already sets — see the 2026-08-09 audit, F7.)
export type ItemAadVersion = number;

export const ITEM_AAD_VERSION_CURRENT = 2;

export function assertSupportedItemAadVersion(version: ItemAadVersion): void {
  if (version !== ITEM_AAD_VERSION_CURRENT) {
    throw new Error(
      `unsupported item AAD version ${version}; this client writes and reads only ${ITEM_AAD_VERSION_CURRENT}`,
    );
  }
}

const ITEM_KEY_DOMAIN_V2 = 'tc-item-key/v2';
const ITEM_TITLE_DOMAIN_V2 = 'tc-item-title/v2';

export interface ItemAadInput {
  tier: VaultTier;
  itemId: string;
}

function assertItemId(itemId: string): void {
  if (itemId.length === 0) throw new Error('a v2 item AAD requires a non-empty item id');
}

export function buildItemKeyAad(input: ItemAadInput): Uint8Array {
  assertItemId(input.itemId);
  return lengthPrefixedConcat([
    utf8(ITEM_KEY_DOMAIN_V2),
    Uint8Array.of(TIER_INDEX[input.tier]),
    utf8(input.itemId),
  ]);
}

export function buildItemTitleAad(input: ItemAadInput): Uint8Array {
  assertItemId(input.itemId);
  return lengthPrefixedConcat([
    utf8(ITEM_TITLE_DOMAIN_V2),
    Uint8Array.of(TIER_INDEX[input.tier]),
    utf8(input.itemId),
  ]);
}
