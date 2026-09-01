// The drill proof (docs/29, Task 1 of the 2026-08-10 fixes).
//
// Every other ceremony integration test in this package starts by INSERTing the
// engine state it needs — `state: 'full_release'` — which is the same shortcut
// the psql drills took, and it leaves the ladder untested. Four real drills have
// been run and none reached a `released` ceremony; the statuses were 4×
// cancelled, 2× failed, 1× initiated. This test closes that gap.
//
// It drives ONE account from `active` to a ceremony with status `released`
// without ever writing `engine_states.state`. The only thing it moves is the
// clock, through the same computeDrillShift/applyDrillShift the operator CLI
// uses, so every ladder transition is computed by packages/engine's
// transitions.ts running inside the real tickBatch, and every audit event the
// ladder emits is emitted, in order, into a chain that then verifies.
//
// The assertion at the end is the point: the audit chain contains the FULL
// transition sequence, not a ceremony hanging off a state that appeared from
// nowhere.
//
// Deliberately S1. S1 is the tier whose release stage is `limited_release`, so
// it exercises the whole chain — ladder → consensus → engine signal → outer key
// → reconstruction — with one contact instead of a Shamir quorum. The S3 crypto
// is already proven byte-for-byte in processor.integration.test.ts; what was
// missing was never the cryptography.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import {
  DbChannelLookup,
  applyDrillShift,
  applyEvent,
  computeDrillShift,
  isDrillAdvanceable,
  loadRow,
  tickBatch,
  type EngineStateRow,
} from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import { createReleaseReviewCeremonies } from './bridges.js';
import {
  processCeremony,
  recordRecipientReconstruction,
  tickCeremonies,
  type ProcessorContext,
} from './processor.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

// Guard against a helper that stops making progress rather than looping forever
// on a red run — the failure this bounds (lockStall, or a deadline on a column
// the drill clock does not slide) is real and should read as a failure, not a
// hang.
const MAX_LADDER_STEPS = 12;

