import { createHash } from 'node:crypto';
import { schema } from '@truecairn/db';
import {
  computeEventTransition,
  computeNextActionAt,
  type EngineEvent,
} from '@truecairn/engine';
import { ITEM_AAD_VERSION_CURRENT, S2_SHARES, S3_NESTED_CONTACT_SHARES } from '@truecairn/keys';
import { revokeAllUserSessions } from '@truecairn/sessions';
import { REPRESENTATIVE_TYPE_FOR_ROLE } from '@truecairn/shared';
import type { SensitiveActionType, UserId, VaultTier } from '@truecairn/shared';
import { applyTierMove, blobKey, releaseUserStorage } from '@truecairn/vault';
import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { HandlerContext, HandlerFn, HandlerOutcome, PendingAction } from './types.js';

// Each action type maps to a handler. Handlers receive the pending action +
// the active tx db and return an outcome. They MUST be idempotent enough
// that, if the transaction is retried after a failure mid-batch, re-running
// produces the same end state.
//
// "Stub" handlers exist for action types whose real implementation depends
// on later phases (Phase 2 crypto for key rotations, Phase 3 API for contact
// changes). Stubs only audit + mark applied — they do not mutate user state.
// A clear comment marks each so they're easy to find and replace later.

// arm_engine: the 7-day post-enrollment reconfirmation. Sets users.armed_at
// and flips engine_states from pre_active → active by feeding the engine
// the engine_armed event. Fully implemented — no crypto required.
//
// NOTE (audit B2): the enrolled-contact prerequisite for arming is enforced at the
// live arming entry point, POST /v1/engine/arm. No product flow currently REQUESTS
// this action; if a requester is ever (re)introduced it MUST enforce the same
// prerequisite at request time, or an account with no contact could be armed into a
// switch that can never reach release consensus — fail-closed, but useless.
const armEngine: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;

  const stateRows = await db
    .select()
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, action.userId))
    .for('update');
  const state = stateRows[0];
  if (!state) {
    return { kind: 'cancelled', reason: 'no_engine_state_row' };
  }
  if (state.state !== 'pre_active') {
    return { kind: 'cancelled', reason: `engine_not_pre_active(state=${state.state})` };
  }

  const event: EngineEvent = { kind: 'engine_armed' };
  const engineRow = {
    userId: action.userId,
    state: state.state,
    previousState: state.previousState,
    stateEnteredAt: state.stateEnteredAt,
    snoozeUntil: state.snoozeUntil,
    lastCheckInAt: state.lastCheckInAt,
    nextScheduledCheckInAt: state.nextScheduledCheckInAt,
    inactivityThresholdDays: state.inactivityThresholdDays,
    checkInTimeoutDays: state.checkInTimeoutDays,
    escalationCooldownDays: state.escalationCooldownDays,
    s1ToS2TimerDays: state.s1ToS2TimerDays,
    s2ToS3TimerDays: state.s2ToS3TimerDays,
    returningGraceDays: state.returningGraceDays,
    notificationStallMaxDays: state.notificationStallMaxDays,
  };
  const result = computeEventTransition(engineRow, event, { now });
  if (result.kind === 'no_change') {
    return { kind: 'cancelled', reason: 'engine_refused_armed_event' };
  }

  await db
    .update(schema.engineStates)
    .set({
      state: result.toState,
      previousState: result.previousStateOverride ?? null,
      stateEnteredAt: now,
      nextActionAt: result.nextActionAt,
      lastCheckInAt: result.lastCheckInAt ?? state.lastCheckInAt,
      nextScheduledCheckInAt: result.nextScheduledCheckInAt ?? state.nextScheduledCheckInAt,
      updatedAt: now,
    })
    .where(eq(schema.engineStates.userId, action.userId));

  await db.insert(schema.engineStateHistory).values({
    userId: action.userId,
    fromState: state.state,
    toState: result.toState,
    reason: result.reason,
    occurredAt: now,
  });

  await db
    .update(schema.users)
    .set({ armedAt: now, accountStatus: 'active', updatedAt: now })
    .where(eq(schema.users.id, action.userId));

  return { kind: 'applied', details: { armedAt: now.toISOString() } };
};

// change_inactivity_threshold: payload is { days: int }. Updates the
// per-user timer and recomputes next_action_at if the user is in a state
// whose deadline depends on inactivityThresholdDays.
const changeInactivityThreshold: HandlerFn = async (action, ctx) => {
  const days = readPositiveInt(action.payload['days']);
  if (days === null) return { kind: 'cancelled', reason: 'invalid_payload' };

  const stateRows = await ctx.db
    .select()
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, action.userId))
    .for('update');
  const state = stateRows[0];
  if (!state) return { kind: 'cancelled', reason: 'no_engine_state_row' };

  // Asymmetric authority, re-checked at APPLY time (not just enqueue time): an
  // AI-initiated change may only ever TIGHTEN. Closes the enqueue→apply TOCTOU
  // where the owner manually lowers the threshold below the AI's pending value
  // during the veto window — applying it then would loosen protection.
  if (action.initiatedBy === 'ai' && days >= state.inactivityThresholdDays) {
    return { kind: 'cancelled', reason: 'ai_threshold_change_must_tighten' };
  }

  const updated = { ...state, inactivityThresholdDays: days };
  const nextActionAt = computeNextActionAt(state.state, {
    ...updated,
    userId: action.userId,
  });

  await ctx.db
    .update(schema.engineStates)
    .set({
      inactivityThresholdDays: days,
      nextActionAt,
      updatedAt: ctx.now,
    })
    .where(eq(schema.engineStates.userId, action.userId));

  return { kind: 'applied', details: { inactivityThresholdDays: days } };
};

// change_cooldown_window: payload is { escalationCooldownDays?, s1ToS2TimerDays?,
// s2ToS3TimerDays?, checkInTimeoutDays?, returningGraceDays? }. Applies any
// subset of timer columns supplied. No crypto required.
const changeCooldownWindow: HandlerFn = async (action, ctx) => {
  const allowed = [
    'escalationCooldownDays',
    's1ToS2TimerDays',
    's2ToS3TimerDays',
    'checkInTimeoutDays',
    'returningGraceDays',
  ] as const;
  const updates: Partial<Record<(typeof allowed)[number], number>> = {};
  for (const key of allowed) {
    const v = readPositiveInt(action.payload[key]);
    if (v !== null) updates[key] = v;
  }
  if (Object.keys(updates).length === 0) {
    return { kind: 'cancelled', reason: 'no_valid_fields_in_payload' };
  }

  await ctx.db
    .update(schema.engineStates)
    .set({ ...updates, updatedAt: ctx.now })
    .where(eq(schema.engineStates.userId, action.userId));

  return { kind: 'applied', details: updates };
};

