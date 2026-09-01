// Server-side ceremony orchestration the worker drives. Mirrors how
// @truecairn/sensitive-actions' processor relates to the worker poll loop.
//
// Responsibilities (all server-side; reconstruction itself is client-side):
//   - commitDueAffirmations: tentative → committed once the 48h window expires.
//   - processCeremony: drive one ceremony's state machine a single tick
//     (time transitions, threshold advance, outer-key release).
//   - recordRecipientReconstruction: a recipient device reports success; the
//     first one flips the ceremony to released.
//
// Audit effects are written through the AuditLogPort. Notification effects
// (enqueue_notification) are realised here too (PHASE3_5 §g): contact-facing
// ceremony purposes resolve to the affirming contacts' own users' verified
// channels; owner-facing ones (engine_state_change) resolve to the owner's. One
// notification_deliveries row per (recipient-user, channel); the delivery worker
// sends them. The enqueue shares the transition's transaction, so a rolled-back
// transition enqueues nothing.

import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import { S2_THRESHOLD, S3_NESTED_CONTACT_THRESHOLD } from '@truecairn/keys';
import type { CeremonyStatus, NotificationPurpose, UserId, VaultTier } from '@truecairn/shared';
import { and, eq, inArray, isNull, lte, notExists, sql } from 'drizzle-orm';
import {
  computeCeremonyEventTransition,
  computeCeremonyTimeTransition,
} from './transitions.js';
import type {
  CeremonyContext,
  CeremonyEffect,
  CeremonyEngineSignal,
  CeremonyRow,
  CeremonyTransitionResult,
} from './types.js';

export interface ProcessorContext {
  db: Database;
  audit: AuditLogPort;
  now: Date;
  reconstructionTimeoutDays?: number;
  // Bridge 3 (CEREMONY_COMPLETION): the consensus→engine callback. When a
  // ceremony transition carries an engineSignal, the processor invokes this so
  // the worker can apply the matching engine event IN THE SAME transaction (the
  // signal commits atomically with the ceremony transition, or both roll back).
  // Worker-supplied; the pure processor stays decoupled from the engine's channels.
  signalEngine?: (
    db: Database,
    userId: UserId,
    signal: CeremonyEngineSignal,
    now: Date,
  ) => Promise<void>;
}

export interface CeremonyTickResult {
  affirmationsCommitted: number;
  ceremoniesProcessed: number;
}

// Worker entry: one ceremony-processing pass. Commits any affirmations whose
// revocation window has expired, then advances every non-terminal ceremony a
// single tick. Recipient reconstruction reports arrive via the API
// (recordRecipientReconstruction), not this pass.
export async function tickCeremonies(
  ctx: ProcessorContext,
  limit: number,
): Promise<CeremonyTickResult> {
  const affirmationsCommitted = await commitDueAffirmations(ctx);

  const active = await ctx.db
    .select({ id: schema.releaseCeremonies.id })
    .from(schema.releaseCeremonies)
    .where(
      sql`${schema.releaseCeremonies.status} IN ('initiated','collecting_affirmations','awaiting_outer_key','reconstructing')`,
    )
    .limit(limit);

  for (const c of active) {
    await processCeremony(ctx, c.id);
  }
  return { affirmationsCommitted, ceremoniesProcessed: active.length };
}

// Consensus threshold per tier: how many committed, diverse-role affirmations
// open the temporal gate. S1 is any-one-contact. S3 is the nested scheme
// (docs/24): any 2 of 3 contacts + the MANDATORY release passphrase reconstruct,
// so consensus is 2 (keeps "lose one contact"). Two colluding contacts opening
// the gate still cannot reconstruct without the passphrase mask — collusion is
// foreclosed cryptographically, not by the consensus count.
// Statuses a ceremony cannot leave — the transitions whose audit entry is the
// TERMINAL one, and therefore the one release_ceremonies.audit_id_terminal
// records. Mirrors TERMINAL_CEREMONY_STATUSES in apps/api's ceremony routes;
// kept as its own literal here because packages/ceremony must not import from
// apps/.
const TERMINAL_STATUSES: ReadonlySet<CeremonyStatus> = new Set<CeremonyStatus>([
  'released',
  'cancelled',
  'failed',
]);

