import { createHash } from 'node:crypto';
import { AiAuthority } from '@truecairn/ai-authority';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateProposals, validateProposalPayload } from './proposals.js';

// ── Pure payload-validation tests (no DB) ─────────────────────────────────────
describe('validateProposalPayload (deny-by-default)', () => {
  it('accepts a well-formed flag_readiness_gap', () => {
    const out = validateProposalPayload('flag_readiness_gap', {
      gap: 's3_role_diversity_unsatisfiable',
      severity: 'blocker',
      tier: 's3',
    });
    expect(out.ok).toBe(true);
  });

  it('rejects an unknown gap code / smuggled field / wrong type / unknown kind', () => {
    expect(validateProposalPayload('flag_readiness_gap', { gap: 'release_everything', severity: 'blocker' }).ok).toBe(false);
    expect(
      validateProposalPayload('flag_readiness_gap', { gap: 'stale_items', severity: 'warning', execute: 'x' }).ok,
    ).toBe(false);
    expect(validateProposalPayload('tighten_checkin_schedule', { currentDays: 'lots', proposedDays: 30 }).ok).toBe(false);
    expect(validateProposalPayload('not_a_kind', {}).ok).toBe(false);
  });

  it('bounds tighten_checkin_schedule ints', () => {
    expect(validateProposalPayload('tighten_checkin_schedule', { currentDays: 90, proposedDays: 30 }).ok).toBe(true);
    expect(validateProposalPayload('tighten_checkin_schedule', { currentDays: 90, proposedDays: 99999 }).ok).toBe(false);
  });
});

