import { openSealedToContact } from '@truecairn/client-crypto';
import {
  reconstructTierKey,
  unwrapShareFromCeremony,
  type CeremonyEphemeralKeypair,
} from '@truecairn/ceremony/client';
import { fromBase64, wipe } from '@truecairn/crypto';
import {
  combineTierKeyForS3Nested,
  decryptItemContent,
  deriveReleasePassphraseShare,
  releaseShareAsTierShare,
  RELEASE_SHARE_INDEX_S2,
  RELEASE_SHARE_INDEX_S3,
  tierKeyFromBytes,
  unwrapItemKey,
  type ItemContentCiphertext,
  type ItemKeyWrappedByTier,
  type ReleaseKdfSalt,
  type ReleasePassphrase,
  type ReleasePassphraseShare,
  type TierKeyShare,
  type UnwrappedTierKey,
} from '@truecairn/keys';
import type { ReleasedItem, SharesResponse } from './api.js';

// The release passphrase at reconstruction: the recipient supplies the owner's
// offline release passphrase + the served KDF salt. For S2 it re-derives the
// reserved last Shamir share, an OPTIONAL fallback standing in for a contact who
// affirmed but never sealed their share. For S3 (nested, docs/24) it is MANDATORY
// — its evaluation is the XOR mask without which the contact shares reconstruct
// only the masked secret, never the tier key. Ownership of `passphrase` passes
// here (zeroized after use).
export interface ReleaseFallback {
  passphrase: Uint8Array;
  salt: Uint8Array;
}

const dec = new TextDecoder();

// Client-side S1 reconstruction across the release boundary (CEREMONY_COMPLETION
// Bridge 3). Open the sealed envelope with the contact's OWN X25519 key (the C4
// key) → the owner's S1 tier key → unwrap the per-item key → decrypt the content.
// Entirely on the recipient's device; the recovered key material is zeroized after.
// The server only ever held ciphertext (inner) + the sealed envelope.
export function reconstructS1Item(envelopeB64: string, item: ReleasedItem): { content: string } {
  const tierKeyBytes = openSealedToContact(fromBase64(envelopeB64));
  try {
    const tierKey = tierKeyFromBytes(tierKeyBytes, 's1');
    return decryptItemWithTierKey(tierKey, item);
  } finally {
    wipe(tierKeyBytes);
  }
}

// One item under a tier key the caller already holds (S1's unsealed envelope
// or the S2/S3 Shamir-reconstructed key): unwrap the per-item key, decrypt.
function decryptItemWithTierKey(tierKey: UnwrappedTierKey, item: ReleasedItem): { content: string } {
  const wrappedKey = {
    ciphertext: fromBase64(item.wrappedPerItemKey),
    nonce: fromBase64(item.wrappedPerItemKeyNonce),
    tier: tierKey.tier,
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
    return { content: dec.decode(decryptItemContent(contentCt, itemKey)) };
  } finally {
    wipe(itemKey);
  }
}

// S2/S3 (Checkpoint B): open every sealed share with the recipient's ceremony
// ephemeral key, reconstruct the tier key from a threshold subset (validated
// against the tier-key sentinel — subset retry tolerates a wrong/superseded
// share), then decrypt the released items. Throws if the shares cannot
// reconstruct (insufficient or unverifiable) — the caller surfaces it; nothing
// decrypts on a failed reconstruction.
export function reconstructTierItems(
  sharesResponse: SharesResponse,
  ephemeral: CeremonyEphemeralKeypair,
  items: ReleasedItem[],
  fallback?: ReleaseFallback,
): { contents: string[]; subsetsTried: number; usedReleasePassphrase: boolean } {
  const tier = sharesResponse.tier;
  const shares = sharesResponse.shares.map((s) =>
    unwrapShareFromCeremony(fromBase64(s.sealedShareCiphertext), ephemeral, tier),
  );

  // The release passphrase is bound in differently per tier (docs/24):
  //  - S3 (nested): MANDATORY. Its evaluation is the XOR mask, NOT a Shamir share
  //    — never added to the pool; instead it parameterises the combine. With no
  //    passphrase there is no mask and reconstruction is impossible (fail closed).
  //  - S2 (flat): OPTIONAL +1 fallback. The derived reserved-last share is added
  //    to the pool so subset retry can use [oneContact, releaseShare] for 2-of-3.
  let releaseForMask: ReleasePassphraseShare | undefined;
  let combine: ((subset: TierKeyShare[]) => UnwrappedTierKey) | undefined;

  if (tier === 's3') {
    if (fallback === undefined) {
      for (const s of shares) wipe(s.bytes);
      throw new Error('S3 reconstruction requires the release passphrase');
    }
    releaseForMask = deriveReleasePassphraseShare(
      fallback.passphrase as ReleasePassphrase,
      fallback.salt as ReleaseKdfSalt,
      's3',
      RELEASE_SHARE_INDEX_S3,
    );
    wipe(fallback.passphrase); // ownership taken — zeroize the secret immediately
    combine = (subset) => combineTierKeyForS3Nested(subset, releaseForMask!);
  } else if (fallback !== undefined) {
    const release = deriveReleasePassphraseShare(
      fallback.passphrase as ReleasePassphrase,
      fallback.salt as ReleaseKdfSalt,
      's2',
      RELEASE_SHARE_INDEX_S2,
    );
    wipe(fallback.passphrase); // ownership taken — zeroize the secret immediately
    // releaseShareAsTierShare reuses the derived bytes, so the shares-wipe loop
    // below zeroizes it too.
    shares.push(releaseShareAsTierShare(release));
  }

  try {
    const result = reconstructTierKey({
      shares,
      threshold: sharesResponse.threshold,
      generation: sharesResponse.generation,
      tierKeyCheck: {
        plaintext: fromBase64(sharesResponse.tierKeyCheck.plaintext),
        ciphertext: fromBase64(sharesResponse.tierKeyCheck.ciphertext),
        nonce: fromBase64(sharesResponse.tierKeyCheck.nonce),
      },
      ...(combine !== undefined ? { combine } : {}),
    });
    if (!result.ok) {
      throw new Error(`tier key reconstruction failed: ${result.reason}`);
    }
    try {
      return {
        contents: items.map((it) => decryptItemWithTierKey(result.tierKey, it).content),
        subsetsTried: result.subsetsTried,
        usedReleasePassphrase: tier === 's3' || fallback !== undefined,
      };
    } finally {
      wipe(result.tierKey);
    }
  } finally {
    if (releaseForMask !== undefined) wipe(releaseForMask.bytes);
    for (const s of shares) wipe(s.bytes);
  }
}