// change_email: payload is { email: string }. Server-side just updates the
// row. Email verification + bouncing is a Phase 3 concern (the API will
// require the user to click a link before the change is requested).
const changeEmail: HandlerFn = async (action, ctx) => {
  const email = action.payload['email'];
  if (typeof email !== 'string' || email.length === 0 || !email.includes('@')) {
    return { kind: 'cancelled', reason: 'invalid_email' };
  }
  await ctx.db
    .update(schema.users)
    .set({ email, updatedAt: ctx.now })
    .where(eq(schema.users.id, action.userId));
  return { kind: 'applied', details: { email } };
};

// ── Contact-domain handlers (Phase 3.2). The owner's endpoint enqueues; these
// APPLY after the 7-day cooldown. The wrapped ciphertext is client-produced and
// stored byte-for-byte — nothing here re-derives or re-wraps it. Each
// re-validates at apply time (the world may have changed in 7 days) and cancels
// cleanly rather than corrupting state. ──────────────────────────────────────

// add_contact: arm a contact's release capability at a tier. Payload:
//   { contactId, tier, shareIndex?, wrappedShareCiphertext?, s1EnvelopeCiphertext? }
// S2/S3 -> a release_shares row (Shamir share); S1 -> an s1_tier_key_envelopes
// row (full sealed key). Exactly one ciphertext, matching the tier.
const addContact: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const p = action.payload;
  const contactId = asString(p['contactId']);
  const tierRaw = p['tier'];
  if (contactId === null || (tierRaw !== 's1' && tierRaw !== 's2' && tierRaw !== 's3')) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const tier: 's1' | 's2' | 's3' = tierRaw;

  const crows = await db
    .select({ status: schema.contacts.status })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, action.userId)))
    .for('update');
  const contact = crows[0];
  if (!contact || (contact.status !== 'enrolled' && contact.status !== 'active')) {
    return { kind: 'cancelled', reason: 'contact_not_enrolled' };
  }

  if (tier === 's1') {
    const ct = decodeB64(p['s1EnvelopeCiphertext']);
    if (ct === null || p['wrappedShareCiphertext'] !== undefined) {
      return { kind: 'cancelled', reason: 'invalid_s1_payload' };
    }
    const existing = await db
      .select({ id: schema.s1TierKeyEnvelopes.id })
      .from(schema.s1TierKeyEnvelopes)
      .where(
        and(
          eq(schema.s1TierKeyEnvelopes.userId, action.userId),
          eq(schema.s1TierKeyEnvelopes.contactId, contactId),
          isNull(schema.s1TierKeyEnvelopes.revokedAt),
        ),
      )
      .limit(1);
    if (existing[0] !== undefined) return { kind: 'cancelled', reason: 's1_envelope_exists' };
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: action.userId,
      contactId,
      sealedBoxCiphertext: ct,
      createdAt: now,
    });
  } else {
    const ct = decodeB64(p['wrappedShareCiphertext']);
    const shareIndex = asInt(p['shareIndex']);
    if (ct === null || shareIndex === null || p['s1EnvelopeCiphertext'] !== undefined) {
      return { kind: 'cancelled', reason: 'invalid_share_payload' };
    }
    const existing = await db
      .select({ id: schema.releaseShares.id })
      .from(schema.releaseShares)
      .where(
        and(
          eq(schema.releaseShares.userId, action.userId),
          eq(schema.releaseShares.tier, tier),
          eq(schema.releaseShares.shareIndex, shareIndex),
          isNull(schema.releaseShares.revokedAt),
        ),
      )
      .limit(1);
    if (existing[0] !== undefined) return { kind: 'cancelled', reason: 'share_index_taken' };
    await db.insert(schema.releaseShares).values({
      userId: action.userId,
      tier,
      shareIndex,
      shareType: 'contact',
      contactId,
      wrappedShareCiphertext: ct,
    });
  }

  await db
    .update(schema.contacts)
    .set({ status: 'active', updatedAt: now })
    .where(eq(schema.contacts.id, contactId));
  return { kind: 'applied', details: { contactId, tier } };
};

// remove_contact: revoke the contact's release capability. Sets revoked_at on
// active shares/envelopes (never DELETE — preserves history + the active
// partial indexes, and matches what an active-share enumerator reads) and marks
// the contact removed.
const removeContact: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const contactId = asString(action.payload['contactId']);
  if (contactId === null) return { kind: 'cancelled', reason: 'invalid_payload' };
  const crows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, action.userId)))
    .limit(1);
  if (crows[0] === undefined) return { kind: 'cancelled', reason: 'contact_not_found' };

  await db
    .update(schema.releaseShares)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.releaseShares.userId, action.userId),
        eq(schema.releaseShares.contactId, contactId),
        isNull(schema.releaseShares.revokedAt),
      ),
    );
  await db
    .update(schema.s1TierKeyEnvelopes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.s1TierKeyEnvelopes.userId, action.userId),
        eq(schema.s1TierKeyEnvelopes.contactId, contactId),
        isNull(schema.s1TierKeyEnvelopes.revokedAt),
      ),
    );
  await db
    .update(schema.contacts)
    .set({ status: 'removed', removedAt: now, updatedAt: now })
    .where(eq(schema.contacts.id, contactId));
  return { kind: 'applied', details: { contactId } };
};

// remove_channel: soft-remove a notification channel after the cooldown
// (docs/26 §4 follow-on — a stolen session must not silence check-in reminders
// instantly; the channel received the pending-removal notice during the delay,
// docs/10-threat-5.2). Soft like the old immediate route: removed_at set, the
// delivery history keeps its FK, and any outstanding verification code burns.
// Cancels cleanly if the channel vanished or was already removed meanwhile.
const removeChannel: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const channelId = asString(action.payload['channelId']);
  if (channelId === null) return { kind: 'cancelled', reason: 'invalid_payload' };
  const rows = await db
    .update(schema.notificationChannels)
    .set({ removedAt: now, verificationCodeHash: null, verificationExpiresAt: null })
    .where(
      and(
        eq(schema.notificationChannels.id, channelId),
        eq(schema.notificationChannels.userId, action.userId),
        isNull(schema.notificationChannels.removedAt),
      ),
    )
    .returning({ channelType: schema.notificationChannels.channelType });
  if (rows[0] === undefined) return { kind: 'cancelled', reason: 'channel_not_found' };
  return { kind: 'applied', details: { channelId, channelType: rows[0].channelType } };
};

