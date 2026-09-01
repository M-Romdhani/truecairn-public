// CEREMONY_COMPLETION Checkpoint A — the engine↔ceremony bridges.
//
// Bridge 1 (create) + the abandon path. Bridge 2's enrolment (affirmation +
// recipient rows) runs inside creation so a ceremony is born fully populated.
// Bridge 3's contact actions live in the API; the consensus→engine signal is
// realised by the worker (see ProcessorContext.signalEngine). These functions are
// the worker/server-shared DB orchestration; the time windows are CONFIG-DRIVEN
// (no test-mode branches) so the E2E can compress them via env.

import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { ContinuityReportPayload, UserId } from '@truecairn/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

const LIVE_CEREMONY_STATUSES = [
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
] as const;

// Engine states in which release ceremonies should exist. A tier's ceremony is
// created as soon as the engine is in any release state; its OUTER-KEY release is
// separately gated on the engine reaching that tier's stage (the processor's
// engineCooldownComplete), so creating early is safe.
const RELEASE_ENGINE_STATES = [
  'release_review',
  'limited_release',
  'staged_release',
  'full_release',
] as const;
// Same set, for the locked re-read below: `due` is a snapshot taken before the
// slow work, so the state has to be re-tested against a value the DB just gave us.
const RELEASE_ENGINE_STATE_SET: ReadonlySet<string> = new Set(RELEASE_ENGINE_STATES);
const TIERS = ['s1', 's2', 's3'] as const;

export interface CeremonyWindows {
  // How long affirmations are collected before a below-threshold ceremony fails.
  syncWindowMs: number;
  // Per-affirmation revocation window (tentative→committed); set at affirm time.
  revocationWindowMs: number;
}

// Continuity Verification (docs/26 §3.3): the report builder enters through a
// PORT so this package stays free of the notifications dependency and the
// worker controls the flag — port absent (CV_REPORT_ENABLED off) means the
// bridge behaves byte-for-byte as before. The port computes the payload, the
// EXACT serialized bytes to store (payloadJson), and their sha256 (hex): the
// bridge stores those bytes verbatim and anchors that hash, so the snapshot
// stays verifiable against the chain forever.
export interface ContinuityReportPort {
  build(
    db: Database,
    userId: UserId,
    now: Date,
  ): Promise<{ payload: ContinuityReportPayload; payloadJson: string; payloadHash: string }>;
}

export interface BridgeContext {
  db: Database;
  audit: AuditLogPort;
  now: Date;
  windows: CeremonyWindows;
  continuityReport?: ContinuityReportPort;
}

