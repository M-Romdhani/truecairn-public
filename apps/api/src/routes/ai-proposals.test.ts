import { createHash } from 'node:crypto';
import { verifyChain } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('AI proposals decision surface', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  afterEach(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai_proposals, audit_log, audit_log_locks, notification_channels, release_shares, outer_layer_keys, vault_items, contacts, engine_states, sessions, users CASCADE`;
  });

  function boot(proposer: boolean): void {
    const config = loadConfig({
      TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
      AI_PROPOSER_ENABLED: proposer ? 'true' : 'false',
    });
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
  }

  // An S3 role-diversity user → generation yields a flag_readiness_gap proposal.
  async function seed(email: string): Promise<{ userId: UserId; cookie: { [k: string]: string } }> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    await db.insert(schema.engineStates).values({ userId, state: 'active', inactivityThresholdDays: 30 });
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
    // A verified channel, so S3 role diversity is this fixture's ONLY blocker —
    // the engine is armed, so without one no_verified_channel also fires and
    // `proposals.find(...)` would be picking one of two rather than the one.
    // `destination_hash` is CHECK-bound to sha256('<type>:<destination>') by
    // migration 0063.
    const destination = `${email}.channel`;
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination,
      destinationHash: createHash('sha256').update(`email:${destination}`).digest(),
      verified: true,
    });
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: { [SESSION_COOKIE]: token } };
  }

  const list = (cookies: { [k: string]: string }) =>
    app.inject({ method: 'GET', url: '/v1/ai/proposals', cookies });

  it('requires a session', async () => {
    boot(true);
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/v1/ai/proposals' })).statusCode).toBe(401);
  });

  it('flag off → disabled, no proposals', async () => {
    boot(false);
    await app.ready();
    const { cookie } = await seed('p-off@example.com');
    const res = await list(cookie);
    expect(res.json().reason).toBe('disabled');
    expect(res.json().proposals).toEqual([]);
  });

  it('lists a generated flag_readiness_gap proposal (idempotent across calls)', async () => {
    boot(true);
    await app.ready();
    const { cookie } = await seed('p-list@example.com');
    const first = await list(cookie);
    const proposals = first.json().proposals as { kind: string; payload: { gap: string } }[];
    const flag = proposals.find((p) => p.kind === 'flag_readiness_gap');
    expect(flag?.payload.gap).toBe('s3_role_diversity_unsatisfiable');
    // Second call does not duplicate.
    const second = await list(cookie);
    expect((second.json().proposals as unknown[]).length).toBe(proposals.length);
  });

  it('approve marks approved + audits (actor=owner), chain valid', async () => {
    boot(true);
    await app.ready();
    const { userId, cookie } = await seed('p-approve@example.com');
    const proposals = (await list(cookie)).json().proposals as { id: string }[];
    const id = proposals[0]!.id;
    const res = await app.inject({ method: 'POST', url: `/v1/ai/proposals/${id}/decision`, cookies: cookie, payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('approved');

    const [row] = await db.select({ status: schema.aiProposals.status }).from(schema.aiProposals).where(eq(schema.aiProposals.id, id));
    expect(row!.status).toBe('approved');
    const [ev] = await db
      .select({ actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_proposal_decided')));
    expect(ev!.actor).toBe('owner');
    expect((await verifyChain(db, userId)).ok).toBe(true);
  });

  it('reject marks rejected and drops it from the inbox', async () => {
    boot(true);
    await app.ready();
    const { cookie } = await seed('p-reject@example.com');
    const id = ((await list(cookie)).json().proposals as { id: string }[])[0]!.id;
    await app.inject({ method: 'POST', url: `/v1/ai/proposals/${id}/decision`, cookies: cookie, payload: { decision: 'reject' } });
    // A generation on the next list won't resurrect it (dedup is only against
    // 'proposed'; a rejected one is gone from the inbox but the gap may re-propose).
    const after = (await list(cookie)).json().proposals as { id: string }[];
    expect(after.find((p) => p.id === id)).toBeUndefined();
  });

  it('deciding an already-decided proposal is 409', async () => {
    boot(true);
    await app.ready();
    const { cookie } = await seed('p-dup@example.com');
    const id = ((await list(cookie)).json().proposals as { id: string }[])[0]!.id;
    await app.inject({ method: 'POST', url: `/v1/ai/proposals/${id}/decision`, cookies: cookie, payload: { decision: 'approve' } });
    const again = await app.inject({ method: 'POST', url: `/v1/ai/proposals/${id}/decision`, cookies: cookie, payload: { decision: 'reject' } });
    expect(again.statusCode).toBe(409);
  });

  it('user A cannot see or decide user B proposals (404)', async () => {
    boot(true);
    await app.ready();
    const a = await seed('p-a@example.com');
    const b = await seed('p-b@example.com');
    const bId = ((await list(b.cookie)).json().proposals as { id: string }[])[0]!.id;
    // A decides B's proposal → 404 (no cross-user disclosure).
    const res = await app.inject({ method: 'POST', url: `/v1/ai/proposals/${bId}/decision`, cookies: a.cookie, payload: { decision: 'approve' } });
    expect(res.statusCode).toBe(404);
    // And A's inbox never contains B's proposal.
    const aInbox = (await list(a.cookie)).json().proposals as { id: string }[];
    expect(aInbox.find((p) => p.id === bId)).toBeUndefined();
  });
});
