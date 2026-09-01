import { beforeAll, describe, expect, it, vi } from 'vitest';

// ── docs/38 F8: the Argon2id evaluation buffer must not outlive the copy ──────
//
// `deriveReleasePassphraseShare` derives a full-strength tier key, COPIES it
// into `shareBytes` via `set`, and returns. Until 2026-08-30 it then dropped the
// original on the floor: a second live copy of release-grade key material with
// no remaining reader and no `finally`, against the repo's own "secrets in
// Uint8Arrays wiped in finally" convention.
//
// The wipe is unobservable from outside the function, so this file mocks the one
// seam that hands the buffer over — `deriveKey` — to keep a REFERENCE to the
// exact array the function derived. `importOriginal` means the real Argon2id
// still runs, so this proves the wipe on the genuine buffer rather than on a
// stub. The frozen KAT in kek.test.ts separately proves the output is unchanged.
const captured = vi.hoisted(() => [] as Uint8Array[]);

vi.mock('@truecairn/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecairn/crypto')>();
  return {
    ...actual,
    deriveKey: (args: Parameters<typeof actual.deriveKey>[0]): Uint8Array => {
      const out = actual.deriveKey(args);
      captured.push(out);
      return out;
    },
  };
});

const { initCrypto, hexToBytes } = await import('@truecairn/crypto');
const { deriveReleasePassphraseShare } = await import('./kek.js');
type Salt = Parameters<typeof deriveReleasePassphraseShare>[1];
type Pass = Parameters<typeof deriveReleasePassphraseShare>[0];

describe('deriveReleasePassphraseShare — key hygiene (F8)', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  const passphrase = new TextEncoder().encode('correct horse battery staple') as Pass;
  const salt = hexToBytes('00'.repeat(16)) as Salt;

  it('zeroizes the derived evaluation buffer once it has been copied', () => {
    captured.length = 0;
    const share = deriveReleasePassphraseShare(passphrase, salt, 's2', 1);

    const evaluation = captured.at(-1);
    expect(evaluation).toBeDefined();
    // The buffer the function derived is zero across every byte.
    expect(Array.from(evaluation as Uint8Array).every((b) => b === 0)).toBe(true);

    // …and the wipe happened AFTER the copy, so the share the caller owns is
    // still real key material. A `finally` that ran too early would zero this
    // too, which is the way this fix could silently destroy a release.
    expect(share.bytes.slice(1).some((b) => b !== 0)).toBe(true);
    expect(share.bytes[0]).toBe(1);
  });

  it('wipes on every call, not just the first', () => {
    captured.length = 0;
    deriveReleasePassphraseShare(passphrase, salt, 's3', 2);
    deriveReleasePassphraseShare(passphrase, salt, 's3', 3);
    expect(captured).toHaveLength(2);
    for (const buf of captured) {
      expect(Array.from(buf).every((b) => b === 0)).toBe(true);
    }
  });
});
