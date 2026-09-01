import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto, randomSecretboxKey } from '@truecairn/crypto';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  hotp,
  totpCode,
  verifyTotp,
} from './totp.js';

beforeAll(async () => {
  await initCrypto();
});

const RFC4226_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
// RFC 4226 Appendix D, the canonical 6-digit HOTP values for counters 0..9.
const RFC4226 = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
];

describe('HOTP (RFC 4226 vectors)', () => {
  it('matches the RFC 4226 Appendix D test vectors', () => {
    for (let c = 0; c < RFC4226.length; c++) {
      expect(hotp(RFC4226_SECRET, c)).toBe(RFC4226[c]);
    }
  });
});

describe('TOTP verify (current + previous window, 30s drift)', () => {
  const secret = RFC4226_SECRET;

  it('accepts the current-window code', () => {
    const now = new Date('2026-05-29T12:00:00Z');
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
  });

  it('accepts a code from the previous window', () => {
    const t0 = new Date('2026-05-29T12:00:00Z');
    const code = totpCode(secret, t0);
    const t1 = new Date(t0.getTime() + 30_000); // +1 window: t0's code is now "previous"
    expect(verifyTotp(secret, code, t1)).toBe(true);
  });

  it('rejects a code two windows old', () => {
    const t0 = new Date('2026-05-29T12:00:00Z');
    const code = totpCode(secret, t0);
    const t2 = new Date(t0.getTime() + 60_000);
    expect(verifyTotp(secret, code, t2)).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000', new Date('2026-05-29T12:00:00Z'))).toBe(false);
  });
});

describe('TOTP secret encryption (XChaCha20-Poly1305 under the KEK)', () => {
  it('round-trips a generated secret', () => {
    const kek = randomSecretboxKey();
    const secret = generateTotpSecret();
    const enc = encryptTotpSecret(kek, secret);
    expect([...decryptTotpSecret(kek, enc)]).toEqual([...secret]);
  });
});
