import { ed25519Verify, randomBytes } from '@truecairn/crypto';
import {
  cancelCeremoniesForUser,
  recordRecipientReconstruction,
  verifyShareSignature,
} from '@truecairn/ceremony';
import { schema, type Database } from '@truecairn/db';
import { applyEvent, DbChannelLookup, loadRow } from '@truecairn/engine';
import { S2_THRESHOLD, S3_NESTED_CONTACT_THRESHOLD } from '@truecairn/keys';
import type { CeremonyStatus, UserId } from '@truecairn/shared';
import { decryptOuterEnvelope } from '@truecairn/vault';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { createChallenge, claimChallenge } from '../auth/challenges.js';
import type { ApiConfig } from '../config.js';
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../errors.js';

const GATE_CLOSED_TYPE = 'https://truecairn.app/problems/release-gate-closed';
const AFFIRM_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ED25519_SIGNATURE_BYTES = 64;
const X25519_PUBKEY_BYTES = 32;
// How long the temporal gate stays open for remaining recipients after the
// first one completes — mirrors the processor's reconstruction-timeout ruling.
const RECONSTRUCTION_GATE_DAYS = 30;

// Ceremony statuses past which nothing more can happen. Derived by exclusion from
// CEREMONY_STATUSES so a status added later must be classified deliberately
// rather than silently inheriting "still live" — the complement of the live set
// the ceremony package cancels over.
const TERMINAL_CEREMONY_STATUSES: ReadonlySet<string> = new Set<CeremonyStatus>([
  'released',
  'cancelled',
  'failed',
]);

// The affirmation possession proof signs (challenge || ceremonyId) so a signed
// challenge can never be replayed against a different ceremony and the
// signature is non-repudiable evidence of WHAT was affirmed.
function affirmationMessage(challenge: Uint8Array, ceremonyId: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(challenge), Buffer.from(ceremonyId, 'utf8')]));
}

