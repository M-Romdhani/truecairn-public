// docs/29 Phase 0: the drill precondition, and the reason it needs a test.
//
// Two production drills stalled at `release_review` with no ceremony and both
// read as engine failures. Neither was. The engine ladder walked correctly and
// emitted every audit event; what was missing was the rows the ceremony bridge
// derives recipients FROM. `truecairn-test-admin` had two `enrolled` contacts
// and zero `release_shares` — enrolment looks exactly like readiness and is not.
//
// resolveCeremonyReadiness answers "could this account open a ceremony?" and is
// what `ceremony-drill.ts` refuses on. The whole value of that refusal is that
// it agrees with creation, so what is pinned here is the AGREEMENT: readiness
// counts holders exactly when createReleaseReviewCeremonies would enrol them.
// A readiness check that has drifted from the create path is worse than none —
// it would green-light the same wasted drill it exists to prevent.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import {
  createReleaseReviewCeremonies,
  resolveCeremonyReadiness,
  type BridgeContext,
} from './bridges.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const WINDOWS = { syncWindowMs: 14 * DAY, revocationWindowMs: 1 * DAY };

describeIfDb('ceremony readiness — the docs/29 Phase 0 precondition', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;
  const now = new Date('2026-05-01T00:00:00Z');

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

  async function seedOwnerInRelease(): Promise<UserId> {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `ready-${Date.now()}-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id as UserId;
    await db.insert(schema.engineStates).values({
      userId,
      state: 'release_review',
      stateEnteredAt: new Date(now.getTime() - DAY),
    });
    return userId;
  }

  // An ENROLLED contact and nothing else — the state that fooled the drill.
  async function enrolContact(userId: UserId): Promise<string> {
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: userId,
        role: 'personal',
        status: 'enrolled',
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array(24),
      })
      .returning({ id: schema.contacts.id });
    return contact!.id;
  }

  const readiness = async (userId: UserId, tier: 's1' | 's2' | 's3') =>
    (await resolveCeremonyReadiness(db, userId)).find((t) => t.tier === tier)!;

  const created = async (userId: UserId): Promise<number> => {
    await createReleaseReviewCeremonies({ db, audit, now, windows: WINDOWS } as BridgeContext, 10);
    const rows = await db
      .select({ status: schema.releaseCeremonies.status })
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, userId));
    return rows.filter((r) => r.status !== 'cancelled' && r.status !== 'failed').length;
  };

  it('reports zero holders for enrolled-but-unassigned contacts — the stall', async () => {
    const userId = await seedOwnerInRelease();
    await enrolContact(userId);
    await enrolContact(userId);

    // Two contacts, both enrolled, and not one recipient anywhere.
    for (const tier of ['s1', 's2', 's3'] as const) {
      expect((await readiness(userId, tier)).holders).toBe(0);
    }
    // And the create path agrees, silently — which is the finding.
    expect(await created(userId)).toBe(0);
  });

  it('counts an S1 envelope as the holder it is', async () => {
    const userId = await seedOwnerInRelease();
    const contactId = await enrolContact(userId);
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId,
      contactId,
      sealedBoxCiphertext: new Uint8Array([0xaa, 0xbb]),
    });

    expect((await readiness(userId, 's1')).holders).toBe(1);
    expect((await readiness(userId, 's2')).holders).toBe(0);
    expect(await created(userId)).toBe(1);
  });

  it('counts S2 HOLDERS, not release_shares rows — three rows, two holders', async () => {
    // The distinction the pre-flight query in docs/29 Phase 0 3b turns on. A
    // correctly set-up S2 has three rows; the passphrase share is a factor the
    // owner supplies at reconstruction, not a party who affirms, so counting
    // rows would report readiness one higher than the ceremony will enrol.
    const userId = await seedOwnerInRelease();
    const a = await enrolContact(userId);
    const b = await enrolContact(userId);

    await db.insert(schema.releaseShares).values([
      { userId, tier: 's2', shareIndex: 1, shareType: 'contact', contactId: a, wrappedShareCiphertext: new Uint8Array([1]) },
      { userId, tier: 's2', shareIndex: 2, shareType: 'contact', contactId: b, wrappedShareCiphertext: new Uint8Array([2]) },
      // Structurally different, and the table says so: release_shares_check
      // requires a passphrase share to carry a SALT and no ciphertext and no
      // contact. It is a factor, not a party — which is the whole point here.
      { userId, tier: 's2', shareIndex: 3, shareType: 'release_passphrase', contactId: null, passphraseSalt: new Uint8Array(16) },
    ]);

    const rows = await db
      .select({ id: schema.releaseShares.id })
      .from(schema.releaseShares)
      .where(eq(schema.releaseShares.userId, userId));
    expect(rows).toHaveLength(3);
    expect((await readiness(userId, 's2')).holders).toBe(2);
  });

  it('does not count a revoked share as a holder', async () => {
    const userId = await seedOwnerInRelease();
    const a = await enrolContact(userId);
    await db.insert(schema.releaseShares).values({
      userId,
      tier: 's3',
      shareIndex: 1,
      shareType: 'contact',
      contactId: a,
      wrappedShareCiphertext: new Uint8Array([1]),
      revokedAt: now,
    });
    expect((await readiness(userId, 's3')).holders).toBe(0);
    expect(await created(userId)).toBe(0);
  });
});
