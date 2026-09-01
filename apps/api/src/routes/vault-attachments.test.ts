import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ed25519Sign, generateEd25519Keypair, initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { attachmentFilePath } from '@truecairn/vault';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildStepUpSigningInput } from '../auth/stepup.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
import { buildApp } from '../app.js';
import { loadConfig, type ApiConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const N24 = (fill: number): string => Buffer.from(new Uint8Array(24).fill(fill)).toString('base64');
const b64 = (arr: number[]): string => Buffer.from(new Uint8Array(arr)).toString('base64');
const OCTET = { 'content-type': 'application/octet-stream' };

describeIfDb('vault attachments (streaming, end-to-end)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let dir: string;
  let config: ApiConfig;

  beforeAll(async () => {
    await initCrypto();
    dir = await mkdtemp(join(tmpdir(), 'tc-attach-route-'));
    config = loadConfig({
      TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
      OUTER_LAYER_KEK: Buffer.alloc(32, 5).toString('base64'),
      ATTACHMENTS_DIR: dir,
      VAULT_MAX_USER_TOTAL_BYTES: '10', // tiny cap so the 413 path is easy to hit
      VAULT_MAX_ATTACHMENT_BYTES: '10000',
    });
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await sql`TRUNCATE attachments, vault_items, outer_layer_keys, sensitive_actions, auth_challenges, totp_credentials, user_key_material, engine_states, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeOwner(
    email: string,
  ): Promise<{ userId: UserId; cookie: string; signingSecret: Uint8Array }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const kek = config.totpKeks.byId.get(config.totpKeks.currentId)!;
    const enc = encryptTotpSecret(kek.key, TOTP_SECRET);
    await db.insert(schema.totpCredentials).values({
      userId,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: kek.id,
      confirmedAt: new Date(),
    });
    const kp = generateEd25519Keypair();
    const ph = new Uint8Array(16);
    await db.insert(schema.userKeyMaterial).values({
      userId,
      masterPassphraseSalt: ph,
      masterKeyWrappedByPassphrase: ph,
      masterKeyPassphraseNonce: ph,
      recoveryCodeSalt: ph,
      masterKeyWrappedByRecovery: ph,
      masterKeyRecoveryNonce: ph,
      releasePassphraseSalt: ph,
      auditSigningPubkey: kp.publicKey,
    });
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token, signingSecret: kp.secretKey };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });

  async function makeItem(cookie: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/items',
      cookies: as(cookie),
      payload: {
        id: randomUUID(),
        tier: 's2',
        category: 'crypto_wallets',
        contentCiphertext: b64([1, 2, 3, 4]),
        contentNonce: N24(7),
        wrappedPerItemKey: b64([5, 6, 7]),
        wrappedPerItemKeyNonce: N24(8),
        titleCiphertext: b64([9]),
        titleNonce: b64([3]),
        contentSizeBytes: 4,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }
  async function createAttachment(cookie: string, itemId: string, sizeBytes: number): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vault/items/${itemId}/attachments`,
      cookies: as(cookie),
      payload: { sizeBytes },
    });
    expect(res.statusCode).toBe(201);
    return res.json().attachmentId;
  }

  it('uploads bytes, increments the budget, and streams them back identically', async () => {
    const { userId, cookie } = await makeOwner('up@example.com');
    const itemId = await makeItem(cookie);
    const blob = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]); // 8 bytes, under the 10-byte cap
    const attachmentId = await createAttachment(cookie, itemId, blob.length);

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
      headers: OCTET,
      payload: blob,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().status).toBe('stored');

    // Budget incremented; metadata reflects stored.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(8);
    const meta = await app.inject({ method: 'GET', url: `/v1/vault/items/${itemId}/attachments/${attachmentId}`, cookies: as(cookie) });
    expect(meta.json().status).toBe('stored');

    // Download streams the exact bytes.
    const get = await app.inject({
      method: 'GET',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
    });
    expect(get.statusCode).toBe(200);
    expect(Buffer.from(get.rawPayload)).toEqual(blob);

    // The item detail now LISTS its attachments (QA 2026-07-17 issue #2 — the
    // field existed but was hardcoded empty): id + ciphertext size + status,
    // never a filename (that lives inside the encrypted blob).
    const item = await app.inject({ method: 'GET', url: `/v1/vault/items/${itemId}`, cookies: as(cookie) });
    const listed = item.json().attachments as Array<{ id: string; sizeBytes: number; status: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(attachmentId);
    expect(listed[0]!.sizeBytes).toBe(8);
    expect(listed[0]!.status).toBe('stored');
  });

  it('two concurrent uploads: one wins, the loser 409s, and the budget is charged ONCE', async () => {
    // 2026-08-07 security audit, finding 2. Both PUTs used to pass the
    // read-outside-a-transaction status check, both reserve `cl`, and both open a
    // write stream on the SAME key — charging 2N for N permanently (the purge
    // path releases the size once) and interleaving two bodies into one file.
    // Each stream's own bytesWritten equalled cl, so the integrity check passed
    // for both and neither rolled back: silent corruption of opaque ciphertext,
    // undetectable until a beneficiary opens it.
    const { userId, cookie } = await makeOwner('race@example.com');
    const itemId = await makeItem(cookie);
    const blob = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const attachmentId = await createAttachment(cookie, itemId, blob.length);

    const put = (): Promise<{ statusCode: number }> =>
      app.inject({
        method: 'PUT',
        url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
        cookies: as(cookie),
        headers: OCTET,
        payload: blob,
      });
    const [a, b] = await Promise.all([put(), put()]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // The whole point: 8 bytes stored, 8 bytes charged. Not 16.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(blob.length);

    // And the stored blob is byte-exact rather than two interleaved copies.
    const get = await app.inject({
      method: 'GET',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
    });
    expect(get.statusCode).toBe(200);
    expect(Buffer.from(get.rawPayload)).toEqual(blob);
  });

  // 2026-08-08 re-audit, N-2. The claim above was guarded by STATUS, and
  // 'uploading' is written by the original claim AND by a takeover — so the
  // terminal write could not tell the two apart. These two tests steal the claim
  // mid-stream (the only way it can be lost) and assert the losing request cannot
  // touch the winner's row, on either exit path.
  //
  // The takeover itself is now unreachable in production, because the stale
  // window is derived as 2x the request-arrival timeout — a request that could
  // still be streaming cannot have a stale claim. These tests bypass that by
  // rewriting upload_claim directly, which is the point: the guard has to hold
  // without depending on the timing argument.
  async function claimStolenMidStream(
    itemId: string,
    attachmentId: string,
    cookie: string,
    body: Buffer,
    declaredLength: number,
  ): Promise<{ statusCode: number; thief: string }> {
    const stream = new PassThrough();
    const put = app.inject({
      method: 'PUT',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
      headers: { ...OCTET, 'content-length': String(declaredLength) },
      payload: stream,
    });
    // Wait for the handler to take the slot, then take it away from it.
    for (let i = 0; i < 200; i++) {
      const [row] = await db
        .select({ claim: schema.attachments.uploadClaim })
        .from(schema.attachments)
        .where(eq(schema.attachments.id, attachmentId));
      if (row?.claim != null) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const thief = randomUUID();
    await db
      .update(schema.attachments)
      .set({ uploadClaim: thief })
      .where(eq(schema.attachments.id, attachmentId));
    stream.end(body);
    const res = await put;
    return { statusCode: res.statusCode, thief };
  }

  it('a stolen claim cannot be marked stored by the request that lost it', async () => {
    // The decisive one. Before the token, this request wrote status='stored'
    // while the new holder was still streaming into the same blob key — our bytes
    // published under their reservation.
    const { userId, cookie } = await makeOwner('steal-store@example.com');
    const itemId = await makeItem(cookie);
    const blob = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const attachmentId = await createAttachment(cookie, itemId, blob.length);

    const { statusCode, thief } = await claimStolenMidStream(
      itemId,
      attachmentId,
      cookie,
      blob,
      blob.length,
    );
    expect(statusCode).toBe(409);

    const [row] = await db
      .select({ status: schema.attachments.status, claim: schema.attachments.uploadClaim })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId));
    expect(row!.status).toBe('uploading'); // still the holder's slot, NOT 'stored'
    expect(row!.claim).toBe(thief);
    // Our reservation went back — a lost claim must not leave a permanent charge.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(0);
  });

  it('a stolen claim cannot be rolled back by the request that lost it', async () => {
    // The other exit. rollbackUpload deleted the blob and reset the status with no
    // ownership check, so a loser that then errored destroyed the HOLDER's upload
    // — one failed upload turning into a second corrupted one.
    const { userId, cookie } = await makeOwner('steal-rollback@example.com');
    const itemId = await makeItem(cookie);
    const blob = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const attachmentId = await createAttachment(cookie, itemId, blob.length);

    // Declare 8 bytes, send 4: the byte-count check fails and rollbackUpload runs.
    const { statusCode, thief } = await claimStolenMidStream(
      itemId,
      attachmentId,
      cookie,
      blob.subarray(0, 4),
      blob.length,
    );
    expect(statusCode).toBe(400);

    const [row] = await db
      .select({ status: schema.attachments.status, claim: schema.attachments.uploadClaim })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId));
    expect(row!.status).toBe('uploading'); // NOT reset to 'failed' under them
    expect(row!.claim).toBe(thief);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(0);
  });

  it('a failed upload can still be retried — the claim is released, not stuck', async () => {
    // The claim introduces a new way to strand a row, so prove the rollback path
    // hands the slot back. A byte-count mismatch rolls back to 'failed', which
    // must remain claimable.
    const { cookie } = await makeOwner('retry@example.com');
    const itemId = await makeItem(cookie);
    const blob = Buffer.from([1, 2, 3, 4]);
    const attachmentId = await createAttachment(cookie, itemId, blob.length);

    const short = await app.inject({
      method: 'PUT',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
      headers: { ...OCTET, 'content-length': String(blob.length + 1) },
      payload: Buffer.concat([blob, Buffer.from([9])]),
    });
    expect(short.statusCode).toBeGreaterThanOrEqual(400);

    const retry = await app.inject({
      method: 'PUT',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
      headers: OCTET,
      payload: blob,
    });
    expect(retry.statusCode).toBe(200);
  });

  it('rejects an over-budget upload with 413 before any bytes touch disk', async () => {
    const { userId, cookie } = await makeOwner('budget@example.com');
    const itemId = await makeItem(cookie);
    const big = Buffer.alloc(20, 9); // 20 bytes > the 10-byte per-user cap
    const attachmentId = await createAttachment(cookie, itemId, big.length);

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
      headers: OCTET,
      payload: big,
    });
    expect(put.statusCode).toBe(413);
    expect(put.json().type).toBe('https://truecairn.app/problems/vault-storage-quota-exceeded');
    // Nothing was written and nothing was reserved.
    await expect(access(attachmentFilePath(dir, userId, attachmentId))).rejects.toThrow();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(0);
  });

  it('refuses an upload while the engine is in a release state (409)', async () => {
    const { userId, cookie } = await makeOwner('locked@example.com');
    const itemId = await makeItem(cookie);
    await db.insert(schema.engineStates).values({ userId, state: 'release_review' });
    // The create-metadata step is itself an upload start — write-gated.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/vault/items/${itemId}/attachments`,
      cookies: as(cookie),
      payload: { sizeBytes: 4 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-locked-during-release');
  });

  it('purge enqueues a delayed action (step-up gated) and flags the attachment pending', async () => {
    const { userId, cookie, signingSecret } = await makeOwner('purge@example.com');
    const itemId = await makeItem(cookie);
    const blob = Buffer.from([1, 2, 3, 4]);
    const attachmentId = await createAttachment(cookie, itemId, blob.length);
    await app.inject({
      method: 'PUT',
      url: `/v1/vault/items/${itemId}/attachments/${attachmentId}/bytes`,
      cookies: as(cookie),
      headers: OCTET,
      payload: blob,
    });

    const body = { attachmentId };
    // R1 → 403, second factor, R2 with signature.
    const r1 = await app.inject({ method: 'POST', url: '/v1/vault/items/attachments/purge', cookies: as(cookie), payload: body });
    expect(r1.statusCode).toBe(403);
    const challenge = new Uint8Array(Buffer.from(r1.json().stepUp.challenge as string, 'base64url'));
    await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: as(cookie),
      payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
    });
    const sig = ed25519Sign(buildStepUpSigningInput(userId, 'purge_attachment', challenge, body), signingSecret);
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/vault/items/attachments/purge',
      cookies: as(cookie),
      headers: {
        'x-truecairn-stepup-challenge': r1.json().stepUp.challengeId as string,
        'x-truecairn-stepup-signature': Buffer.from(sig).toString('base64url'),
      },
      payload: body,
    });
    expect(r2.statusCode).toBe(202);

    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId));
    expect(att!.pendingDeleteAt).not.toBeNull();
    expect(att!.status).toBe('stored'); // still on disk during the cooldown
    const [action] = await db.select().from(schema.sensitiveActions);
    expect(action!.actionType).toBe('purge_attachment');
    expect(action!.requestedBySessionId).not.toBeNull();
  });

  it('refuses to enqueue a purge while the engine is in a release state (409)', async () => {
    const { userId, cookie } = await makeOwner('purgelock@example.com');
    const itemId = await makeItem(cookie);
    const attachmentId = await createAttachment(cookie, itemId, 4);
    await db.insert(schema.engineStates).values({ userId, state: 'staged_release' });
    // writableGate runs before requireStepUp — a cheap 409, no step-up challenge.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/items/attachments/purge',
      cookies: as(cookie),
      payload: { attachmentId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-locked-during-release');
  });
});