// Bridge 1 — create-once. Scan engine_states in release_review and ensure each has
// exactly one live S1 ceremony, enrolled from the owner's active S1 envelopes.
// Idempotent two ways: ON CONFLICT DO NOTHING against the partial unique index
// (0030), and a no-op when no S1 holders exist. Returns the count created.
export async function createReleaseReviewCeremonies(
  ctx: BridgeContext,
  limit: number,
): Promise<number> {
  const due = await ctx.db
    .select({ userId: schema.engineStates.userId })
    .from(schema.engineStates)
    .where(inArray(schema.engineStates.state, [...RELEASE_ENGINE_STATES]))
    .limit(limit);

  let created = 0;
  for (const { userId } of due) {
    // One report payload per user per pass: the builder is deterministic over
    // the same rows, and every tier ceremony created in this pass freezes the
    // same evidence (built lazily — only if a ceremony is actually created).
    let report: {
      payload: ContinuityReportPayload;
      payloadJson: string;
      payloadHash: string;
    } | null = null;
    for (const tier of TIERS) {
      // Enrol the tier's holders: S1 from sealed envelopes (no Shamir share, share_id
      // null); S2/S3 from the contact-type release_shares (share_id set so the contact
      // can later unwrap + re-seal its Shamir share at affirmation).
      // Cheap, lock-free short-circuit: if this tier already has a live
      // ceremony there is nothing to create, so skip the holder resolution, the
      // report build AND the locking transaction below.
      //
      // This is an optimisation, not a correctness guard — it races, and the
      // real create-once guarantees remain the partial unique index plus the
      // locked re-read inside the transaction. But it is load-bearing for
      // BEHAVIOUR, not just speed. Without it the locked re-read runs on every
      // poll (500ms in the E2E) for every user in a release state and every
      // tier, taking an exclusive row lock on engine_states just to discover
      // there is nothing to do. That lock is the same one the API takes on the
      // request path (the engine's loadRow), so the steady state of a release
      // became "the worker holds this user's engine row 6x/second while their
      // contacts are trying to affirm and reconstruct against it".
      //
      // Steady state is the common case: a ceremony exists for almost the whole
      // life of a release, so the transaction was being opened purely to no-op
      // against onConflictDoNothing. Before the locked re-read landed that cost
      // nothing measurable, because no lock was taken.
      if (await hasLiveCeremony(ctx.db, userId as UserId, tier)) continue;

      const holders = await resolveHolders(ctx.db, userId as UserId, tier);
      if (holders.length === 0) continue;

      // Build the report BEFORE the creation transaction (reads only) so the
      // transaction stays short; the snapshot insert + audit append ride the
      // SAME transaction as the ceremony they evidence (invariant 5).
      if (ctx.continuityReport !== undefined && report === null) {
        report = await ctx.continuityReport.build(ctx.db, userId as UserId, ctx.now);
      }

      const didCreate = await ctx.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;

        // Re-read the engine state INSIDE the transaction, locked, before
        // inserting anything. `due` was read outside it and everything since —
        // holder resolution, the continuity report — is slow, so a cancel can
        // and does commit in that gap. Without this re-read the cancel did not
        // merely fail to stop the insert, it ENABLED it: the create-once guard
        // is a partial unique index over LIVE ceremony statuses, so cancelling
        // the incumbent frees the slot the index was holding. The observed end
        // state was engine_states.state = 'active' while current_ceremony_id
        // pointed at a live collecting_affirmations ceremony contacts could
        // still affirm — the fail-closed invariant reading backwards.
        //
        // The cancel path takes the same lock (engine's loadRow does SELECT …
        // FOR UPDATE on this row) and commits state + currentCeremonyId
        // atomically, so whichever writer arrives second observes the other's
        // committed result. If that is us, the release is over: bail without
        // creating. Lock order matches every other writer here (engine_states
        // before audit_log_locks), so this adds no deadlock edge.
        const locked = await tx
          .select({ state: schema.engineStates.state })
          .from(schema.engineStates)
          .where(eq(schema.engineStates.userId, userId))
          .for('update');
        const state = locked[0]?.state;
        if (state === undefined || !RELEASE_ENGINE_STATE_SET.has(state)) return false;

        const inserted = await tx
          .insert(schema.releaseCeremonies)
          .values({
            userId,
            tier,
            status: 'initiated',
            syncWindowExpiresAt: new Date(ctx.now.getTime() + ctx.windows.syncWindowMs),
          })
          .onConflictDoNothing() // create-once per (user, tier) via the partial unique index
          .returning({ id: schema.releaseCeremonies.id });
        const ceremonyId = inserted[0]?.id;
        if (ceremonyId === undefined) return false;

        // currentCeremonyId is a single convenience pointer; set it to the first
        // ceremony opened (cancel/abandon enumerates ALL live ceremonies regardless).
        await tx
          .update(schema.engineStates)
          .set({ currentCeremonyId: ceremonyId, updatedAt: ctx.now })
          .where(
            and(
              eq(schema.engineStates.userId, userId),
              isNull(schema.engineStates.currentCeremonyId),
            ),
          );

        for (const h of holders) {
          await tx.insert(schema.ceremonyAffirmations).values({
            ceremonyId,
            contactId: h.contactId,
            ...(h.shareId !== null ? { shareId: h.shareId } : {}),
            status: 'pending',
          });
          await tx
            .insert(schema.ceremonyRecipients)
            .values({ ceremonyId, recipientContactId: h.contactId, status: 'pending' });
        }

        // Designated beneficiaries (backlog #2): non-affirming recipients. Enrol
        // them as ceremony_recipients ONLY (no affirmation row → not a consensus
        // party) so the affirming holders re-seal their shares to them and they
        // can reconstruct. onConflictDoNothing covers a beneficiary who is also a
        // holder (already a recipient). S2/S3 only — resolveBeneficiaries is empty
        // for S1.
        const beneficiaries = await resolveBeneficiaries(tx, userId as UserId, tier);
        for (const b of beneficiaries) {
          await tx
            .insert(schema.ceremonyRecipients)
            .values({ ceremonyId, recipientContactId: b.contactId, status: 'pending' })
            .onConflictDoNothing();
        }

        // The returned id is written back to release_ceremonies.audit_id_initiated
        // so a ceremony carries a direct pointer to the chain entry that opened
        // it. The column shipped with the table and nothing wrote it, which left
        // "which audit entry initiated this ceremony?" answerable only by
        // matching user id + timestamp by hand.
        const initiated = await ctx.audit.append(tx, userId as UserId, 'ceremony.initiated', {
          ceremonyId,
          tier,
          holders: holders.length,
          beneficiaries: beneficiaries.length,
        });
        await tx
          .update(schema.releaseCeremonies)
          .set({ auditIdInitiated: initiated.id, updatedAt: ctx.now })
          .where(eq(schema.releaseCeremonies.id, ceremonyId));

        // Freeze the Continuity Report against this ceremony (docs/26 §3.3):
        // snapshot + audit-anchored hash, in the creation transaction. The
        // unique(ceremony_id) + create-once index make re-runs no-ops; the
        // audit payload carries the HASH only — the evidence itself is served
        // recipient-gated, never through the audit chain.
        if (report !== null) {
          await tx
            .insert(schema.continuityReports)
            .values({ ceremonyId, generatedAt: ctx.now, payload: report.payloadJson })
            .onConflictDoNothing();
          await ctx.audit.append(tx, userId as UserId, 'ceremony.continuity_report_attached', {
            ceremonyId,
            tier,
            payloadHash: report.payloadHash,
            schemaVersion: report.payload.schemaVersion,
          });
        }
        return true;
      });
      if (didCreate) created += 1;
    }
  }
  return created;
}

