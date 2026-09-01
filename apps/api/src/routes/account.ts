import { schema, type Database } from '@truecairn/db';
import { RELEASE_SHARE_INDEX_S2, S2_SHARES, S3_NESTED_CONTACT_SHARES } from '@truecairn/keys';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import { HONORIFIC_TITLES, LOCALES, PLAN_LIMITS } from '@truecairn/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getEntitlement } from '../billing/entitlement.js';
import { countContacts, countVaultItems } from '../billing/limits.js';
import { requireSession } from '../auth/session.js';
import { requireStepUp } from '../auth/stepup.js';
import { ApiError, badRequest, conflict, unauthorized } from '../errors.js';
import { stepUpLinkage } from './vault.js';

const VAULT_OWNER_REQUIRED_TYPE = 'https://truecairn.app/problems/vault-owner-required';

const b64 = { type: 'string', minLength: 1, maxLength: 8192 } as const;
// One capped resource's usage: current count vs the plan limit (null = unlimited).
const usageShape = {
  type: 'object',
  additionalProperties: false,
  required: ['used', 'limit'],
  properties: { used: { type: 'integer' }, limit: { type: ['integer', 'null'] } },
} as const;
const enqueuedResponse = {
  202: {
    type: 'object',
    additionalProperties: false,
    required: ['sensitiveActionId', 'effectiveAt'],
    properties: { sensitiveActionId: { type: 'string' }, effectiveAt: { type: 'string' } },
  },
} as const;

// Account/key sensitive actions are owner-only (they touch key material / release
// composition). A contact-only account has no key material → 409.
function requireVaultOwner(db: Database) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const rows = await db
      .select({ userId: schema.userKeyMaterial.userId })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, session.userId))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ApiError(
        409,
        'Vault owner required',
        'this account has no master-key material',
        VAULT_OWNER_REQUIRED_TYPE,
      );
    }
  };
}

