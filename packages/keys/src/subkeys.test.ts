import { beforeAll, describe, expect, it } from 'vitest';
import vectorFile from './vectors/subkeys.json' with { type: 'json' };
import {
  bytesToHex,
  ed25519KeypairFromSeed,
  hexToBytes,
  initCrypto,
  randomBytes,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  x25519KeypairFromSeed,
} from '@truecairn/crypto';
import {
  deriveAuditSigningSeed,
  deriveContactPinKey,
  deriveContactX25519Seed,
  deriveTierWrappingKey,
  deriveVaultCaptureX25519Seed,
} from './subkeys.js';
import {
  AUDIT_SIGNING_SEED_BYTES,
  KDF_CONTEXT_AUDIT,
  CONTACT_PIN_KEY_BYTES,
  KDF_CONTEXT_CONTACT_PIN,
  KDF_CONTEXT_CONTACT_X25519,
  KDF_CONTEXT_VAULT_CAPTURE,
  KDF_CONTEXT_WRAP,
  TIER_WRAPPING_KEY_BYTES,
  VAULT_CAPTURE_X25519_SEED_BYTES,
  type UnwrappedMasterKey,
} from './types.js';

beforeAll(async () => {
  await initCrypto();
});

describe('deriveAuditSigningSeed — frozen KAT', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex) as UnwrappedMasterKey;

  it('produces the locked seed bytes for the documented master key', () => {
    const seed = deriveAuditSigningSeed(masterKey);
    expect(bytesToHex(seed)).toBe(vectorFile.auditSigningSeedHex);
    expect(seed.length).toBe(AUDIT_SIGNING_SEED_BYTES);
  });
});

describe('deriveTierWrappingKey — frozen KAT', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex) as UnwrappedMasterKey;

  it('produces the locked key bytes for the documented master key', () => {
    const key = deriveTierWrappingKey(masterKey);
    expect(bytesToHex(key)).toBe(vectorFile.tierWrappingKeyHex);
    expect(key.length).toBe(TIER_WRAPPING_KEY_BYTES);
  });
});

// The critical property: the two subkeys derived from the same master key
// MUST differ. A typo making KDF_CONTEXT_AUDIT === KDF_CONTEXT_WRAP, or
// matching subkey ids with matching contexts, would collapse them into the
// same key and silently violate key separation.
describe('subkey domain separation', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex) as UnwrappedMasterKey;

  it('audit signing seed ≠ tier wrapping key', () => {
    const a = deriveAuditSigningSeed(masterKey);
    const b = deriveTierWrappingKey(masterKey);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('audit signing seed ≠ master key bytes', () => {
    const seed = deriveAuditSigningSeed(masterKey);
    expect(bytesToHex(seed)).not.toBe(bytesToHex(masterKey));
  });

  it('tier wrapping key ≠ master key bytes', () => {
    const key = deriveTierWrappingKey(masterKey);
    expect(bytesToHex(key)).not.toBe(bytesToHex(masterKey));
  });

  it('contexts are distinct (compile-time-style assertion at runtime)', () => {
    // Belt-and-braces: catches a copy-paste accident where both contexts
    // become the same string. If this fails, the KAT test above would
    // also fail (the two subkeys would be equal), but the separate
    // assertion makes the source of the bug obvious.
    expect(KDF_CONTEXT_AUDIT).not.toBe(KDF_CONTEXT_WRAP);
  });

  it('contexts are exactly 8 bytes UTF-8 (libsodium KDF requirement)', () => {
    expect(new TextEncoder().encode(KDF_CONTEXT_AUDIT).length).toBe(8);
    expect(new TextEncoder().encode(KDF_CONTEXT_WRAP).length).toBe(8);
    expect(new TextEncoder().encode(KDF_CONTEXT_VAULT_CAPTURE).length).toBe(8);
  });
});

