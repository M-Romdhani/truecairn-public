import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { generateX25519Keypair, initCrypto, sealedBoxDecrypt } from '@truecairn/crypto';
import {
  combineTierKey,
  combineTierKeyForS3Nested,
  deriveReleasePassphraseShare,
  RELEASE_SHARE_INDEX_S2,
  RELEASE_SHARE_INDEX_S3,
  releaseShareAsTierShare,
  validateTierKeyCheck,
  type ReleaseKdfSalt,
  type ReleasePassphrase,
  type TierKeyShare,
} from '@truecairn/keys';
import { generateEnrollmentMaterial } from './enrollment.js';
import * as session from './session.js';

// The owner-side S2/S3 split (CEREMONY_COMPLETION Checkpoint B). Proves the
// session-level splitTierKeyToContactShares produces contact shares that (a)
// unseal only with the matching contact key, (b) reconstruct the REAL tier key
// at threshold, validated against the enrollment sentinel, and (c) stay
// consistent with the release-passphrase share as the +1 fallback factor —
// passphrase + one contact reconstructs the same key.

const enc = new TextEncoder();
const PASS = 'a master passphrase for tests';
const RELEASE_PASS = 'the offline release passphrase';

beforeAll(async () => {
  await initCrypto();
}, 120_000);
afterEach(() => {
  session.lock();
});