export function accountRoutes(app: FastifyInstance, db: Database): void {
  const owner = requireVaultOwner(db);

  // ── Who am I (current account email + display profile) ─────────────────────
  // The authenticated owner's own email, plus the optional display name/honorific
  // they set for the account menu (audit M17). The server already holds the email
  // as the login identifier; the name is the same category of display metadata —
  // not vault content — so returning it to the owner's OWN session crosses no
  // zero-knowledge line. displayName/title are null when unset.
  app.get(
    '/v1/account/me',
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['email', 'displayName', 'title', 'locale'],
            properties: {
              email: { type: 'string' },
              displayName: { type: ['string', 'null'] },
              title: { type: ['string', 'null'] },
              // null ⇒ never expressed a preference (migration 0067). The client
              // resolves that through DEFAULT_LOCALE rather than the server
              // guessing, so "no preference" stays visible to the caller.
              locale: { type: ['string', 'null'], enum: [...LOCALES, null] },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const rows = await db
        .select({
          email: schema.users.email,
          displayName: schema.users.displayName,
          title: schema.users.title,
          locale: schema.users.locale,
        })
        .from(schema.users)
        .where(eq(schema.users.id, session.userId))
        .limit(1);
      if (rows[0] === undefined) throw unauthorized('no account');
      return {
        email: rows[0].email,
        displayName: rows[0].displayName,
        title: rows[0].title,
        locale: rows[0].locale,
      };
    },
  );

  // ── Update the display profile (name + honorific) ──────────────────────────
  // NOT a sensitive action: display metadata only — it touches no key material,
  // release composition, or auth path — so no step-up/cooldown (the same lane as
  // the AI preference toggles below). The name is trimmed; an empty name or the
  // "None" honorific is stored as NULL. The update + its audit append ride the
  // same transaction (CLAUDE.md invariant #5); the audit records only WHICH
  // fields are now set, never the name value.
  app.post(
    '/v1/account/profile',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['displayName', 'title'],
          properties: {
            displayName: { type: ['string', 'null'], maxLength: 80 },
            title: { type: ['string', 'null'], enum: [...HONORIFIC_TITLES, null] },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['displayName', 'title'],
            properties: {
              displayName: { type: ['string', 'null'] },
              title: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as { displayName: string | null; title: string | null };
      const trimmed = body.displayName === null ? null : body.displayName.trim();
      const displayName = trimmed === null || trimmed === '' ? null : trimmed;
      const title = body.title;
      const now = new Date();
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .update(schema.users)
          .set({ displayName, title, updatedAt: now })
          .where(eq(schema.users.id, session.userId));
        await audit.append(tx, session.userId, 'account_profile_updated', {
          hasName: displayName !== null,
          hasTitle: title !== null,
        });
      });
      return { displayName, title };
    },
  );

  // ── Plan usage vs limits (for the Plans/Upgrade UI) ────────────────────────
  // The owner's current usage of the capped resources (contacts, vault items,
  // storage) alongside their plan's limits, so the UI can show "3 / 5 used" and
  // point at the real difference between tiers. A read of the owner's OWN counts
  // — no vault content, no zero-knowledge line crossed. `limit: null` = unlimited.
  app.get(
    '/v1/account/usage',
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['plan', 'contacts', 'vaultItems', 'storageBytes'],
            properties: {
              plan: { type: 'string' },
              contacts: usageShape,
              vaultItems: usageShape,
              storageBytes: usageShape,
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const now = new Date();
      const { plan } = await getEntitlement(db, session.userId, now);
      const planLimits = PLAN_LIMITS[plan];
      const [used, contacts, vaultItems] = await Promise.all([
        db
          .select({ b: schema.users.storageBytesUsed })
          .from(schema.users)
          .where(eq(schema.users.id, session.userId))
          .limit(1),
        countContacts(db, session.userId),
        countVaultItems(db, session.userId),
      ]);
      return {
        plan,
        contacts: { used: contacts, limit: planLimits.maxContacts },
        vaultItems: { used: vaultItems, limit: planLimits.maxVaultItems },
        storageBytes: { used: used[0]?.b ?? 0, limit: planLimits.maxStorageBytes },
      };
    },
  );

  // ── Preferred language ─────────────────────────────────────────────────────
  // NOT a sensitive action, and deliberately its OWN route rather than a field on
  // /v1/account/profile. Two reasons. Changing language must not require sending
  // displayName and title back, which a shared route would (both are `required`
  // there), so a language switch in one tab could clobber a name edit in another.
  // And this value is read by the WORKER when it renders the 13 transactional
  // templates — a different consumer, with a different lifetime, from the account
  // menu's display metadata.
  //
  // It touches no key material, release composition or auth path, so it takes the
  // same lane as the AI preference toggles: session only, no step-up, no cooldown.
  // The write and its audit append ride one transaction (CLAUDE.md invariant #5).
  // The audit records the language itself — display metadata, not content, the
  // same category as WHICH profile fields are set, recorded above.
  app.post(
    '/v1/account/locale',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['locale'],
          // The closed set from @truecairn/shared, so an unknown tag is refused at
          // the schema as a 400 and never reaches the CHECK constraint as a 500.
          // Migration 0067's vocabulary is kept in step with this same list by
          // locale-lockstep.test.ts.
          properties: { locale: { type: 'string', enum: [...LOCALES] } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['locale'],
            properties: { locale: { type: 'string', enum: [...LOCALES] } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { locale } = request.body as { locale: string };
      const now = new Date();
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .update(schema.users)
          .set({ locale, updatedAt: now })
          .where(eq(schema.users.id, session.userId));
        await audit.append(tx, session.userId, 'account_profile_updated', {
          setting: 'locale',
          value: locale,
        });
      });
      return { locale };
    },
  );

  // ── Rotate the recovery code (sensitive) ───────────────────────────────────
  // The master KEY is unchanged; the client re-wrapped it under a new recovery
  // KEK. We carry the three recovery fields; the handler swaps them after the
  // cooldown. (POST + body, not a path id — the step-up signature binds the body.)
  app.post(
    '/v1/account/recovery-code/rotate',
    {
      preHandler: [requireSession, owner, requireStepUp('rotate_recovery_code')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['recoveryCodeSalt', 'masterKeyWrappedByRecovery', 'masterKeyRecoveryNonce'],
          properties: {
            recoveryCodeSalt: b64,
            masterKeyWrappedByRecovery: b64,
            masterKeyRecoveryNonce: b64,
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const body = request.body as Record<string, string>;
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'rotate_recovery_code',
        payload: {
          recoveryCodeSalt: body['recoveryCodeSalt'],
          masterKeyWrappedByRecovery: body['masterKeyWrappedByRecovery'],
          masterKeyRecoveryNonce: body['masterKeyRecoveryNonce'],
        },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Change a release-share's factor (sensitive) ────────────────────────────
  // Swaps which factor fills an S2/S3 share slot (the Shamir threshold is locked;
  // this changes the factor, not the count). Client-wrapped material per the new
  // factor; the handler revokes the old share + inserts the new one after cooldown.
  app.post(
    '/v1/release/share-composition',
    {
      preHandler: [requireSession, owner, requireStepUp('change_share_composition')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tier', 'shareIndex', 'newShareType'],
          properties: {
            tier: { type: 'string', enum: ['s2', 's3'] },
            shareIndex: { type: 'integer', minimum: 1, maximum: 16 },
            newShareType: {
              type: 'string',
              enum: ['contact', 'second_professional_contact', 'hardware_key', 'release_passphrase'],
            },
            contactId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            wrappedShareCiphertext: b64,
            passphraseSalt: b64,
            hardwareKeyId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const body = request.body as {
        tier: 's2' | 's3';
        shareIndex: number;
        newShareType: string;
        contactId?: string;
        wrappedShareCiphertext?: string;
        passphraseSalt?: string;
        hardwareKeyId?: string;
      };
      const invalid = validateComposition(body);
      if (invalid !== null) throw badRequest(invalid);

      const payload: Record<string, unknown> = {
        tier: body.tier,
        shareIndex: body.shareIndex,
        newShareType: body.newShareType,
      };
      if (body.contactId !== undefined) payload['contactId'] = body.contactId;
      if (body.wrappedShareCiphertext !== undefined)
        payload['wrappedShareCiphertext'] = body.wrappedShareCiphertext;
      if (body.passphraseSalt !== undefined) payload['passphraseSalt'] = body.passphraseSalt;
      if (body.hardwareKeyId !== undefined) payload['hardwareKeyId'] = body.hardwareKeyId;

      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'change_share_composition',
        payload,
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Rotate the master passphrase (sensitive — the hard one) ────────────────
  // A FULL master-key rotation: the client re-wraps the master key under the new
  // passphrase + existing recovery KEKs, and EVERY tier key under the new
  // tier-wrapping key. The handler structurally validates the payload covers
  // every tier (or cancels with tier_count_mismatch, no mutation), then atomically
  // replaces the key material + force-revokes sessions. We pass the body through
  // as the action payload; the handler is the validation authority.
  app.post(
    '/v1/account/master-passphrase/rotate',
    {
      preHandler: [requireSession, owner, requireStepUp('rotate_master_passphrase')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'masterPassphraseSalt',
            'masterKeyWrappedByPassphrase',
            'masterKeyPassphraseNonce',
            'masterKeyWrappedByRecovery',
            'masterKeyRecoveryNonce',
            'auditSigningPubkey',
            'generation',
            'tierRewraps',
          ],
          properties: {
            masterPassphraseSalt: b64,
            masterKeyWrappedByPassphrase: b64,
            masterKeyPassphraseNonce: b64,
            masterKeyWrappedByRecovery: b64,
            masterKeyRecoveryNonce: b64,
            auditSigningPubkey: b64,
            generation: { type: 'integer', minimum: 2 },
            tierRewraps: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['tier', 'tierKeyWrappedByMaster', 'tierKeyMasterNonce'],
                properties: {
                  tier: { type: 'string', enum: ['s1', 's2', 's3'] },
                  tierKeyWrappedByMaster: b64,
                  tierKeyMasterNonce: b64,
                },
              },
            },
          },
        },
        response: enqueuedResponse,
      },
    },
    enqueueBodyAsPayload(db, app, 'rotate_master_passphrase'),
  );

  // ── Rotate the release passphrase (sensitive — re-split S2/S3) ─────────────
  // Re-wraps every active S2/S3 share with the new split + supplies the new salt.
  // Handler validates every active share is covered (or share_count_mismatch) and
  // is BLOCKED while a ceremony is in flight (a mid-ceremony re-split mixes
  // polynomials). Body passes through as the payload.
  app.post(
    '/v1/account/release-passphrase/rotate',
    {
      preHandler: [requireSession, owner, requireStepUp('rotate_release_passphrase')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['releasePassphraseSalt', 'shares'],
          properties: {
            releasePassphraseSalt: b64,
            shares: {
              type: 'array',
              minItems: 1,
              maxItems: 16,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['tier', 'shareIndex', 'shareType'],
                properties: {
                  tier: { type: 'string', enum: ['s2', 's3'] },
                  shareIndex: { type: 'integer', minimum: 1, maximum: 16 },
                  shareType: {
                    type: 'string',
                    enum: ['contact', 'second_professional_contact', 'hardware_key', 'release_passphrase'],
                  },
                  contactId: {
                    type: 'string',
                    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
                  },
                  wrappedShareCiphertext: b64,
                  passphraseSalt: b64,
                  hardwareKeyId: {
                    type: 'string',
                    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
                  },
                },
              },
            },
          },
        },
        response: enqueuedResponse,
      },
    },
    enqueueBodyAsPayload(db, app, 'rotate_release_passphrase'),
  );

  // ── Remove a hardware key (sensitive) ──────────────────────────────────────
  // The handler re-counts surviving auth paths at apply and CANCELS (credential
  // stays active) if this would remove the user's last login path.
  app.post(
    '/v1/account/hardware-keys/remove',
    {
      preHandler: [requireSession, owner, requireStepUp('remove_hardware_key')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['credentialId'],
          properties: {
            credentialId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
        },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const { credentialId } = request.body as { credentialId: string };
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'remove_hardware_key',
        payload: { credentialId },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Delete the account (sensitive) ─────────────────────────────────────────
  // After the cooldown the handler purges the user's data, deletes attachment
  // blobs (best-effort), and tombstones the users row — the audit log survives.
  app.post(
    '/v1/account/delete',
    {
      preHandler: [requireSession, owner, requireStepUp('delete_account')],
      schema: {
        body: { type: 'object', additionalProperties: false, properties: {} },
        response: enqueuedResponse,
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null) {
        throw unauthorized('auth backend unavailable');
      }
      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'delete_account',
        payload: {},
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: stepUpLinkage(stepUp),
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Record the release-passphrase share slot (Checkpoint B, Q8 deferred) ───
  // S2 ONLY. The flat S2 scheme reserves a fixed last index for the passphrase
  // share; at the first S2 assignment the client records that the slot is the
  // passphrase factor (only the SALT is stored — it already lives in
  // user_key_material; this row makes the composition enumerable), never the
  // share value. Nested S3 (docs/24) has NO passphrase slot — the passphrase is
  // the XOR mask, recorded only as the KDF salt — so S3 never calls this.
  // Create-once + idempotent, so no step-up: it writes no secret and can't
  // displace another factor (swaps go through change_share_composition).
  app.post(
    '/v1/release/passphrase-slot',
    {
      preHandler: [requireSession, owner],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tier'],
          properties: { tier: { type: 'string', enum: ['s2'] } },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { tier } = request.body as { tier: 's2' };
      const shareIndex = RELEASE_SHARE_INDEX_S2;

      const material = await db
        .select({ salt: schema.userKeyMaterial.releasePassphraseSalt })
        .from(schema.userKeyMaterial)
        .where(eq(schema.userKeyMaterial.userId, session.userId))
        .limit(1);
      const salt = material[0]?.salt;
      if (salt === undefined) throw unauthorized('no key material'); // owner guard makes this unreachable

      const existing = await db
        .select({ shareType: schema.releaseShares.shareType })
        .from(schema.releaseShares)
        .where(
          and(
            eq(schema.releaseShares.userId, session.userId),
            eq(schema.releaseShares.tier, tier),
            eq(schema.releaseShares.shareIndex, shareIndex),
            isNull(schema.releaseShares.revokedAt),
          ),
        )
        .limit(1);
      const occupant = existing[0];
      if (occupant !== undefined) {
        if (occupant.shareType === 'release_passphrase') {
          return { created: false as const, shareIndex }; // already recorded
        }
        throw conflict('the release slot is held by another factor (use share-composition to swap)');
      }

      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx.insert(schema.releaseShares).values({
          userId: session.userId,
          tier,
          shareIndex,
          shareType: 'release_passphrase',
          passphraseSalt: salt,
        });
        await audit.append(tx, session.userId, 'release.passphrase_slot_recorded', {
          tier,
          shareIndex,
        });
      });
      return { created: true as const, shareIndex };
    },
  );

  // ── AI opt-out (plan docs/25 §4 task 0.3 / D5) ─────────────────────────────
  // A per-user preference, NOT a sensitive action: it touches no key material and
  // only ever REDUCES what AI can do (opting out is the fail-closed direction), so
  // no step-up/cooldown. When set, the AI guard short-circuits before any prompt is
  // built (see ai/guard.ts). GET returns the current value for the Settings toggle.
  app.get(
    '/v1/account/ai-settings',
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['optOut'],
            properties: { optOut: { type: 'boolean' } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const [row] = await db
        .select({ optOut: schema.users.aiOptOut })
        .from(schema.users)
        .where(eq(schema.users.id, session.userId))
        .limit(1);
      if (row === undefined) throw unauthorized('no account');
      return { optOut: row.optOut };
    },
  );

  app.post(
    '/v1/account/ai-opt-out',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['optOut'],
          properties: { optOut: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['optOut'],
            properties: { optOut: { type: 'boolean' } },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { optOut } = request.body as { optOut: boolean };
      const now = new Date();
      // The setting change + its audit append ride the same transaction (CLAUDE.md
      // invariant #5). actor defaults to 'owner' — this is the account-holder's
      // own preference change, not an AI action.
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .update(schema.users)
          .set({ aiOptOut: optOut, updatedAt: now })
          .where(eq(schema.users.id, session.userId));
        await audit.append(tx, session.userId, 'ai_config_changed', {
          setting: 'ai_opt_out',
          value: optOut,
        });
      });
      return { optOut };
    },
  );

  // ── AI autonomy opt-in (plan docs/25 §6 / Phase 2) ─────────────────────────
  // Per-user opt-in for bounded autonomy + the check-in floor. NOT a sensitive
  // action: enabling autonomy only ever ADDS a vetoable helper and can only tighten
  // (never loosen) protection, so no step-up. The floor is the bound below which the
  // AI may never autonomously shorten the check-in interval; null ⇒ nudges only.
  app.get(
    '/v1/account/ai-autonomy',
    {
      preHandler: requireSession,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'checkinFloorDays'],
            properties: {
              enabled: { type: 'boolean' },
              checkinFloorDays: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const [row] = await db
        .select({
          enabled: schema.users.aiAutonomyEnabled,
          floor: schema.users.aiCheckinFloorDays,
        })
        .from(schema.users)
        .where(eq(schema.users.id, session.userId))
        .limit(1);
      if (row === undefined) throw unauthorized('no account');
      return { enabled: row.enabled, checkinFloorDays: row.floor };
    },
  );

  app.post(
    '/v1/account/ai-autonomy',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
            // null clears the floor (nudges only, no autonomous tightening).
            checkinFloorDays: { type: ['integer', 'null'], minimum: 1, maximum: 3650 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'checkinFloorDays'],
            properties: {
              enabled: { type: 'boolean' },
              checkinFloorDays: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as { enabled: boolean; checkinFloorDays?: number | null };
      const floor = body.checkinFloorDays ?? null;
      const now = new Date();
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .update(schema.users)
          .set({ aiAutonomyEnabled: body.enabled, aiCheckinFloorDays: floor, updatedAt: now })
          .where(eq(schema.users.id, session.userId));
        await audit.append(tx, session.userId, 'ai_config_changed', {
          setting: 'ai_autonomy',
          enabled: body.enabled,
          checkinFloorDays: floor,
        });
      });
      return { enabled: body.enabled, checkinFloorDays: floor };
    },
  );
}

