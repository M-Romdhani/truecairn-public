import { readFileSync } from 'node:fs';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, initCrypto } from '@truecairn/crypto';
import {
  derivePassphraseKek,
  deriveRecoveryKek,
  generateMasterKdfSalt,
  generateMasterKey,
  unwrapMasterKeyByPassphrase,
  validateTierKeyCheck,
  wrapMasterKeyByPassphrase,
  type MasterKdfSalt,
  type MasterPassphrase,
  type RecoveryCode,
  type RecoveryKdfSalt,
} from '@truecairn/keys';
import { generateEnrollmentMaterial } from './enrollment.js';
import { decodeKeyMaterial, encodeKeyMaterial } from './material.js';
import * as session from './session.js';

// Interop proof (PHASE4 §d): the client crypto and the server crypto MUST produce
// byte-identical results, or a wrap on one side fails to unwrap on the other and
// a ceremony silently breaks. We init via the Node default loader here (the real
// browser loader is exercised by the C2 Vite app); the load-bearing properties —
// the KAT match and the cross-side round-trip — are loader-independent.

const enc = new TextEncoder();
const readVector = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as Record<string, unknown>;

beforeAll(async () => {
  await initCrypto();
});
afterEach(() => {
  session.lock();
});

describe('client/server crypto interop (PHASE4 C1)', () => {
  // KAT: the client's KDF reproduces the SERVER's frozen kek.json vectors
  // byte-for-byte — the version-pin / param-drift guard (PHASE4 Q5). Reads the
  // EXACT same fixture the @truecairn/keys suite uses.
  it('derives passphrase + recovery KEKs matching the server kek.json KAT', () => {
    const v = readVector('../../keys/src/vectors/kek.json');
    const p = v['passphraseKek'] as { passphraseAscii: string; saltHex: string; expectedKekHex: string };
    const passKek = derivePassphraseKek(
      enc.encode(p.passphraseAscii) as MasterPassphrase,
      hexToBytes(p.saltHex) as MasterKdfSalt,
    );
    expect(bytesToHex(passKek)).toBe(p.expectedKekHex);

    const r = v['recoveryKek'] as { codeHex: string; saltHex: string; expectedKekHex: string };
    const recKek = deriveRecoveryKek(
      hexToBytes(r.codeHex) as RecoveryCode,
      hexToBytes(r.saltHex) as RecoveryKdfSalt,
    );
    expect(bytesToHex(recKek)).toBe(r.expectedKekHex);
  });

  // The load-bearing test (reviewer-specified): derive the master KEK from a
  // known passphrase + salt, wrap a known plaintext, and prove the SERVER path
  // (raw @truecairn/keys unwrap) recovers it byte-for-byte — and the reverse.
  it('client-wrap → server-unwrap round-trips byte-for-byte, both directions', () => {
    const passphrase = 'correct horse battery staple';
    const salt = generateMasterKdfSalt();
    const plaintext = generateMasterKey(); // a known 32-byte "master key"

    // CLIENT wraps under a freshly derived KEK.
    const clientKek = derivePassphraseKek(enc.encode(passphrase) as MasterPassphrase, salt);
    const wrapped = wrapMasterKeyByPassphrase(plaintext, clientKek);

    // SERVER re-derives the KEK (determinism) and unwraps → identical bytes.
    const serverKek = derivePassphraseKek(enc.encode(passphrase) as MasterPassphrase, salt);
    const recovered = unwrapMasterKeyByPassphrase(wrapped, serverKek);
    expect(bytesToHex(recovered)).toBe(bytesToHex(plaintext));

    // Reverse direction (server wraps, client unwraps) is the same code path with
    // the roles swapped; a second wrap+unwrap confirms it is symmetric.
    const wrapped2 = wrapMasterKeyByPassphrase(plaintext, serverKek);
    expect(bytesToHex(unwrapMasterKeyByPassphrase(wrapped2, clientKek))).toBe(bytesToHex(plaintext));
  });

  // Full enrollment → wire DTO → unlock: the material the client UPLOADS at
  // enrollment is exactly what the session CONSUMES at login; both the passphrase
  // and recovery paths recover the same master key, and every tier key unwraps
  // and validates against its check sentinel (proving the whole hierarchy interops
  // across the base64 wire boundary).
  it('enrollment material round-trips through the wire DTO and unlocks (both paths)', () => {
    const { material, recoveryCode } = generateEnrollmentMaterial(enc.encode('pw-enroll'));

    // Simulate POST → store → GET: encode to base64 DTO and decode back.
    const material2 = decodeKeyMaterial(encodeKeyMaterial(material));
    expect(bytesToHex(material2.masterKeyWrappedByPassphrase)).toBe(
      bytesToHex(material.masterKeyWrappedByPassphrase),
    );
    expect(material2.tierKeys).toHaveLength(3);

    // Passphrase unlock → every tier key unwraps and validates.
    session.unlock(enc.encode('pw-enroll'), material2);
    expect(session.isUnlocked()).toBe(true);
    for (const t of material2.tierKeys) {
      const ok = session.withTierKey(t.tier, (tierKey) =>
        validateTierKeyCheck(
          tierKey,
          {
            plaintext: t.tierKeyCheckPlaintext,
            ciphertext: t.tierKeyCheckCiphertext,
            nonce: t.tierKeyCheckNonce,
          },
          t.generation,
        ),
      );
      expect(ok).toBe(true);
    }
    session.lock();

    // Recovery unlock yields the SAME master key (tier check still validates).
    session.unlockWithRecovery(recoveryCode, material2);
    expect(session.isUnlocked()).toBe(true);
    const s1 = material2.tierKeys.find((t) => t.tier === 's1')!;
    const okRecovery = session.withTierKey('s1', (tierKey) =>
      validateTierKeyCheck(
        tierKey,
        { plaintext: s1.tierKeyCheckPlaintext, ciphertext: s1.tierKeyCheckCiphertext, nonce: s1.tierKeyCheckNonce },
        s1.generation,
      ),
    );
    expect(okRecovery).toBe(true);
  });
});