// change_contact_role: personal <-> professional <-> recovery. Role diversity is
// re-checked at affirmation time by the ceremony (threat 5.6).
const changeContactRole: HandlerFn = async (action, ctx) => {
  const role = action.payload['newRole'];
  if (role !== 'personal' && role !== 'professional' && role !== 'recovery') {
    return { kind: 'cancelled', reason: 'invalid_role' };
  }
  const contactId = asString(action.payload['contactId']);
  if (contactId === null) return { kind: 'cancelled', reason: 'invalid_payload' };
  // The recipient type (0066) MUST move with the role. It is a second axis over
  // the same row, and the database refuses a pair that disagrees
  // (contacts_recipient_type_matches_role) — so setting `role` alone would make
  // this action fail at APPLY time, in the worker, seven days after the owner
  // asked for it, with the cause seven days behind them.
  //
  // The old type cannot survive the move: `cofounder_business_partner` on a row
  // that is now `personal` is not a stale label, it is a contradiction. So this
  // takes the representative type for the new role — the same inference migration
  // 0066 makes for pre-existing rows, from the same table, deliberately biased to
  // the narrowest column. The owner re-picks if the guess is wrong; the guess
  // itself never widens who receives what.
  const recipientType = REPRESENTATIVE_TYPE_FOR_ROLE[role];
  const rows = await ctx.db
    .update(schema.contacts)
    .set({ role, recipientType, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.contacts.id, contactId),
        eq(schema.contacts.ownerUserId, action.userId),
        ne(schema.contacts.status, 'removed'),
      ),
    )
    .returning({ id: schema.contacts.id });
  if (rows[0] === undefined) return { kind: 'cancelled', reason: 'contact_not_found' };
  return { kind: 'applied', details: { contactId, role, recipientType } };
};

// rotate_contact: the contact re-keyed (new device). Payload carries the new
// pubkeys + the shares re-wrapped to the new X25519 key. Revoke the old material
// FIRST (so new rows don't collide on the active unique index), then insert the
// re-wrapped shares and update the pubkeys.
const rotateContact: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const p = action.payload;
  const contactId = asString(p['contactId']);
  const newX = decodeB64(p['newX25519Pubkey']);
  const newEd = decodeB64(p['newEd25519Pubkey']);
  if (contactId === null || newX === null || newEd === null || newX.length !== 32 || newEd.length !== 32) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const crows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, action.userId)))
    .for('update');
  if (crows[0] === undefined) return { kind: 'cancelled', reason: 'contact_not_found' };

  await db
    .update(schema.releaseShares)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.releaseShares.userId, action.userId),
        eq(schema.releaseShares.contactId, contactId),
        isNull(schema.releaseShares.revokedAt),
      ),
    );
  await db
    .update(schema.s1TierKeyEnvelopes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.s1TierKeyEnvelopes.userId, action.userId),
        eq(schema.s1TierKeyEnvelopes.contactId, contactId),
        isNull(schema.s1TierKeyEnvelopes.revokedAt),
      ),
    );

  const shares = Array.isArray(p['shares']) ? p['shares'] : [];
  for (const s of shares) {
    if (typeof s !== 'object' || s === null) return { kind: 'cancelled', reason: 'invalid_share' };
    const sr = s as Record<string, unknown>;
    const tier = sr['tier'];
    const idx = asInt(sr['shareIndex']);
    const ct = decodeB64(sr['wrappedShareCiphertext']);
    if ((tier !== 's2' && tier !== 's3') || idx === null || ct === null) {
      return { kind: 'cancelled', reason: 'invalid_share' };
    }
    await db.insert(schema.releaseShares).values({
      userId: action.userId,
      tier,
      shareIndex: idx,
      shareType: 'contact',
      contactId,
      wrappedShareCiphertext: ct,
    });
  }
  const envelopes = Array.isArray(p['s1Envelopes']) ? p['s1Envelopes'] : [];
  for (const e of envelopes) {
    if (typeof e !== 'object' || e === null) return { kind: 'cancelled', reason: 'invalid_envelope' };
    const ct = decodeB64((e as Record<string, unknown>)['ciphertext']);
    if (ct === null) return { kind: 'cancelled', reason: 'invalid_envelope' };
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: action.userId,
      contactId,
      sealedBoxCiphertext: ct,
      createdAt: now,
    });
  }

  await db
    .update(schema.contacts)
    .set({ contactX25519Pubkey: newX, contactEd25519Pubkey: newEd, status: 'active', updatedAt: now })
    .where(eq(schema.contacts.id, contactId));
  return { kind: 'applied', details: { contactId, rotated: true } };
};

// designate_beneficiary: name a contact to RECEIVE a release without holding a
// share or affirming. Payload: { contactId, tier, s1EnvelopeCiphertext? }. The
// contact must be enrolled/active (re-checked at apply — 7 days can change the
// world). Idempotent: an existing active designation is a no-op success. The
// bridge enrols active beneficiaries as ceremony_recipients when a ceremony opens.
// S2/S3 beneficiaries hold nothing (holders re-seal shares to them at ceremony);
// S1 has no shares, so an S1 beneficiary receives their OWN sealed envelope here.
const designateBeneficiary: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const contactId = asString(action.payload['contactId']);
  const tierRaw = action.payload['tier'];
  if (contactId === null || (tierRaw !== 's1' && tierRaw !== 's2' && tierRaw !== 's3')) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const tier: 's1' | 's2' | 's3' = tierRaw;

  const crows = await db
    .select({ status: schema.contacts.status })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, action.userId)))
    .for('update');
  const contact = crows[0];
  if (!contact || (contact.status !== 'enrolled' && contact.status !== 'active')) {
    return { kind: 'cancelled', reason: 'contact_not_enrolled' };
  }

  const existing = await db
    .select({ id: schema.releaseBeneficiaries.id })
    .from(schema.releaseBeneficiaries)
    .where(
      and(
        eq(schema.releaseBeneficiaries.userId, action.userId),
        eq(schema.releaseBeneficiaries.tier, tier),
        eq(schema.releaseBeneficiaries.contactId, contactId),
        isNull(schema.releaseBeneficiaries.revokedAt),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) return { kind: 'applied', details: { contactId, tier, alreadyDesignated: true } };

  // S1 delivers via a per-recipient sealed envelope (no Shamir shares), so an S1
  // beneficiary needs their OWN envelope of the S1 tier key — sealed client-side
  // by the owner and carried in the payload, exactly like an S1 holder
  // (add_contact). resolveHolders excludes beneficiaries, so this envelope makes
  // them a RECEIVER, never an affirmer. Reject if the contact already holds S1
  // (they already receive it). Both rows ride the handler's transaction.
  if (tier === 's1') {
    const ct = decodeB64(action.payload['s1EnvelopeCiphertext']);
    if (ct === null) return { kind: 'cancelled', reason: 'invalid_s1_payload' };
    const env = await db
      .select({ id: schema.s1TierKeyEnvelopes.id })
      .from(schema.s1TierKeyEnvelopes)
      .where(
        and(
          eq(schema.s1TierKeyEnvelopes.userId, action.userId),
          eq(schema.s1TierKeyEnvelopes.contactId, contactId),
          isNull(schema.s1TierKeyEnvelopes.revokedAt),
        ),
      )
      .limit(1);
    if (env[0] !== undefined) return { kind: 'cancelled', reason: 's1_envelope_exists' };
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: action.userId,
      contactId,
      sealedBoxCiphertext: ct,
      createdAt: now,
    });
  }

  await db.insert(schema.releaseBeneficiaries).values({ userId: action.userId, tier, contactId });
  return { kind: 'applied', details: { contactId, tier } };
};