const TIER_THRESHOLD: Record<VaultTier, number> = {
  s1: 1,
  s2: S2_THRESHOLD,
  s3: S3_NESTED_CONTACT_THRESHOLD,
};

// Engine release stage that gates outer-key release per ceremony tier.
const TIER_RELEASE_STAGE: Record<VaultTier, string> = {
  s1: 'limited_release',
  s2: 'staged_release',
  s3: 'full_release',
};

// ---------------------------------------------------------------------------
// commitDueAffirmations — tentative → committed once the revocation window has
// passed. One audit entry per commit. Returns the number committed.
// ---------------------------------------------------------------------------

export async function commitDueAffirmations(ctx: ProcessorContext): Promise<number> {
  // Only affirmations on LIVE ceremonies commit — a cancelled/failed/released
  // ceremony's tentative affirmations stay tentative (no audit noise, no
  // 'committed' rows on a dead ceremony).
  const due = await ctx.db
    .select({
      id: schema.ceremonyAffirmations.id,
      ceremonyId: schema.ceremonyAffirmations.ceremonyId,
      contactId: schema.ceremonyAffirmations.contactId,
    })
    .from(schema.ceremonyAffirmations)
    .innerJoin(
      schema.releaseCeremonies,
      eq(schema.ceremonyAffirmations.ceremonyId, schema.releaseCeremonies.id),
    )
    .where(
      and(
        eq(schema.ceremonyAffirmations.status, 'tentative'),
        lte(schema.ceremonyAffirmations.revocationWindowExpiresAt, ctx.now),
        inArray(schema.releaseCeremonies.status, [
          'initiated',
          'collecting_affirmations',
          'awaiting_outer_key',
          'reconstructing',
        ]),
      ),
    );

  let committed = 0;
  for (const a of due) {
    const ceremony = await loadCeremonyUser(ctx.db, a.ceremonyId);
    if (!ceremony) continue;
    const didCommit = await ctx.db.transaction(async (tx) => {
      const tdb = tx as unknown as Database;
      // Status-guarded: a revoke racing this commit loses cleanly — only a row
      // still 'tentative' flips, and the audit entry rides the same guard.
      const updated = await tdb
        .update(schema.ceremonyAffirmations)
        .set({ status: 'committed', committedAt: ctx.now, updatedAt: ctx.now })
        .where(
          and(
            eq(schema.ceremonyAffirmations.id, a.id),
            eq(schema.ceremonyAffirmations.status, 'tentative'),
          ),
        )
        .returning({ id: schema.ceremonyAffirmations.id });
      if (updated[0] === undefined) return false;
      // ceremony_affirmations.audit_id_affirmed — the fourth declared-but-unwritten
      // audit link, and the one that matters most per row: an affirmation is a
      // named person's assertion that an owner is gone, and "which chain entry
      // records THIS contact's commitment" should not need a timestamp match.
      const entry = await ctx.audit.append(
        tdb,
        ceremony.userId,
        'ceremony.affirmation_committed',
        { ceremonyId: a.ceremonyId, contactId: a.contactId },
      );
      await tdb
        .update(schema.ceremonyAffirmations)
        .set({ auditIdAffirmed: entry.id, updatedAt: ctx.now })
        .where(eq(schema.ceremonyAffirmations.id, a.id));
      return true;
    });
    if (didCommit) committed += 1;
  }
  return committed;
}

// ---------------------------------------------------------------------------
// processCeremony — drive one ceremony a single tick. Time transition first;
// then the state-appropriate event. Returns the resulting status.
// ---------------------------------------------------------------------------

