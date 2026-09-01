import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/blake2b.json' with { type: 'json' };
import { initCrypto } from './init.js';
import {
  BLAKE2B_256_OUTPUT_BYTES,
  BLAKE2B_MAX_KEY_BYTES,
  BLAKE2B_MAX_OUTPUT_BYTES,
  BLAKE2B_MIN_OUTPUT_BYTES,
  blake2b256,
  blake2bHash,
} from './blake2b.js';
import { bytesToHex, hexToBytes } from './util.js';

beforeAll(async () => {
  await initCrypto();
});

describe('BLAKE2b-256 — canonical KAT (independent: BLAKE2 reference implementation)', () => {
  for (const v of vectorFile.unkeyed) {
    it(v.name, () => {
      const message =
        'messageAscii' in v
          ? new TextEncoder().encode(v.messageAscii as string)
          : hexToBytes(v.messageHex as string);
      const out = blake2bHash({ message, outputLength: v.outputLength });
      expect(bytesToHex(out)).toBe(v.expectedHex);
      expect(out.length).toBe(v.outputLength);
    });
  }
});

describe('BLAKE2b-256 keyed — frozen libsodium KAT', () => {
  for (const v of vectorFile.keyed) {
    it(v.name, () => {
      const message = new TextEncoder().encode(v.messageAscii);
      const key = hexToBytes(v.keyHex);
      const out = blake2bHash({ message, outputLength: v.outputLength, key });
      expect(bytesToHex(out)).toBe(v.expectedHex);
    });
  }
});

describe('blake2b256 convenience function', () => {
  it('matches the canonical "abc" vector', () => {
    const out = blake2b256(new TextEncoder().encode('abc'));
    expect(bytesToHex(out)).toBe(vectorFile.unkeyed[0]!.expectedHex);
    expect(out.length).toBe(BLAKE2B_256_OUTPUT_BYTES);
  });
});

describe('BLAKE2b properties', () => {
  it('determinism — same inputs return identical output', () => {
    const msg = new TextEncoder().encode('determinism check');
    const a = blake2b256(msg);
    const b = blake2b256(msg);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('different messages produce different outputs', () => {
    const a = blake2b256(new TextEncoder().encode('a'));
    const b = blake2b256(new TextEncoder().encode('b'));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('different keys produce different outputs (keyed mode)', () => {
    const msg = new TextEncoder().encode('msg');
    const a = blake2bHash({ message: msg, outputLength: 32, key: new Uint8Array(16).fill(0x01) });
    const b = blake2bHash({ message: msg, outputLength: 32, key: new Uint8Array(16).fill(0x02) });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('keyed and unkeyed of same message produce different outputs', () => {
    const msg = new TextEncoder().encode('msg');
    const unkeyed = blake2bHash({ message: msg, outputLength: 32 });
    const keyed = blake2bHash({ message: msg, outputLength: 32, key: new Uint8Array(16).fill(0x01) });
    expect(bytesToHex(unkeyed)).not.toBe(bytesToHex(keyed));
  });
});

describe('BLAKE2b input validation', () => {
  it('rejects outputLength < 16', () => {
    expect(() => blake2bHash({ message: new Uint8Array(0), outputLength: 15 })).toThrow(
      /outputLength/,
    );
  });

  it('rejects outputLength > 64', () => {
    expect(() => blake2bHash({ message: new Uint8Array(0), outputLength: 65 })).toThrow(
      /outputLength/,
    );
  });

  it('rejects key > 64 bytes', () => {
    expect(() =>
      blake2bHash({
        message: new Uint8Array(0),
        outputLength: 32,
        key: new Uint8Array(BLAKE2B_MAX_KEY_BYTES + 1),
      }),
    ).toThrow(/key/);
  });

  it('exports constants matching libsodium', () => {
    expect(BLAKE2B_MIN_OUTPUT_BYTES).toBe(16);
    expect(BLAKE2B_MAX_OUTPUT_BYTES).toBe(64);
    expect(BLAKE2B_256_OUTPUT_BYTES).toBe(32);
  });
});