// remove_beneficiary: revoke an active designation (never DELETE — preserves
// history + the active partial-unique index). Payload: { contactId, tier }.
const removeBeneficiary: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const contactId = asString(action.payload['contactId']);
  const tierRaw = action.payload['tier'];
  if (contactId === null || (tierRaw !== 's1' && tierRaw !== 's2' && tierRaw !== 's3')) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const rows = await db
    .update(schema.releaseBeneficiaries)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.releaseBeneficiaries.userId, action.userId),
        eq(schema.releaseBeneficiaries.tier, tierRaw),
        eq(schema.releaseBeneficiaries.contactId, contactId),
        isNull(schema.releaseBeneficiaries.revokedAt),
      ),
    )
    .returning({ id: schema.releaseBeneficiaries.id });
  if (rows[0] === undefined) return { kind: 'cancelled', reason: 'not_designated' };
  // An S1 beneficiary holds their own envelope (designate created it). Revoke it
  // too so the designation fully removes their S1 access — and so resolveHolders
  // does not later pick the orphaned envelope up and promote them to an affirmer.
  if (tierRaw === 's1') {
    await db
      .update(schema.s1TierKeyEnvelopes)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.s1TierKeyEnvelopes.userId, action.userId),
          eq(schema.s1TierKeyEnvelopes.contactId, contactId),
          isNull(schema.s1TierKeyEnvelopes.revokedAt),
        ),
      );
  }
  return { kind: 'applied', details: { contactId, tier: tierRaw } };
};

// ── Vault-domain handlers (Phase 3.3). The owner's step-up-gated endpoint
// enqueues; these APPLY after the 7-day cooldown. ─────────────────────────────

// set_vault_item_tier: move an item to a new tier. Payload:
//   { itemId, newTier, wrappedPerItemKey, wrappedPerItemKeyNonce }
// The content ciphertext is unchanged; the client re-wrapped the per-item key
// under the new tier key (carried here) and the server re-wraps the inner bundle
// under the NEW tier's outer key (applyTierMove — same provision/wrap path as an
// initial store). Re-validates at apply: the item may have been deleted, or the
// move may now be a no-op. The backup slot is cleared (its envelope is keyed to
// the OLD tier's outer key, so it would be un-revertible after the move).
const setVaultItemTier: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const p = action.payload;
  const itemId = asString(p['itemId']);
  const newTierRaw = p['newTier'];
  const newKey = decodeB64(p['wrappedPerItemKey']);
  const newKeyNonce = decodeB64(p['wrappedPerItemKeyNonce']);
  // The title is encrypted under the TIER key, so it has to move with it. The
  // client re-encrypted it at enqueue — the only moment a tier key exists, since
  // the worker holds none and never will. Required, not optional: an action
  // without it is a pre-2026-08-09 enqueue, and applying that would leave the
  // item's title sealed under the tier it just left.
  const newTitle = decodeB64(p['titleCiphertext']);
  const newTitleNonce = decodeB64(p['titleNonce']);
  if (
    itemId === null ||
    (newTierRaw !== 's1' && newTierRaw !== 's2' && newTierRaw !== 's3') ||
    newKey === null ||
    newKeyNonce === null ||
    newTitle === null ||
    newTitleNonce === null
  ) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const newTier: VaultTier = newTierRaw;

  // Missing KEK is worker MISCONFIG, not a "world changed" cancel — throw so the
  // action stays pending and retries once the worker is configured.
  if (ctx.outerLayerKeks === undefined) {
    throw new Error('set_vault_item_tier handler requires outerLayerKeks (OUTER_LAYER_KEK)');
  }

  const rows = await db
    .select()
    .from(schema.vaultItems)
    .where(and(eq(schema.vaultItems.id, itemId), eq(schema.vaultItems.userId, action.userId)))
    .for('update');
  const item = rows[0];
  if (!item || item.deletedAt !== null) return { kind: 'cancelled', reason: 'item_not_found' };
  if (item.tier === newTier) return { kind: 'cancelled', reason: 'tier_unchanged' };

  const rewrapped = await applyTierMove(db, ctx.outerLayerKeks, item, newTier, newKey, newKeyNonce);
  await db
    .update(schema.vaultItems)
    .set({
      tier: newTier,
      titleCiphertext: newTitle,
      titleNonce: newTitleNonce,
      // Re-sealed under the destination tier, so it lands at the current AAD
      // version whatever it was before.
      aadVersion: ITEM_AAD_VERSION_CURRENT,
      outerCiphertext: rewrapped.outerCiphertext,
      outerNonce: rewrapped.outerNonce,
      outerLayerKeyId: rewrapped.outerLayerKeyId,
      outerKekId: rewrapped.outerKekId,
      outerGeneration: rewrapped.outerGeneration,
      // The old-tier backup envelope can't be unwrapped under the new tier's key.
      backupOuterCiphertext: null,
      backupOuterNonce: null,
      backupAt: null,
      updatedAt: now,
    })
    .where(eq(schema.vaultItems.id, itemId));
  return { kind: 'applied', details: { itemId, fromTier: item.tier, toTier: newTier } };
};