export async function processCeremony(
  ctx: ProcessorContext,
  ceremonyId: string,
): Promise<CeremonyStatus> {
  const loaded = await loadCeremony(ctx.db, ceremonyId);
  if (!loaded) throw new Error(`ceremony ${ceremonyId} not found`);
  const { row, userId } = loaded;

  const cctx = await buildContext(ctx, ceremonyId, row.tier);

  // 1. Time-driven (sync-window expiry / reconstruction timeout).
  const timeResult = computeCeremonyTimeTransition(row, cctx);
  if (timeResult.kind === 'transition') {
    await applyTransition(ctx, ceremonyId, userId, row.tier, timeResult);
    return timeResult.toStatus;
  }

  // 2. State-appropriate event.
  switch (row.status) {
    case 'initiated': {
      const r = computeCeremonyEventTransition(row, { kind: 'contacts_notified' }, cctx);
      if (r.kind === 'transition') {
        await applyTransition(ctx, ceremonyId, userId, row.tier, r);
        return r.toStatus;
      }
      return row.status;
    }
    case 'collecting_affirmations': {
      const r = computeCeremonyEventTransition(row, { kind: 'affirmation_committed' }, cctx);
      if (r.kind === 'transition') {
        await applyTransition(ctx, ceremonyId, userId, row.tier, r);
        return r.toStatus;
      }
      return row.status;
    }
    case 'awaiting_outer_key': {
      const cooldownComplete = await engineCooldownComplete(ctx.db, userId, row.tier);
      if (!cooldownComplete) return row.status;
      const r = computeCeremonyEventTransition(row, { kind: 'outer_key_released' }, cctx);
      if (r.kind === 'transition') {
        await applyTransition(ctx, ceremonyId, userId, row.tier, r);
        return r.toStatus;
      }
      return row.status;
    }
    default:
      return row.status;
  }
}

// ---------------------------------------------------------------------------
// recordRecipientReconstruction — a recipient device reports a successful
// client-side reconstruction. Marks that recipient released; the first such
// report flips the ceremony to released.
// ---------------------------------------------------------------------------

export async function recordRecipientReconstruction(
  ctx: ProcessorContext,
  ceremonyId: string,
  recipientContactId: string,
): Promise<CeremonyStatus> {
  const loaded = await loadCeremony(ctx.db, ceremonyId);
  if (!loaded) throw new Error(`ceremony ${ceremonyId} not found`);
  const { row, userId } = loaded;

  // A reconstruction can only genuinely happen once the temporal gate has
  // opened. A report in any earlier (or cancelled/failed) state is premature —
  // marking the recipient 'released' there would later suppress the
  // reconstruction timeout (releasedRecipients > 0 keeps the gate open forever).
  if (row.status !== 'reconstructing' && row.status !== 'released') {
    return row.status;
  }

  await ctx.db
    .update(schema.ceremonyRecipients)
    .set({ status: 'released', completedAt: ctx.now, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.ceremonyRecipients.ceremonyId, ceremonyId),
        eq(schema.ceremonyRecipients.recipientContactId, recipientContactId),
      ),
    );

  if (row.status !== 'reconstructing') {
    // Ceremony already released (an earlier recipient) or not yet there; the
    // per-recipient row is updated above regardless.
    return row.status;
  }

  const cctx = await buildContext(ctx, ceremonyId, row.tier);
  const r = computeCeremonyEventTransition(row, { kind: 'recipient_reconstructed' }, cctx);
  if (r.kind === 'transition') {
    await applyTransition(ctx, ceremonyId, userId, row.tier, r);
    return r.toStatus;
  }
  return row.status;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function buildContext(
  ctx: ProcessorContext,
  ceremonyId: string,
  tier: VaultTier,
): Promise<CeremonyContext> {
  const committed = await countCommittedAffirmations(ctx.db, ceremonyId);
  const tentative = await countTentativeAffirmations(ctx.db, ceremonyId);
  const diverse = await diverseRoleSatisfied(ctx.db, ceremonyId, tier);
  const diversePossible = await diverseRoleSatisfied(ctx.db, ceremonyId, tier, [
    'tentative',
    'committed',
  ]);
  const released = await countReleasedRecipients(ctx.db, ceremonyId);
  return {
    now: ctx.now,
    threshold: TIER_THRESHOLD[tier],
    committedAffirmations: committed,
    tentativeAffirmations: tentative,
    diverseRoleSatisfied: diverse,
    diverseRolePossible: diversePossible,
    releasedRecipients: released,
    reconstructionTimeoutDays: ctx.reconstructionTimeoutDays ?? 30,
  };
}