describe('splitTierKeyToContactShares (CEREMONY_COMPLETION B)', () => {
  it('splits S2 into sealed contact shares that reconstruct the real tier key — and the passphrase share substitutes for a contact', () => {
    const { material } = generateEnrollmentMaterial(enc.encode(PASS));
    session.unlock(enc.encode(PASS), material);

    const c1 = generateX25519Keypair();
    const c2 = generateX25519Keypair();
    const sealed = session.splitTierKeyToContactShares('s2', enc.encode(RELEASE_PASS), [
      c1.publicKey,
      c2.publicKey,
    ]);
    expect(sealed.map((s) => s.shareIndex)).toEqual([1, 2]);

    // Each share unseals only with its contact's key, carrying its index byte.
    const share1Bytes = sealedBoxDecrypt({
      recipientPublicKey: c1.publicKey,
      recipientSecretKey: c1.secretKey,
      ciphertext: sealed[0]!.wrappedShareCiphertext,
    });
    const share2Bytes = sealedBoxDecrypt({
      recipientPublicKey: c2.publicKey,
      recipientSecretKey: c2.secretKey,
      ciphertext: sealed[1]!.wrappedShareCiphertext,
    });
    expect(share1Bytes[0]).toBe(1);
    expect(share2Bytes[0]).toBe(2);
    expect(() =>
      sealedBoxDecrypt({
        recipientPublicKey: c2.publicKey,
        recipientSecretKey: c2.secretKey,
        ciphertext: sealed[0]!.wrappedShareCiphertext,
      }),
    ).toThrow(); // c2 cannot open c1's share

    // The two contact shares reconstruct the REAL S2 tier key (the enrollment
    // sentinel proves it — no access to the raw key needed).
    const share1 = { bytes: share1Bytes, tier: 's2' } as TierKeyShare;
    const share2 = { bytes: share2Bytes, tier: 's2' } as TierKeyShare;
    const reconstructed = combineTierKey([share1, share2]);
    const s2material = material.tierKeys.find((t) => t.tier === 's2')!;
    const check = {
      plaintext: s2material.tierKeyCheckPlaintext,
      ciphertext: s2material.tierKeyCheckCiphertext,
      nonce: s2material.tierKeyCheckNonce,
    };
    expect(validateTierKeyCheck(reconstructed, check, s2material.generation)).toBe(true);

    // The fallback factor: re-derive the release-passphrase share from the
    // passphrase + the enrollment salt — one contact + the passphrase share
    // reconstructs the SAME key (the split reserved the last index for it).
    const releaseShare = deriveReleasePassphraseShare(
      enc.encode(RELEASE_PASS) as ReleasePassphrase,
      material.releasePassphraseSalt as ReleaseKdfSalt,
      's2',
      RELEASE_SHARE_INDEX_S2,
    );
    const viaFallback = combineTierKey([share1, releaseShareAsTierShare(releaseShare)]);
    expect(validateTierKeyCheck(viaFallback, check, s2material.generation)).toBe(true);
    expect(Buffer.from(viaFallback).equals(Buffer.from(reconstructed))).toBe(true);
  }, 120_000);

  it('splits S3 (nested): any 2 of 3 contact shares + the release passphrase reconstruct; contacts alone never do', () => {
    const { material } = generateEnrollmentMaterial(enc.encode(PASS));
    session.unlock(enc.encode(PASS), material);

    const cks = [generateX25519Keypair(), generateX25519Keypair(), generateX25519Keypair()];
    const sealed = session.splitTierKeyToContactShares(
      's3',
      enc.encode(RELEASE_PASS),
      cks.map((k) => k.publicKey),
    );
    // Three CONTACT shares (indices 1..3); the passphrase is the mask, never a
    // distributed share — so there is no index-4 share among them.
    expect(sealed.map((s) => s.shareIndex)).toEqual([1, 2, 3]);

    const contactShares = sealed.map(
      (s, i) =>
        ({
          bytes: sealedBoxDecrypt({
            recipientPublicKey: cks[i]!.publicKey,
            recipientSecretKey: cks[i]!.secretKey,
            ciphertext: s.wrappedShareCiphertext,
          }),
          tier: 's3',
        }) as TierKeyShare,
    );

    const s3material = material.tierKeys.find((t) => t.tier === 's3')!;
    const check = {
      plaintext: s3material.tierKeyCheckPlaintext,
      ciphertext: s3material.tierKeyCheckCiphertext,
      nonce: s3material.tierKeyCheckNonce,
    };

    // The release passphrase supplies the MANDATORY XOR mask.
    const releaseShare = deriveReleasePassphraseShare(
      enc.encode(RELEASE_PASS) as ReleasePassphrase,
      material.releasePassphraseSalt as ReleaseKdfSalt,
      's3',
      RELEASE_SHARE_INDEX_S3,
    );

    // ANY 2 of the 3 contact shares + the passphrase mask reconstruct the REAL key.
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const key = combineTierKeyForS3Nested([contactShares[a]!, contactShares[b]!], releaseShare);
      expect(validateTierKeyCheck(key, check, s3material.generation)).toBe(true);
    }

    // Contacts ALONE (no passphrase) never reach the tier key: the flat combine of
    // the masked shares yields only the masked secret, which fails the sentinel.
    const masked = combineTierKey([contactShares[0]!, contactShares[1]!]);
    expect(validateTierKeyCheck(masked, check, s3material.generation)).toBe(false);

    // A WRONG passphrase → wrong mask → wrong key (fail closed).
    const wrongRelease = deriveReleasePassphraseShare(
      enc.encode('not the release passphrase') as ReleasePassphrase,
      material.releasePassphraseSalt as ReleaseKdfSalt,
      's3',
      RELEASE_SHARE_INDEX_S3,
    );
    const wrongKey = combineTierKeyForS3Nested(
      [contactShares[0]!, contactShares[1]!],
      wrongRelease,
    );
    expect(validateTierKeyCheck(wrongKey, check, s3material.generation)).toBe(false);
  }, 120_000);

  it('takes ownership of the release passphrase (zeroized) and rejects a wrong pubkey count', () => {
    const { material } = generateEnrollmentMaterial(enc.encode(PASS));
    session.unlock(enc.encode(PASS), material);

    const wrongCount = enc.encode(RELEASE_PASS);
    expect(() =>
      session.splitTierKeyToContactShares('s2', wrongCount, [generateX25519Keypair().publicKey]),
    ).toThrow(/needs exactly 2 contact pubkeys/);
    expect(wrongCount.every((b) => b === 0)).toBe(true); // wiped even on the error path

    const pass = enc.encode(RELEASE_PASS);
    session.splitTierKeyToContactShares('s3', pass, [
      generateX25519Keypair().publicKey,
      generateX25519Keypair().publicKey,
      generateX25519Keypair().publicKey,
    ]);
    expect(pass.every((b) => b === 0)).toBe(true); // wiped on the success path
  }, 120_000);
});
