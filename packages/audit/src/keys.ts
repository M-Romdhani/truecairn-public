import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import { eq } from 'drizzle-orm';
import {
  describeAuditKeyLineage,
  inspectAuditKeyLineage,
  type AuditKeyLineage,
} from './lineage.js';

// In-memory representation of a server signing key. The KeyObject holds the
// private half via Node's crypto subsystem; we never expose its raw bytes
// outside this module unless rotating.
export interface ServerSigner {
  keyId: string;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
  // How this key relates to the chain already in the database, as read at
  // resolve time (F-5). Only resolveServerSigner can know it — decodeServerSigner
  // has no database — so it is optional, and absent means "not established"
  // rather than "fine". Carried here so the ops check can report a boot-time
  // reading instead of re-scanning audit_log on every /status request.
  lineage?: AuditKeyLineage;
}

// Generate a fresh Ed25519 keypair. Returns the same shape as decode() so
// callers can persist + use it.
export function generateServerSigner(): {
  keyId: string;
  publicKey: Uint8Array;
  privateKeyDer: Uint8Array;
  envSerialized: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = extractRawEd25519PublicKey(publicKey);
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    keyId: deriveKeyId(pubRaw),
    publicKey: pubRaw,
    privateKeyDer: new Uint8Array(privDer),
    envSerialized: Buffer.from(privDer).toString('base64'),
  };
}

// Decode a base64-encoded PKCS#8 Ed25519 private key (the format produced by
// generateServerSigner().envSerialized). Returns a usable ServerSigner.
export function decodeServerSigner(b64: string): ServerSigner {
  const der = Buffer.from(b64, 'base64');
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const pubRaw = extractRawEd25519PublicKey(publicKey);
  const keyId = deriveKeyId(pubRaw);
  return {
    keyId,
    publicKey: pubRaw,
    sign: (msg) => new Uint8Array(edSign(null, msg, privateKey)),
  };
}

// Resolve a ServerSigner from env, generating one if the env var is missing.
// On first-boot generation, writes the key id + public part to the registry
// and prints the base64 private key to stderr so the operator can persist it.
// In production a missing key refuses to start: an ephemeral signer would make
// every prior audit signature unverifiable after a restart — and printing a
// production private key to stderr is not a key-management plan.
export async function resolveServerSigner(db: Database): Promise<ServerSigner> {
  const env = process.env['SERVER_AUDIT_SIGNING_KEY'];
  if (env) {
    const signer = decodeServerSigner(env);
    // F-5: check lineage BEFORE registering, because registering is what makes a
    // wrong key look like it belongs. Never fatal — a rotation legitimately puts
    // a new key in front of a chain signed by the old one, and refusing to boot
    // would break the one operation that legitimately causes this. See lineage.ts.
    const lineage = await inspectAuditKeyLineage(db, signer.keyId);
    if (lineage.kind === 'split') {
      process.stderr.write(
        `[audit] WARNING: audit signing key lineage split. ${describeAuditKeyLineage(lineage)}. ` +
          `If you did not just rotate, SERVER_AUDIT_SIGNING_KEY is not the key this chain was ` +
          `built with — verify it against the paper copy before writing more entries.\n`,
      );
    }
    await registerPublicKey(db, signer.keyId, signer.publicKey);
    return { ...signer, lineage };
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'SERVER_AUDIT_SIGNING_KEY must be set in production (refusing an ephemeral audit signer)',
    );
  }
  const generated = generateServerSigner();
  process.stderr.write(
    `[audit] no SERVER_AUDIT_SIGNING_KEY set; generated key_id=${generated.keyId}. ` +
      `Persist this and set in env to keep audit signatures verifiable across restarts:\n` +
      `SERVER_AUDIT_SIGNING_KEY=${generated.envSerialized}\n`,
  );
  // Same reading for the generated key, so /status says the same kind of thing
  // in development as in production. A freshly generated signer in front of an
  // existing chain IS a split — that is the dev-mode shape of exactly the
  // accident F-5 is about (a restart that forgot the variable), and it should
  // look like one rather than being quietly exempt.
  const lineage = await inspectAuditKeyLineage(db, generated.keyId);
  await registerPublicKey(db, generated.keyId, generated.publicKey);
  return { ...decodeServerSigner(generated.envSerialized), lineage };
}

async function registerPublicKey(
  db: Database,
  keyId: string,
  publicKey: Uint8Array,
): Promise<void> {
  await db
    .insert(schema.serverSigningKeys)
    .values({ keyId, publicKey })
    .onConflictDoNothing({ target: schema.serverSigningKeys.keyId });
}

// Look up the public key for a previously-recorded key_id. Used by the
// verifier to validate audit entries signed under retired keys.
export async function loadPublicKey(db: Database, keyId: string): Promise<Uint8Array | null> {
  const rows = await db
    .select({ publicKey: schema.serverSigningKeys.publicKey })
    .from(schema.serverSigningKeys)
    .where(eq(schema.serverSigningKeys.keyId, keyId))
    .limit(1);
  return rows[0]?.publicKey ?? null;
}

export function verifyServerSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  const keyObject = createPublicKey({
    key: Buffer.from(spkiFromRawEd25519PublicKey(publicKey)),
    format: 'der',
    type: 'spki',
  });
  return edVerify(null, message, keyObject, signature);
}

// Verify a user-supplied Ed25519 signature over a message. Used for the
// optional user_signature on sensitive-event audit entries. The user's
// public key lives in user_key_material.audit_signing_pubkey.
export function verifyUserSignature(
  userPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  return verifyServerSignature(userPublicKey, message, signature);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// key_id = "audit-" + first 12 base64url chars of SHA-256(public_key). Stable
// and short; collisions would require a SHA-256 preimage match.
function deriveKeyId(publicKey: Uint8Array): string {
  const digest = createHash('sha256').update(publicKey).digest();
  const b64 = digest
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'audit-' + b64.slice(0, 12);
}

// Node KeyObject only exports SPKI / JWK for public keys. The Ed25519 raw
// public key (32 bytes) is the last 32 bytes of the SPKI DER encoding.
function extractRawEd25519PublicKey(key: KeyObject): Uint8Array {
  const spki = key.export({ type: 'spki', format: 'der' });
  if (spki.length < 32) throw new Error('SPKI too short for Ed25519');
  return new Uint8Array(spki.subarray(spki.length - 32));
}

// Reconstruct the SPKI prefix bytes for an Ed25519 public key. The prefix is
// constant; appending the raw 32-byte key yields valid SPKI.
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function spkiFromRawEd25519PublicKey(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const out = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
  out.set(ED25519_SPKI_PREFIX, 0);
  out.set(raw, ED25519_SPKI_PREFIX.length);
  return out;
}
