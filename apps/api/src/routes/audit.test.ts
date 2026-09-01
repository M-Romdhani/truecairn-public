import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, canonicalBytes, resolveServerSigner, type CanonicalEntry } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { SessionId, UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('audit routes — the owner can read AND verify their own chain', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let audit: AuditLogWriter;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

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
    await sql`TRUNCATE engine_states, engine_state_history, sensitive_actions, notification_deliveries, notification_channels, auth_attempts, sessions, audit_log_locks, audit_log, contacts, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function owner(
    email: string,
    entries = 3,
  ): Promise<{ userId: UserId; cookie: string; sessionId: SessionId }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    for (let i = 0; i < entries; i++) {
      await audit.append(db, userId, 'test.event', { i });
    }
    const { id, token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token, sessionId: id };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });

  it('returns the chain with everything needed to verify it off-server', async () => {
    const { cookie } = await owner('a@example.com');
    const res = await app.inject({ method: 'GET', url: '/v1/account/audit', cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(3);

    const first = body.entries[0];
    // The canonical inputs must all be present — a missing field would make
    // independent verification impossible and silently reduce this to "trust us".
    for (const field of [
      'seq',
      'userId',
      'eventType',
      'eventPayload',
      'serverTimestamp',
      'serverKeyId',
      'entryHash',
      'serverSignature',
    ]) {
      expect(first[field], `missing canonical field ${field}`).not.toBeUndefined();
    }
    expect(first.prevEntryHash).toBeNull(); // genesis
    expect(Object.keys(body.serverKeys)).toContain(first.serverKeyId);
  });

  // THE test that gives the feature its meaning. If a client cannot rebuild the
  // signed bytes from what we return and land on the same hash, the "verify it
  // yourself" promise is empty. This recomputes the chain exactly as the browser
  // panel does — from the RESPONSE ONLY, never from the database.
  it('the returned page re-verifies independently (hash chain recomputes)', async () => {
    const { cookie } = await owner('b@example.com', 5);
    const res = await app.inject({ method: 'GET', url: '/v1/account/audit', cookies: as(cookie) });
    const body = res.json();

    let expectedPrev: string | null = null;
    for (const e of body.entries) {
      const canonical: CanonicalEntry = {
        seq: BigInt(e.seq),
        userId: e.userId,
        eventType: e.eventType,
        eventPayload: e.eventPayload,
        prevEntryHash: e.prevEntryHash === null ? null : new Uint8Array(Buffer.from(e.prevEntryHash, 'base64')),
        serverTimestamp: new Date(e.serverTimestamp),
        serverKeyId: e.serverKeyId,
        clientTimestamp: e.clientTimestamp === null ? null : new Date(e.clientTimestamp),
      };
      const recomputed = createHash('sha256').update(canonicalBytes(canonical)).digest('base64');
      expect(recomputed, `entry ${e.seq} hash mismatch`).toBe(e.entryHash);
      // And the link actually links.
      expect(e.prevEntryHash, `entry ${e.seq} prev-hash break`).toBe(expectedPrev);
      expectedPrev = recomputed;
    }
  });

  it('verify reports ok and labels its own assurance honestly', async () => {
    const { cookie } = await owner('c@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account/audit/verify',
      cookies: as(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, entriesChecked: 3, assurance: 'server_asserted' });
  });

  it('audit_log is append-only at the DATABASE layer (first line of defence)', async () => {
    const { userId } = await owner('d0@example.com');
    // migration 0007 installs audit_log_no_update / audit_log_no_delete. The
    // hash chain is the SECOND line of defence; this is the first, and it means
    // ordinary application bugs and stray UPDATEs cannot rewrite history at all.
    let rejected: unknown = null;
    try {
      await db
        .update(schema.auditLog)
        .set({ eventPayload: { i: 999 } })
        .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.seq, 2n)));
    } catch (err) {
      rejected = err;
    }
    // drizzle wraps the driver error, so the trigger's message is on the cause.
    expect(rejected, 'the UPDATE was allowed through').not.toBeNull();
    const cause = (rejected as { cause?: { message?: string } }).cause;
    expect(`${cause?.message ?? ''}`).toMatch(/append-only/);

    // And the row genuinely did not move.
    const [row] = await db
      .select({ payload: schema.auditLog.eventPayload })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.seq, 2n)));
    expect(row!.payload).toEqual({ i: 1 });
  });

  it('verify DETECTS tampering by someone who CAN bypass the trigger', async () => {
    const { userId, cookie } = await owner('d@example.com');
    // The threat the hash chain actually exists for: an actor with database-level
    // access (a compromised operator, a restored-and-edited backup) who can drop
    // the append-only trigger. Simulate exactly that, then confirm the chain
    // still gives them away — this is the property the whole design pays for.
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`;
    try {
      await db
        .update(schema.auditLog)
        .set({ eventPayload: { i: 999 } })
        .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.seq, 2n)));
    } finally {
      await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`;
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/account/audit/verify',
      cookies: as(cookie),
    });
    expect(res.json()).toMatchObject({ ok: false, failureSeq: 2, reason: 'entry_hash_mismatch' });
  });

  it('is strictly owner-scoped — one user never sees another user chain', async () => {
    const a = await owner('e1@example.com', 2);
    await owner('e2@example.com', 4);
    const res = await app.inject({ method: 'GET', url: '/v1/account/audit', cookies: as(a.cookie) });
    const body = res.json();
    expect(body.entries).toHaveLength(2);
    for (const e of body.entries) expect(e.userId).toBe(a.userId);
  });

  it('paginates with a bounded page size and a usable cursor', async () => {
    const { cookie } = await owner('f@example.com', 7);
    const p1 = await app.inject({
      method: 'GET',
      url: '/v1/account/audit?limit=3',
      cookies: as(cookie),
    });
    const b1 = p1.json();
    expect(b1.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(b1.nextFromSeq).toBe(4);

    const p2 = await app.inject({
      method: 'GET',
      url: `/v1/account/audit?limit=3&fromSeq=${b1.nextFromSeq}`,
      cookies: as(cookie),
    });
    expect(p2.json().entries.map((e: { seq: number }) => e.seq)).toEqual([4, 5, 6]);

    // Over-large pages are refused by schema rather than silently clamped.
    const tooBig = await app.inject({
      method: 'GET',
      url: '/v1/account/audit?limit=99999',
      cookies: as(cookie),
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/account/audit' });
    expect(res.statusCode).toBe(401);
    const v = await app.inject({ method: 'GET', url: '/v1/account/audit/verify' });
    expect(v.statusCode).toBe(401);
  });

  it('surfaces the actor so AI-caused entries are visible to the owner', async () => {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `actor-${randomBytes(3).toString('hex')}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    await audit.append(db, userId, 'test.owner_event', {});
    await audit.append(db, userId, 'ai_review_signal_emitted', {}, { actor: 'ai' });
    const { token } = await createSession(db, { userId, now: new Date() });

    const res = await app.inject({ method: 'GET', url: '/v1/account/audit', cookies: as(token) });
    expect(res.json().entries.map((e: { actor: string }) => e.actor)).toEqual(['owner', 'ai']);
  });
});