async function applyTransition(
  ctx: ProcessorContext,
  ceremonyId: string,
  userId: UserId,
  tier: VaultTier,
  result: Extract<CeremonyTransitionResult, { kind: 'transition' }>,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const tdb = tx as unknown as Database;

    // The first audit entry of this transition is the one the ceremony row
    // points at when the transition is TERMINAL. Captured here rather than
    // correlated later: release_ceremonies.audit_id_terminal has existed since
    // the table shipped and nothing ever wrote it, so "which chain entry ended
    // this ceremony?" was a manual timestamp match on the row a disputed
    // release is argued over.
    let firstAuditId: string | null = null;
    for (const effect of result.effects) {
      if (effect.kind === 'audit_event') {
        const entry = await ctx.audit.append(tdb, userId, effect.eventType, effect.payload);
        firstAuditId ??= entry.id;
      } else if (effect.kind === 'enqueue_notification') {
        await enqueueCeremonyNotification(tdb, { id: ceremonyId, userId, tier }, effect, ctx.now);
      }
    }

    const update: Record<string, unknown> = { status: result.toStatus, updatedAt: ctx.now };
    if (result.toStatus === 'reconstructing') update['reconstructionStartedAt'] = ctx.now;
    if (result.toStatus === 'reconstructing') update['outerKeyReleasedAt'] = ctx.now;
    if (result.toStatus === 'released') update['releasedAt'] = ctx.now;
    if (result.toStatus === 'cancelled') {
      update['cancelledAt'] = ctx.now;
      update['cancellationReason'] = result.reason;
    }
    if (result.toStatus === 'failed') update['failureReason'] = result.reason;
    // Every way a ceremony can END, not just cancellation — a terminal link that
    // only some terminals set is worse than none, because its absence would read
    // as "no audit entry" rather than "this path forgot".
    if (TERMINAL_STATUSES.has(result.toStatus) && firstAuditId !== null) {
      update['auditIdTerminal'] = firstAuditId;
    }

    await tdb
      .update(schema.releaseCeremonies)
      .set(update)
      .where(eq(schema.releaseCeremonies.id, ceremonyId));

    // Bridge 3: drive the engine in the SAME transaction so consensus→advance
    // (or fail→review_required) is atomic with the ceremony transition.
    if (result.engineSignal !== undefined) {
      await ctx.signalEngine?.(tdb, userId, result.engineSignal, ctx.now);
    }
  });
}

// ---------------------------------------------------------------------------
// enqueueCeremonyNotification — realise an enqueue_notification effect. The
// purpose decides the audience: contact-facing ceremony notices go to the
// affirming contacts (resolved from the live release_shares for this tier →
// their contact users → their verified channels); owner-facing notices
// (engine_state_change) go to the owner's own verified channels. One delivery
// row per (recipient-user, channel). Content is the server-side template
// (templates.ts) keyed by purpose — the transport carries no ceremony detail
// (PHASE3_5 §f/§g); `summary` is internal only (payload_summary), never sent.
// ---------------------------------------------------------------------------

const CONTACT_FACING_PURPOSES: ReadonlySet<NotificationPurpose> = new Set([
  'ceremony_initiation',
  'ceremony_affirmation_request',
  'ceremony_revocation_window',
]);

