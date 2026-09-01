import { schema, type Database } from '@truecairn/db';
import {
  S2_SHARES,
  S2_THRESHOLD,
  S3_NESTED_CONTACT_SHARES,
  S3_NESTED_CONTACT_THRESHOLD,
} from '@truecairn/keys';
import type { UserId, VaultTier } from '@truecairn/shared';
import { loadOrProvisionOuterKey } from '@truecairn/vault';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';

// Enrollment provisioning + login bootstrap of zero-knowledge key material
// (PHASE4 R0.4 — the gap Phase 3 deferred). The client generates ALL of this
// (random master key wrapped twice, three tier keys, the master-derived audit
// pubkey, the KDF salts) and uploads the wrapped forms here at enrollment; at
// login it fetches them back to derive the passphrase KEK and unlock. The server
// stores ciphertext + salts + a public key only — never a plaintext secret.
//
// Both routes are requireSession ONLY: bootstrap must work for a logged-in but
// still-LOCKED user (you need this material TO unlock — gating it on unlock would
// be circular), and it touches no key material the server could decrypt.

const b64 = { type: 'string', minLength: 1, maxLength: 16384 } as const;
const tierEnum = { type: 'string', enum: ['s1', 's2', 's3'] } as const;

const tierKeyItem = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tier',
    'tierKeyWrappedByMaster',
    'tierKeyMasterNonce',
    'tierKeyCheckPlaintext',
    'tierKeyCheckCiphertext',
    'tierKeyCheckNonce',
  ],
  properties: {
    tier: tierEnum,
    tierKeyWrappedByMaster: b64,
    tierKeyMasterNonce: b64,
    tierKeyCheckPlaintext: b64,
    tierKeyCheckCiphertext: b64,
    tierKeyCheckNonce: b64,
  },
} as const;

const provisionBody = {
  type: 'object',
  additionalProperties: false,
  required: [
    'masterPassphraseSalt',
    'masterKeyWrappedByPassphrase',
    'masterKeyPassphraseNonce',
    'recoveryCodeSalt',
    'masterKeyWrappedByRecovery',
    'masterKeyRecoveryNonce',
    'releasePassphraseSalt',
    'auditSigningPubkey',
    'tierKeys',
  ],
  properties: {
    masterPassphraseSalt: b64,
    masterKeyWrappedByPassphrase: b64,
    masterKeyPassphraseNonce: b64,
    recoveryCodeSalt: b64,
    masterKeyWrappedByRecovery: b64,
    masterKeyRecoveryNonce: b64,
    releasePassphraseSalt: b64,
    auditSigningPubkey: b64,
    // The owner's write-only capture PUBLIC key (docs/34). Optional so an older
    // client can still enrol; accounts without one publish it on first unlock via
    // PUT /v1/account/capture-key.
    vaultCapturePubkey: b64,
    // All three tiers, exactly once — the tier keys exist from enrollment so S2/S3
    // release composition can be set up later (PHASE4 Q8).
    tierKeys: { type: 'array', minItems: 3, maxItems: 3, items: tierKeyItem },
  },
} as const;

interface TierKeyDto {
  tier: VaultTier;
  tierKeyWrappedByMaster: string;
  tierKeyMasterNonce: string;
  tierKeyCheckPlaintext: string;
  tierKeyCheckCiphertext: string;
  tierKeyCheckNonce: string;
}
interface ProvisionBody {
  masterPassphraseSalt: string;
  masterKeyWrappedByPassphrase: string;
  masterKeyPassphraseNonce: string;
  recoveryCodeSalt: string;
  masterKeyWrappedByRecovery: string;
  masterKeyRecoveryNonce: string;
  releasePassphraseSalt: string;
  auditSigningPubkey: string;
  vaultCapturePubkey?: string;
  tierKeys: TierKeyDto[];
}

// Shamir scheme metadata per tier (locked presets). Informational on the row;
// the actual shares are created later at contact/plan setup.
const SHAMIR: Record<VaultTier, { threshold: number | null; shares: number | null }> = {
  s1: { threshold: null, shares: null },
  s2: { threshold: S2_THRESHOLD, shares: S2_SHARES },
  // S3 nested (docs/24): contacts hold a 2-of-3 split of the masked key; the
  // mandatory release passphrase is the XOR mask, not a counted Shamir share.
  s3: { threshold: S3_NESTED_CONTACT_THRESHOLD, shares: S3_NESTED_CONTACT_SHARES },
};

const dec = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const enc = (b: Uint8Array): string => Buffer.from(b).toString('base64');

