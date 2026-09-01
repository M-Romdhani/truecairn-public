// Integration test: real Postgres, real audit chain, Bridge 1's create-once
// path under a release that gets cancelled while the bridge is mid-flight.
//
// The race this pins (CLAUDE.md backlog item 0, found 2026-08-09):
// createReleaseReviewCeremonies reads WHICH users are in a release state
// outside its insert transaction, then does slow work — holder resolution, the
// continuity report — and used to insert without re-checking. A cancel
// committing in that gap did not merely fail to stop the insert, it ENABLED
// it: the create-once guard is a partial unique index over LIVE ceremony
// statuses, so cancelling the incumbent frees the slot. The end state was
// engine_states.state = 'active' pointing at a live collecting_affirmations
// ceremony that contacts could still affirm — the fail-closed invariant
// (CLAUDE.md #2) reading backwards.
//
// The gap is driven through a REAL seam rather than a test-mode branch
// (CLAUDE.md #3): ContinuityReportPort.build is called by the bridge in
// precisely the window between the `due` snapshot and the insert transaction,
// so a port that cancels the release from inside build() reproduces the
// interleaving deterministically, with no timing assumptions.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import {
  CONTINUITY_REPORT_SCHEMA_VERSION,
  type ContinuityReportPayload,
  type UserId,
} from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import {
  cancelCeremoniesForUser,
  createReleaseReviewCeremonies,
  type BridgeContext,
  type ContinuityReportPort,
} from './bridges.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const WINDOWS = { syncWindowMs: 14 * DAY, revocationWindowMs: 1 * DAY };

describeIfDb('release-ceremony bridge (integration)', () => {
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
      continuity_reports, ceremony_affirmation_shares, ceremony_recipients,
      ceremony_affirmations, release_ceremonies, release_shares,
      s1_tier_key_envelopes, contacts,
      notification_deliveries, notification_channels,
      engine_state_history, engine_states, audit_log_locks, audit_log, users
      CASCADE`;
  });

  // One owner in release_review with a single S1 envelope holder — the smallest
  // fixture that makes Bridge 1 want to create a ceremony.
  async function seedOwnerInRelease(now: Date): Promise<UserId> {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `owner-${Date.now()}-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id as UserId;

    await db.insert(schema.engineStates).values({
      userId,
      state: 'release_review',
      stateEnteredAt: new Date(now.getTime() - 1 * DAY),
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

    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId,
      contactId: contact!.id,
      sealedBoxCiphertext: new Uint8Array([0xaa, 0xbb]),
    });

    return userId;
  }

  // The bridge reads only schemaVersion off the payload (the stored bytes are
  // payloadJson, the anchor is payloadHash), so the rest is not constructed.
  function reportPort(onBuild: () => Promise<void>): ContinuityReportPort {
    return {
      async build() {
        await onBuild();
        return {
          payload: { schemaVersion: CONTINUITY_REPORT_SCHEMA_VERSION } as ContinuityReportPayload,
          payloadJson: '{"schemaVersion":1}',
          payloadHash: 'a'.repeat(64),
        };
      },
    };
  }

  async function liveCeremonyCount(userId: UserId): Promise<number> {
    const rows = await db
      .select({ id: schema.releaseCeremonies.id, status: schema.releaseCeremonies.status })
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, userId));
    return rows.filter((r) => r.status !== 'cancelled' && r.status !== 'failed').length;
  }

  it('creates the S1 ceremony when the release is still live at insert time', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const userId = await seedOwnerInRelease(now);

    const ctx: BridgeContext = {
      db,
      audit,
      now,
      windows: WINDOWS,
      // Port present but inert: proves the re-read does not block the happy path.
      continuityReport: reportPort(async () => {}),
    };
    const created = await createReleaseReviewCeremonies(ctx, 10);

    expect(created).toBe(1);
    expect(await liveCeremonyCount(userId)).toBe(1);
  });

  it('does NOT resurrect a release cancelled while the bridge was mid-flight', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const userId = await seedOwnerInRelease(now);

    // The cancel lands in the gap: after the bridge snapshotted `due`, before it
    // opens the insert transaction. This is exactly what a worker tick racing an
    // owner's cancel_release does in production.
    const ctx: BridgeContext = {
      db,
      audit,
      now,
      windows: WINDOWS,
      continuityReport: reportPort(async () => {
        await db.transaction(async (txRaw) => {
          const tx = txRaw as unknown as Database;
          await cancelCeremoniesForUser(tx, audit, userId, 'owner_cancelled', now);
          await tx
            .update(schema.engineStates)
            .set({ state: 'active', stateEnteredAt: now, updatedAt: now })
            .where(eq(schema.engineStates.userId, userId));
        });
      }),
    };

    const created = await createReleaseReviewCeremonies(ctx, 10);

    // Nothing opened, for any tier.
    expect(created).toBe(0);
    expect(await liveCeremonyCount(userId)).toBe(0);

    // And the engine is coherent: active, with no ceremony pointer left behind.
    // The pre-fix failure showed 'active' + a live currentCeremonyId, which is
    // the state contacts could still affirm against.
    const [engine] = await db
      .select({
        state: schema.engineStates.state,
        currentCeremonyId: schema.engineStates.currentCeremonyId,
      })
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, userId));
    expect(engine!.state).toBe('active');
    expect(engine!.currentCeremonyId).toBeNull();
  });
});