async function enqueueCeremonyNotification(
  db: Database,
  ceremony: { id: string; userId: UserId; tier: VaultTier },
  effect: Extract<CeremonyEffect, { kind: 'enqueue_notification' }>,
  now: Date,
): Promise<void> {
  const purpose: NotificationPurpose = effect.purpose;
  const targets = CONTACT_FACING_PURPOSES.has(purpose)
    ? await resolveContactRecipients(db, ceremony.userId, ceremony.tier)
    : await resolveOwnerChannels(db, ceremony.userId);
  if (targets.length === 0) return;
  await db.insert(schema.notificationDeliveries).values(
    targets.map((t) => ({
      channelId: t.channelId,
      userId: t.userId,
      purpose,
      status: 'queued' as const,
      nextAttemptAt: now,
      relatedEntityType: 'release_ceremony',
      relatedEntityId: ceremony.id,
      payloadSummary: effect.summary,
    })),
  );
}

// The affirming contacts for a tier are those holding an active (non-revoked)
// contact-type release share. Only contacts who are themselves Truecairn users
// (contactUserId set) AND enrolled/active, with a VERIFIED, non-removed channel,
// are reachable — the inner joins drop everyone else (an unverified channel is
// never selected). selectDistinct collapses a contact who somehow holds two
// shares for the same tier to one (user, channel) pair.
async function resolveContactRecipients(
  db: Database,
  ownerUserId: UserId,
  tier: VaultTier,
): Promise<Array<{ userId: string; channelId: string }>> {
  // S1 holders live in s1_tier_key_envelopes (a full sealed envelope, not a
  // Shamir release_shares row), so S1 must resolve from there; S2/S3 resolve from
  // release_shares. Both land on the contact's own verified channels, honouring
  // THAT CONTACT's channel matrix for the contact_notices class (docs/26 §3.1 —
  // a contact opting a channel out narrows only where their own request lands).
  if (tier === 's1') {
    return db
      .selectDistinct({
        userId: schema.notificationChannels.userId,
        channelId: schema.notificationChannels.id,
      })
      .from(schema.s1TierKeyEnvelopes)
      .innerJoin(schema.contacts, eq(schema.s1TierKeyEnvelopes.contactId, schema.contacts.id))
      .innerJoin(
        schema.notificationChannels,
        eq(schema.notificationChannels.userId, schema.contacts.contactUserId),
      )
      .where(
        and(
          eq(schema.s1TierKeyEnvelopes.userId, ownerUserId),
          isNull(schema.s1TierKeyEnvelopes.revokedAt),
          inArray(schema.contacts.status, ['enrolled', 'active']),
          eq(schema.notificationChannels.verified, true),
          isNull(schema.notificationChannels.removedAt),
          matrixEnabled(db, 'contact_notices'),
        ),
      );
  }
  return db
    .selectDistinct({
      userId: schema.notificationChannels.userId,
      channelId: schema.notificationChannels.id,
    })
    .from(schema.releaseShares)
    .innerJoin(schema.contacts, eq(schema.releaseShares.contactId, schema.contacts.id))
    .innerJoin(
      schema.notificationChannels,
      eq(schema.notificationChannels.userId, schema.contacts.contactUserId),
    )
    .where(
      and(
        eq(schema.releaseShares.userId, ownerUserId),
        eq(schema.releaseShares.tier, tier),
        inArray(schema.releaseShares.shareType, ['contact', 'second_professional_contact']),
        isNull(schema.releaseShares.revokedAt),
        inArray(schema.contacts.status, ['enrolled', 'active']),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
        matrixEnabled(db, 'contact_notices'),
      ),
    );
}

async function resolveOwnerChannels(
  db: Database,
  ownerUserId: UserId,
): Promise<Array<{ userId: string; channelId: string }>> {
  // Owner-facing ceremony notices are engine_state_change — a routine
  // owner_notices-class update, so the owner's matrix applies here too.
  return db
    .select({
      userId: schema.notificationChannels.userId,
      channelId: schema.notificationChannels.id,
    })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, ownerUserId),
        eq(schema.notificationChannels.verified, true),
        isNull(schema.notificationChannels.removedAt),
        matrixEnabled(db, 'owner_notices'),
      ),
    );
}

