import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, initCrypto, randomBytes } from '@truecairn/crypto';
import { derivePassphraseKek, deriveRecoveryKek } from './kek.js';
import {
  generateMasterKey,
  generateRecoveryCode,
  unwrapMasterKeyByPassphrase,
  unwrapMasterKeyByRecovery,
  wrapMasterKeyByPassphrase,
  wrapMasterKeyByRecovery,
} from './master-key.js';
import {
  MASTER_KEY_BYTES,
  type MasterKdfSalt,
  type MasterKeyWrappedByPassphrase,
  type MasterKeyWrappedByRecovery,
  type MasterPassphrase,
  type PassphraseKek,
  type RecoveryCode,
  type RecoveryKdfSalt,
  type RecoveryKek,
  type UnwrappedMasterKey,
} from './types.js';

// The KEK derivations are slow (production Argon2id), so we generate one
// PassphraseKek + one RecoveryKek in beforeAll and reuse them across every
// wrap/unwrap test. That keeps the master-key test surface fast (~3-4s
// total: 2 KEK derivations + many instant wraps/unwraps).

let passphraseKek: PassphraseKek;
let recoveryKek: RecoveryKek;

beforeAll(async () => {
  await initCrypto();
  const passphrase = new TextEncoder().encode('master-key-test-passphrase') as MasterPassphrase;
  const passSalt = hexToBytes('0001020304050607' + '08090a0b0c0d0e0f') as MasterKdfSalt;
  passphraseKek = derivePassphraseKek(passphrase, passSalt);

  const code = hexToBytes(
    '1011121314151617' + '18191a1b1c1d1e1f' +
    '2021222324252627' + '28292a2b2c2d2e2f',
  ) as RecoveryCode;
  const recoverySalt = hexToBytes('3031323334353637' + '38393a3b3c3d3e3f') as RecoveryKdfSalt;
  recoveryKek = deriveRecoveryKek(code, recoverySalt);
}, 60_000);

describe('generateMasterKey', () => {
  it('returns 32 random bytes', () => {
    const mk = generateMasterKey();
    expect(mk.length).toBe(MASTER_KEY_BYTES);
  });

  it('two consecutive calls return different keys', () => {
    expect(bytesToHex(generateMasterKey())).not.toBe(bytesToHex(generateMasterKey()));
  });
});

describe('wrap/unwrap by passphrase — round-trip', () => {
  it('unwrap(wrap(mk, kek), kek) returns the original bytes', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const recovered = unwrapMasterKeyByPassphrase(wrapped, passphraseKek);
    expect(bytesToHex(recovered)).toBe(bytesToHex(mk));
  });

  it('wrap output is { ciphertext, nonce }; ciphertext length = key + 16 (AEAD tag)', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByPassphrase(mk, passphraseKek);
    expect(wrapped.nonce.length).toBe(24);
    expect(wrapped.ciphertext.length).toBe(MASTER_KEY_BYTES + 16);
  });

  it('two wraps of the same key produce different ciphertexts (nonce randomness)', () => {
    const mk = generateMasterKey();
    const a = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const b = wrapMasterKeyByPassphrase(mk, passphraseKek);
    expect(bytesToHex(a.nonce)).not.toBe(bytesToHex(b.nonce));
    expect(bytesToHex(a.ciphertext)).not.toBe(bytesToHex(b.ciphertext));
  });
});

describe('wrap/unwrap by recovery — round-trip', () => {
  it('unwrap(wrap(mk, kek), kek) returns the original bytes', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByRecovery(mk, recoveryKek);
    const recovered = unwrapMasterKeyByRecovery(wrapped, recoveryKek);
    expect(bytesToHex(recovered)).toBe(bytesToHex(mk));
  });
});