// docs/34 — the owner's write-only capture keypair.
describe('deriveVaultCaptureX25519Seed — frozen KAT', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex) as UnwrappedMasterKey;

  it('produces the locked seed bytes for the documented master key', () => {
    const seed = deriveVaultCaptureX25519Seed(masterKey);
    expect(bytesToHex(seed)).toBe(vectorFile.vaultCapture.seedHex);
    expect(seed.length).toBe(VAULT_CAPTURE_X25519_SEED_BYTES);
  });

  // The public key is the value that actually leaves the browser and lands on a
  // phone. Pinning it catches a change in HOW the keypair is built from the seed,
  // which the seed assertion alone would sail past — and that change would strand
  // every capture already sealed to the old key.
  it('produces the locked PUBLIC key, the value phones hold', () => {
    const kp = x25519KeypairFromSeed(deriveVaultCaptureX25519Seed(masterKey));
    expect(bytesToHex(kp.publicKey)).toBe(vectorFile.vaultCapture.publicKeyHex);
  });

  it('is deterministic, so publishing it twice is a no-op rather than a rotation', () => {
    const a = x25519KeypairFromSeed(deriveVaultCaptureX25519Seed(masterKey));
    const b = x25519KeypairFromSeed(deriveVaultCaptureX25519Seed(masterKey));
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  // The owner's capture key and a CONTACT's share-receipt key are both X25519
  // seeds derived from a master key. If the contexts ever collided, a contact's
  // affirmation keypair would double as the owner's capture keypair — one
  // compromised contact device would then open every unfiled capture.
  it('is not the contact X25519 seed (context collision would be catastrophic)', () => {
    const capture = deriveVaultCaptureX25519Seed(masterKey);
    const contact = deriveContactX25519Seed(masterKey);
    expect(bytesToHex(capture)).not.toBe(bytesToHex(contact));
    expect(KDF_CONTEXT_VAULT_CAPTURE).not.toBe(KDF_CONTEXT_CONTACT_X25519);
  });

  it('is not the audit signing seed or the tier wrapping key', () => {
    const capture = bytesToHex(deriveVaultCaptureX25519Seed(masterKey));
    expect(capture).not.toBe(bytesToHex(deriveAuditSigningSeed(masterKey)));
    expect(capture).not.toBe(bytesToHex(deriveTierWrappingKey(masterKey)));
    expect(capture).not.toBe(bytesToHex(masterKey));
  });

  // The property the whole feature rests on (docs/34 D1): the public half seals,
  // and only the master-derived secret half opens. A phone holding the pubkey
  // cannot read back even its own capture, because crypto_box_seal throws away
  // the ephemeral secret it used.
  it('seals to the public half and opens only with the master-derived secret', () => {
    const kp = x25519KeypairFromSeed(deriveVaultCaptureX25519Seed(masterKey));
    const captureKey = randomBytes(32);
    const sealed = sealedBoxEncrypt({ recipientPublicKey: kp.publicKey, plaintext: captureKey });
    expect(bytesToHex(sealed)).not.toContain(bytesToHex(captureKey));

    const opened = sealedBoxDecrypt({
      recipientPublicKey: kp.publicKey,
      recipientSecretKey: kp.secretKey,
      ciphertext: sealed,
    });
    expect(bytesToHex(opened)).toBe(bytesToHex(captureKey));

    // A different master key — i.e. anyone who is not the owner — cannot open it.
    const stranger = x25519KeypairFromSeed(
      deriveVaultCaptureX25519Seed(randomBytes(32) as UnwrappedMasterKey),
    );
    expect(() =>
      sealedBoxDecrypt({
        recipientPublicKey: stranger.publicKey,
        recipientSecretKey: stranger.secretKey,
        ciphertext: sealed,
      }),
    ).toThrow();
  });
});

