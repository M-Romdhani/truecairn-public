import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepExpiredProposals } from './ai-proposals-sweep.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('sweepExpiredProposals', () => {
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
    await sql`TRUNCATE ai_proposals, audit_log, audit_log_locks, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    return u!.id as UserId;
  }

  async function proposal(userId: UserId, expiresAt: Date): Promise<string> {
    const [p] = await db
      .insert(schema.aiProposals)
      .values({ userId, kind: 'flag_readiness_gap', payload: { gap: 'stale_items', severity: 'warning' }, status: 'proposed', source: 'assist', expiresAt })
      .returning({ id: schema.aiProposals.id });
    return p!.id;
  }

  it('expires only proposals past expires_at, audits, keeps the chain valid', async () => {
    const userId = await makeUser('sweep@example.com');
    const now = new Date('2026-07-04T00:00:00Z');
    const pastId = await proposal(userId, new Date('2026-06-01T00:00:00Z'));
    const futureId = await proposal(userId, new Date('2026-08-01T00:00:00Z'));

    const res = await sweepExpiredProposals({ db, audit, now }, 50);
    expect(res.expired).toBe(1);

    const [past] = await db.select({ status: schema.aiProposals.status }).from(schema.aiProposals).where(eq(schema.aiProposals.id, pastId));
    const [future] = await db.select({ status: schema.aiProposals.status }).from(schema.aiProposals).where(eq(schema.aiProposals.id, futureId));
    expect(past!.status).toBe('expired');
    expect(future!.status).toBe('proposed');

    const audits = await db
      .select({ eventType: schema.auditLog.eventType })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_proposal_decided')));
    expect(audits).toHaveLength(1);
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('is a no-op when nothing is due', async () => {
    const userId = await makeUser('sweep-noop@example.com');
    await proposal(userId, new Date('2027-01-01T00:00:00Z'));
    expect((await sweepExpiredProposals({ db, audit, now: new Date('2026-07-04T00:00:00Z') }, 50)).expired).toBe(0);
  });

  it('two concurrent sweeps expire each due row exactly once (SKIP LOCKED)', async () => {
    const userId = await makeUser('sweep-concurrent@example.com');
    const now = new Date('2026-07-04T00:00:00Z');
    const past = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < 6; i++) await proposal(userId, past);

    // Run two sweeps concurrently; between them they expire all 6 once — never
    // double-expiring a row (which would double-audit + corrupt the chain).
    const [a, b] = await Promise.all([
      sweepExpiredProposals({ db, audit, now }, 50),
      sweepExpiredProposals({ db, audit, now }, 50),
    ]);
    expect(a.expired + b.expired).toBe(6);

    const expired = await db.select({ id: schema.aiProposals.id }).from(schema.aiProposals).where(eq(schema.aiProposals.status, 'expired'));
    expect(expired).toHaveLength(6);
    const audits = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_proposal_decided')));
    expect(audits).toHaveLength(6); // exactly one audit per row, no duplicates
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });
});