// Shared handler for the two key-rotation enqueues: the request body IS the action
// payload (the worker handler is the validation authority), recorded with the
// step-up linkage + requesting session.
function enqueueBodyAsPayload(
  db: Database,
  app: FastifyInstance,
  actionType: 'rotate_master_passphrase' | 'rotate_release_passphrase',
) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const session = request.session;
    const audit = app.audit;
    const stepUp = request.stepUp;
    if (session === null || stepUp === null || audit === null) {
      throw unauthorized('auth backend unavailable');
    }
    const result = await requestSensitiveAction(db, audit, {
      userId: session.userId,
      actionType,
      payload: request.body as Record<string, unknown>,
      now: new Date(),
      requestedBySessionId: session.id,
      stepUp: stepUpLinkage(stepUp),
    });
    void reply.status(202);
    return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
  };
}

// shareIndex bound + factor rules. S2 (flat 2-of-3) has 3 slots (1..3) with the
// passphrase as the reserved last factor. Nested S3 (docs/24) has NO passphrase
// slot — the passphrase is the XOR mask — so S3 is contact/hardware shares at
// indices 1..S3_NESTED_CONTACT_SHARES only; a release_passphrase factor is rejected.
function validateComposition(body: {
  tier: 's2' | 's3';
  shareIndex: number;
  newShareType: string;
  contactId?: string;
  wrappedShareCiphertext?: string;
  passphraseSalt?: string;
}): string | null {
  const maxIndex = body.tier === 's2' ? S2_SHARES : S3_NESTED_CONTACT_SHARES;
  if (body.shareIndex > maxIndex) return `shareIndex must be 1..${maxIndex} for ${body.tier}`;
  switch (body.newShareType) {
    case 'contact':
    case 'second_professional_contact':
      if (body.contactId === undefined || body.wrappedShareCiphertext === undefined) {
        return 'a contact share requires contactId + wrappedShareCiphertext';
      }
      return null;
    case 'hardware_key':
      if (body.wrappedShareCiphertext === undefined) return 'a hardware_key share requires wrappedShareCiphertext';
      return null;
    case 'release_passphrase':
      if (body.tier === 's3') return 'S3 has no release-passphrase slot (the passphrase is the nested mask)';
      if (body.passphraseSalt === undefined) return 'a release_passphrase share requires passphraseSalt';
      return null;
    default:
      return 'invalid newShareType';
  }
}
