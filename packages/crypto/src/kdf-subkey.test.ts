import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/kdf-subkey.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  KDF_CONTEXT_BYTES,
  KDF_KEY_BYTES,
  KDF_MAX_SUBKEY_BYTES,
  KDF_MIN_SUBKEY_BYTES,
  deriveSubkey,
} from './kdf-subkey.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

// Frozen-vector tests. libsodium's crypto_kdf_derive_from_key is a BLAKE2b
// construction with a specific subkey-id encoding; no public independent KAT
// exists. The vectors here are libsodium output captured once and locked.
// They catch wrong-context, wrong-subkey-id, wrong-output-length, and any
// regression in the libsodium build.

describe('deriveSubkey — frozen KAT vectors', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex);

  for (const v of vectorFile.vectors) {
    it(v.name, () => {
      const out = deriveSubkey({
        masterKey,
        context: v.context,
        subkeyId: v.subkeyId,
        subkeyLength: v.subkeyLength,
      });
      expect(out.length).toBe(v.subkeyLength);
      expect(bytesToHex(out)).toBe(v.expectedHex);
    });
  }
});

describe('deriveSubkey — separation properties', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex);

  it('different subkey ids produce different outputs', () => {
    const a = deriveSubkey({ masterKey, context: 'tc-sep01', subkeyId: 1, subkeyLength: 32 });
    const b = deriveSubkey({ masterKey, context: 'tc-sep01', subkeyId: 2, subkeyLength: 32 });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('different contexts produce different outputs', () => {
    const a = deriveSubkey({ masterKey, context: 'tc-sep01', subkeyId: 1, subkeyLength: 32 });
    const b = deriveSubkey({ masterKey, context: 'tc-sep02', subkeyId: 1, subkeyLength: 32 });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('different master keys produce different outputs', () => {
    const otherKey = new Uint8Array(KDF_KEY_BYTES).fill(0xcd);
    const a = deriveSubkey({ masterKey, context: 'tc-sep01', subkeyId: 1, subkeyLength: 32 });
    const b = deriveSubkey({ masterKey: otherKey, context: 'tc-sep01', subkeyId: 1, subkeyLength: 32 });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('determinism — same inputs return identical bytes', () => {
    const a = deriveSubkey({ masterKey, context: 'tc-test1', subkeyId: 1, subkeyLength: 32 });
    const b = deriveSubkey({ masterKey, context: 'tc-test1', subkeyId: 1, subkeyLength: 32 });
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('bigint and number subkeyId encodings produce identical output for small values', () => {
    const a = deriveSubkey({ masterKey, context: 'tc-test1', subkeyId: 7, subkeyLength: 32 });
    const b = deriveSubkey({ masterKey, context: 'tc-test1', subkeyId: 7n, subkeyLength: 32 });
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});

describe('deriveSubkey — input validation', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex);

  it('rejects master key of wrong length', () => {
    expect(() =>
      deriveSubkey({
        masterKey: new Uint8Array(16),
        context: 'tc-test1',
        subkeyId: 1,
        subkeyLength: 32,
      }),
    ).toThrow(/masterKey must be 32/);
  });

  it('rejects context shorter than 8 bytes', () => {
    expect(() =>
      deriveSubkey({ masterKey, context: 'short', subkeyId: 1, subkeyLength: 32 }),
    ).toThrow(/context must encode to exactly 8 bytes/);
  });

  it('rejects context longer than 8 bytes', () => {
    expect(() =>
      deriveSubkey({ masterKey, context: 'too-long!', subkeyId: 1, subkeyLength: 32 }),
    ).toThrow(/context must encode to exactly 8 bytes/);
  });

  it('rejects context with multi-byte UTF-8 chars that push byte length over 8', () => {
    // "é" is 2 UTF-8 bytes; "ttttttté" is 9 bytes (>8) even though 8 characters.
    expect(() =>
      deriveSubkey({ masterKey, context: 'ttttttté', subkeyId: 1, subkeyLength: 32 }),
    ).toThrow(/context must encode to exactly 8 bytes/);
  });

  it('rejects subkeyLength below minimum', () => {
    expect(() =>
      deriveSubkey({
        masterKey,
        context: 'tc-test1',
        subkeyId: 1,
        subkeyLength: KDF_MIN_SUBKEY_BYTES - 1,
      }),
    ).toThrow(/subkeyLength/);
  });

  it('rejects subkeyLength above maximum', () => {
    expect(() =>
      deriveSubkey({
        masterKey,
        context: 'tc-test1',
        subkeyId: 1,
        subkeyLength: KDF_MAX_SUBKEY_BYTES + 1,
      }),
    ).toThrow(/subkeyLength/);
  });

  it('rejects negative subkeyId', () => {
    expect(() =>
      deriveSubkey({ masterKey, context: 'tc-test1', subkeyId: -1, subkeyLength: 32 }),
    ).toThrow(/64-bit unsigned/);
  });

  it('exposes the canonical context-byte constant', () => {
    expect(KDF_CONTEXT_BYTES).toBe(8);
  });
});
