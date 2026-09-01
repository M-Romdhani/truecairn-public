import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAuditVerifySweep } from './audit-verify-sweep.js';
import { recordHeartbeat } from './heartbeat.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('runAuditVerifySweep — somebody actually checks the chain', () => {
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
    await sql`TRUNCATE worker_heartbeats, audit_log, audit_log_locks, users CASCADE`;
  });

  async function userWithChain(email: string, entries = 3): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    for (let i = 0; i < entries; i++) await audit.append(db, userId, 'test.event', { i });
    return userId;
  }

  // Rewrite history the way only someone with database-level access could — the
  // append-only triggers (migration 0007) block this for everyone else, which is
  // precisely why the hash chain is the second line of defence.
  async function tamper(userId: UserId, seq: bigint): Promise<void> {
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`;
    try {
      await db
        .update(schema.auditLog)
        .set({ eventPayload: { tampered: true } })
        .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.seq, seq)));
    } finally {
      await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`;
    }
  }

  it('reports clean chains as clean', async () => {
    await userWithChain('clean1@example.com');
    await userWithChain('clean2@example.com');
    const broken: unknown[] = [];
    const res = await runAuditVerifySweep({ db, onBroken: (i) => broken.push(i) }, 50, null);
    expect(res.checked).toBe(2);
    expect(res.broken).toBe(0);
    expect(broken).toEqual([]);
  });

  it('DETECTS a tampered chain and names the user and the break point', async () => {
    const victim = await userWithChain('victim@example.com', 4);
    await userWithChain('bystander@example.com', 2);
    await tamper(victim, 3n);

    const broken: Array<{ userId: UserId; failureSeq: number; reason: string }> = [];
    const res = await runAuditVerifySweep({ db, onBroken: (i) => broken.push(i) }, 50, null);

    expect(res.broken).toBe(1);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ userId: victim, failureSeq: 3, reason: 'entry_hash_mismatch' });
  });

  it('does NOT append to the audit log — a broken chain must not be extended', async () => {
    const victim = await userWithChain('nowrite@example.com', 3);
    await tamper(victim, 2n);
    const before = await db
      .select({ seq: schema.auditLog.seq })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, victim));

    await runAuditVerifySweep({ db, onBroken: () => {} }, 50, null);

    const after = await db
      .select({ seq: schema.auditLog.seq })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, victim));
    // Appending to a chain that is already broken would compound the damage and
    // bury the evidence under a fresh, valid-looking tail. The alert is the log.
    expect(after.length).toBe(before.length);
  });

  it('rotates through users across passes and wraps around', async () => {
    for (let i = 0; i < 5; i++) await userWithChain(`rot${i}@example.com`, 1);

    const p1 = await runAuditVerifySweep({ db, onBroken: () => {} }, 2, null);
    expect(p1.checked).toBe(2);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await runAuditVerifySweep({ db, onBroken: () => {} }, 2, p1.nextCursor);
    expect(p2.checked).toBe(2);

    const p3 = await runAuditVerifySweep({ db, onBroken: () => {} }, 2, p2.nextCursor);
    expect(p3.checked).toBe(1);
    // Short page ⇒ end of the rotation; the next pass starts over.
    expect(p3.nextCursor).toBeNull();
  });
});

describeIfDb('recordHeartbeat — the worker proves it is alive in the database', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE worker_heartbeats CASCADE`;
  });

  it('upserts one row per worker and advances the tick', async () => {
    const t1 = new Date('2026-07-25T10:00:00Z');
    const t2 = new Date('2026-07-25T10:00:10Z');
    await recordHeartbeat({ db, workerId: 'w1', now: t1, tickMs: 12, errors: 0, version: 'test' });
    await recordHeartbeat({ db, workerId: 'w1', now: t2, tickMs: 34, errors: 0, version: 'test' });

    const rows = await db.select().from(schema.workerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastTickAt.toISOString()).toBe(t2.toISOString());
    expect(rows[0]!.lastTickMs).toBe(34);
  });

  it('accumulates errors across ticks and resets on a clean one', async () => {
    const now = new Date();
    await recordHeartbeat({ db, workerId: 'w1', now, tickMs: 1, errors: 2, version: 'test' });
    await recordHeartbeat({ db, workerId: 'w1', now, tickMs: 1, errors: 3, version: 'test' });
    let [row] = await db.select().from(schema.workerHeartbeats);
    // Alive-but-broken must be distinguishable from a single bad batch.
    expect(row!.consecutiveErrors).toBe(5);

    await recordHeartbeat({ db, workerId: 'w1', now, tickMs: 1, errors: 0, version: 'test' });
    [row] = await db.select().from(schema.workerHeartbeats);
    expect(row!.consecutiveErrors).toBe(0);
  });

  it('tracks horizontally-scaled workers separately', async () => {
    const now = new Date();
    await recordHeartbeat({ db, workerId: 'w1', now, tickMs: 1, errors: 0, version: 'test' });
    await recordHeartbeat({ db, workerId: 'w2', now, tickMs: 1, errors: 0, version: 'test' });
    expect(await db.select().from(schema.workerHeartbeats)).toHaveLength(2);
  });
});
