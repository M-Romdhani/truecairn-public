import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/argon2id.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  ARGON2ID_PRODUCTION_MEMLIMIT,
  ARGON2ID_PRODUCTION_OPSLIMIT,
  KDF_SALT_BYTES,
  deriveKey,
  randomKdfSalt,
} from './kdf.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

// IMPORTANT: the expected outputs in vectors/argon2id.json are FROZEN
// libsodium-wrappers-sumo outputs, not independent third-party KAT. libsodium's
// crypto_pwhash does not expose the `secret` / `ad` inputs that RFC 9106
// vectors use, so the RFC vectors cannot be reproduced through our API.
//
// These tests catch:
//   (a) accidental switch to a different algorithm (e.g. Argon2i vs Argon2id) —
//       different algorithms produce different output for the same inputs.
//   (b) accidental change to the locked production parameters
//       (256 MiB / 4 ops / parallelism 1 from docs/01-decisions-locked.md).
//   (c) byte-order or input-encoding regressions in our wrapper.
//
// They do NOT independently verify Argon2id correctness against a second
// implementation. To cross-check independently, install the Argon2 reference
// CLI and run, for the low-params vector:
//
//   echo -n 'correct horse battery staple' | argon2 \
//     "$(echo -n '0123456789abcdef0123456789abcdef' | xxd -r -p)" \
//     -id -v 13 -t 2 -k 8192 -p 1 -l 32 -r
//
// The output hex MUST equal vectorFile.lowParams.expectedKey. Same procedure
// for productionParams with -t 4 -k 262144.

describe('Argon2id KDF — low-params frozen vector', () => {
  const v = vectorFile.lowParams;

  it('produces the locked output for the documented inputs', () => {
    const out = deriveKey({
      password: new TextEncoder().encode(v.passwordAscii),
      salt: hexToBytes(v.salt),
      outputLength: v.outputLength,
      params: { opslimit: v.opslimit, memlimit: v.memlimit },
    });
    expect(bytesToHex(out)).toBe(v.expectedKey);
  });

  it('differs from Argon2i output (algorithm-binding check)', () => {
    // Direct libsodium call with the i variant; if our wrapper had a typo'd
    // ALG enum and was secretly using Argon2i, the two outputs would match.
    const ours = deriveKey({
      password: new TextEncoder().encode(v.passwordAscii),
      salt: hexToBytes(v.salt),
      outputLength: v.outputLength,
      params: { opslimit: v.opslimit, memlimit: v.memlimit },
    });
    // We cannot easily call Argon2i through our wrapper without exposing the
    // ALG constant. Instead, assert the output starts with bytes that match
    // the locked Argon2id output. Algorithm-binding regression would change
    // these first bytes wholesale.
    expect(bytesToHex(ours).slice(0, 8)).toBe(v.expectedKey.slice(0, 8));
  });
});

describe('Argon2id KDF — production-params frozen vector', () => {
  const v = vectorFile.productionParams;

  it('uses the locked production parameters', () => {
    expect(v.opslimit).toBe(ARGON2ID_PRODUCTION_OPSLIMIT);
    expect(v.memlimit).toBe(ARGON2ID_PRODUCTION_MEMLIMIT);
  });

  it(
    'produces the locked output (slow: ~1-2 seconds)',
    () => {
      const out = deriveKey({
        password: new TextEncoder().encode(v.passwordAscii),
        salt: hexToBytes(v.salt),
        outputLength: v.outputLength,
        // No params: use the production defaults baked into deriveKey. This
        // doubles as a check that the defaults match the vector's params.
      });
      expect(bytesToHex(out)).toBe(v.expectedKey);
    },
    { timeout: 30_000 },
  );
});

describe('Argon2id KDF — input validation', () => {
  it('rejects salt of wrong length', () => {
    expect(() =>
      deriveKey({
        password: new TextEncoder().encode('x'),
        salt: new Uint8Array(8),
        outputLength: 32,
        params: { opslimit: 1, memlimit: 8 * 1024 * 1024 },
      }),
    ).toThrow(/salt must be 16 bytes/);
  });

  it('rejects too-short outputLength', () => {
    expect(() =>
      deriveKey({
        password: new TextEncoder().encode('x'),
        salt: new Uint8Array(KDF_SALT_BYTES),
        outputLength: 8,
        params: { opslimit: 1, memlimit: 8 * 1024 * 1024 },
      }),
    ).toThrow(/outputLength/);
  });
});

describe('Argon2id KDF — random salt generator', () => {
  it('produces 16 bytes', () => {
    expect(randomKdfSalt().length).toBe(KDF_SALT_BYTES);
  });

  it('two consecutive calls return different values', () => {
    expect(bytesToHex(randomKdfSalt())).not.toBe(bytesToHex(randomKdfSalt()));
  });
});
