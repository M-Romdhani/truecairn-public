import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  base64urlToBytes,
  bytesToBase64url,
  isSignCountRegression,
  parseAaguid,
  resolveExpectedOrigin,
} from './webauthn.js';

// docs/35 §3 — native clients assert from an origin that is not our https one.
// Android's Credential Manager sends `android:apk-key-hash:<fingerprint>`; that
// value IS the app's release signing identity restated, so it must be named
// explicitly and can never be inferred.
describe('resolveExpectedOrigin (native app origins)', () => {
  const base = { rpId: 'truecairn.app', rpName: 'Truecairn', origin: 'https://truecairn.app' };
  const android = 'android:apk-key-hash:47DEQpj8HBSaTImW1p3rM0zH1PtA5Bzo1RCTQKPWeQU';

  // The house "absent ⇒ byte-identical" rule, made structural: with nothing
  // configured the verifier receives the same lone STRING it received before
  // this option existed — not a one-element array that merely behaves the same.
  it('is the bare origin string when no native origin is configured', () => {
    expect(resolveExpectedOrigin(base)).toBe('https://truecairn.app');
    expect(resolveExpectedOrigin({ ...base, nativeOrigins: [] })).toBe('https://truecairn.app');
  });

  it('appends configured native origins, keeping the web origin first', () => {
    expect(resolveExpectedOrigin({ ...base, nativeOrigins: [android] })).toEqual([
      'https://truecairn.app',
      android,
    ]);
  });

  // The web origin is never displaced by adding a phone: the browser is still
  // the only client that can unlock a vault, so losing it would be a far worse
  // outage than mobile never working.
  it('keeps the web origin accepted when native origins are present', () => {
    const resolved = resolveExpectedOrigin({ ...base, nativeOrigins: [android, 'ios://x'] });
    expect(resolved).toContain('https://truecairn.app');
    expect(resolved).toHaveLength(3);
  });
});

describe('WEBAUTHN_NATIVE_ORIGINS parsing', () => {
  const env = (v?: string): NodeJS.ProcessEnv => ({
    ...(v !== undefined ? { WEBAUTHN_NATIVE_ORIGINS: v } : {}),
  });

  it('defaults to empty when unset or blank', () => {
    expect(loadConfig(env()).webauthnNativeOrigins).toEqual([]);
    expect(loadConfig(env('')).webauthnNativeOrigins).toEqual([]);
  });

  it('splits, trims, and drops blank entries', () => {
    // A trailing comma in a deploy variable must not become an empty expected
    // origin — an empty string is a wildcard-shaped value to hand a verifier.
    expect(loadConfig(env('android:apk-key-hash:aaa, https://x.test ,')).webauthnNativeOrigins)
      .toEqual(['android:apk-key-hash:aaa', 'https://x.test']);
  });
});

describe('isSignCountRegression (clone-detection rule)', () => {
  it('accepts an authenticator that implements no counter (0 -> 0)', () => {
    expect(isSignCountRegression(0, 0)).toBe(false);
  });
  it('accepts a strictly increasing counter', () => {
    expect(isSignCountRegression(0, 5)).toBe(false);
    expect(isSignCountRegression(5, 6)).toBe(false);
  });
  it('rejects a flat non-zero counter (clone signal)', () => {
    expect(isSignCountRegression(5, 5)).toBe(true);
  });
  it('rejects a decreasing counter (clone signal)', () => {
    expect(isSignCountRegression(5, 4)).toBe(true);
    expect(isSignCountRegression(5, 0)).toBe(true);
  });
});

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const b = new Uint8Array([0, 1, 2, 127, 128, 250, 255]);
    expect([...base64urlToBytes(bytesToBase64url(b))]).toEqual([...b]);
  });
});

describe('parseAaguid', () => {
  it('parses a formatted GUID to 16 bytes', () => {
    const g = parseAaguid('01020304-0506-0708-090a-0b0c0d0e0f10');
    expect(g).not.toBeNull();
    expect(g).toHaveLength(16);
    expect([...(g as Uint8Array)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });
  it('returns null for a malformed GUID', () => {
    expect(parseAaguid('not-a-guid')).toBeNull();
    expect(parseAaguid('')).toBeNull();
  });
});
