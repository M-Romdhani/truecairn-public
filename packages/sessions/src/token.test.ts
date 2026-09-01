import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashPresentedToken } from './token.js';

describe('session token', () => {
  it('generates a base64url token and a 32-byte SHA-256 hash', () => {
    const { token, tokenHash } = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(tokenHash).toBeInstanceOf(Uint8Array);
    expect(tokenHash).toHaveLength(32);
  });

  it('produces distinct tokens and hashes across calls', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.tokenHash)).not.toEqual(Buffer.from(b.tokenHash));
  });

  it('round-trips a generated token to its stored hash', () => {
    const { token, tokenHash } = generateSessionToken();
    const recomputed = hashPresentedToken(token);
    expect(recomputed).not.toBeNull();
    expect(Buffer.from(recomputed as Uint8Array)).toEqual(Buffer.from(tokenHash));
  });

  it('rejects a wrong-length token as null (clean miss, not a throw)', () => {
    expect(hashPresentedToken('')).toBeNull();
    expect(hashPresentedToken('short')).toBeNull();
    expect(hashPresentedToken(Buffer.alloc(16).toString('base64url'))).toBeNull();
    expect(hashPresentedToken(Buffer.alloc(48).toString('base64url'))).toBeNull();
  });

  it('a tampered token never hashes to the original', () => {
    const { token, tokenHash } = generateSessionToken();
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    const recomputed = hashPresentedToken(flipped);
    if (recomputed !== null) {
      expect(Buffer.from(recomputed)).not.toEqual(Buffer.from(tokenHash));
    }
  });
});