// delete_vault_item: soft-delete after the cooldown. Sets deleted_at and clears
// the pending marker. (Hard-delete of the row + attachment blobs is deferred to
// Checkpoint C, alongside attachments.)
const deleteVaultItem: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const itemId = asString(action.payload['itemId']);
  if (itemId === null) return { kind: 'cancelled', reason: 'invalid_payload' };
  const rows = await db
    .update(schema.vaultItems)
    .set({ deletedAt: now, pendingDeleteAt: null, updatedAt: now })
    .where(
      and(
        eq(schema.vaultItems.id, itemId),
        eq(schema.vaultItems.userId, action.userId),
        isNull(schema.vaultItems.deletedAt),
      ),
    )
    .returning({ id: schema.vaultItems.id });
  if (rows[0] === undefined) return { kind: 'cancelled', reason: 'item_not_found_or_deleted' };
  return { kind: 'applied', details: { itemId } };
};

// purge_attachment: hard-delete an attachment after the cooldown. The DB row is
// the durable state (deleted transactionally + the user's storage budget released
// for a stored blob); the blob itself is best-effort — already gone is success
// (Q5). Missing blobStore is worker MISCONFIG → throw (retry), so we never delete
// the row while orphaning the blob.
const purgeAttachment: HandlerFn = async (action, ctx) => {
  const { db } = ctx;
  const attachmentId = asString(action.payload['attachmentId']);
  if (attachmentId === null) return { kind: 'cancelled', reason: 'invalid_payload' };
  if (ctx.blobStore === undefined) {
    throw new Error('purge_attachment handler requires a blob store (ATTACHMENTS_DIR / S3_*)');
  }
  const rows = await db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.userId, action.userId)))
    .for('update');
  const att = rows[0];
  if (!att) return { kind: 'cancelled', reason: 'attachment_not_found' };

  // Release the budget a stored blob reserved (pending_upload/failed reserved none).
  if (att.status === 'stored') {
    await releaseUserStorage(db, action.userId, att.sizeBytes);
  }
  await db.delete(schema.attachments).where(eq(schema.attachments.id, attachmentId));
  await ctx.blobStore.delete(blobKey(action.userId, attachmentId));
  return { kind: 'applied', details: { attachmentId } };
};

// ── Account/key-domain handlers (Phase 3.4). ─────────────────────────────────

// rotate_recovery_code: the master KEY is unchanged — only its recovery-code
// wrapping moves. The client derived a new recovery KEK from the new code and
// re-wrapped the master key; we just swap the three recovery columns. Nothing
// downstream (tier keys, audit key, content) changes. Payload: base64
//   { recoveryCodeSalt, masterKeyWrappedByRecovery, masterKeyRecoveryNonce }.
const rotateRecoveryCode: HandlerFn = async (action, ctx) => {
  const salt = decodeB64(action.payload['recoveryCodeSalt']);
  const wrapped = decodeB64(action.payload['masterKeyWrappedByRecovery']);
  const nonce = decodeB64(action.payload['masterKeyRecoveryNonce']);
  if (salt === null || wrapped === null || nonce === null) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const rows = await ctx.db
    .update(schema.userKeyMaterial)
    .set({
      recoveryCodeSalt: salt,
      masterKeyWrappedByRecovery: wrapped,
      masterKeyRecoveryNonce: nonce,
      updatedAt: ctx.now,
    })
    .where(eq(schema.userKeyMaterial.userId, action.userId))
    .returning({ userId: schema.userKeyMaterial.userId });
  if (rows[0] === undefined) return { kind: 'cancelled', reason: 'no_key_material' };
  return { kind: 'applied', details: { rotated: 'recovery_code' } };
};

// change_share_composition: swap which factor fills a release-share slot (S2/S3
// only — the Shamir threshold is locked by the user_tier_keys CHECK; this changes
// the factor, not the count). Revoke the existing active share at (tier, index)
// then insert the new one. The client-wrapped material is stored byte-for-byte;
// the DB CHECK binds share_type → required columns, but we validate first so a bad
// payload cancels cleanly rather than throwing the CHECK (which would retry).
// Payload: { tier, shareIndex, newShareType, contactId?, wrappedShareCiphertext?, passphraseSalt?, hardwareKeyId? }.
const changeShareComposition: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const p = action.payload;
  const tierRaw = p['tier'];
  const shareIndex = asInt(p['shareIndex']);
  const newType = p['newShareType'];
  if ((tierRaw !== 's2' && tierRaw !== 's3') || shareIndex === null || shareIndex < 1) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  const tier: 's2' | 's3' = tierRaw;
  // Nested S3 (docs/24) has no distributed passphrase share — the passphrase is
  // the XOR mask, not a slot. So S3 recomposition is contact/hardware factors at
  // indices 1..S3_NESTED_CONTACT_SHARES only; a release_passphrase factor or an
  // out-of-range index is rejected. S2 keeps its flat reserved passphrase slot.
  const maxIndex = tier === 's2' ? S2_SHARES : S3_NESTED_CONTACT_SHARES;
  if (shareIndex > maxIndex) return { kind: 'cancelled', reason: 'invalid_payload' };
  if (tier === 's3' && newType === 'release_passphrase') {
    return { kind: 'cancelled', reason: 'invalid_share_type' };
  }

  const insert: typeof schema.releaseShares.$inferInsert = {
    userId: action.userId,
    tier,
    shareIndex,
    shareType: 'contact',
  };
  if (newType === 'contact' || newType === 'second_professional_contact') {
    const contactId = asString(p['contactId']);
    const ct = decodeB64(p['wrappedShareCiphertext']);
    if (contactId === null || ct === null) return { kind: 'cancelled', reason: 'invalid_contact_share' };
    // Re-validate the contact at apply (7 days can change the world; 3.2 pattern).
    const crows = await db
      .select({ status: schema.contacts.status })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.ownerUserId, action.userId)))
      .limit(1);
    const c = crows[0];
    if (!c || (c.status !== 'enrolled' && c.status !== 'active')) {
      return { kind: 'cancelled', reason: 'contact_not_enrolled' };
    }
    insert.shareType = newType;
    insert.contactId = contactId;
    insert.wrappedShareCiphertext = ct;
  } else if (newType === 'hardware_key') {
    const ct = decodeB64(p['wrappedShareCiphertext']);
    if (ct === null) return { kind: 'cancelled', reason: 'invalid_hardware_share' };
    insert.shareType = 'hardware_key';
    insert.wrappedShareCiphertext = ct;
    const hwId = asString(p['hardwareKeyId']);
    if (hwId !== null) insert.hardwareKeyId = hwId;
  } else if (newType === 'release_passphrase') {
    const salt = decodeB64(p['passphraseSalt']);
    if (salt === null) return { kind: 'cancelled', reason: 'invalid_passphrase_share' };
    insert.shareType = 'release_passphrase';
    insert.passphraseSalt = salt;
  } else {
    return { kind: 'cancelled', reason: 'invalid_share_type' };
  }

  // Revoke the existing active share at this slot (if any) so the new insert
  // doesn't collide on the active partial-unique index, then insert the new one.
  await db
    .update(schema.releaseShares)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.releaseShares.userId, action.userId),
        eq(schema.releaseShares.tier, tier),
        eq(schema.releaseShares.shareIndex, shareIndex),
        isNull(schema.releaseShares.revokedAt),
      ),
    );
  await db.insert(schema.releaseShares).values(insert);
  return { kind: 'applied', details: { tier, shareIndex, newShareType: newType } };
};

