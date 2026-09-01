import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, initCrypto } from '@truecairn/crypto';
import { buildOuterLayerAad } from './aad.js';
import {
  derivePassphraseKek,
  deriveRecoveryKek,
  deriveReleasePassphraseShare,
} from './kek.js';
import {
  generateMasterKey,
  unwrapMasterKeyByPassphrase,
  unwrapMasterKeyByRecovery,
  wrapMasterKeyByPassphrase,
  wrapMasterKeyByRecovery,
} from './master-key.js';
import { deriveTierWrappingKey } from './subkeys.js';
import {
  combineTierKey,
  generateTierKey,
  releaseShareAsTierShare,
  splitTierKeyForS3,
  unwrapTierKey,
  wrapTierKey,
} from './tier-key.js';
import { encryptItemContent, decryptItemContent } from './item-content.js';
import { generateItemKey, unwrapItemKey, wrapItemKey } from './item-key.js';
import {
  applyOuterLayerWrap,
  generateOuterLayerKek,
  generateOuterLayerKey,
  makeInnerVaultBundle,
  removeOuterLayerWrap,
  unwrapOuterLayerKey,
  wrapOuterLayerKey,
} from './outer-layer.js';
import {
  RELEASE_SHARE_INDEX_S3,
  type ItemKeyWrappedByTier,
  type MasterKeyWrappedByPassphrase,
  type MasterKeyWrappedByRecovery,
  type PassphraseKek,
  type RecoveryKek,
  type TierKeyWrappedByMaster,
  type TierWrappingKey,
  type UnwrappedItemKey,
  type UnwrappedMasterKey,
  type UnwrappedTierKey,
} from './types.js';

// The composition runs one item end to end; its id binds both AAD layers (F3).
const E2E_ITEM_ID = '9c8b7a65-4321-4fed-8ba9-876543210fed';
const E2E_BOUND = { version: 2, itemId: E2E_ITEM_ID } as const;

beforeAll(async () => {
  await initCrypto();
}, 30_000);

// Fixed inputs. The master/tier/item/outer-layer keys are random per run
// (generateX), so this test proves COMPOSITION, not frozen byte values —
// the per-operation KAT lives in the dedicated test files. Several
// production-Argon2id derivations make this the slowest test in the package
// (~6-8s); that is the cost of exercising the real KDF parameters.
const USER_ID = '11111111-2222-3333-4444-555555555555';
const MASTER_PASSPHRASE = new TextEncoder().encode('horse-battery-correct');
const MASTER_SALT = hexToBytes('0102030405060708090a0b0c0d0e0f10');
const RECOVERY_CODE = hexToBytes(
  '1112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30',
);
const RECOVERY_SALT = hexToBytes('2122232425262728292a2b2c2d2e2f30');
const RELEASE_PASSPHRASE = new TextEncoder().encode('release-only-secret');
const RELEASE_SALT = hexToBytes('3132333435363738393a3b3c3d3e3f40');
const PLAINTEXT = new TextEncoder().encode('the launch codes are in the safe');
const KEK_ID = 'kek-e2e';

