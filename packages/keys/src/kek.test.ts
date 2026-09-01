import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/kek.json' with { type: 'json' };
import { bytesToHex, hexToBytes, initCrypto } from '@truecairn/crypto';
import {
  derivePassphraseKek,
  derivePerCallReleaseSalt,
  deriveRecoveryKek,
  deriveReleasePassphraseShare,
  generateMasterKdfSalt,
  generateRecoveryKdfSalt,
  generateReleaseKdfSalt,
} from './kek.js';
import type {
  MasterKdfSalt,
  MasterPassphrase,
  RecoveryCode,
  RecoveryKdfSalt,
  ReleaseKdfSalt,
  ReleasePassphrase,
} from './types.js';

// IMPORTANT: the expected outputs in vectors/kek.json are FROZEN libsodium
// outputs with our production Argon2id parameters (opslimit=4, memlimit=256
// MiB). Same trust-class as @truecairn/crypto's Argon2id KAT. Each
// production-params Argon2id call takes ~1-2 seconds; this whole file
// therefore runs in 5-10 seconds. That is intentional — silently dropping
// production parameters to speed up tests would defeat the KAT.
//
// To cross-verify independently with the argon2 CLI tool:
//   echo -n 'correct horse battery staple' | argon2 \
//     "$(printf 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf' | xxd -r -p)" \
//     -id -v 13 -t 4 -k 262144 -p 1 -l 32 -r
//
// Output hex MUST equal vectorFile.passphraseKek.expectedKekHex.

beforeAll(async () => {
  await initCrypto();
}, 30_000);

describe('derivePassphraseKek — frozen KAT (production Argon2id params)', () => {
  it(
    'produces the locked KEK for documented passphrase + salt',
    () => {
      const v = vectorFile.passphraseKek;
      const passphrase = new TextEncoder().encode(v.passphraseAscii) as MasterPassphrase;
      const salt = hexToBytes(v.saltHex) as MasterKdfSalt;
      const kek = derivePassphraseKek(passphrase, salt);
      expect(bytesToHex(kek)).toBe(v.expectedKekHex);
    },
    { timeout: 30_000 },
  );

  it(
    'determinism — same inputs return identical bytes',
    () => {
      const v = vectorFile.passphraseKek;
      const passphrase = new TextEncoder().encode(v.passphraseAscii) as MasterPassphrase;
      const salt = hexToBytes(v.saltHex) as MasterKdfSalt;
      const a = derivePassphraseKek(passphrase, salt);
      const b = derivePassphraseKek(passphrase, salt);
      expect(bytesToHex(a)).toBe(bytesToHex(b));
    },
    { timeout: 30_000 },
  );
});

describe('deriveRecoveryKek — frozen KAT (production Argon2id params)', () => {
  it(
    'produces the locked KEK for documented code + salt',
    () => {
      const v = vectorFile.recoveryKek;
      const code = hexToBytes(v.codeHex) as RecoveryCode;
      const salt = hexToBytes(v.saltHex) as RecoveryKdfSalt;
      const kek = deriveRecoveryKek(code, salt);
      expect(bytesToHex(kek)).toBe(v.expectedKekHex);
    },
    { timeout: 30_000 },
  );
});

