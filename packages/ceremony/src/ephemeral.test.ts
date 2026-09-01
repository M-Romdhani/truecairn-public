import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, initCrypto } from '@truecairn/crypto';
import { generateTierKey, splitTierKeyForS3, type ReleasePassphraseShare, type TierKeyShare } from '@truecairn/keys';
import {
  generateCeremonyEphemeralKeypair,
  rewrapShareToRecipient,
  unwrapShareFromCeremony,
} from './ephemeral.js';

beforeAll(async () => {
  await initCrypto();
});

function syntheticReleaseShare(shareIndex: number): ReleasePassphraseShare {
  const bytes = new Uint8Array(1 + 32);
  bytes[0] = shareIndex;
  for (let i = 1; i <= 32; i++) bytes[i] = (i * 5 + shareIndex) & 0xff;
  return { bytes, tier: 's3' } as ReleasePassphraseShare;
}

describe('ceremony ephemeral keypair', () => {
  it('generates 32-byte X25519 public + secret', () => {
    const kp = generateCeremonyEphemeralKeypair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('two keypairs differ', () => {
    const a = generateCeremonyEphemeralKeypair();
    const b = generateCeremonyEphemeralKeypair();
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });
});

describe('share re-wrap / unwrap round-trip', () => {
  it('re-wraps a real tier-key share to a recipient and opens it back', () => {
    const tk = generateTierKey('s3');
    const shares = splitTierKeyForS3(tk, syntheticReleaseShare(4));
    const share: TierKeyShare = shares[0]!;

    const recipient = generateCeremonyEphemeralKeypair();
    const sealed = rewrapShareToRecipient(share, recipient.publicKey);
    const opened = unwrapShareFromCeremony(sealed, recipient, 's3');

    expect(bytesToHex(opened.bytes)).toBe(bytesToHex(share.bytes));
    expect(opened.tier).toBe('s3');
  });

  it('sealed output differs from the plaintext share and is longer (sealed-box overhead)', () => {
    const tk = generateTierKey('s3');
    const share = splitTierKeyForS3(tk, syntheticReleaseShare(4))[0]!;
    const recipient = generateCeremonyEphemeralKeypair();
    const sealed = rewrapShareToRecipient(share, recipient.publicKey);
    expect(bytesToHex(sealed)).not.toBe(bytesToHex(share.bytes));
    expect(sealed.length).toBe(share.bytes.length + 48); // 32 ephemeral pub + 16 tag
  });

  it('a different recipient keypair cannot open the sealed share', () => {
    const tk = generateTierKey('s3');
    const share = splitTierKeyForS3(tk, syntheticReleaseShare(4))[0]!;
    const intended = generateCeremonyEphemeralKeypair();
    const attacker = generateCeremonyEphemeralKeypair();
    const sealed = rewrapShareToRecipient(share, intended.publicKey);
    expect(() => unwrapShareFromCeremony(sealed, attacker, 's3')).toThrow();
  });

  it('two re-wraps of the same share differ (sealed-box ephemeral randomness)', () => {
    const tk = generateTierKey('s3');
    const share = splitTierKeyForS3(tk, syntheticReleaseShare(4))[0]!;
    const recipient = generateCeremonyEphemeralKeypair();
    const a = rewrapShareToRecipient(share, recipient.publicKey);
    const b = rewrapShareToRecipient(share, recipient.publicKey);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});
