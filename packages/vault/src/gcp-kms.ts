import type { KmsClient } from './kek.js';

// GCP Cloud KMS adapter for the KmsClient seam (Phase 5, docs/18 §outer-layer).
// The KEK is a Cloud KMS symmetric cryptoKey that NEVER leaves the HSM; we send
// only the (small) outer-layer key to KMS to wrap/unwrap, AEAD-bound to `aad`
// (additionalAuthenticatedData). Auth is Application Default Credentials — the
// same ADC the API already materialises for Vertex — so no key material is in env.
//
// @google-cloud/kms is an OPTIONAL dependency, imported LAZILY on first call, so
// env-only deployments never load it (and importing this module loads no SDK).
// NOT exercised by CI (no live KMS); the provider LOGIC is unit-tested via a fake
// KmsClient (kek.test.ts), and THIS adapter is validated in deployment.

// The slice of the SDK surface we use — the constructed client is cast to this so
// the adapter doesn't couple to the SDK's full generated types.
interface KmsApiClient {
  encrypt(req: {
    name: string;
    plaintext: Buffer;
    additionalAuthenticatedData: Buffer;
  }): Promise<[{ ciphertext?: Uint8Array | string | null }]>;
  decrypt(req: {
    name: string;
    ciphertext: Buffer;
    additionalAuthenticatedData: Buffer;
  }): Promise<[{ plaintext?: Uint8Array | string | null }]>;
}

export class GcpKmsClient implements KmsClient {
  // `keyName`: the Cloud KMS cryptoKey resource —
  // projects/P/locations/L/keyRings/R/cryptoKeys/K
  constructor(private readonly keyName: string) {}

  private clientPromise: Promise<KmsApiClient> | undefined;

  private client(): Promise<KmsApiClient> {
    if (this.clientPromise === undefined) {
      this.clientPromise = import('@google-cloud/kms').then(
        (mod) => new mod.KeyManagementServiceClient() as unknown as KmsApiClient,
      );
    }
    return this.clientPromise;
  }

  async encrypt(input: { plaintext: Uint8Array; aad: Uint8Array }): Promise<Uint8Array> {
    const client = await this.client();
    const [res] = await client.encrypt({
      name: this.keyName,
      plaintext: Buffer.from(input.plaintext),
      additionalAuthenticatedData: Buffer.from(input.aad),
    });
    if (res.ciphertext === undefined || res.ciphertext === null) {
      throw new Error('Cloud KMS encrypt returned no ciphertext');
    }
    return toBytes(res.ciphertext);
  }

  async decrypt(input: { ciphertext: Uint8Array; aad: Uint8Array }): Promise<Uint8Array> {
    const client = await this.client();
    const [res] = await client.decrypt({
      name: this.keyName,
      ciphertext: Buffer.from(input.ciphertext),
      additionalAuthenticatedData: Buffer.from(input.aad),
    });
    if (res.plaintext === undefined || res.plaintext === null) {
      throw new Error('Cloud KMS decrypt returned no plaintext');
    }
    return toBytes(res.plaintext);
  }
}

// gax returns bytes fields as Buffer by default, or a base64 string if the client
// is configured with fallback/JSON — accept either.
function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? new Uint8Array(Buffer.from(v, 'base64')) : new Uint8Array(v);
}