// Does this (user, tier) already have a ceremony in a LIVE status? Deliberately
// no row lock: this only decides whether it is worth doing the work, and a
// false negative is corrected by the locked re-read + the unique index.
async function hasLiveCeremony(
  db: Database,
  userId: UserId,
  tier: 's1' | 's2' | 's3',
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.releaseCeremonies.id })
    .from(schema.releaseCeremonies)
    .where(
      and(
        eq(schema.releaseCeremonies.userId, userId),
        eq(schema.releaseCeremonies.tier, tier),
        inArray(schema.releaseCeremonies.status, [...LIVE_CEREMONY_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// The tier's enrolled holders + the share_id that backs each affirmation. S1's key
// is a full sealed envelope (s1_tier_key_envelopes, no Shamir share → null); S2/S3
// hold a Shamir contact share (release_shares, share_id set).
async function resolveHolders(
  db: Database,
  userId: UserId,
  tier: 's1' | 's2' | 's3',
): Promise<Array<{ contactId: string; shareId: string | null }>> {
  if (tier === 's1') {
    const rows = await db
      .select({ contactId: schema.s1TierKeyEnvelopes.contactId })
      .from(schema.s1TierKeyEnvelopes)
      .innerJoin(schema.contacts, eq(schema.s1TierKeyEnvelopes.contactId, schema.contacts.id))
      .where(
        and(
          eq(schema.s1TierKeyEnvelopes.userId, userId),
          isNull(schema.s1TierKeyEnvelopes.revokedAt),
          inArray(schema.contacts.status, ['enrolled', 'active']),
        ),
      );
    // A designated S1 beneficiary also holds an envelope (designate_beneficiary
    // created it) but must NOT affirm — exclude them here so they are enrolled as
    // a recipient only (resolveBeneficiaries), never a consensus party.
    const beneficiaries = new Set(
      (await resolveBeneficiaries(db, userId, 's1')).map((b) => b.contactId),
    );
    return rows
      .filter((r) => !beneficiaries.has(r.contactId))
      .map((r) => ({ contactId: r.contactId, shareId: null }));
  }
  const rows = await db
    .select({ shareId: schema.releaseShares.id, contactId: schema.releaseShares.contactId })
    .from(schema.releaseShares)
    .innerJoin(schema.contacts, eq(schema.releaseShares.contactId, schema.contacts.id))
    .where(
      and(
        eq(schema.releaseShares.userId, userId),
        eq(schema.releaseShares.tier, tier),
        inArray(schema.releaseShares.shareType, ['contact', 'second_professional_contact']),
        isNull(schema.releaseShares.revokedAt),
        inArray(schema.contacts.status, ['enrolled', 'active']),
      ),
    );
  return rows.flatMap((r) =>
    r.contactId === null ? [] : [{ contactId: r.contactId, shareId: r.shareId }],
  );
}

// ── Drill readiness (docs/29 Phase 0) ────────────────────────────────────────
//
// Whether an account could actually produce a ceremony, per tier, computed with
// the SAME resolveHolders the creation path enrols from — deliberately, because
// the failure this exists to prevent is precisely a readiness check that has
// drifted from what creation requires.
//
// It exists because two production drills stalled at release_review with no
// ceremony and both read as engine failures. They were setup failures:
//
//   * truecairn-test-admin had ZERO release_shares rows. Its two contacts were
//     `enrolled`, which looks exactly like readiness and is not — enrolled
//     contacts are not recipients, the tier's holder rows are. Zero holders ⇒
//     `continue` above ⇒ nothing to initiate, silently.
//   * truecairn-d5-owner had three s2 rows and DID get a ceremony, which then
//     failed sync_window_expired_below_threshold because no recipient registered
//     inside the window.
//
// Note the counts do not match the row counts an operator sees. Only
// shareType 'contact' / 'second_professional_contact' are holders: an S2 account
// set up the normal way has THREE release_shares rows (indices 1 and 2 contact,
// index 3 release_passphrase) and TWO holders, because the passphrase share is a
// factor the owner supplies, not a party who affirms. And S1 does not use
// release_shares at all — its holders are sealed envelopes.
export interface TierCeremonyReadiness {
  tier: 's1' | 's2' | 's3';
  // Contacts who would be enrolled to affirm. Zero ⇒ this tier cannot open a
  // ceremony, whatever the engine does.
  holders: number;
  // Contacts named to RECEIVE without affirming. Never sufficient alone.
  beneficiaries: number;
}

export async function resolveCeremonyReadiness(
  db: Database,
  userId: UserId,
): Promise<TierCeremonyReadiness[]> {
  const out: TierCeremonyReadiness[] = [];
  for (const tier of TIERS) {
    out.push({
      tier,
      holders: (await resolveHolders(db, userId, tier)).length,
      beneficiaries: (await resolveBeneficiaries(db, userId, tier)).length,
    });
  }
  return out;
}

// A tier's active designated beneficiaries: contacts named to RECEIVE the release
// without holding a share / affirming. Only enrolled/active contacts — an
// unenrolled contact has no verified key to receive with. Works for every tier:
// S2/S3 beneficiaries collect holders' re-sealed shares; an S1 beneficiary holds
// their OWN owner-sealed envelope (designate_beneficiary) and is enrolled here as
// a recipient only (resolveHolders excludes them, so they never affirm).
async function resolveBeneficiaries(
  db: Database,
  userId: UserId,
  tier: 's1' | 's2' | 's3',
): Promise<Array<{ contactId: string }>> {
  const rows = await db
    .select({ contactId: schema.releaseBeneficiaries.contactId })
    .from(schema.releaseBeneficiaries)
    .innerJoin(schema.contacts, eq(schema.releaseBeneficiaries.contactId, schema.contacts.id))
    .where(
      and(
        eq(schema.releaseBeneficiaries.userId, userId),
        eq(schema.releaseBeneficiaries.tier, tier),
        isNull(schema.releaseBeneficiaries.revokedAt),
        inArray(schema.contacts.status, ['enrolled', 'active']),
      ),
    );
  return rows.map((r) => ({ contactId: r.contactId }));
}

// The abandon path — Bridge 1's other half. Drives every live ceremony for the
// user to cancelled and clears currentCeremonyId. A ceremony already 'released' is
// terminal (not live) and is left alone — the engine can't un-release. Runs inside
// the caller's transaction (cancel-release / dispute), so it commits atomically
// with the engine returning to active. Returns the count cancelled.
export async function cancelCeremoniesForUser(
  db: Database,
  audit: AuditLogPort,
  userId: UserId,
  reason: string,
  now: Date,
): Promise<number> {
  const live = await db
    .select({ id: schema.releaseCeremonies.id })
    .from(schema.releaseCeremonies)
    .where(
      and(
        eq(schema.releaseCeremonies.userId, userId),
        inArray(schema.releaseCeremonies.status, [...LIVE_CEREMONY_STATUSES]),
      ),
    );
  for (const c of live) {
    // Append first, then set status AND the terminal audit link in one update —
    // the shape packages/sensitive-actions/src/scheduler.ts already uses. A
    // cancelled ceremony is exactly the row someone re-reads during a dispute,
    // so it is the last place to make them correlate by timestamp.
    const cancelled = await audit.append(db, userId, 'ceremony.cancelled', {
      ceremonyId: c.id,
      reason,
    });
    await db
      .update(schema.releaseCeremonies)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancellationReason: reason,
        auditIdTerminal: cancelled.id,
        updatedAt: now,
      })
      .where(eq(schema.releaseCeremonies.id, c.id));
  }
  await db
    .update(schema.engineStates)
    .set({ currentCeremonyId: null, updatedAt: now })
    .where(eq(schema.engineStates.userId, userId));
  return live.length;
}