// The channel-matrix narrowing condition (docs/26 §3.1): no preference row that
// explicitly disables this (channel, class) cell — absent row = enabled, the
// load-bearing default that preserves pre-matrix behaviour.
function matrixEnabled(db: Database, purposeClass: 'owner_notices' | 'contact_notices') {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(schema.channelPreferences)
      .where(
        and(
          eq(schema.channelPreferences.channelId, schema.notificationChannels.id),
          eq(schema.channelPreferences.purposeClass, purposeClass),
          eq(schema.channelPreferences.enabled, false),
        ),
      ),
  );
}

async function loadCeremony(
  db: Database,
  ceremonyId: string,
): Promise<{ row: CeremonyRow; userId: UserId } | null> {
  const rows = await db
    .select()
    .from(schema.releaseCeremonies)
    .where(eq(schema.releaseCeremonies.id, ceremonyId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    row: {
      status: r.status,
      tier: r.tier,
      initiatedAt: r.initiatedAt,
      syncWindowExpiresAt: r.syncWindowExpiresAt,
      reconstructionStartedAt: r.reconstructionStartedAt,
    },
    userId: r.userId as UserId,
  };
}

async function loadCeremonyUser(
  db: Database,
  ceremonyId: string,
): Promise<{ userId: UserId } | null> {
  const rows = await db
    .select({ userId: schema.releaseCeremonies.userId })
    .from(schema.releaseCeremonies)
    .where(eq(schema.releaseCeremonies.id, ceremonyId))
    .limit(1);
  const r = rows[0];
  return r ? { userId: r.userId as UserId } : null;
}

async function countCommittedAffirmations(db: Database, ceremonyId: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ceremonyAffirmations)
    .where(
      and(
        eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId),
        eq(schema.ceremonyAffirmations.status, 'committed'),
      ),
    );
  return r[0]?.n ?? 0;
}

async function countTentativeAffirmations(db: Database, ceremonyId: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ceremonyAffirmations)
    .where(
      and(
        eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId),
        eq(schema.ceremonyAffirmations.status, 'tentative'),
      ),
    );
  return r[0]?.n ?? 0;
}

async function countReleasedRecipients(db: Database, ceremonyId: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ceremonyRecipients)
    .where(
      and(
        eq(schema.ceremonyRecipients.ceremonyId, ceremonyId),
        eq(schema.ceremonyRecipients.status, 'released'),
      ),
    );
  return r[0]?.n ?? 0;
}

// Diverse-role rule (docs/12 §5.4.5, docs/14 §5.6.5): committed affirmations
// must span more than one contact role. For S1 (threshold 1, any-one-contact)
// it is trivially satisfied.
async function diverseRoleSatisfied(
  db: Database,
  ceremonyId: string,
  tier: VaultTier,
  statuses: Array<'tentative' | 'committed'> = ['committed'],
): Promise<boolean> {
  if (TIER_THRESHOLD[tier] < 2) return true;
  const r = await db
    .select({ role: schema.contacts.role })
    .from(schema.ceremonyAffirmations)
    .innerJoin(schema.contacts, eq(schema.ceremonyAffirmations.contactId, schema.contacts.id))
    .where(
      and(
        eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId),
        inArray(schema.ceremonyAffirmations.status, statuses),
      ),
    );
  const roles = new Set(r.map((x) => x.role));
  return roles.size >= 2;
}

// The outer-layer key releases once the engine has reached the release stage
// matching the ceremony tier (cooldown completed without cancellation).
async function engineCooldownComplete(
  db: Database,
  userId: UserId,
  tier: VaultTier,
): Promise<boolean> {
  const rows = await db
    .select({ state: schema.engineStates.state })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);
  const state = rows[0]?.state;
  if (!state) return false;
  // At-or-past the tier's release stage. The release ladder is
  // limited → staged → full; reaching a later stage implies the earlier
  // tiers' gates are open too.
  const ladder = ['limited_release', 'staged_release', 'full_release'];
  const required = ladder.indexOf(TIER_RELEASE_STAGE[tier]);
  const current = ladder.indexOf(state);
  return current >= 0 && current >= required;
}
