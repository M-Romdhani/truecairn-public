import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalJson, CANONICAL_VERSION, type CanonicalEntry } from './canonical.js';
import { entryHash } from './hash.js';

const USER = '11111111-2222-3333-4444-555555555555';
const T0 = new Date('2026-01-01T00:00:00.000Z');

function base(): CanonicalEntry {
  return {
    seq: 1n,
    userId: USER,
    eventType: 'engine.test',
    eventPayload: { from: 'active', to: 'check_in_pending' },
    prevEntryHash: null,
    serverTimestamp: T0,
    serverKeyId: 'audit-test',
    clientTimestamp: null,
  };
}

describe('canonical encoding', () => {
  it('starts with the version byte', () => {
    const bytes = canonicalBytes(base());
    expect(bytes[0]).toBe(CANONICAL_VERSION);
  });

  it('is deterministic across calls', () => {
    const a = canonicalBytes(base());
    const b = canonicalBytes(base());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('changes when seq changes', () => {
    const a = canonicalBytes(base());
    const e = base();
    e.seq = 2n;
    const b = canonicalBytes(e);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('changes when event_type changes', () => {
    const a = canonicalBytes(base());
    const b = canonicalBytes({ ...base(), eventType: 'engine.other' });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('changes when payload changes', () => {
    const a = canonicalBytes(base());
    const b = canonicalBytes({ ...base(), eventPayload: { from: 'active', to: 'active' } });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('changes when prev_entry_hash changes', () => {
    const a = canonicalBytes(base());
    const b = canonicalBytes({ ...base(), prevEntryHash: new Uint8Array(32).fill(7) });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects malformed uuid', () => {
    expect(() => canonicalBytes({ ...base(), userId: 'not-a-uuid' })).toThrow();
  });
});

describe('canonical JSON', () => {
  it('sorts object keys lexicographically', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).toString('utf8')).toBe('{"a":2,"b":1,"c":3}');
  });

  it('handles nested objects', () => {
    const out = canonicalJson({ outer: { z: 1, a: 2 }, top: true });
    expect(Buffer.from(out).toString('utf8')).toBe('{"outer":{"a":2,"z":1},"top":true}');
  });

  it('handles arrays without sorting them', () => {
    const out = canonicalJson([3, 1, 2]);
    expect(Buffer.from(out).toString('utf8')).toBe('[3,1,2]');
  });

  it('escapes special characters', () => {
    const out = canonicalJson({ msg: 'hello "world"\n' });
    expect(Buffer.from(out).toString('utf8')).toBe('{"msg":"hello \\"world\\"\\n"}');
  });

  it('rejects floats', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/floats/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Infinity })).toThrow();
    expect(() => canonicalJson({ x: NaN })).toThrow();
  });

  it('skips undefined fields', () => {
    const out = canonicalJson({ a: 1, b: undefined, c: 3 });
    expect(Buffer.from(out).toString('utf8')).toBe('{"a":1,"c":3}');
  });
});

describe('entryHash', () => {
  it('produces 32 bytes', () => {
    expect(entryHash(base()).length).toBe(32);
  });

  it('is deterministic', () => {
    expect(Buffer.from(entryHash(base())).equals(Buffer.from(entryHash(base())))).toBe(true);
  });

  it('differs when ANY field differs', () => {
    const variants: CanonicalEntry[] = [
      { ...base(), seq: 2n },
      { ...base(), eventType: 'x' },
      { ...base(), eventPayload: { x: 1 } },
      { ...base(), prevEntryHash: new Uint8Array(32).fill(1) },
      { ...base(), serverTimestamp: new Date(T0.getTime() + 1) },
      { ...base(), serverKeyId: 'other' },
      { ...base(), clientTimestamp: T0 },
    ];
    const baseline = entryHash(base());
    for (const v of variants) {
      expect(Buffer.from(entryHash(v)).equals(Buffer.from(baseline))).toBe(false);
    }
  });
});