describe('subkey properties — determinism and master-key sensitivity', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex) as UnwrappedMasterKey;

  it('same master key → same audit signing seed every time', () => {
    const a = deriveAuditSigningSeed(masterKey);
    const b = deriveAuditSigningSeed(masterKey);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('same master key → same tier wrapping key every time', () => {
    const a = deriveTierWrappingKey(masterKey);
    const b = deriveTierWrappingKey(masterKey);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('different master keys → different audit signing seeds', () => {
    const other = randomBytes(32) as UnwrappedMasterKey;
    const a = deriveAuditSigningSeed(masterKey);
    const b = deriveAuditSigningSeed(other);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('different master keys → different tier wrapping keys', () => {
    const other = randomBytes(32) as UnwrappedMasterKey;
    const a = deriveTierWrappingKey(masterKey);
    const b = deriveTierWrappingKey(other);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('a single-bit change in the master key changes BOTH subkeys', () => {
    const flipped = new Uint8Array(masterKey);
    flipped[0] = flipped[0]! ^ 0x01;
    const a1 = deriveAuditSigningSeed(masterKey);
    const a2 = deriveAuditSigningSeed(flipped as UnwrappedMasterKey);
    const t1 = deriveTierWrappingKey(masterKey);
    const t2 = deriveTierWrappingKey(flipped as UnwrappedMasterKey);
    expect(bytesToHex(a1)).not.toBe(bytesToHex(a2));
    expect(bytesToHex(t1)).not.toBe(bytesToHex(t2));
  });
});

// Integration smoke: the audit signing seed must be a valid Ed25519 seed
// (any 32 bytes are valid). Confirms downstream consumers can construct
// the keypair from the seed without surprises.
describe('audit signing seed → Ed25519 keypair', () => {
  const masterKey = hexToBytes(vectorFile.masterKeyHex) as UnwrappedMasterKey;

  it('produces a usable Ed25519 keypair (32-byte pubkey, 64-byte secret)', () => {
    const seed = deriveAuditSigningSeed(masterKey);
    const kp = ed25519KeypairFromSeed(seed);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);
  });

  it('same master key → same audit pubkey (deterministic verification key)', () => {
    const seed = deriveAuditSigningSeed(masterKey);
    const a = ed25519KeypairFromSeed(seed);
    const b = ed25519KeypairFromSeed(seed);
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });
});

// ── F1 + F2: the contact-metadata key (PLAN-v1-launch.md §1.2) ───────────────
describe('deriveContactPinKey — contact labels and pins off the S1 tier key', () => {
  const master = hexToBytes(vectorFile.masterKeyHex) as never;

  it('matches the frozen vector', () => {
    expect(bytesToHex(deriveContactPinKey(master))).toBe(vectorFile.contactPin.contactPinKeyHex);
  });

  it('uses an 8-byte context, as crypto_kdf_derive_from_key requires', () => {
    // The plan specified 'tc-cpin', which is SEVEN bytes and throws on first
    // call. This is the assertion that would have caught it at review time.
    expect(new TextEncoder().encode(KDF_CONTEXT_CONTACT_PIN)).toHaveLength(8);
    expect(KDF_CONTEXT_CONTACT_PIN).toBe(vectorFile.contactPin.context);
  });

  it('is deterministic and the declared length', () => {
    const a = deriveContactPinKey(master);
    const b = deriveContactPinKey(master);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(a).toHaveLength(CONTACT_PIN_KEY_BYTES);
  });

  // Domain separation is the property the whole change rests on: if this key
  // collided with any other subkey off the same master, moving labels onto it
  // would move them onto something already in circulation.
  it('is distinct from every other subkey derived from the same master key', () => {
    const pin = bytesToHex(deriveContactPinKey(master));
    expect(pin).not.toBe(bytesToHex(deriveTierWrappingKey(master)));
    expect(pin).not.toBe(bytesToHex(deriveAuditSigningSeed(master)));
    expect(pin).not.toBe(bytesToHex(deriveContactX25519Seed(master)));
    expect(pin).not.toBe(bytesToHex(deriveVaultCaptureX25519Seed(master)));
  });

  it('changes completely with the master key — it is master-derived, not fixed', () => {
    const other = hexToBytes('cd'.repeat(32)) as never;
    expect(bytesToHex(deriveContactPinKey(other))).not.toBe(
      bytesToHex(deriveContactPinKey(master)),
    );
  });
});