const AUDIT_PUBKEY_BYTES = 32;
const IN_FLIGHT_CEREMONY_STATUSES = [
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
] as const;

// SHA-256 of the (PUBLIC) audit signing key. Recorded in the rotation audit
// payload to prove old≠new without bloating it with full keys. The pubkey is the
// verification key (not secret), so a plain hash suffices to prove rotation; an
// HMAC under a server secret would only add non-correlatability (deferred).
function auditKeyHash(pubkey: Uint8Array): string {
  return createHash('sha256').update(pubkey).digest('hex');
}

// rotate_master_passphrase (PHASE3_4 §d) — a FULL master-key rotation. The client
// (zero-knowledge) minted a new master key and re-wrapped: it under the new
// passphrase KEK + the existing recovery KEK, and EVERY tier key under the new
// tier-wrapping key. The handler's load-bearing job is STRUCTURAL VALIDATION: the
// payload must re-wrap every user_tier_keys row (counted against the live set),
// carry the recovery re-wrap, a well-formed new audit pubkey, and generation+1.
// Any gap CANCELS before mutating anything — so a buggy/hostile client can't strip
// a tier's access by omitting its re-wrap. Then: atomic replace + force-revoke
// sessions (pending actions SURVIVE — revoke ≠ cancel). Payload base64 except
// generation (int) and tierRewraps[] ({ tier, tierKeyWrappedByMaster, tierKeyMasterNonce }).
const rotateMasterPassphrase: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const p = action.payload;
  const salt = decodeB64(p['masterPassphraseSalt']);
  const passWrap = decodeB64(p['masterKeyWrappedByPassphrase']);
  const passNonce = decodeB64(p['masterKeyPassphraseNonce']);
  const recWrap = decodeB64(p['masterKeyWrappedByRecovery']);
  const recNonce = decodeB64(p['masterKeyRecoveryNonce']);
  const newPubkey = decodeB64(p['auditSigningPubkey']);
  const generation = asInt(p['generation']);
  if (
    salt === null || passWrap === null || passNonce === null ||
    recWrap === null || recNonce === null || newPubkey === null || generation === null
  ) {
    return { kind: 'cancelled', reason: 'invalid_payload' };
  }
  if (newPubkey.length !== AUDIT_PUBKEY_BYTES) return { kind: 'cancelled', reason: 'invalid_audit_pubkey' };

  const kmRows = await db
    .select()
    .from(schema.userKeyMaterial)
    .where(eq(schema.userKeyMaterial.userId, action.userId))
    .for('update');
  const km = kmRows[0];
  if (!km) return { kind: 'cancelled', reason: 'no_key_material' };
  if (generation !== km.generation + 1) return { kind: 'cancelled', reason: 'generation_mismatch' };

  // The load-bearing check: every tier row must have a re-wrap in the payload.
  const tierRows = await db
    .select({ tier: schema.userTierKeys.tier })
    .from(schema.userTierKeys)
    .where(eq(schema.userTierKeys.userId, action.userId))
    .for('update');
  const rewraps = Array.isArray(p['tierRewraps']) ? p['tierRewraps'] : [];
  const byTier = new Map<VaultTier, { wrap: Uint8Array; nonce: Uint8Array }>();
  for (const r of rewraps) {
    if (typeof r !== 'object' || r === null) return { kind: 'cancelled', reason: 'tier_count_mismatch' };
    const rr = r as Record<string, unknown>;
    const tier = rr['tier'];
    const wrap = decodeB64(rr['tierKeyWrappedByMaster']);
    const nonce = decodeB64(rr['tierKeyMasterNonce']);
    if ((tier !== 's1' && tier !== 's2' && tier !== 's3') || wrap === null || nonce === null) {
      return { kind: 'cancelled', reason: 'tier_count_mismatch' };
    }
    byTier.set(tier, { wrap, nonce });
  }
  if (byTier.size !== tierRows.length) return { kind: 'cancelled', reason: 'tier_count_mismatch' };
  for (const tr of tierRows) {
    if (!byTier.has(tr.tier)) return { kind: 'cancelled', reason: 'tier_count_mismatch' };
  }

  // ── All validation passed; mutate atomically. ──
  const fromKeyHash = auditKeyHash(km.auditSigningPubkey);
  const toKeyHash = auditKeyHash(newPubkey);
  await db
    .update(schema.userKeyMaterial)
    .set({
      masterPassphraseSalt: salt,
      masterKeyWrappedByPassphrase: passWrap,
      masterKeyPassphraseNonce: passNonce,
      masterKeyWrappedByRecovery: recWrap,
      masterKeyRecoveryNonce: recNonce,
      auditSigningPubkey: newPubkey,
      generation,
      updatedAt: now,
    })
    .where(eq(schema.userKeyMaterial.userId, action.userId));
  for (const [tier, rw] of byTier) {
    await db
      .update(schema.userTierKeys)
      .set({ tierKeyWrappedByMaster: rw.wrap, tierKeyMasterNonce: rw.nonce, updatedAt: now })
      .where(and(eq(schema.userTierKeys.userId, action.userId), eq(schema.userTierKeys.tier, tier)));
  }
  // Force-revoke sessions: old sessions predate the new key. This is the SESSION
  // revocation (revoked_at), NOT a delete and NOT a cancel of pending actions.
  await revokeAllUserSessions(db, action.userId, 'master_passphrase_rotated', now);
  return {
    kind: 'applied',
    details: { rotated: 'master_passphrase', fromKeyHash, toKeyHash, tiersRewrapped: byTier.size },
  };
};