describe('end-to-end key hierarchy composition', () => {
  it(
    'enrolls, stores, and recovers via passphrase / recovery code / S3 ceremony',
    () => {
      // ── PHASE A — enroll + store ────────────────────────────────────────
      const masterKey = generateMasterKey();
      const passphraseKek = derivePassphraseKek(
        MASTER_PASSPHRASE as never,
        MASTER_SALT as never,
      );
      const recoveryKek = deriveRecoveryKek(RECOVERY_CODE as never, RECOVERY_SALT as never);
      const wrappedByPassphrase = wrapMasterKeyByPassphrase(masterKey, passphraseKek);
      const wrappedByRecovery = wrapMasterKeyByRecovery(masterKey, recoveryKek);

      const tierWrappingKey = deriveTierWrappingKey(masterKey);
      const tierKey = generateTierKey('s3');
      const tierKeyBytesHex = bytesToHex(tierKey);
      const wrappedTierKey = wrapTierKey(tierKey, tierWrappingKey, 1);

      const itemKey = generateItemKey();
      const wrappedItemKey = wrapItemKey(itemKey, tierKey, E2E_ITEM_ID);
      const contentCiphertext = encryptItemContent(PLAINTEXT, itemKey);

      const innerBundle = makeInnerVaultBundle(contentCiphertext, wrappedItemKey);
      const outerLayerKey = generateOuterLayerKey();
      const storedBundle = applyOuterLayerWrap(innerBundle, outerLayerKey);

      const outerLayerKek = generateOuterLayerKek();
      const olkAad = buildOuterLayerAad({
        userId: USER_ID,
        tier: 's3',
        kekId: KEK_ID,
        generation: 1,
      });
      const wrappedOuterLayerKey = wrapOuterLayerKey(outerLayerKey, outerLayerKek, olkAad);

      // The "server" now holds only: wrappedByPassphrase, wrappedByRecovery,
      // wrappedTierKey, storedBundle, wrappedOuterLayerKey, outerLayerKek
      // (the last via HSM in production). masterKey / tierKey / itemKey /
      // outerLayerKey are not referenced again except for final assertions.

      // ── PHASE B — recover via passphrase ────────────────────────────────
      {
        // Re-derive the KEK from scratch to prove the derive→unwrap round-trip.
        const rederivedKek = derivePassphraseKek(MASTER_PASSPHRASE as never, MASTER_SALT as never);
        const recoveredMaster = unwrapMasterKeyByPassphrase(wrappedByPassphrase, rederivedKek);
        const recoveredWrapKey = deriveTierWrappingKey(recoveredMaster);
        const recoveredTierKey = unwrapTierKey(wrappedTierKey, recoveredWrapKey);
        const recoveredOuterKey = unwrapOuterLayerKey(wrappedOuterLayerKey, outerLayerKek, olkAad);
        const recoveredInner = removeOuterLayerWrap(storedBundle, recoveredOuterKey);
        const recoveredItemKey = unwrapItemKey(recoveredInner.wrappedItemKey, recoveredTierKey, E2E_BOUND);
        const recovered = decryptItemContent(recoveredInner.contentCiphertext, recoveredItemKey);
        expect(bytesToHex(recovered)).toBe(bytesToHex(PLAINTEXT));
      }

      // ── PHASE C — recover via recovery code ─────────────────────────────
      {
        const rederivedKek = deriveRecoveryKek(RECOVERY_CODE as never, RECOVERY_SALT as never);
        const recoveredMaster = unwrapMasterKeyByRecovery(wrappedByRecovery, rederivedKek);
        const recoveredWrapKey = deriveTierWrappingKey(recoveredMaster);
        const recoveredTierKey = unwrapTierKey(wrappedTierKey, recoveredWrapKey);
        const recoveredOuterKey = unwrapOuterLayerKey(wrappedOuterLayerKey, outerLayerKek, olkAad);
        const recoveredInner = removeOuterLayerWrap(storedBundle, recoveredOuterKey);
        const recoveredItemKey = unwrapItemKey(recoveredInner.wrappedItemKey, recoveredTierKey, E2E_BOUND);
        const recovered = decryptItemContent(recoveredInner.contentCiphertext, recoveredItemKey);
        expect(bytesToHex(recovered)).toBe(bytesToHex(PLAINTEXT));
      }

      // ── PHASE D — recover via Shamir + release passphrase (S3 ceremony) ─
      {
        // Split the tier key with the release-passphrase share at index 4.
        const releaseShare = deriveReleasePassphraseShare(
          RELEASE_PASSPHRASE as never,
          RELEASE_SALT as never,
          's3',
          RELEASE_SHARE_INDEX_S3,
        );
        const shares = splitTierKeyForS3(tierKey, releaseShare);

        // Ceremony: two contact shares (indices 1, 2) + the release share
        // recomputed from the passphrase. Threshold for S3 is 3.
        const recomputedReleaseShare = deriveReleasePassphraseShare(
          RELEASE_PASSPHRASE as never,
          RELEASE_SALT as never,
          's3',
          RELEASE_SHARE_INDEX_S3,
        );
        const reconstructedTierKey = combineTierKey([
          shares[0]!,
          shares[1]!,
          releaseShareAsTierShare(recomputedReleaseShare),
        ]);

        // Shamir math sanity: reconstructed tier key bytes equal the original.
        expect(bytesToHex(reconstructedTierKey)).toBe(tierKeyBytesHex);

        // And it decrypts the vault item end-to-end.
        const recoveredOuterKey = unwrapOuterLayerKey(wrappedOuterLayerKey, outerLayerKek, olkAad);
        const recoveredInner = removeOuterLayerWrap(storedBundle, recoveredOuterKey);
        const recoveredItemKey = unwrapItemKey(recoveredInner.wrappedItemKey, reconstructedTierKey, E2E_BOUND);
        const recovered = decryptItemContent(recoveredInner.contentCiphertext, recoveredItemKey);
        expect(bytesToHex(recovered)).toBe(bytesToHex(PLAINTEXT));
      }
    },
    { timeout: 60_000 },
  );
});