describe('cross-wrap consistency — both wrappings unwrap to the same key', () => {
  it('passphrase- and recovery-wrappings of the same master key yield identical plaintext', () => {
    const mk = generateMasterKey();
    const wrappedP = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const wrappedR = wrapMasterKeyByRecovery(mk, recoveryKek);
    const recoveredP = unwrapMasterKeyByPassphrase(wrappedP, passphraseKek);
    const recoveredR = unwrapMasterKeyByRecovery(wrappedR, recoveryKek);
    expect(bytesToHex(recoveredP)).toBe(bytesToHex(mk));
    expect(bytesToHex(recoveredR)).toBe(bytesToHex(mk));
    expect(bytesToHex(recoveredP)).toBe(bytesToHex(recoveredR));
  });
});

describe('wrap/unwrap by passphrase — authentication failures', () => {
  it('wrong KEK on unwrap throws', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const wrongKek = randomBytes(32) as PassphraseKek;
    expect(() => unwrapMasterKeyByPassphrase(wrapped, wrongKek)).toThrow();
  });

  it('tampered ciphertext byte throws', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const tamperedCt = new Uint8Array(wrapped.ciphertext);
    tamperedCt[0] = tamperedCt[0]! ^ 0x01;
    const tampered = {
      ciphertext: tamperedCt,
      nonce: wrapped.nonce,
    } as MasterKeyWrappedByPassphrase;
    expect(() => unwrapMasterKeyByPassphrase(tampered, passphraseKek)).toThrow();
  });

  it('tampered Poly1305 tag byte throws', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const tamperedCt = new Uint8Array(wrapped.ciphertext);
    tamperedCt[tamperedCt.length - 1] = tamperedCt[tamperedCt.length - 1]! ^ 0x01;
    const tampered = {
      ciphertext: tamperedCt,
      nonce: wrapped.nonce,
    } as MasterKeyWrappedByPassphrase;
    expect(() => unwrapMasterKeyByPassphrase(tampered, passphraseKek)).toThrow();
  });

  it('tampered nonce throws', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByPassphrase(mk, passphraseKek);
    const tamperedNonce = new Uint8Array(wrapped.nonce);
    tamperedNonce[0] = tamperedNonce[0]! ^ 0x01;
    const tampered = {
      ciphertext: wrapped.ciphertext,
      nonce: tamperedNonce,
    } as MasterKeyWrappedByPassphrase;
    expect(() => unwrapMasterKeyByPassphrase(tampered, passphraseKek)).toThrow();
  });

  it('wrap rejects master key of wrong length', () => {
    const tooShort = randomBytes(16) as UnwrappedMasterKey;
    expect(() => wrapMasterKeyByPassphrase(tooShort, passphraseKek)).toThrow(
      /masterKey must be 32/,
    );
  });
});

describe('wrap/unwrap by recovery — authentication failures', () => {
  it('wrong KEK on unwrap throws', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByRecovery(mk, recoveryKek);
    const wrongKek = randomBytes(32) as RecoveryKek;
    expect(() => unwrapMasterKeyByRecovery(wrapped, wrongKek)).toThrow();
  });

  it('tampered ciphertext throws', () => {
    const mk = generateMasterKey();
    const wrapped = wrapMasterKeyByRecovery(mk, recoveryKek);
    const tamperedCt = new Uint8Array(wrapped.ciphertext);
    tamperedCt[0] = tamperedCt[0]! ^ 0x01;
    const tampered = {
      ciphertext: tamperedCt,
      nonce: wrapped.nonce,
    } as MasterKeyWrappedByRecovery;
    expect(() => unwrapMasterKeyByRecovery(tampered, recoveryKek)).toThrow();
  });
});

describe('generateRecoveryCode', () => {
  it('returns 32 random bytes', () => {
    expect(generateRecoveryCode().length).toBe(32);
  });

  it('two consecutive calls return different codes', () => {
    expect(bytesToHex(generateRecoveryCode())).not.toBe(bytesToHex(generateRecoveryCode()));
  });
});