// Contact-facing release-ceremony API (CEREMONY_COMPLETION Bridge 3). Every route
// is gated on the CONTACT's OWN session (contacts are full users, 3.2 Q3) — the
// authorization is a ceremony_affirmations row linking this ceremony to a contact
// whose contactUserId is the caller. Affirm carries a possession proof (the C4
// Ed25519 affirmation key); revoke/dispute are protective and need only the session.
export function ceremonyRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const channels = new DbChannelLookup(db);

  // The caller's affirmation context for a ceremony, or null if they aren't a
  // recipient of it (→ 404, no existence disclosure).
  async function loadFor(
    ceremonyId: string,
    contactUserId: UserId,
  ): Promise<{
    affirmationId: string;
    contactId: string;
    shareId: string | null;
    ed25519Pubkey: Uint8Array | null;
    affStatus: string;
    disputedAt: Date | null;
    ownerUserId: UserId;
    ceremonyStatus: string;
    reconstructionStartedAt: Date | null;
    tier: string;
  } | null> {
    const rows = await db
      .select({
        affirmationId: schema.ceremonyAffirmations.id,
        contactId: schema.ceremonyAffirmations.contactId,
        shareId: schema.ceremonyAffirmations.shareId,
        ed25519Pubkey: schema.contacts.contactEd25519Pubkey,
        affStatus: schema.ceremonyAffirmations.status,
        disputedAt: schema.ceremonyAffirmations.disputedAt,
        ownerUserId: schema.releaseCeremonies.userId,
        ceremonyStatus: schema.releaseCeremonies.status,
        reconstructionStartedAt: schema.releaseCeremonies.reconstructionStartedAt,
        tier: schema.releaseCeremonies.tier,
      })
      .from(schema.ceremonyAffirmations)
      .innerJoin(schema.contacts, eq(schema.ceremonyAffirmations.contactId, schema.contacts.id))
      .innerJoin(
        schema.releaseCeremonies,
        eq(schema.ceremonyAffirmations.ceremonyId, schema.releaseCeremonies.id),
      )
      .where(
        and(
          eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId),
          eq(schema.contacts.contactUserId, contactUserId),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (r === undefined) return null;
    return {
      affirmationId: r.affirmationId,
      contactId: r.contactId,
      shareId: r.shareId,
      ed25519Pubkey: r.ed25519Pubkey,
      affStatus: r.affStatus,
      disputedAt: r.disputedAt,
      ownerUserId: r.ownerUserId as UserId,
      ceremonyStatus: r.ceremonyStatus,
      reconstructionStartedAt: r.reconstructionStartedAt,
      tier: r.tier,
    };
  }

  // The caller's RECIPIENT context — the path for collecting shares + reconstructing.
  // Authorizes BOTH affirming holders (recipient + affirmation rows) AND designated
  // beneficiaries (recipient row, NO affirmation — backlog #2). Returns null if the
  // caller is not a recipient of this ceremony (→ 404, no existence disclosure).
  async function loadRecipient(
    ceremonyId: string,
    contactUserId: UserId,
  ): Promise<{
    recipientId: string;
    contactId: string;
    ownerUserId: UserId;
    ceremonyStatus: string;
    tier: string;
    reconstructionStartedAt: Date | null;
    ephemeralPubkey: Uint8Array | null;
    affStatus: string | null;
    isBeneficiary: boolean;
  } | null> {
    const rows = await db
      .select({
        recipientId: schema.ceremonyRecipients.id,
        contactId: schema.ceremonyRecipients.recipientContactId,
        ephemeralPubkey: schema.ceremonyRecipients.ephemeralPubkey,
        ownerUserId: schema.releaseCeremonies.userId,
        ceremonyStatus: schema.releaseCeremonies.status,
        tier: schema.releaseCeremonies.tier,
        reconstructionStartedAt: schema.releaseCeremonies.reconstructionStartedAt,
        affStatus: schema.ceremonyAffirmations.status,
      })
      .from(schema.ceremonyRecipients)
      .innerJoin(schema.contacts, eq(schema.ceremonyRecipients.recipientContactId, schema.contacts.id))
      .innerJoin(
        schema.releaseCeremonies,
        eq(schema.ceremonyRecipients.ceremonyId, schema.releaseCeremonies.id),
      )
      .leftJoin(
        schema.ceremonyAffirmations,
        and(
          eq(schema.ceremonyAffirmations.ceremonyId, schema.ceremonyRecipients.ceremonyId),
          eq(schema.ceremonyAffirmations.contactId, schema.ceremonyRecipients.recipientContactId),
        ),
      )
      .where(
        and(
          eq(schema.ceremonyRecipients.ceremonyId, ceremonyId),
          eq(schema.contacts.contactUserId, contactUserId),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (r === undefined) return null;
    // Beneficiary status is computed for EVERY tier — an S1 beneficiary holds
    // their own owner-sealed envelope and must pass mayCollect like S2/S3 ones.
    const ben = await db
      .select({ id: schema.releaseBeneficiaries.id })
      .from(schema.releaseBeneficiaries)
      .where(
        and(
          eq(schema.releaseBeneficiaries.userId, r.ownerUserId as UserId),
          eq(schema.releaseBeneficiaries.tier, r.tier),
          eq(schema.releaseBeneficiaries.contactId, r.contactId),
          isNull(schema.releaseBeneficiaries.revokedAt),
        ),
      )
      .limit(1);
    const isBeneficiary = ben[0] !== undefined;
    return {
      recipientId: r.recipientId,
      contactId: r.contactId,
      ownerUserId: r.ownerUserId as UserId,
      ceremonyStatus: r.ceremonyStatus,
      tier: r.tier,
      reconstructionStartedAt: r.reconstructionStartedAt,
      ephemeralPubkey: r.ephemeralPubkey,
      affStatus: r.affStatus,
      isBeneficiary,
    };
  }

  // May this recipient collect the actual key material (shares / release salt)? A
  // committed affirmer (a consensus participant) or a designated beneficiary. A
  // holder who never affirmed and is not a beneficiary may NOT — consensus is the
  // affirming holders, never the beneficiary.
  function mayCollect(ctx: { affStatus: string | null; isBeneficiary: boolean }): boolean {
    return ctx.affStatus === 'committed' || ctx.isBeneficiary;
  }

  // The temporal gate. Open while the ceremony is 'reconstructing', and it STAYS
  // open after the first recipient's success flips the ceremony to 'released' —
  // every other recipient reconstructs independently (transitions.ts) and must
  // not be locked out by whoever finished first. The released grace is bounded
  // by the same reconstruction-timeout ruling (30 days from gate opening), so
  // the gate never outlives the window a live ceremony would have had.
  function gateOpen(ctx: {
    ceremonyStatus: string;
    reconstructionStartedAt: Date | null;
  }): boolean {
    if (ctx.ceremonyStatus === 'reconstructing') return true;
    if (ctx.ceremonyStatus !== 'released') return false;
    if (ctx.reconstructionStartedAt === null) return false;
    return (
      Date.now() <
      ctx.reconstructionStartedAt.getTime() + RECONSTRUCTION_GATE_DAYS * 24 * 60 * 60 * 1000
    );
  }

  // May a recipient still PREPARE to recover — register an ephemeral, fetch its
  // seal context, receive a freshly-sealed share? Accepts everything up to and
  // including the open reconstruction gate. The C2 promise (QA 2026-07-21 D9):
  // the first recipient's success flips the ceremony to 'released', but a lagging
  // recipient must NOT be locked out — they can still register and a not-yet-
  // retrieved contact can still seal to them, for exactly as long as they could
  // still reconstruct (the same 30-day window gateOpen enforces). 'cancelled' /
  // 'failed' are truly terminal and never accept; 'released' past the gate is
  // closed by gateOpen. Everything pre-release accepts as before. This does NOT
  // touch the release gate itself (/shares, /released-items stay gateOpen +
  // mayCollect) — it only lets a legitimate recipient gather what they're
  // already entitled to.
  function acceptsRecoveryContribution(ctx: {
    ceremonyStatus: string;
    reconstructionStartedAt: Date | null;
  }): boolean {
    if (ctx.ceremonyStatus === 'cancelled' || ctx.ceremonyStatus === 'failed') return false;
    if (ctx.ceremonyStatus === 'released') return gateOpen(ctx);
    return true;
  }

  // ── List: the live ceremonies this contact is a recipient of ───────────────
  // Recipient-centric: every holder AND every designated beneficiary has a
  // ceremony_recipients row. Left-join the caller's affirmation (holders have one;
  // beneficiaries don't → myAffirmation null).
  app.get('/v1/ceremonies', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const rows = await db
      .select({
        ceremonyId: schema.releaseCeremonies.id,
        tier: schema.releaseCeremonies.tier,
        status: schema.releaseCeremonies.status,
        myAffirmation: schema.ceremonyAffirmations.status,
        // The caller's OWN change-your-mind deadline (QA 2026-07-21 D5): the
        // portal shows it so "revocable" is a concrete time, not a vibe.
        myRevocationWindowExpiresAt: schema.ceremonyAffirmations.revocationWindowExpiresAt,
        myRecipientStatus: schema.ceremonyRecipients.status,
      })
      .from(schema.ceremonyRecipients)
      .innerJoin(schema.contacts, eq(schema.ceremonyRecipients.recipientContactId, schema.contacts.id))
      .innerJoin(
        schema.releaseCeremonies,
        eq(schema.ceremonyRecipients.ceremonyId, schema.releaseCeremonies.id),
      )
      .leftJoin(
        schema.ceremonyAffirmations,
        and(
          eq(schema.ceremonyAffirmations.ceremonyId, schema.ceremonyRecipients.ceremonyId),
          eq(schema.ceremonyAffirmations.contactId, schema.ceremonyRecipients.recipientContactId),
        ),
      )
      .where(eq(schema.contacts.contactUserId, session.userId));
    return { ceremonies: rows };
  });

  // ── View: what's happening + my own affirmation + peer progress ─────────────
  // Recipient-scoped (not affirmation-scoped) so a designated beneficiary — a
  // recipient with NO affirmation row — sees the same detail the list shows
  // them (myAffirmation null), instead of a 404 the list contradicts.
  app.get('/v1/ceremonies/:id', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    const ctx = await loadRecipient(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    const counts = await affirmationCounts(db, id);
    return {
      ceremonyId: id,
      tier: ctx.tier,
      status: ctx.ceremonyStatus,
      myAffirmation: ctx.affStatus,
      committed: counts.committed,
      total: counts.total,
    };
  });

  // ── Affirm: possession-proof challenge, then verify → tentative ─────────────
  app.post('/v1/ceremonies/:id/affirm/options', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    const ctx = await loadFor(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    const challenge = randomBytes(32);
    const created = await createChallenge(db, {
      userId: session.userId,
      purpose: 'ceremony_affirmation',
      challenge,
      expiresAt: new Date(Date.now() + AFFIRM_CHALLENGE_TTL_MS),
      now: new Date(),
    });
    return { challengeId: created.id, challenge: Buffer.from(challenge).toString('base64url') };
  });

  app.post(
    '/v1/ceremonies/:id/affirm',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['challengeId', 'signature'],
          properties: {
            challengeId: { type: 'string', minLength: 1, maxLength: 64 },
            signature: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { id } = request.params as { id: string };
      const body = request.body as { challengeId: string; signature: string };
      const ctx = await loadFor(id, session.userId);
      if (ctx === null) throw notFound('ceremony not found');
      if (ctx.ceremonyStatus !== 'collecting_affirmations') {
        throw conflict('this ceremony is not collecting affirmations');
      }
      if (ctx.affStatus !== 'pending') throw conflict(`affirmation already ${ctx.affStatus}`);
      if (ctx.ed25519Pubkey === null) throw conflict('contact has no affirmation key enrolled');

      const now = new Date();
      const claimed = await claimChallenge(db, {
        id: body.challengeId,
        purpose: 'ceremony_affirmation',
        now,
      });
      if (claimed === null || claimed.userId !== session.userId) {
        throw badRequest('affirmation challenge invalid or expired');
      }
      const sig = new Uint8Array(Buffer.from(body.signature, 'base64'));
      if (sig.length !== ED25519_SIGNATURE_BYTES) throw badRequest('malformed signature');
      if (!ed25519Verify(sig, affirmationMessage(claimed.challenge, id), ctx.ed25519Pubkey)) {
        throw unauthorized('affirmation signature verification failed');
      }

      // Status-guarded write: the pre-check above read outside this transaction,
      // so re-assert 'pending' in the UPDATE itself — a concurrent affirm /
      // cancel loses cleanly instead of overwriting.
      let updated = false;
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const rows = await tx
          .update(schema.ceremonyAffirmations)
          .set({
            status: 'tentative',
            affirmedAt: now,
            revocationWindowExpiresAt: new Date(now.getTime() + config.ceremonyWindows.revocationWindowMs),
            contactAffirmationSignature: sig,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.ceremonyAffirmations.id, ctx.affirmationId),
              eq(schema.ceremonyAffirmations.status, 'pending'),
            ),
          )
          .returning({ id: schema.ceremonyAffirmations.id });
        updated = rows[0] !== undefined;
        if (updated) {
          await audit.append(tx, ctx.ownerUserId, 'ceremony.affirmation_tentative', {
            ceremonyId: id,
            contactId: ctx.contactId,
          });
        }
      });
      if (!updated) throw conflict('affirmation is no longer pending');
      return { status: 'tentative' as const };
    },
  );

  // ── Revoke within the window (tentative only) — "any choice can be undone" ──
  app.post('/v1/ceremonies/:id/revoke', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    const audit = app.audit;
    if (session === null || audit === null) throw unauthorized('auth backend unavailable');
    const { id } = request.params as { id: string };
    const ctx = await loadFor(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (ctx.affStatus !== 'tentative') {
      throw conflict('only a tentative affirmation can be revoked (committed → dispute)');
    }
    const now = new Date();
    // Status-guarded write: the pre-check read outside this transaction, so
    // re-assert 'tentative' in the UPDATE itself — a revoke racing the worker's
    // tentative→committed commit loses cleanly instead of flipping an already
    // COUNTED affirmation to 'revoked' after the ceremony advanced on it.
    let updated = false;
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const rows = await tx
        .update(schema.ceremonyAffirmations)
        .set({ status: 'revoked', revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.ceremonyAffirmations.id, ctx.affirmationId),
            eq(schema.ceremonyAffirmations.status, 'tentative'),
          ),
        )
        .returning({ id: schema.ceremonyAffirmations.id });
      updated = rows[0] !== undefined;
      if (updated) {
        await audit.append(tx, ctx.ownerUserId, 'ceremony.affirmation_revoked', {
          ceremonyId: id,
          contactId: ctx.contactId,
        });
      }
    });
    if (!updated) {
      throw conflict('only a tentative affirmation can be revoked (committed → dispute)');
    }
    return { status: 'revoked' as const };
  });

  // ── Dispute: a contact who believes the owner is alive aborts the release ──
  //
  // Deliberately the LOWEST-friction protective action there is: no step-up, no
  // affirmation status required. A contact who has not affirmed yet is exactly
  // the one most likely to know the owner is alive, and the asymmetry is the
  // whole point — a false "they're alive" costs one delay, a false release is
  // irreversible. That stays.
  //
  // What it was missing (2026-08-07 audit, finding 3) is bounds. This was the only
  // loadFor consumer that read neither the affirmation status nor the ceremony
  // status, and nothing limited how often it could be called. The owner's only
  // exit from review_required costs them a fresh second factor, so one contact —
  // including one whose ceremony finished months ago, since those rows are never
  // deleted — could push the engine straight back indefinitely and hold a release
  // hostage. Two guards, below, and neither narrows who may dispute a live
  // release.
  app.post('/v1/ceremonies/:id/dispute', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    const audit = app.audit;
    if (session === null || audit === null) throw unauthorized('auth backend unavailable');
    const { id } = request.params as { id: string };
    const ctx = await loadFor(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');

    // 1. Idempotent per affirmation, and checked BEFORE the terminal guard
    //    below — deliberately, because a successful dispute CANCELS the ceremony,
    //    so the disputer's own retry would otherwise be told "this ceremony has
    //    finished" when the truthful answer is "you already did this, and it
    //    worked". A worried contact double-tapping should see success, not an
    //    error about a state they caused.
    if (ctx.disputedAt !== null) return { disputed: true as const };
    // 2. A finished ceremony is not a lever on the engine. released/cancelled/
    //    failed are terminal, and their affirmation rows outlive them forever, so
    //    without this a contact from a ceremony that ended months ago kept a live
    //    push into review_required.
    if (TERMINAL_CEREMONY_STATUSES.has(ctx.ceremonyStatus)) {
      throw conflict('this ceremony has already finished and can no longer be disputed');
    }

    const now = new Date();
    let claimed = false;
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      // Compare-and-swap, same pattern as /revoke above: the read happened outside
      // this transaction, so re-assert disputed_at IS NULL here. Two simultaneous
      // disputes from one contact collapse to one engine effect.
      const rows = await tx
        .update(schema.ceremonyAffirmations)
        .set({ disputedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.ceremonyAffirmations.id, ctx.affirmationId),
            isNull(schema.ceremonyAffirmations.disputedAt),
          ),
        )
        .returning({ id: schema.ceremonyAffirmations.id });
      claimed = rows[0] !== undefined;
      if (!claimed) return;
      // Abort the release: cancel the ceremony(ies) and push the engine to
      // review_required (the engine's dispute_raised event), atomically.
      await cancelCeremoniesForUser(tx, audit, ctx.ownerUserId, 'dispute_raised', now);
      const row = await loadRow(tx, ctx.ownerUserId);
      if (row !== null) {
        await applyEvent(row, { kind: 'dispute_raised' }, { db: tx, audit, channels, now });
      }
    });
    return { disputed: true as const };
  });

  // ── S1 envelope: the temporal gate. Served ONLY once reconstructing ────────
  // Any RECIPIENT may fetch their own envelope: holders (recipient + affirmation)
  // AND designated beneficiaries (recipient row, NO affirmation — so loadRecipient,
  // not loadFor). Each envelope is sealed to that recipient's own key, so serving
  // it past the gate discloses nothing the recipient can't already open.
  app.get('/v1/ceremonies/:id/s1-envelope', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    const ctx = await loadRecipient(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (!gateOpen(ctx)) {
      // The secret is not retrievable until the whole ladder + consensus has
      // actually happened and the outer key released.
      throw new ApiError(403, 'Release gate closed', 'the release is not yet open', GATE_CLOSED_TYPE);
    }
    if (!mayCollect(ctx)) {
      throw conflict('only a committed affirmer or designated beneficiary may collect the release');
    }
    const env = await db
      .select({ ciphertext: schema.s1TierKeyEnvelopes.sealedBoxCiphertext })
      .from(schema.s1TierKeyEnvelopes)
      .where(
        and(
          eq(schema.s1TierKeyEnvelopes.userId, ctx.ownerUserId),
          eq(schema.s1TierKeyEnvelopes.contactId, ctx.contactId),
        ),
      )
      .limit(1);
    const ct = env[0]?.ciphertext;
    if (ct === undefined) throw notFound('no envelope for this recipient');
    return { sealedBoxCiphertext: Buffer.from(ct).toString('base64') };
  });

  // ── Released content: the owner's tier items, outer-layer removed ──────────
  // The "outer key released" delivery — temporal-gated to reconstructing. The
  // platform strips the OUTER wrap (decryptOuterEnvelope); what is returned is
  // still the INNER zero-knowledge ciphertext, openable only with the tier key
  // the recipient reconstructs from the envelope. So the platform never sees
  // plaintext — it only lifts the temporal gate.
  app.get('/v1/ceremonies/:id/released-items', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    // Any recipient (holder or designated beneficiary) past the temporal gate.
    // What is returned is still inner ciphertext — useless without the tier key,
    // which only the threshold of shares reconstructs.
    const ctx = await loadRecipient(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (!gateOpen(ctx)) {
      throw new ApiError(403, 'Release gate closed', 'the release is not yet open', GATE_CLOSED_TYPE);
    }
    if (!mayCollect(ctx)) {
      throw conflict('only a committed affirmer or designated beneficiary may collect the release');
    }
    const items = await db
      .select()
      .from(schema.vaultItems)
      .where(
        and(
          eq(schema.vaultItems.userId, ctx.ownerUserId),
          eq(schema.vaultItems.tier, ctx.tier as 's1' | 's2' | 's3'),
          isNull(schema.vaultItems.deletedAt),
        ),
      );
    const out = [];
    for (const item of items) {
      const inner = await decryptOuterEnvelope(db, config.outerLayerKeks, item);
      out.push({
        id: item.id,
        // The recipient rebuilds the item-key AAD from (tier, id) and needs to
        // know which construction was used — a release is the one read path
        // where getting this wrong is unrecoverable (F3, migration 0062).
        aadVersion: item.aadVersion,
        contentCiphertext: Buffer.from(inner.contentCiphertext).toString('base64'),
        contentNonce: Buffer.from(inner.contentNonce).toString('base64'),
        wrappedPerItemKey: Buffer.from(inner.wrappedPerItemKey).toString('base64'),
        wrappedPerItemKeyNonce: Buffer.from(inner.wrappedPerItemKeyNonce).toString('base64'),
        titleCiphertext: Buffer.from(item.titleCiphertext).toString('base64'),
        titleNonce: Buffer.from(item.titleNonce).toString('base64'),
      });
    }
    return { items: out };
  });

  // ── S2/S3 share collection (CEREMONY_COMPLETION Checkpoint B) ──────────────
  // The Shamir path: a RECIPIENT registers a ceremony ephemeral X25519 pubkey;
  // each AFFIRMING contact unwraps its own sealed Shamir share on-device and
  // re-seals it to every registered recipient (ceremony_affirmation_shares);
  // once the temporal gate opens (reconstructing) the recipient collects a
  // threshold subset and reconstructs CLIENT-SIDE. The platform only ever holds
  // sealed ciphertexts it cannot open.

  // The caller's recipient row for a ceremony (every enrolled holder is also a
  // recipient — the bridge enrols both), or null.
  async function loadRecipientRow(
    ceremonyId: string,
    contactId: string,
  ): Promise<{ id: string; ephemeralPubkey: Uint8Array | null } | null> {
    const rows = await db
      .select({
        id: schema.ceremonyRecipients.id,
        ephemeralPubkey: schema.ceremonyRecipients.ephemeralPubkey,
      })
      .from(schema.ceremonyRecipients)
      .where(
        and(
          eq(schema.ceremonyRecipients.ceremonyId, ceremonyId),
          eq(schema.ceremonyRecipients.recipientContactId, contactId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // Register the recipient's ceremony ephemeral pubkey. Allowed any time before
  // the ceremony is terminal — the earlier it lands, the sooner affirming
  // contacts can seal to it. Re-registering a DIFFERENT key is rejected: shares
  // already sealed to the first key would become undecryptable.
  app.post(
    '/v1/ceremonies/:id/recipient/ephemeral',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ephemeralPubkey'],
          properties: { ephemeralPubkey: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { id } = request.params as { id: string };
      const body = request.body as { ephemeralPubkey: string };
      // A recipient (holder or designated beneficiary) registers — holders do this
      // before affirming, so no affirmation-status gate here, only not-terminal.
      const ctx = await loadRecipient(id, session.userId);
      if (ctx === null) throw notFound('you are not a recipient of this ceremony');
      // Not just "not terminal": a lagging recipient may register while the
      // reconstruction gate is still open after 'released' (C2, QA D9).
      if (!acceptsRecoveryContribution(ctx)) {
        throw conflict('this ceremony is no longer active');
      }

      const pubkey = new Uint8Array(Buffer.from(body.ephemeralPubkey, 'base64'));
      if (pubkey.length !== X25519_PUBKEY_BYTES) throw badRequest('malformed ephemeral pubkey');
      if (ctx.ephemeralPubkey !== null) {
        if (Buffer.from(ctx.ephemeralPubkey).equals(Buffer.from(pubkey))) {
          return { registered: true as const }; // idempotent re-register of the same key
        }
        throw conflict('an ephemeral key is already registered for this ceremony');
      }

      const now = new Date();
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .update(schema.ceremonyRecipients)
          .set({ ephemeralPubkey: pubkey, registeredAt: now, updatedAt: now })
          .where(eq(schema.ceremonyRecipients.id, ctx.recipientId));
        await audit.append(tx, ctx.ownerUserId, 'ceremony.recipient_ephemeral_registered', {
          ceremonyId: id,
          contactId: ctx.contactId,
        });
      });
      return { registered: true as const };
    },
  );

  // Everything an affirming contact needs to seal its Shamir share: its OWN
  // wrapped share (sealed to its C4 X25519 key at assignment) plus the
  // registered recipients to seal to. S2/S3 only; the caller must have affirmed
  // (the share contribution is the affirmation made material — pending or
  // revoked contacts have no business unwrapping their share).
  app.get('/v1/ceremonies/:id/seal-context', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    const ctx = await loadFor(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (ctx.shareId === null) throw conflict('this ceremony has no Shamir shares (S1 uses the envelope)');
    // A committed contact can still seal to a lagging recipient after 'released'
    // while the gate is open (C2, QA D9) — the first recovery must not lock the
    // rest out. 'cancelled'/'failed' and post-gate 'released' still refuse.
    if (!acceptsRecoveryContribution(ctx)) {
      throw conflict('this ceremony is no longer active');
    }
    if (ctx.affStatus !== 'tentative' && ctx.affStatus !== 'committed') {
      throw conflict('affirm the release before contributing your share');
    }
    const share = await db
      .select({ ciphertext: schema.releaseShares.wrappedShareCiphertext })
      .from(schema.releaseShares)
      .where(and(eq(schema.releaseShares.id, ctx.shareId), isNull(schema.releaseShares.revokedAt)))
      .limit(1);
    const wrapped = share[0]?.ciphertext;
    if (wrapped === undefined || wrapped === null) throw conflict('your share has been revoked');

    const recipients = await db
      .select({
        recipientContactId: schema.ceremonyRecipients.recipientContactId,
        ephemeralPubkey: schema.ceremonyRecipients.ephemeralPubkey,
      })
      .from(schema.ceremonyRecipients)
      .where(eq(schema.ceremonyRecipients.ceremonyId, id));
    const sealed = await db
      .select({ recipientContactId: schema.ceremonyAffirmationShares.recipientContactId })
      .from(schema.ceremonyAffirmationShares)
      .where(eq(schema.ceremonyAffirmationShares.affirmationId, ctx.affirmationId));

    return {
      affirmationId: ctx.affirmationId,
      tier: ctx.tier,
      wrappedShareCiphertext: Buffer.from(wrapped).toString('base64'),
      recipients: recipients
        .filter((r) => r.ephemeralPubkey !== null)
        .map((r) => ({
          recipientContactId: r.recipientContactId,
          ephemeralPubkey: Buffer.from(r.ephemeralPubkey!).toString('base64'),
        })),
      sealedTo: sealed.map((s) => s.recipientContactId),
    };
  });

  // Store one re-sealed share for one recipient. The server VERIFIES the
  // contact's Ed25519 share signature over (affirmationId, recipient,
  // registered ephemeral pubkey, sealed ciphertext) before accepting — a
  // sealed blob that doesn't verify against what the server knows is rejected,
  // so a swapped recipient key or tampered ciphertext can't enter the table.
  app.post(
    '/v1/ceremonies/:id/seal-share',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['recipientContactId', 'sealedShareCiphertext', 'shareSignature'],
          properties: {
            recipientContactId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
            sealedShareCiphertext: { type: 'string', minLength: 1, maxLength: 1024 },
            shareSignature: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { id } = request.params as { id: string };
      const body = request.body as {
        recipientContactId: string;
        sealedShareCiphertext: string;
        shareSignature: string;
      };
      const ctx = await loadFor(id, session.userId);
      if (ctx === null) throw notFound('ceremony not found');
      if (ctx.shareId === null) throw conflict('this ceremony has no Shamir shares (S1 uses the envelope)');
      // Accept a seal to a lagging recipient after 'released' while the gate is
      // open (C2, QA D9); refuse cancelled/failed and post-gate 'released'.
      if (!acceptsRecoveryContribution(ctx)) {
        throw conflict('this ceremony is no longer active');
      }
      if (ctx.affStatus !== 'tentative' && ctx.affStatus !== 'committed') {
        throw conflict('affirm the release before contributing your share');
      }
      if (ctx.ed25519Pubkey === null) throw conflict('contact has no affirmation key enrolled');

      const rec = await loadRecipientRow(id, body.recipientContactId);
      if (rec === null) throw notFound('that recipient is not part of this ceremony');
      if (rec.ephemeralPubkey === null) {
        throw conflict('the recipient has not registered an ephemeral key yet');
      }

      const sealedShareCiphertext = new Uint8Array(Buffer.from(body.sealedShareCiphertext, 'base64'));
      const signature = new Uint8Array(Buffer.from(body.shareSignature, 'base64'));
      if (signature.length !== ED25519_SIGNATURE_BYTES) throw badRequest('malformed signature');
      const verified = verifyShareSignature(
        signature,
        {
          affirmationId: ctx.affirmationId,
          recipientContactId: body.recipientContactId,
          recipientEphemeralPubkey: rec.ephemeralPubkey,
          sealedShareCiphertext,
        },
        ctx.ed25519Pubkey,
      );
      if (!verified) throw unauthorized('share signature verification failed');

      let created = false;
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const inserted = await tx
          .insert(schema.ceremonyAffirmationShares)
          .values({
            affirmationId: ctx.affirmationId,
            recipientContactId: body.recipientContactId,
            sealedShareCiphertext,
            shareSignature: signature,
          })
          .onConflictDoNothing() // one sealed share per (affirmation, recipient)
          .returning({ id: schema.ceremonyAffirmationShares.id });
        created = inserted[0] !== undefined;
        if (created) {
          await audit.append(tx, ctx.ownerUserId, 'ceremony.share_sealed', {
            ceremonyId: id,
            contactId: ctx.contactId,
            recipientContactId: body.recipientContactId,
          });
        }
      });
      return { sealed: true as const, created };
    },
  );

  // The recipient's sealed shares + the reconstruction context — the S2/S3
  // temporal gate, the s1-envelope's exact 403-before discipline. Only shares
  // from COMMITTED affirmations count (a revoked contact's contribution must
  // never serve reconstruction), and only a committed affirmer may collect
  // (B decision: the recipient IS an affirming contact).
  app.get('/v1/ceremonies/:id/shares', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    const ctx = await loadRecipient(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (ctx.tier === 's1') throw conflict('this ceremony has no Shamir shares (S1 uses the envelope)');
    if (!gateOpen(ctx)) {
      throw new ApiError(403, 'Release gate closed', 'the release is not yet open', GATE_CLOSED_TYPE);
    }
    if (!mayCollect(ctx)) {
      throw conflict('only a committed affirmer or designated beneficiary may reconstruct');
    }
    if (ctx.ephemeralPubkey === null) {
      throw conflict('register an ephemeral key before collecting shares');
    }

    const tier = ctx.tier as 's2' | 's3';
    const shares = await db
      .select({
        affirmationId: schema.ceremonyAffirmationShares.affirmationId,
        contactId: schema.ceremonyAffirmations.contactId,
        sealedShareCiphertext: schema.ceremonyAffirmationShares.sealedShareCiphertext,
        shareSignature: schema.ceremonyAffirmationShares.shareSignature,
      })
      .from(schema.ceremonyAffirmationShares)
      .innerJoin(
        schema.ceremonyAffirmations,
        eq(schema.ceremonyAffirmationShares.affirmationId, schema.ceremonyAffirmations.id),
      )
      .where(
        and(
          eq(schema.ceremonyAffirmations.ceremonyId, id),
          eq(schema.ceremonyAffirmations.status, 'committed'),
          eq(schema.ceremonyAffirmationShares.recipientContactId, ctx.contactId),
        ),
      );

    // The tier-key check sentinel lets the recipient VALIDATE the reconstructed
    // key client-side (subset retry against wrong/superseded shares). It is a
    // random plaintext + its tier-key AEAD ciphertext — it can decrypt nothing.
    const tk = await db
      .select({
        generation: schema.userTierKeys.generation,
        checkPlaintext: schema.userTierKeys.tierKeyCheckPlaintext,
        checkCiphertext: schema.userTierKeys.tierKeyCheckCiphertext,
        checkNonce: schema.userTierKeys.tierKeyCheckNonce,
      })
      .from(schema.userTierKeys)
      .where(
        and(eq(schema.userTierKeys.userId, ctx.ownerUserId), eq(schema.userTierKeys.tier, tier)),
      )
      .limit(1);
    const t = tk[0];
    if (t === undefined) throw notFound('no tier key material for this tier');

    return {
      // S2 reconstructs from S2_THRESHOLD contact shares (2-of-3, passphrase an
      // optional fallback). S3 is the nested scheme (docs/24): any 2 of 3 contact
      // shares PLUS the mandatory release passphrase (the recipient fetches it via
      // /release-salt — load-bearing for every S3 reconstruction, not a fallback).
      tier,
      threshold: tier === 's2' ? S2_THRESHOLD : S3_NESTED_CONTACT_THRESHOLD,
      generation: t.generation,
      tierKeyCheck: {
        plaintext: Buffer.from(t.checkPlaintext).toString('base64'),
        ciphertext: Buffer.from(t.checkCiphertext).toString('base64'),
        nonce: Buffer.from(t.checkNonce).toString('base64'),
      },
      shares: shares.map((s) => ({
        affirmationId: s.affirmationId,
        contactId: s.contactId,
        sealedShareCiphertext: Buffer.from(s.sealedShareCiphertext).toString('base64'),
        shareSignature: Buffer.from(s.shareSignature).toString('base64'),
      })),
    };
  });

  // ── Release-passphrase fallback: the owner's KDF salt (the +1 factor) ───────
  // The release passphrase is the reserved last Shamir share. When a contact
  // affirmed but never sealed its share, a committed affirmer can substitute the
  // owner's OFFLINE release passphrase for that missing contact at reconstruction
  // (docs/01 §3: 2-of-3 / 3-of-4 with the passphrase as the fixed last share).
  // Deriving that share on the recipient's device needs this KDF salt. The salt
  // is NOT secret — it is a KDF salt (like the tier-key check already served from
  // /shares) and is useless without the passphrase, which never reaches the
  // server. Argon2id at production cost bounds any offline guessing. Same strict
  // gate as /shares (reconstructing + committed affirmer), and a dedicated route
  // so the happy path — enough contact shares — never ships it.
  app.get('/v1/ceremonies/:id/release-salt', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const { id } = request.params as { id: string };
    const ctx = await loadRecipient(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (ctx.tier === 's1') {
      throw conflict('this ceremony has no Shamir shares (S1 uses the envelope)');
    }
    if (!gateOpen(ctx)) {
      throw new ApiError(403, 'Release gate closed', 'the release is not yet open', GATE_CLOSED_TYPE);
    }
    if (!mayCollect(ctx)) {
      throw conflict('only a committed affirmer or designated beneficiary may reconstruct');
    }
    const km = await db
      .select({ salt: schema.userKeyMaterial.releasePassphraseSalt })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, ctx.ownerUserId))
      .limit(1);
    const salt = km[0]?.salt;
    if (salt === undefined) throw notFound('no key material for this owner');
    return { releasePassphraseSalt: Buffer.from(salt).toString('base64') };
  });

  // ── Reconstruction report: a recipient device reports success ──────────────
  app.post('/v1/ceremonies/:id/reconstructed', { preHandler: requireSession }, async (request) => {
    const session = request.session;
    const audit = app.audit;
    if (session === null || audit === null) throw unauthorized('auth backend unavailable');
    const { id } = request.params as { id: string };
    // Any recipient (holder or designated beneficiary) reports their own success
    // — but only once the temporal gate has actually opened, and only a caller
    // who may collect. An ungated report would mark the recipient 'released'
    // prematurely, which suppresses the reconstruction timeout downstream.
    const ctx = await loadRecipient(id, session.userId);
    if (ctx === null) throw notFound('ceremony not found');
    if (!gateOpen(ctx)) {
      throw new ApiError(403, 'Release gate closed', 'the release is not yet open', GATE_CLOSED_TYPE);
    }
    if (!mayCollect(ctx)) {
      throw conflict('only a committed affirmer or designated beneficiary may reconstruct');
    }
    const status = await recordRecipientReconstruction(
      { db, audit, now: new Date() },
      id,
      ctx.contactId,
    );
    return { ceremonyStatus: status };
  });
}

async function affirmationCounts(
  db: Database,
  ceremonyId: string,
): Promise<{ committed: number; total: number }> {
  const rows = await db
    .select({ status: schema.ceremonyAffirmations.status })
    .from(schema.ceremonyAffirmations)
    .where(eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId));
  return {
    committed: rows.filter((r) => r.status === 'committed').length,
    total: rows.length,
  };
}
