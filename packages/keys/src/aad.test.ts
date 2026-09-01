import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@truecairn/crypto';
import { buildOuterLayerAad } from './aad.js';

describe('buildOuterLayerAad — byte-layout KAT', () => {
  it('produces the documented length-prefixed encoding for a known input', () => {
    // Manually computed expected bytes:
    //   uint32_be(36) || "11111111-2222-3333-4444-555555555555" (36 bytes)
    //   uint32_be(3)  // tier s3
    //   uint32_be(8)  || "kek-prod" (8 bytes)
    //   uint32_be(7)
    const aad = buildOuterLayerAad({
      userId: '11111111-2222-3333-4444-555555555555',
      tier: 's3',
      kekId: 'kek-prod',
      generation: 7,
    });

    // Build the expected bytes piece by piece so the test mirrors the spec.
    const expected = new Uint8Array(4 + 36 + 4 + 4 + 8 + 4);
    const dv = new DataView(expected.buffer);
    let o = 0;
    dv.setUint32(o, 36, false); o += 4;
    expected.set(new TextEncoder().encode('11111111-2222-3333-4444-555555555555'), o);
    o += 36;
    dv.setUint32(o, 3, false); o += 4;
    dv.setUint32(o, 8, false); o += 4;
    expected.set(new TextEncoder().encode('kek-prod'), o);
    o += 8;
    dv.setUint32(o, 7, false); o += 4;

    expect(bytesToHex(aad)).toBe(bytesToHex(expected));
    expect(aad.length).toBe(expected.length);
  });

  it('different tier produces different AAD', () => {
    const base = { userId: 'u', kekId: 'k', generation: 1 } as const;
    const a = buildOuterLayerAad({ ...base, tier: 's1' });
    const b = buildOuterLayerAad({ ...base, tier: 's2' });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('different generation produces different AAD', () => {
    const base = { userId: 'u', kekId: 'k', tier: 's2' } as const;
    const a = buildOuterLayerAad({ ...base, generation: 1 });
    const b = buildOuterLayerAad({ ...base, generation: 2 });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('length-prefixes prevent boundary ambiguity', () => {
    // Without length prefixes, ("ab", "c") and ("a", "bc") would collide
    // because concatenation gives "abc" both ways. With length prefixes the
    // outputs must differ.
    const a = buildOuterLayerAad({ userId: 'ab', kekId: 'c', tier: 's1', generation: 0 });
    const b = buildOuterLayerAad({ userId: 'a', kekId: 'bc', tier: 's1', generation: 0 });
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('determinism — same inputs → identical bytes', () => {
    const a = buildOuterLayerAad({ userId: 'u', kekId: 'k', tier: 's2', generation: 42 });
    const b = buildOuterLayerAad({ userId: 'u', kekId: 'k', tier: 's2', generation: 42 });
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('rejects generation outside uint32 range', () => {
    expect(() =>
      buildOuterLayerAad({ userId: 'u', kekId: 'k', tier: 's1', generation: -1 }),
    ).toThrow(/uint32/);
    expect(() =>
      buildOuterLayerAad({ userId: 'u', kekId: 'k', tier: 's1', generation: 2 ** 32 }),
    ).toThrow(/uint32/);
  });
});
