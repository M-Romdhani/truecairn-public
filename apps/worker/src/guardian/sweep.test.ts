import { AiAuthority } from '@truecairn/ai-authority';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import { DbChannelLookup } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EngineReviewPort } from '../engine-review-port.js';
import { DEFAULT_GUARDIAN_CONFIG } from './config.js';
import { runGuardianSweep, type GuardianSweepConfig } from './sweep.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const NOW = new Date('2026-07-04T12:00:00Z');
const ON: GuardianSweepConfig = { aiEnabled: true, guardianEnabled: true, thresholds: DEFAULT_GUARDIAN_CONFIG };

describeIfDb('runGuardianSweep', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;
  let authority: AiAuthority;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
    authority = new AiAuthority({ audit, engine: new EngineReviewPort(audit, new DbChannelLookup(db)) });
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE ceremony_affirmations, release_ceremonies, notification_deliveries, notification_channels, auth_attempts, contacts, engine_state_history, engine_states, audit_log, audit_log_locks, users CASCADE`;
  });

  async function makeReleaseUser(
    email: string,
    state: 'release_review' | 'escalation_pending' | 'active' = 'release_review',
  ): Promise<UserId> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    await db.insert(schema.engineStates).values({ userId, state });
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination: email,
      destinationHash: channelDestinationHash('email', email),
      verified: true,
    });
    return userId;
  }

  // A ceremony with contacts whose affirmations committed at the given times.
  async function seedAffirmations(userId: UserId, commitTimesMs: number[]): Promise<void> {
    const [cer] = await db
      .insert(schema.releaseCeremonies)
      .values({ userId, tier: 's2', status: 'collecting_affirmations', syncWindowExpiresAt: new Date(NOW.getTime() + 86_400_000) })
      .returning({ id: schema.releaseCeremonies.id });
    for (const t of commitTimesMs) {
      const [c] = await db
        .insert(schema.contacts)
        .values({ ownerUserId: userId, role: 'personal', status: 'enrolled', displayLabelCiphertext: new Uint8Array(8), displayLabelNonce: new Uint8Array(24) })
        .returning({ id: schema.contacts.id });
      await db.insert(schema.ceremonyAffirmations).values({
        ceremonyId: cer!.id,
        contactId: c!.id,
        status: 'committed',
        committedAt: new Date(t),
      });
    }
  }

  async function seedFailedAuth(email: string, timesMs: number[]): Promise<void> {
    for (const t of timesMs) {
      await db.insert(schema.authAttempts).values({
        scope: 'login',
        identifier: email.toLowerCase(),
        succeeded: false,
        attemptedAt: new Date(t),
      });
    }
  }

  const sweep = (config: GuardianSweepConfig = ON) =>
    runGuardianSweep({ db, authority, config, now: NOW }, 50);

  async function stateOf(userId: UserId): Promise<string | null> {
    const [es] = await db.select({ state: schema.engineStates.state }).from(schema.engineStates).where(eq(schema.engineStates.userId, userId));
    return es?.state ?? null;
  }
  async function reviewSignals(userId: UserId): Promise<number> {
    const rows = await db
      .select({ id: schema.auditLog.id, actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_review_signal_emitted')));
    return rows.length;
  }

  it('affirmation velocity (sev2) → pauses to review_required, audits actor=ai, notifies, chain valid', async () => {
    const userId = await makeReleaseUser('vel@example.com', 'release_review');
    await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - 60_000, NOW.getTime() - 2 * 60_000]); // 3 in 2 min
    expect((await sweep()).signalsEmitted).toBe(1);
    expect(await stateOf(userId)).toBe('review_required'); // release PAUSED
    const [sig] = await db
      .select({ actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_review_signal_emitted')));
    expect(sig!.actor).toBe('ai');
    const notices = await db
      .select({ purpose: schema.notificationDeliveries.purpose })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.userId, userId));
    expect(notices.some((n) => n.purpose === 'security_alert')).toBe(true);
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('near-miss: affirmations spread over 20 min do NOT fire', async () => {
    const userId = await makeReleaseUser('slow@example.com', 'release_review');
    const step = (20 * 60_000) / 2;
    await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - step, NOW.getTime() - 2 * step]);
    expect((await sweep()).signalsEmitted).toBe(0);
    expect(await stateOf(userId)).toBe('release_review'); // untouched
  });

  it('does NOT act when the engine is not in a release-relevant state', async () => {
    const userId = await makeReleaseUser('active@example.com', 'active');
    await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - 60_000, NOW.getTime() - 2 * 60_000]);
    expect((await sweep()).signalsEmitted).toBe(0);
    expect(await stateOf(userId)).toBe('active');
  });

  it('failed_auth spike (sev1) during a release fires', async () => {
    const userId = await makeReleaseUser('auth@example.com', 'escalation_pending');
    const times = Array.from({ length: 5 }, (_, i) => NOW.getTime() - i * 2 * 60_000); // 5 in ~10 min
    await seedFailedAuth('auth@example.com', times);
    expect((await sweep()).signalsEmitted).toBe(1);
    expect(await stateOf(userId)).toBe('review_required');
  });

  describe('hysteresis', () => {
    it('sev1 is suppressed within the cooldown', async () => {
      const userId = await makeReleaseUser('cool1@example.com', 'escalation_pending');
      // A prior review signal 2 days ago (< 7-day cooldown).
      await authority.appendAiAudit(db, userId, 'ai_review_signal_emitted', { detectorId: 'x' });
      const times = Array.from({ length: 5 }, (_, i) => NOW.getTime() - i * 2 * 60_000);
      await seedFailedAuth('cool1@example.com', times);
      expect((await sweep()).signalsEmitted).toBe(0); // cooled down
      expect(await stateOf(userId)).toBe('escalation_pending');
    });

    it('sev2 bypasses the cooldown', async () => {
      const userId = await makeReleaseUser('cool2@example.com', 'release_review');
      await authority.appendAiAudit(db, userId, 'ai_review_signal_emitted', { detectorId: 'x' });
      await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - 60_000, NOW.getTime() - 2 * 60_000]);
      expect((await sweep()).signalsEmitted).toBe(1); // sev2 ignores cooldown
      expect(await stateOf(userId)).toBe('review_required');
    });
  });

  describe('suppression', () => {
    it('guardian flag off → no signal', async () => {
      const userId = await makeReleaseUser('off@example.com', 'release_review');
      await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - 60_000, NOW.getTime() - 2 * 60_000]);
      expect((await sweep({ ...ON, guardianEnabled: false })).signalsEmitted).toBe(0);
      expect(await reviewSignals(userId)).toBe(0);
    });
    it('kill switch off → no signal', async () => {
      const userId = await makeReleaseUser('kill@example.com', 'release_review');
      await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - 60_000, NOW.getTime() - 2 * 60_000]);
      expect((await sweep({ ...ON, aiEnabled: false })).signalsEmitted).toBe(0);
    });
  });

  it('two concurrent sweeps emit exactly one signal (SKIP LOCKED + state moves out)', async () => {
    const userId = await makeReleaseUser('conc@example.com', 'release_review');
    await seedAffirmations(userId, [NOW.getTime(), NOW.getTime() - 60_000, NOW.getTime() - 2 * 60_000]);
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.signalsEmitted + b.signalsEmitted).toBe(1);
    expect(await reviewSignals(userId)).toBe(1); // exactly one, no duplicate
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });
});
