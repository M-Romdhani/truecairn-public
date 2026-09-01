import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto, randomBytes } from '@truecairn/crypto';
import {
  envKekProvider,
  KmsKekProvider,
  OuterKekUnavailableError,
  type KekSet,
  type KmsClient,
} from './kek.js';

// The KEK-provider seam (Phase 5, docs/18 §outer-layer). The env provider is the
// historical default (KEK in process, XChaCha20); the KMS provider keeps the KEK
// in an HSM. Here the KMS logic is exercised via a FAKE KmsClient — the real GCP
// adapter (gcp-kms.ts) is a thin shim, validated in deployment.

beforeAll(async () => {
  await initCrypto();
}, 120_000);

function kekSet(): KekSet {
  const k = { id: 'outer_layer-test00000000', key: new Uint8Array(32).fill(7) };
  return { currentId: k.id, byId: new Map([[k.id, k]]) };
}

describe('EnvKekProvider', () => {
  it('round-trips an outer-layer key (wrap → unwrap) with AAD binding', async () => {
    const p = envKekProvider(kekSet());
    const plaintext = randomBytes(32);
    const aad = new Uint8Array([1, 2, 3, 4]);
    const wrapped = await p.wrap(plaintext, aad);
    expect(wrapped.nonce.length).toBeGreaterThan(0); // env uses an AEAD nonce
    const got = await p.unwrap(p.currentKekId, wrapped, aad);
    expect(Buffer.from(got)).toEqual(Buffer.from(plaintext));
  }, 30_000);

  it('fails the unwrap when the AAD differs (binding enforced)', async () => {
    const p = envKekProvider(kekSet());
    const wrapped = await p.wrap(randomBytes(32), new Uint8Array([1]));
    await expect(p.unwrap(p.currentKekId, wrapped, new Uint8Array([2]))).rejects.toThrow();
  });

  it('throws OuterKekUnavailableError for an unknown kekId', async () => {
    const p = envKekProvider(kekSet());
    const wrapped = await p.wrap(randomBytes(32), new Uint8Array([1]));
    await expect(
      p.unwrap('outer_layer-unknown00000', wrapped, new Uint8Array([1])),
    ).rejects.toBeInstanceOf(OuterKekUnavailableError);
  });
});

// A reversible in-memory stand-in for a KMS: it records the AAD with each
// "ciphertext" token and re-checks it on decrypt, so it exercises the provider's
// AEAD-binding contract without real crypto.
class FakeKms implements KmsClient {
  private readonly store = new Map<string, { aad: string; plaintext: Uint8Array }>();
  encryptCalls = 0;
  decryptCalls = 0;

  async encrypt(input: { plaintext: Uint8Array; aad: Uint8Array }): Promise<Uint8Array> {
    this.encryptCalls += 1;
    const token = `t${this.store.size}`;
    this.store.set(token, { aad: b64(input.aad), plaintext: new Uint8Array(input.plaintext) });
    return new TextEncoder().encode(token);
  }

  async decrypt(input: { ciphertext: Uint8Array; aad: Uint8Array }): Promise<Uint8Array> {
    this.decryptCalls += 1;
    const rec = this.store.get(new TextDecoder().decode(input.ciphertext));
    if (rec === undefined || rec.aad !== b64(input.aad)) {
      throw new Error('fake kms: AAD mismatch or unknown ciphertext');
    }
    return rec.plaintext;
  }
}

function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

describe('KmsKekProvider', () => {
  const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';

  it('wraps via KMS (empty nonce) and unwraps, forwarding the AAD', async () => {
    const kms = new FakeKms();
    const p = new KmsKekProvider(kms, KEY);
    expect(p.currentKekId).toBe(KEY);
    const plaintext = randomBytes(32);
    const aad = new Uint8Array([9, 9, 9]);
    const wrapped = await p.wrap(plaintext, aad);
    expect(wrapped.nonce.length).toBe(0); // the HSM manages its own nonce
    const got = await p.unwrap(p.currentKekId, wrapped, aad);
    expect(Buffer.from(got)).toEqual(Buffer.from(plaintext));
    expect(kms.encryptCalls).toBe(1);
    expect(kms.decryptCalls).toBe(1);
  });

  it('fails the unwrap when the AAD differs (KMS enforces the binding)', async () => {
    const kms = new FakeKms();
    const p = new KmsKekProvider(kms, KEY);
    const wrapped = await p.wrap(randomBytes(32), new Uint8Array([1]));
    await expect(p.unwrap(p.currentKekId, wrapped, new Uint8Array([2]))).rejects.toThrow();
  });
});