// ── DB generation tests ───────────────────────────────────────────────────────
const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('generateProposals', () => {
  let db: Database;
  let sql: Sql;
  let authority: AiAuthority;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    authority = new AiAuthority({ audit: new AuditLogWriter(await resolveServerSigner(db)) });
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai_proposals, audit_log, audit_log_locks, notification_channels, release_shares, outer_layer_keys, vault_items, contacts, engine_states, users CASCADE`;
  });

  async function s3DiversityUser(email: string, thresholdDays = 30): Promise<UserId> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    await db.insert(schema.engineStates).values({ userId, state: 'active', inactivityThresholdDays: thresholdDays });
    const [k] = await db
      .insert(schema.outerLayerKeys)
      .values({ userId, tier: 's3', kekId: 'k', outerKeyEncrypted: Buffer.alloc(32, 9), outerKeyNonce: Buffer.alloc(24, 9), outerKeyEncryptionAad: Buffer.alloc(8, 9), generation: 1 })
      .returning({ id: schema.outerLayerKeys.id });
    await db.insert(schema.vaultItems).values({
      userId, tier: 's3', category: 'personal_archive', outerLayerKeyId: k!.id, outerKekId: 'k', outerGeneration: 1,
      outerCiphertext: Buffer.alloc(8, 1), outerNonce: Buffer.alloc(24, 2), titleCiphertext: Buffer.alloc(8, 3), titleNonce: Buffer.alloc(24, 4), contentSizeBytes: 8,
    });
    for (let idx = 1; idx <= 3; idx++) {
      const [c] = await db
        .insert(schema.contacts)
        .values({ ownerUserId: userId, role: 'personal', status: 'enrolled', displayLabelCiphertext: Buffer.alloc(8, 5), displayLabelNonce: Buffer.alloc(24, 6) })
        .returning({ id: schema.contacts.id });
      await db.insert(schema.releaseShares).values({ userId, tier: 's3', shareIndex: idx, shareType: 'contact', contactId: c!.id, wrappedShareCiphertext: Buffer.alloc(16, 7) });
    }
    // A verified channel, so this fixture's ONLY readiness blocker is the S3 role
    // diversity it is named for. The engine is armed here, so without one the
    // no_verified_channel blocker also fires and these tests would be asserting
    // against two proposals while claiming to describe one.
    // `destination_hash` is CHECK-bound to sha256('<type>:<destination>')
    // (migration 0063), so it cannot be filled with arbitrary bytes.
    const destination = `${email}.channel`;
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination,
      destinationHash: createHash('sha256').update(`email:${destination}`).digest(),
      verified: true,
    });
    return userId;
  }

  // QA 2026-08-11 §4: a proposal outlived the gap that justified it. The owner
  // fixed three gaps and all three were still in the inbox with a live Accept
  // button, while the checkups list beside them pruned correctly.
  it('supersedes an open proposal once the owner fixes its gap', async () => {
    const userId = await s3DiversityUser('resolve@example.com');
    await generateProposals(db, authority, userId, new Date());

    const before = await db
      .select({ id: schema.aiProposals.id, status: schema.aiProposals.status })
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.userId, userId), eq(schema.aiProposals.kind, 'flag_readiness_gap')));
    expect(before).toHaveLength(1);
    expect(before[0]!.status).toBe('proposed');

    // Fix the gap the way an owner would: give one share-holder a different role,
    // so the tier can satisfy release diversity.
    const contacts = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.ownerUserId, userId));
    await db
      .update(schema.contacts)
      .set({ role: 'professional' })
      .where(eq(schema.contacts.id, contacts[0]!.id));

    await generateProposals(db, authority, userId, new Date());

    const after = await db
      .select({ status: schema.aiProposals.status })
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.userId, userId), eq(schema.aiProposals.kind, 'flag_readiness_gap')));
    expect(after).toHaveLength(1);
    // 'superseded', never 'expired' — the owner resolved this, they did not ignore
    // it, and the two are different facts on a chain that is meant to be evidence.
    expect(after[0]!.status).toBe('superseded');

    // The audit rode the same transaction, and the chain still verifies.
    const events = await db
      .select({ t: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_proposal_decided')));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('leaves a still-open gap alone, and does not touch a decided proposal', async () => {
    const userId = await s3DiversityUser('keep@example.com');
    await generateProposals(db, authority, userId, new Date());

    // A second pass with the gap UNCHANGED must not retire anything — the
    // supersede sweep runs on every generate, so an over-eager predicate would
    // empty the inbox on the next dashboard load.
    await generateProposals(db, authority, userId, new Date());
    const rows = await db
      .select({ status: schema.aiProposals.status })
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.userId, userId), eq(schema.aiProposals.kind, 'flag_readiness_gap')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('proposed');
  });

  it('creates a flag_readiness_gap proposal for the S3 diversity blocker + audits it', async () => {
    const userId = await s3DiversityUser('gen@example.com');
    const created = await generateProposals(db, authority, userId, new Date());
    expect(created).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.userId, userId), eq(schema.aiProposals.kind, 'flag_readiness_gap')));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { gap: string }).gap).toBe('s3_role_diversity_unsatisfiable');
    expect(rows[0]!.status).toBe('proposed');
    // No raw prompt stored — hash only.
    expect(rows[0]!.promptHash).toBeNull();
    expect(rows[0]!.outputHash).toBeTruthy();

    const audit = await db
      .select({ actor: schema.auditLog.actor, eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_proposal_created')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('ai');
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('is idempotent — a second run creates no duplicates', async () => {
    const userId = await s3DiversityUser('idem@example.com');
    await generateProposals(db, authority, userId, new Date());
    const secondRun = await generateProposals(db, authority, userId, new Date());
    expect(secondRun).toBe(0);
    const rows = await db.select().from(schema.aiProposals).where(eq(schema.aiProposals.userId, userId));
    // Exactly the first-run set — no dupes.
    const flags = rows.filter((r) => r.kind === 'flag_readiness_gap');
    expect(flags).toHaveLength(1);
  });

  it('proposes tighten_checkin_schedule only when the interval is loose, shortening only', async () => {
    const loose = await s3DiversityUser('loose@example.com', 90);
    await generateProposals(db, authority, loose, new Date());
    const [t] = await db
      .select()
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.userId, loose), eq(schema.aiProposals.kind, 'tighten_checkin_schedule')));
    expect(t).toBeDefined();
    const payload = t!.payload as { currentDays: number; proposedDays: number };
    expect(payload.currentDays).toBe(90);
    expect(payload.proposedDays).toBeLessThan(payload.currentDays); // shorten only

    const tight = await s3DiversityUser('tight@example.com', 30);
    await generateProposals(db, authority, tight, new Date());
    const tightRows = await db
      .select()
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.userId, tight), eq(schema.aiProposals.kind, 'tighten_checkin_schedule')));
    expect(tightRows).toHaveLength(0); // 30 days is not loose
  });
});
