import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import { hashPassword, SENTINEL_PASSWORD_HASH, verifyPassword } from './password.js';

beforeAll(async () => {
  await initCrypto();
});

describe('password hashing (Argon2id via @truecairn/crypto KDF)', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const phc = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', phc)).toBe(true);
    expect(verifyPassword('wrong password', phc)).toBe(false);
  });

  it('uses a fresh salt per call (same password -> different encodings)', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    expect(verifyPassword('same', a)).toBe(true);
    expect(verifyPassword('same', b)).toBe(true);
  });

  it('no password matches the in-memory sentinel', () => {
    expect(verifyPassword('', SENTINEL_PASSWORD_HASH)).toBe(false);
    expect(verifyPassword('anything', SENTINEL_PASSWORD_HASH)).toBe(false);
  });

  it('rejects a malformed encoding without throwing', () => {
    expect(verifyPassword('x', 'not-a-valid-encoding')).toBe(false);
    expect(verifyPassword('x', 'v1$2$1$$')).toBe(false);
  });
});