// ===========================================================================
// Compile-time negatives.
//
// This function is NEVER called. It exists so `tsc --noEmit` (the typecheck
// step) verifies that the brands REJECT these misuses. Each @ts-expect-error
// MUST flag a real error; if a brand weakens so the misuse becomes legal, the
// directive turns into an unused-directive error and the build fails. vitest
// strips types and never runs this, so the deliberately-wrong calls never
// execute. `void _compileTimeNegatives` at the end marks it used (satisfying
// noUnusedLocals) without calling it.
// ===========================================================================
function _compileTimeNegatives(): void {
  const masterKey = new Uint8Array(32) as unknown as UnwrappedMasterKey;
  const itemKey = new Uint8Array(32) as unknown as UnwrappedItemKey;
  const tierKey = new Uint8Array(32) as unknown as UnwrappedTierKey;
  const tierWrappingKey = new Uint8Array(32) as unknown as TierWrappingKey;
  const passphraseKek = new Uint8Array(32) as unknown as PassphraseKek;
  const recoveryKek = new Uint8Array(32) as unknown as RecoveryKek;
  const wrappedByPassphrase = {
    ciphertext: new Uint8Array(0),
    nonce: new Uint8Array(0),
  } as unknown as MasterKeyWrappedByPassphrase;
  const wrappedByRecovery = {
    ciphertext: new Uint8Array(0),
    nonce: new Uint8Array(0),
  } as unknown as MasterKeyWrappedByRecovery;
  const wrappedItemKey = {
    ciphertext: new Uint8Array(0),
    nonce: new Uint8Array(0),
    tier: 's3',
  } as unknown as ItemKeyWrappedByTier;
  const wrappedTierKey = {
    ciphertext: new Uint8Array(0),
    nonce: new Uint8Array(0),
    tier: 's3',
    generation: 1,
  } as unknown as TierKeyWrappedByMaster;
  const content = new Uint8Array(0);

  // @ts-expect-error - UnwrappedItemKey is not assignable to PassphraseKek
  wrapMasterKeyByPassphrase(masterKey, itemKey);

  // @ts-expect-error - a passphrase-wrapped master key is not the recovery-wrapped form
  unwrapMasterKeyByRecovery(wrappedByPassphrase, recoveryKek);

  // @ts-expect-error - a recovery-wrapped master key is not the passphrase-wrapped form
  unwrapMasterKeyByPassphrase(wrappedByRecovery, passphraseKek);

  // @ts-expect-error - PassphraseKek is not an UnwrappedMasterKey
  deriveTierWrappingKey(passphraseKek);

  // @ts-expect-error - UnwrappedMasterKey is not an UnwrappedItemKey
  encryptItemContent(content, masterKey);

  // @ts-expect-error - UnwrappedMasterKey is not an UnwrappedTierKey
  unwrapItemKey(wrappedItemKey, masterKey);

  // @ts-expect-error - UnwrappedItemKey is not an UnwrappedTierKey (wrong key for tier wrap)
  wrapTierKey(itemKey, tierWrappingKey, 1);

  // @ts-expect-error - UnwrappedMasterKey is not an UnwrappedTierKey (wrong key for item wrap)
  wrapItemKey(itemKey, masterKey);

  // @ts-expect-error - a tier-key-wrapped form is not the passphrase-wrapped master form
  unwrapMasterKeyByPassphrase(wrappedTierKey, passphraseKek);

  // Reference values only used through @ts-expect-error lines so noUnusedLocals
  // does not flag them, while keeping the negatives self-contained.
  void tierKey;
  void recoveryKek;
}

// Mark the negatives function used without calling it. tsc still typechecks
// its body (validating the @ts-expect-error directives); nothing runs.
void _compileTimeNegatives;