export function keyMaterialRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  // ── Provision (enrollment) ────────────────────────────────────────────────
  app.post(
    '/v1/account/key-material',
    { preHandler: [requireSession], schema: { body: provisionBody } },
    async (request, reply) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const userId = session.userId as UserId;
      const body = request.body as ProvisionBody;

      const tiers = new Set(body.tierKeys.map((t) => t.tier));
      if (tiers.size !== 3 || !(['s1', 's2', 's3'] as const).every((t) => tiers.has(t))) {
        throw badRequest('tierKeys must cover s1, s2 and s3 exactly once');
      }

      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        // Seed-once: a re-provision would orphan every already-wrapped vault item
        // (their per-item keys are wrapped under the tier keys we'd replace). Same
        // discipline as the vault backup slot — reject, never overwrite.
        const existing = await tx
          .select({ userId: schema.userKeyMaterial.userId })
          .from(schema.userKeyMaterial)
          .where(eq(schema.userKeyMaterial.userId, userId))
          .limit(1);
        if (existing[0] !== undefined) {
          throw conflict('key material already provisioned for this account');
        }

        await tx.insert(schema.userKeyMaterial).values({
          userId,
          masterPassphraseSalt: dec(body.masterPassphraseSalt),
          masterKeyWrappedByPassphrase: dec(body.masterKeyWrappedByPassphrase),
          masterKeyPassphraseNonce: dec(body.masterKeyPassphraseNonce),
          recoveryCodeSalt: dec(body.recoveryCodeSalt),
          masterKeyWrappedByRecovery: dec(body.masterKeyWrappedByRecovery),
          masterKeyRecoveryNonce: dec(body.masterKeyRecoveryNonce),
          releasePassphraseSalt: dec(body.releasePassphraseSalt),
          auditSigningPubkey: dec(body.auditSigningPubkey),
          vaultCapturePubkey:
            body.vaultCapturePubkey !== undefined ? dec(body.vaultCapturePubkey) : null,
          generation: 1,
        });

        for (const t of body.tierKeys) {
          // The server generates the per-tier OUTER key (temporal gate) eagerly,
          // since user_tier_keys.outer_layer_key_id is NOT NULL. The vault store
          // path later finds it via the load branch on first item store.
          const outer = await loadOrProvisionOuterKey(tx, config.outerLayerKeks, userId, t.tier);
          const s = SHAMIR[t.tier];
          await tx.insert(schema.userTierKeys).values({
            userId,
            tier: t.tier,
            tierKeyWrappedByMaster: dec(t.tierKeyWrappedByMaster),
            tierKeyMasterNonce: dec(t.tierKeyMasterNonce),
            outerLayerKeyId: outer.id,
            shamirThreshold: s.threshold,
            shamirShareCount: s.shares,
            generation: 1,
            tierKeyCheckPlaintext: dec(t.tierKeyCheckPlaintext),
            tierKeyCheckCiphertext: dec(t.tierKeyCheckCiphertext),
            tierKeyCheckNonce: dec(t.tierKeyCheckNonce),
          });
        }
      });

      void reply.status(201);
      // Return the user's own id so a freshly-registered client (which only knows
      // its credentialId) can sign step-up payloads without a separate round-trip.
      return { provisioned: true, userId };
    },
  );

  // ── Bootstrap (login/unlock) ──────────────────────────────────────────────
  app.get(
    '/v1/account/key-material',
    { preHandler: [requireSession] },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const userId = session.userId as UserId;

      const km = (
        await db
          .select()
          .from(schema.userKeyMaterial)
          .where(eq(schema.userKeyMaterial.userId, userId))
          .limit(1)
      )[0];
      if (km === undefined) throw notFound('no key material provisioned for this account');

      const tierRows = await db
        .select()
        .from(schema.userTierKeys)
        .where(eq(schema.userTierKeys.userId, userId));

      return {
        // The session's own user id (non-secret) — the client needs it to build
        // step-up signing inputs after a login bootstrap.
        userId,
        masterPassphraseSalt: enc(km.masterPassphraseSalt),
        masterKeyWrappedByPassphrase: enc(km.masterKeyWrappedByPassphrase),
        masterKeyPassphraseNonce: enc(km.masterKeyPassphraseNonce),
        recoveryCodeSalt: enc(km.recoveryCodeSalt),
        masterKeyWrappedByRecovery: enc(km.masterKeyWrappedByRecovery),
        masterKeyRecoveryNonce: enc(km.masterKeyRecoveryNonce),
        releasePassphraseSalt: enc(km.releasePassphraseSalt),
        auditSigningPubkey: enc(km.auditSigningPubkey),
        // null for accounts enrolled before capture existed — the client derives
        // and publishes it on this same unlock (docs/34 §5).
        vaultCapturePubkey: km.vaultCapturePubkey != null ? enc(km.vaultCapturePubkey) : null,
        generation: km.generation,
        tierKeys: tierRows.map((t) => ({
          tier: t.tier,
          generation: t.generation,
          tierKeyWrappedByMaster: enc(t.tierKeyWrappedByMaster),
          tierKeyMasterNonce: enc(t.tierKeyMasterNonce),
          tierKeyCheckPlaintext: enc(t.tierKeyCheckPlaintext),
          tierKeyCheckCiphertext: enc(t.tierKeyCheckCiphertext),
          tierKeyCheckNonce: enc(t.tierKeyCheckNonce),
        })),
      };
    },
  );
}