describeIfDb('drill: the real ladder, clock-driven, to a released ceremony', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      ceremony_affirmation_shares, ceremony_recipients, ceremony_affirmations,
      release_ceremonies, release_shares, s1_tier_key_envelopes, contacts,
      notification_deliveries, notification_channels,
      engine_state_history, engine_states, audit_log_locks, audit_log, users
      CASCADE`;
  });

  it('walks active → check_in_pending → escalation_pending → release_review → released, all audited', async () => {
    const now = new Date();
    const channels = new DbChannelLookup(db);

    // ── fixture ────────────────────────────────────────────────────────────
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'drill@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id as UserId;

    // One healthy verified channel. Without it the ladder correctly diverts to
    // notification_stalled (zero channels IS total unreachability) — which the
    // drill clock also advances, but the sequence under test here is the
    // reachable-owner one.
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination: 'drill@example.com',
      destinationHash: channelDestinationHash('email', 'drill@example.com'),
      verified: true,
      health: 'healthy',
    });

    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: userId,
        role: 'personal',
        status: 'active',
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array(24),
      })
      .returning({ id: schema.contacts.id });
    const contactId = contact!.id;

    // The S1 holder: an owner-sealed envelope. The bridge enrols from these.
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId,
      contactId,
      // Opaque to the server by construction; the ceremony never opens it.
      sealedBoxCiphertext: new Uint8Array(48).fill(0x51),
    });

    await db.insert(schema.engineStates).values({ userId, state: 'pre_active', stateEnteredAt: now });

    const engineCtx = (at: Date) => ({ db, audit, channels, now: at });

    // ── arm: pre_active → active, through the real event path ──────────────
    const armed = await loadRow(db, userId);
    expect(armed).not.toBeNull();
    await applyEvent(armed!, { kind: 'engine_armed' }, engineCtx(now));
    expect((await loadRow(db, userId))!.state).toBe('active');

    // ── the ladder, clock only ─────────────────────────────────────────────
    // Nothing below writes `state`. Each pass slides the timestamps the current
    // state's deadline is computed from, then lets tickBatch — the worker's own
    // entry point — claim the row and let transitions.ts decide what happens.
    const ladder: string[] = ['active'];
    for (let step = 0; step < MAX_LADDER_STEPS; step++) {
      const row = (await loadRow(db, userId))!;
      if (row.state === 'release_review') break;
      expect(isDrillAdvanceable(row), `${row.state} has no time-driven exit`).toBe(true);

      const at = new Date();
      const shift = computeDrillShift(row, at)!;
      await db
        .update(schema.engineStates)
        .set(applyDrillShift(row, shift))
        .where(eq(schema.engineStates.userId, userId));

      const processed = await tickBatch(engineCtx(at), 10);
      expect(processed, `worker claimed nothing while in ${row.state}`).toBe(1);

      const after = (await loadRow(db, userId))!;
      expect(after.state, `${row.state} did not advance`).not.toBe(row.state);
      ladder.push(after.state);
    }

    // The sequence a real death walks — computed, not asserted into existence.
    expect(ladder).toEqual(['active', 'check_in_pending', 'escalation_pending', 'release_review']);

    // release_review is where the clock stops mattering: the state has no
    // time-driven exit and the drill CANNOT advance past it. Everything from
    // here is consensus.
    const atReview = (await loadRow(db, userId))!;
    expect(isDrillAdvanceable(atReview)).toBe(false);
    expect(computeDrillShift(atReview, new Date())).toBeNull();

    // ── the ceremony ───────────────────────────────────────────────────────
    const later = new Date(Date.now() + 1000);
    const bridgeCtx = {
      db,
      audit,
      now: later,
      windows: { syncWindowMs: 48 * 3600_000, revocationWindowMs: 0 },
    };
    expect(await createReleaseReviewCeremonies(bridgeCtx, 10)).toBe(1);

    const [ceremony] = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, userId));
    expect(ceremony!.tier).toBe('s1');
    const ceremonyId = ceremony!.id;

    // The worker's consensus→engine callback, wired exactly as loop.ts wires it:
    // the engine event rides the ceremony transition's own transaction.
    const signalEngine: NonNullable<ProcessorContext['signalEngine']> = async (
      txdb,
      uid,
      sig,
      when,
    ) => {
      const row = await loadRow(txdb, uid);
      if (row === null) return;
      const event =
        sig === 'release_review_verification_passed'
          ? ({ kind: 'release_review_verification_passed' } as const)
          : sig === 'release_review_verification_failed'
            ? ({ kind: 'release_review_verification_failed' } as const)
            : ({ kind: 'dispute_raised' } as const);
      await applyEvent(row, event, { db: txdb, audit, channels, now: when });
    };
    const procCtx = (at: Date): ProcessorContext => ({ db, audit, now: at, signalEngine });

    expect(await processCeremony(procCtx(later), ceremonyId)).toBe('collecting_affirmations');

    // The contact affirms — the bridge already enrolled them as a `pending`
    // holder, so affirming is the UPDATE the API route performs, not a new row.
    // The revocation window has already elapsed (the drill's compressed window),
    // so the next tick commits it.
    const past = new Date(later.getTime() - 1000);
    await db
      .update(schema.ceremonyAffirmations)
      .set({ status: 'tentative', affirmedAt: past, revocationWindowExpiresAt: past })
      .where(eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId));
    // The recipient registers their device to receive the release.
    await db
      .update(schema.ceremonyRecipients)
      .set({
        ephemeralPubkey: new Uint8Array(32).fill(7),
        registeredAt: later,
        status: 'reconstructing',
      })
      .where(eq(schema.ceremonyRecipients.ceremonyId, ceremonyId));

    // Consensus reached → the ceremony signals the ENGINE, which is what moves
    // release_review → limited_release. No clock involved, and no test writing
    // that state by hand: transitions.ts computes it from the contact's
    // affirmation, which is the entire point of the state having no timer.
    const tick = await tickCeremonies(procCtx(later), 10);
    expect(tick.affirmationsCommitted).toBe(1);
    expect((await loadRow(db, userId))!.state).toBe('limited_release');

    // With the engine at the S1 release stage the cooldown gate opens and the
    // temporal gate is released. tickCeremonies may already have carried the
    // ceremony through awaiting_outer_key in the pass above — it processes every
    // live ceremony and the engine was moved inside that same pass — so drive to
    // a fixed point rather than asserting a step count that depends on how many
    // transitions one tick happens to chain.
    let status = await processCeremony(procCtx(later), ceremonyId);
    for (let i = 0; i < 4 && status !== 'reconstructing'; i++) {
      status = await processCeremony(procCtx(later), ceremonyId);
    }
    expect(status).toBe('reconstructing');

    // The temporal gate — the server's one cryptographic power — actually opened.
    const [gated] = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.id, ceremonyId));
    expect(gated!.outerKeyReleasedAt).not.toBeNull();

    // ── the recipient reconstructs → released ──────────────────────────────
    expect(await recordRecipientReconstruction(procCtx(later), ceremonyId, contactId)).toBe(
      'released',
    );
    const [final] = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.id, ceremonyId));
    expect(final!.status).toBe('released');
    expect(final!.releasedAt).not.toBeNull();

    // ── the deliverable: the audit chain accounts for all of it ────────────
    const events = (
      await db
        .select({ eventType: schema.auditLog.eventType })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.userId, userId))
        .orderBy(schema.auditLog.seq)
    ).map((e) => e.eventType);
    // DRILL_TRANSCRIPT=1 prints the chain. docs/29 cites this as the
    // reproducible transcript, so it is worth being able to re-produce on demand
    // rather than pasting a run from one afternoon into a document.
    if (process.env['DRILL_TRANSCRIPT'] === '1') {
      for (const [i, e] of events.entries()) {
        process.stdout.write(`  ${String(i + 1).padStart(2)}  ${e}\n`);
      }
    }

    // Every ladder transition is present and in order. This is what a forced
    // UPDATE could never produce, and what a disputed release would be
    // adjudicated on.
    expect(events).toEqual(
      expect.arrayContaining([
        'engine.armed',
        'engine.entered_check_in_pending',
        'engine.entered_escalation_pending',
        'engine.entered_release_review',
        'ceremony.affirmation_committed',
        'engine.release_review_passed',
      ]),
    );
    const ladderOrder = [
      'engine.armed',
      'engine.entered_check_in_pending',
      'engine.entered_escalation_pending',
      'engine.entered_release_review',
      'engine.release_review_passed',
    ].map((e) => events.indexOf(e));
    expect(ladderOrder).toEqual([...ladderOrder].sort((a, b) => a - b));
    expect(Math.min(...ladderOrder)).toBeGreaterThanOrEqual(0);

    // And it verifies — a chain that both verifies AND records a history that
    // actually happened, which is the pair a forced state breaks.
    expect((await verifyChain(db, userId as never)).ok).toBe(true);

    // ── the JOIN from a row to its chain entry ─────────────────────────────
    //
    // The events above prove the evidence exists. These prove you can get to it
    // from the row without matching timestamps by hand. A production drill on
    // 2026-08-10 walked this exact ladder and left every engine_state_history
    // row's related_audit_id NULL and both release_ceremonies audit columns
    // NULL — declared with FKs since the tables shipped, written by nothing.
    expect(final!.auditIdInitiated, 'ceremony has no link to the entry that opened it').not.toBeNull();
    expect(final!.auditIdTerminal, 'a RELEASED ceremony has no terminal audit link').not.toBeNull();

    const initiated = await db
      .select({ eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, final!.auditIdInitiated!));
    expect(initiated[0]?.eventType).toBe('ceremony.initiated');

    // Every engine hop, not just the first — a link that only some transitions
    // set is worse than none, because a NULL then reads as "no audit entry for
    // this hop" rather than "this path forgot to write it".
    const history = await db
      .select()
      .from(schema.engineStateHistory)
      .where(eq(schema.engineStateHistory.userId, userId));
    expect(history.length).toBeGreaterThan(2);
    for (const h of history) {
      expect(
        h.relatedAuditId,
        `${String(h.fromState)} → ${h.toState} (${h.reason}) landed with no audit link`,
      ).not.toBeNull();
    }

    // And the affirmation — the row recording a named person's assertion that
    // the owner is gone.
    const affirmations = await db
      .select()
      .from(schema.ceremonyAffirmations)
      .where(eq(schema.ceremonyAffirmations.ceremonyId, ceremonyId));
    const committed = affirmations.filter((a) => a.status === 'committed');
    expect(committed.length).toBeGreaterThan(0);
    for (const a of committed) {
      expect(a.auditIdAffirmed, 'a committed affirmation has no audit link').not.toBeNull();
    }
  });

  it('the drill clock cannot walk past release_review — consensus is not a timer', async () => {
    // The negative half of the invariant above, stated on its own so a change
    // that gave release_review a time-driven exit fails here loudly. A drill
    // that could clock past consensus would be rehearsing a release no contact
    // authorised.
    const now = new Date();
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'noskip@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id as UserId;
    await db.insert(schema.engineStates).values({
      userId,
      state: 'release_review',
      stateEnteredAt: new Date(now.getTime() - 365 * 86_400_000),
      nextActionAt: new Date(now.getTime() - 365 * 86_400_000),
    });

    const row = (await loadRow(db, userId))! as EngineStateRow;
    expect(computeDrillShift(row, now)).toBeNull();

    // Even a year past every conceivable deadline, with next_action_at due so
    // the worker genuinely claims the row, the ladder does not move.
    await tickBatch({ db, audit, channels: new DbChannelLookup(db), now }, 10);
    expect((await loadRow(db, userId))!.state).toBe('release_review');
  });
});