// rotate_release_passphrase (PHASE3_4 §d/§g-5). The release passphrase derives a
// fixed Shamir share, so rotating it re-splits each S2/S3 tier key — the client
// re-wraps EVERY active contact share with its new split portion + supplies the
// new release-passphrase salt. Same structural-validation shape as master
// rotation: every active S2/S3 share must have a re-wrap, or cancel. BLOCKED while
// a ceremony is in flight: the snapshot isolates already-affirmed shares, but a
// contact affirming AFTER a mid-ceremony re-split would contribute a new-polynomial
// share, mixing polynomials and breaking reconstruction (PHASE3_4 ceremony note).
const rotateReleasePassphrase: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const newSalt = decodeB64(action.payload['releasePassphraseSalt']);
  if (newSalt === null) return { kind: 'cancelled', reason: 'invalid_payload' };

  const ceremonies = await db
    .select({ id: schema.releaseCeremonies.id })
    .from(schema.releaseCeremonies)
    .where(
      and(
        eq(schema.releaseCeremonies.userId, action.userId),
        inArray(schema.releaseCeremonies.status, [...IN_FLIGHT_CEREMONY_STATUSES]),
      ),
    )
    .limit(1);
  if (ceremonies[0] !== undefined) return { kind: 'cancelled', reason: 'ceremony_in_flight' };

  const active = await db
    .select()
    .from(schema.releaseShares)
    .where(and(eq(schema.releaseShares.userId, action.userId), isNull(schema.releaseShares.revokedAt)))
    .for('update');
  const rawShares = Array.isArray(action.payload['shares']) ? action.payload['shares'] : [];
  const bySlot = new Map<string, typeof schema.releaseShares.$inferInsert>();
  for (const s of rawShares) {
    if (typeof s !== 'object' || s === null) return { kind: 'cancelled', reason: 'share_count_mismatch' };
    const built = buildReleaseShareInsert(action.userId, s as Record<string, unknown>);
    if (built === null) return { kind: 'cancelled', reason: 'invalid_share' };
    bySlot.set(`${built.tier}:${built.shareIndex}`, built);
  }
  // Every active share must be re-wrapped — counts match + each slot covered.
  if (bySlot.size !== active.length) return { kind: 'cancelled', reason: 'share_count_mismatch' };
  for (const a of active) {
    if (!bySlot.has(`${a.tier}:${a.shareIndex}`)) return { kind: 'cancelled', reason: 'share_count_mismatch' };
  }

  // ── Atomic re-split: revoke all active, insert the new set, swap the salt. ──
  await db
    .update(schema.releaseShares)
    .set({ revokedAt: now })
    .where(and(eq(schema.releaseShares.userId, action.userId), isNull(schema.releaseShares.revokedAt)));
  for (const insert of bySlot.values()) await db.insert(schema.releaseShares).values(insert);
  await db
    .update(schema.userKeyMaterial)
    .set({ releasePassphraseSalt: newSalt, updatedAt: now })
    .where(eq(schema.userKeyMaterial.userId, action.userId));
  return { kind: 'applied', details: { rotated: 'release_passphrase', sharesRewrapped: bySlot.size } };
};

// Build a release_shares insert from a client-supplied share, validating the
// material matches the share_type (the DB CHECK enforces it too, but validating
// here cancels cleanly instead of throwing). S2/S3 only.
function buildReleaseShareInsert(
  userId: UserId,
  raw: Record<string, unknown>,
): typeof schema.releaseShares.$inferInsert | null {
  const tierRaw = raw['tier'];
  const shareIndex = asInt(raw['shareIndex']);
  const type = raw['shareType'];
  if ((tierRaw !== 's2' && tierRaw !== 's3') || shareIndex === null || shareIndex < 1) return null;
  const tier: 's2' | 's3' = tierRaw;
  // Nested S3 has no passphrase share and only S3_NESTED_CONTACT_SHARES contact
  // slots; reject an out-of-range index or a release_passphrase factor for S3.
  if (shareIndex > (tier === 's2' ? S2_SHARES : S3_NESTED_CONTACT_SHARES)) return null;
  if (tier === 's3' && type === 'release_passphrase') return null;
  if (type === 'contact' || type === 'second_professional_contact') {
    const contactId = asString(raw['contactId']);
    const ct = decodeB64(raw['wrappedShareCiphertext']);
    if (contactId === null || ct === null) return null;
    return { userId, tier, shareIndex, shareType: type, contactId, wrappedShareCiphertext: ct };
  }
  if (type === 'hardware_key') {
    const ct = decodeB64(raw['wrappedShareCiphertext']);
    if (ct === null) return null;
    const hwId = asString(raw['hardwareKeyId']);
    const base = { userId, tier, shareIndex, shareType: 'hardware_key' as const, wrappedShareCiphertext: ct };
    return hwId !== null ? { ...base, hardwareKeyId: hwId } : base;
  }
  if (type === 'release_passphrase') {
    const salt = decodeB64(raw['passphraseSalt']);
    if (salt === null) return null;
    return { userId, tier, shareIndex, shareType: 'release_passphrase', passphraseSalt: salt };
  }
  return null;
}

// remove_hardware_key (PHASE3_4 §e). Removing an auth factor must not strip the
// user's last way in. The surviving-auth-path check PRECEDES the revocation (same
// discipline as the master-rotation tier check): a login path survives if a
// non-revoked webauthn credential OTHER than the target remains, OR password+TOTP
// is configured. If removal would leave zero, the handler CANCELS — the credential
// stays active, and the all-channel notice (the sensitive-action notice path) tells
// the user to set up an alternate factor first. Payload: { credentialId }.
const removeHardwareKey: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const credentialId = asString(action.payload['credentialId']);
  if (credentialId === null) return { kind: 'cancelled', reason: 'invalid_payload' };

  const target = await db
    .select({ id: schema.webauthnCredentials.id })
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.id, credentialId),
        eq(schema.webauthnCredentials.userId, action.userId),
        isNull(schema.webauthnCredentials.revokedAt),
      ),
    )
    .for('update');
  if (target[0] === undefined) return { kind: 'cancelled', reason: 'credential_not_found' };

  // Surviving login paths AFTER the removal — computed BEFORE any mutation.
  const otherWebauthn = await db
    .select({ id: schema.webauthnCredentials.id })
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.userId, action.userId),
        isNull(schema.webauthnCredentials.revokedAt),
        ne(schema.webauthnCredentials.id, credentialId),
      ),
    );
  let hasPasswordTotp = false;
  if (otherWebauthn.length === 0) {
    const pw = await db
      .select({ userId: schema.passwordCredentials.userId })
      .from(schema.passwordCredentials)
      .where(eq(schema.passwordCredentials.userId, action.userId))
      .limit(1);
    const totp = await db
      .select({ userId: schema.totpCredentials.userId })
      .from(schema.totpCredentials)
      .where(
        and(
          eq(schema.totpCredentials.userId, action.userId),
          isNotNull(schema.totpCredentials.confirmedAt),
        ),
      )
      .limit(1);
    hasPasswordTotp = pw[0] !== undefined && totp[0] !== undefined;
  }
  if (otherWebauthn.length === 0 && !hasPasswordTotp) {
    return { kind: 'cancelled', reason: 'would_remove_last_auth_path' };
  }

  // Check passed → revoke (soft-delete, preserves the credential history).
  await db
    .update(schema.webauthnCredentials)
    .set({ revokedAt: now })
    .where(eq(schema.webauthnCredentials.id, credentialId));
  return { kind: 'applied', details: { removedCredentialId: credentialId } };
};