// The release-passphrase derivation pins BOTH the intermediate per-call salt
// AND the final share bytes. Pinning the per-call salt makes a base-salt-
// reuse regression visible (it would change the share value AND surface in
// the per-call salt assertion); pinning the share bytes catches any change
// to the Argon2id wiring downstream of the salt derivation.
describe('derivePerCallReleaseSalt + deriveReleasePassphraseShare — frozen KAT (per-call-salt construction)', () => {
  const ctorVec = vectorFile.releasePassphraseSharePerCallSaltConstruction;
  const baseSalt = hexToBytes(ctorVec.baseSaltHex) as ReleaseKdfSalt;
  const passphrase = new TextEncoder().encode(ctorVec.passphraseAscii) as ReleasePassphrase;

  for (const v of vectorFile.releasePassphraseShares) {
    it(
      `(tier=${v.tier}, idx=${v.shareIndex}): per-call salt + share bytes match KAT`,
      () => {
        // Intermediate: per-call salt is fast (BLAKE2b + KDF, microseconds).
        // Pinning it catches base-salt-reuse regressions visibly.
        const perCallSalt = derivePerCallReleaseSalt(baseSalt, v.tier as 's2' | 's3', v.shareIndex);
        expect(bytesToHex(perCallSalt)).toBe(v.expectedPerCallSaltHex);

        // Final: Argon2id with production params (~1-2s per call).
        const share = deriveReleasePassphraseShare(
          passphrase,
          baseSalt,
          v.tier as 's2' | 's3',
          v.shareIndex,
        );
        expect(bytesToHex(share.bytes)).toBe(v.expectedShareBytesHex);
        expect(share.bytes[0]).toBe(v.shareIndex);
        expect(share.tier).toBe(v.tier);
        expect(share.bytes.length).toBe(33); // index byte + 32-byte tier-key-sized evaluation
      },
      { timeout: 30_000 },
    );
  }
});

// Specific regression: two distinct (tier, shareIndex) inputs MUST produce
// two distinct per-call salts. If the helper accidentally returned the base
// salt unchanged (the prior approach's risk after refactor), or used a fixed
// subkey id, both calls would collide. The KAT loop above implicitly tests
// this (3 distinct expected per-call salts) but this assertion makes the
// intent explicit and would catch a regression even if the KAT was stale.
describe('derivePerCallReleaseSalt — domain separation', () => {
  it('different (tier, shareIndex) tuples produce distinct per-call salts', () => {
    const baseSalt = hexToBytes(
      vectorFile.releasePassphraseSharePerCallSaltConstruction.baseSaltHex,
    ) as ReleaseKdfSalt;
    const a = derivePerCallReleaseSalt(baseSalt, 's3', 4);
    const b = derivePerCallReleaseSalt(baseSalt, 's2', 4);
    const c = derivePerCallReleaseSalt(baseSalt, 's3', 1);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(bytesToHex(a)).not.toBe(bytesToHex(c));
    expect(bytesToHex(b)).not.toBe(bytesToHex(c));
    // And none of them equal the base salt unchanged.
    expect(bytesToHex(a)).not.toBe(bytesToHex(baseSalt));
    expect(bytesToHex(b)).not.toBe(bytesToHex(baseSalt));
    expect(bytesToHex(c)).not.toBe(bytesToHex(baseSalt));
  });
});

describe('deriveReleasePassphraseShare — input validation', () => {
  const passphrase = new TextEncoder().encode('p') as ReleasePassphrase;
  const salt = hexToBytes(
    vectorFile.releasePassphraseSharePerCallSaltConstruction.baseSaltHex,
  ) as ReleaseKdfSalt;

  it('rejects non-integer share index', () => {
    expect(() => deriveReleasePassphraseShare(passphrase, salt, 's2', 1.5)).toThrow(
      /shareIndex/,
    );
  });

  it('rejects share index < 1', () => {
    expect(() => deriveReleasePassphraseShare(passphrase, salt, 's2', 0)).toThrow(/shareIndex/);
  });

  it('rejects share index > 255', () => {
    expect(() => deriveReleasePassphraseShare(passphrase, salt, 's2', 256)).toThrow(/shareIndex/);
  });

  it('derivePerCallReleaseSalt also rejects out-of-range share index', () => {
    expect(() => derivePerCallReleaseSalt(salt, 's2', 0)).toThrow(/shareIndex/);
    expect(() => derivePerCallReleaseSalt(salt, 's2', 256)).toThrow(/shareIndex/);
  });
});

describe('salt generators', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it('generateMasterKdfSalt returns 16 random bytes', () => {
    const a = generateMasterKdfSalt();
    const b = generateMasterKdfSalt();
    expect(a.length).toBe(16);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('generateRecoveryKdfSalt returns 16 random bytes', () => {
    expect(generateRecoveryKdfSalt().length).toBe(16);
  });

  it('generateReleaseKdfSalt returns 16 random bytes', () => {
    expect(generateReleaseKdfSalt().length).toBe(16);
  });
});