// delete_account (PHASE3_4 §f). NOT a row delete — audit_log.user_id is ON DELETE
// RESTRICT, so the users row + the entire audit_log SURVIVE (a compromised session
// that triggered deletion can't erase its own evidence). Purges the user's data in
// FK-safe order (children before NO ACTION/RESTRICT parents), removes attachment
// blobs best-effort, then tombstones the users row. The purge order is mapped
// against the live FK graph — see PHASE3_4 Checkpoint C.
const deleteAccount: HandlerFn = async (action, ctx) => {
  const { db, now } = ctx;
  const userId = action.userId;

  // Attachment blobs (best-effort — the DB row is the truth; a gone blob is fine).
  if (ctx.blobStore !== undefined) {
    const atts = await db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(eq(schema.attachments.userId, userId));
    for (const a of atts) await ctx.blobStore.delete(blobKey(userId, a.id));
  }

  // Purge order: each child before any NO ACTION / RESTRICT parent it references.
  await db.delete(schema.attachments).where(eq(schema.attachments.userId, userId));
  await db.delete(schema.vaultItems).where(eq(schema.vaultItems.userId, userId));
  await db.delete(schema.userTierKeys).where(eq(schema.userTierKeys.userId, userId));
  await db.delete(schema.outerLayerKeys).where(eq(schema.outerLayerKeys.userId, userId));
  await db.delete(schema.engineStates).where(eq(schema.engineStates.userId, userId));
  await db.delete(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.userId, userId));
  await db.delete(schema.releaseShares).where(eq(schema.releaseShares.userId, userId));
  await db.delete(schema.releaseBeneficiaries).where(eq(schema.releaseBeneficiaries.userId, userId));
  await db.delete(schema.s1TierKeyEnvelopes).where(eq(schema.s1TierKeyEnvelopes.userId, userId));
  await db.delete(schema.contacts).where(eq(schema.contacts.ownerUserId, userId));
  await db.delete(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId));
  await db.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, userId));
  await db.delete(schema.passwordCredentials).where(eq(schema.passwordCredentials.userId, userId));
  await db.delete(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId));
  await db.delete(schema.authChallenges).where(eq(schema.authChallenges.userId, userId));
  await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.userId, userId));
  await db.delete(schema.notificationChannels).where(eq(schema.notificationChannels.userId, userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  await db.delete(schema.deviceRegistrations).where(eq(schema.deviceRegistrations.userId, userId));

  // Tombstone the surviving users row: free the email for re-registration, flip
  // status. The generated email_lower follows, so the unique index no longer
  // collides with the original address.
  await db
    .update(schema.users)
    .set({ email: `deleted-${userId}@deleted.truecairn.local`, accountStatus: 'deleted', updatedAt: now })
    .where(eq(schema.users.id, userId));
  return { kind: 'applied', details: { deleted: true } };
};

// Stub handler for actions whose real implementation depends on later phases.
// Audits as applied without mutating user state. Marker comment per Phase 2 /
// Phase 3 work so these are trivially greppable.
const phaseDeferredStub: HandlerFn = async () => {
  // PHASE_DEFERRED: replace with real implementation (key rotation, contact
  // changes, hardware key registration, etc.) when the corresponding phase
  // builds out the supporting infrastructure.
  return { kind: 'applied', details: { stub: true } };
};

const HANDLERS: Record<SensitiveActionType, HandlerFn> = {
  arm_engine: armEngine,
  change_inactivity_threshold: changeInactivityThreshold,
  change_cooldown_window: changeCooldownWindow,
  change_email: changeEmail,
  // Contact-domain (Phase 3.2): real implementations.
  rotate_contact: rotateContact,
  add_contact: addContact,
  remove_contact: removeContact,
  change_contact_role: changeContactRole,
  // Channel removal (docs/26 §4 follow-on): verified channels only reach here —
  // the route removes unverified ones immediately.
  remove_channel: removeChannel,
  // Designated beneficiary (backlog #2).
  designate_beneficiary: designateBeneficiary,
  remove_beneficiary: removeBeneficiary,
  // Vault-domain (Phase 3.3): tier move, delete, and attachment purge.
  set_vault_item_tier: setVaultItemTier,
  delete_vault_item: deleteVaultItem,
  purge_attachment: purgeAttachment,
  // Account/key-domain (Phase 3.4): Checkpoint A.
  rotate_recovery_code: rotateRecoveryCode,
  change_share_composition: changeShareComposition,
  // Phase 3.4 Checkpoint B (the hard rotations).
  rotate_master_passphrase: rotateMasterPassphrase,
  rotate_release_passphrase: rotateReleasePassphrase,
  // Phase 3.4 Checkpoint C.
  remove_hardware_key: removeHardwareKey,
  delete_account: deleteAccount,
  // The release-FACTOR hardware-key assignment (share_type='hardware_key'); 3.1's
  // immediate path is canonical for AUTH registration. Pending (PHASE3_4 §g-2).
  register_hardware_key: phaseDeferredStub,
  // Deferred pending design (no current use case in this architecture — tiers are
  // locked, items move per-item via set_vault_item_tier). PHASE3_4 §g-6.
  change_tier_configuration: phaseDeferredStub,
};

export function handlerFor(actionType: SensitiveActionType): HandlerFn {
  return HANDLERS[actionType];
}

export async function runHandler(
  action: PendingAction,
  ctx: HandlerContext,
): Promise<HandlerOutcome> {
  const fn = handlerFor(action.actionType);
  return fn(action, ctx);
}

function readPositiveInt(v: unknown): number | null {
  if (typeof v !== 'number') return null;
  if (!Number.isInteger(v)) return null;
  if (v <= 0) return null;
  return v;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

// Contact-domain payloads carry client-wrapped ciphertext as base64 (jsonb has
// no bytea); decode it back to the exact bytes for storage.
function decodeB64(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  return new Uint8Array(Buffer.from(v, 'base64'));
}
