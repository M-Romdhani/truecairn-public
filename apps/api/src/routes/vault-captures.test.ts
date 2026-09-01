import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateEd25519Keypair,
  initCrypto,
  randomBytes,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  x25519KeypairFromSeed,
} from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { deriveVaultCaptureX25519Seed, type UnwrappedMasterKey } from '@truecairn/keys';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { encryptTotpSecret } from '../auth/totp.js';
import { buildApp } from '../app.js';
import { loadConfig, type ApiConfig } from '../config.js';

// Write-only vault capture (docs/34). The properties under test are the ones the
// feature's honesty rests on, not just the happy path:
//
//   - the server stores a key it cannot open, and hands back exactly what it got
//   - a capture is invisible to the release path (D3/D4)
//   - the plan cap and the engine write-gate treat a capture like an item
//   - with the flag off, none of it exists

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const OCTET = { 'content-type': 'application/octet-stream' };
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describeIfDb('vault captures (write-only, docs/34)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let dir: string;
  let config: ApiConfig;

  beforeAll(async () => {
    await initCrypto();
    dir = await mkdtemp(join(tmpdir(), 'tc-capture-route-'));
    config = loadConfig({
      TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
      OUTER_LAYER_KEK: Buffer.alloc(32, 5).toString('base64'),
      ATTACHMENTS_DIR: dir,
      VAULT_CAPTURE_ENABLED: '1',
      VAULT_MAX_CAPTURE_BYTES: '4096',
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
    await sql`TRUNCATE vault_captures, attachments, vault_items, outer_layer_keys, sensitive_actions, auth_challenges, totp_credentials, user_key_material, engine_states, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // A real owner, with a real master-derived capture keypair. The test holds the
  // master key the way a browser would; the "phone" below only ever sees the
  // public half.
  async function makeOwner(email: string): Promise<{
    userId: UserId;
    cookie: string;
    masterKey: UnwrappedMasterKey;
    capture: { publicKey: Uint8Array; secretKey: Uint8Array };
  }> {
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
    const masterKey = randomBytes(32) as UnwrappedMasterKey;
    const capture = x25519KeypairFromSeed(deriveVaultCaptureX25519Seed(masterKey));
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
    return { userId, cookie: token, masterKey, capture };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });

  async function publishKey(cookie: string, publicKey: Uint8Array): Promise<number> {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/account/capture-key',
      cookies: as(cookie),
      payload: { vaultCapturePubkey: b64(publicKey) },
    });
    return res.statusCode;
  }

  // What the phone does: seal a fresh key to the fetched pubkey, encrypt, upload.
  async function sendCapture(
    cookie: string,
    recipientPubkey: Uint8Array,
    payload: Buffer,
    tier = 's2',
  ): Promise<{ id: string; captureKey: Uint8Array }> {
    const captureKey = randomBytes(32);
    const sealed = sealedBoxEncrypt({ recipientPublicKey: recipientPubkey, plaintext: captureKey });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier,
        sealedCaptureKey: b64(sealed),
        payloadNonce: b64(new Uint8Array(24).fill(9)),
        sizeBytes: payload.length,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/vault/captures/${id}/bytes`,
      cookies: as(cookie),
      headers: OCTET,
      payload,
    });
    expect(put.statusCode).toBe(200);
    return { id, captureKey };
  }

  it('round-trips a capture the server cannot open but the owner can', async () => {
    const { cookie, capture } = await makeOwner('rt@example.com');
    expect(await publishKey(cookie, capture.publicKey)).toBe(204);

    // The phone asks for the key it is allowed to have.
    const keyRes = await app.inject({
      method: 'GET',
      url: '/v1/vault/capture-key',
      cookies: as(cookie),
    });
    expect(keyRes.statusCode).toBe(200);
    const fetched = new Uint8Array(Buffer.from(keyRes.json().vaultCapturePubkey, 'base64'));
    expect(Buffer.from(fetched).equals(Buffer.from(capture.publicKey))).toBe(true);
    expect(keyRes.json().maxCaptureBytes).toBe(4096);

    const payload = Buffer.from('sealed container bytes');
    const { id, captureKey } = await sendCapture(cookie, fetched, payload);

    // The queue shows it; the metadata is tier + size + time and nothing else.
    const list = await app.inject({ method: 'GET', url: '/v1/vault/captures', cookies: as(cookie) });
    expect(list.statusCode).toBe(200);
    expect(list.json().captures).toHaveLength(1);
    expect(list.json().captures[0]).toMatchObject({ id, tier: 's2', sizeBytes: payload.length });
    expect(Object.keys(list.json().captures[0]).sort()).toEqual([
      'createdAt',
      'id',
      'sizeBytes',
      'tier',
    ]);

    // The owner opens the sealed key with the master-derived secret half.
    const one = await app.inject({
      method: 'GET',
      url: `/v1/vault/captures/${id}`,
      cookies: as(cookie),
    });
    expect(one.statusCode).toBe(200);
    const opened = sealedBoxDecrypt({
      recipientPublicKey: capture.publicKey,
      recipientSecretKey: capture.secretKey,
      ciphertext: new Uint8Array(Buffer.from(one.json().sealedCaptureKey, 'base64')),
    });
    expect(Buffer.from(opened).equals(Buffer.from(captureKey))).toBe(true);

    // And the bytes come back exactly as sent.
    const bytes = await app.inject({
      method: 'GET',
      url: `/v1/vault/captures/${id}/bytes`,
      cookies: as(cookie),
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.rawPayload.equals(payload)).toBe(true);
  });

  // D3/D4: the release ladder reconstructs TIER keys, never the master key, so a
  // capture sealed to a master-derived key is outside it by construction. This
  // asserts the structural fact the design rests on — nothing a ceremony reads
  // ever contains a capture.
  it('two concurrent uploads: one wins, the loser 409s, and the budget is charged ONCE', async () => {
    // The attachment path's TOCTOU (2026-08-07 audit, finding 2) existed here
    // verbatim, so it is fixed and pinned here too — a partial fix would have
    // left the identical bug live on the sibling route.
    const { userId, cookie, capture } = await makeOwner('caprace@example.com');
    expect(await publishKey(cookie, capture.publicKey)).toBe(204);

    const payload = Buffer.from('sealed container bytes');
    const captureKey = randomBytes(32);
    const sealed = sealedBoxEncrypt({
      recipientPublicKey: capture.publicKey,
      plaintext: captureKey,
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier: 's2',
        sealedCaptureKey: b64(sealed),
        payloadNonce: b64(new Uint8Array(24).fill(9)),
        sizeBytes: payload.length,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    const put = (): Promise<{ statusCode: number }> =>
      app.inject({
        method: 'PUT',
        url: `/v1/vault/captures/${id}/bytes`,
        cookies: as(cookie),
        headers: OCTET,
        payload,
      });
    const [a, b] = await Promise.all([put(), put()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(payload.length);
  });

  it('a stolen claim cannot be marked stored by the request that lost it', async () => {
    // 2026-08-08 re-audit, N-2. The 2026-08-07 fix guarded the terminal write on
    // status='uploading', which a takeover ALSO writes — so a request whose slot
    // had been stolen still matched and published its bytes under the new
    // holder's reservation. Pinned on this route as well as the attachment one:
    // last time the sibling path is where the defect survived.
    const { userId, cookie, capture } = await makeOwner('capsteal@example.com');
    expect(await publishKey(cookie, capture.publicKey)).toBe(204);

    const payload = Buffer.from('sealed container bytes');
    const sealed = sealedBoxEncrypt({
      recipientPublicKey: capture.publicKey,
      plaintext: randomBytes(32),
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier: 's2',
        sealedCaptureKey: b64(sealed),
        payloadNonce: b64(new Uint8Array(24).fill(9)),
        sizeBytes: payload.length,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    const stream = new PassThrough();
    const put = app.inject({
      method: 'PUT',
      url: `/v1/vault/captures/${id}/bytes`,
      cookies: as(cookie),
      headers: { ...OCTET, 'content-length': String(payload.length) },
      payload: stream,
    });
    for (let i = 0; i < 200; i++) {
      const [row] = await db
        .select({ claim: schema.vaultCaptures.uploadClaim })
        .from(schema.vaultCaptures)
        .where(eq(schema.vaultCaptures.id, id));
      if (row?.claim != null) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const thief = randomUUID();
    await db
      .update(schema.vaultCaptures)
      .set({ uploadClaim: thief })
      .where(eq(schema.vaultCaptures.id, id));
    stream.end(payload);

    expect((await put).statusCode).toBe(409);
    const [row] = await db
      .select({ status: schema.vaultCaptures.status, claim: schema.vaultCaptures.uploadClaim })
      .from(schema.vaultCaptures)
      .where(eq(schema.vaultCaptures.id, id));
    expect(row!.status).toBe('uploading'); // still the holder's slot
    expect(row!.claim).toBe(thief);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.storageBytesUsed).toBe(0);
  });

  it('is invisible to the release path: no vault_items row, no outer-layer key', async () => {
    const { userId, cookie, capture } = await makeOwner('rel@example.com');
    await publishKey(cookie, capture.publicKey);
    await sendCapture(cookie, capture.publicKey, Buffer.from('nothing to release here'));

    const items = await db
      .select()
      .from(schema.vaultItems)
      .where(eq(schema.vaultItems.userId, userId));
    expect(items).toHaveLength(0);

    // No outer-layer (temporal gate) key was provisioned either — the server's
    // one cryptographic power over the vault never touches a capture.
    const outer = await db
      .select()
      .from(schema.outerLayerKeys)
      .where(eq(schema.outerLayerKeys.userId, userId));
    expect(outer).toHaveLength(0);
  });

  it('stores no plaintext: only the sealed key, the nonce, and opaque bytes', async () => {
    const { userId, cookie, capture } = await makeOwner('zk@example.com');
    await publishKey(cookie, capture.publicKey);
    const secret = 'PASSPORT-NUMBER-X9912';
    await sendCapture(cookie, capture.publicKey, Buffer.from(`sealed(${secret})-ciphertext`));

    const [row] = await db
      .select()
      .from(schema.vaultCaptures)
      .where(eq(schema.vaultCaptures.userId, userId));
    // The row's columns are transport metadata; nothing here is content.
    expect(Object.keys(row!).sort()).toEqual([
      'createdAt',
      'id',
      'payloadNonce',
      'sealedCaptureKey',
      'sizeBytes',
      'status',
      'storagePath',
      'tier',
      'updatedAt',
      // Identity of the in-flight upload holding the slot (migration 0059) — a
      // server-minted uuid, carrying nothing of the owner's.
      'uploadClaim',
      'userId',
    ]);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('rejects a sealed key or nonce of the wrong length', async () => {
    const { cookie, capture } = await makeOwner('len@example.com');
    await publishKey(cookie, capture.publicKey);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier: 's1',
        sealedCaptureKey: b64(new Uint8Array(40)), // not 80
        payloadNonce: b64(new Uint8Array(24)),
        sizeBytes: 10,
      },
    });
    expect(bad.statusCode).toBe(400);

    const badNonce = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier: 's1',
        sealedCaptureKey: b64(new Uint8Array(80)),
        payloadNonce: b64(new Uint8Array(12)), // not 24
        sizeBytes: 10,
      },
    });
    expect(badNonce.statusCode).toBe(400);
  });

  it('refuses a capture larger than the ceiling, before any bytes are read', async () => {
    const { cookie, capture } = await makeOwner('big@example.com');
    await publishKey(cookie, capture.publicKey);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier: 's1',
        sealedCaptureKey: b64(new Uint8Array(80)),
        payloadNonce: b64(new Uint8Array(24)),
        sizeBytes: 4097,
      },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-capture-too-large');
  });

  it('requires Content-Length to match the declared size', async () => {
    const { cookie, capture } = await makeOwner('cl@example.com');
    await publishKey(cookie, capture.publicKey);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/vault/captures',
      cookies: as(cookie),
      payload: {
        tier: 's1',
        sealedCaptureKey: b64(new Uint8Array(80)),
        payloadNonce: b64(new Uint8Array(24)),
        sizeBytes: 100,
      },
    });
    const id = create.json().id;
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/vault/captures/${id}/bytes`,
      cookies: as(cookie),
      headers: OCTET,
      payload: Buffer.from('only a few bytes'),
    });
    expect(put.statusCode).toBe(400);
  });

  it('tells an account with no published key what to do about it', async () => {
    const { cookie } = await makeOwner('nokey@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/capture-key',
      cookies: as(cookie),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://truecairn.app/problems/vault-capture-key-missing');
    expect(res.json().detail).toContain('unlock the vault on the web');
  });

  it('treats re-publishing the same key as a no-op and a different key as a conflict', async () => {
    const { cookie, capture } = await makeOwner('pub@example.com');
    expect(await publishKey(cookie, capture.publicKey)).toBe(204);
    // A second browser deriving the same key must not be an error.
    expect(await publishKey(cookie, capture.publicKey)).toBe(204);
    // A different key would strand every capture already sealed to the old one.
    expect(await publishKey(cookie, randomBytes(32))).toBe(409);
  });

  it('discards a capture and gives the storage back', async () => {
    const { userId, cookie, capture } = await makeOwner('del@example.com');
    await publishKey(cookie, capture.publicKey);
    const payload = Buffer.from('discard me');
    const { id } = await sendCapture(cookie, capture.publicKey, payload);

    const [before] = await db
      .select({ used: schema.users.storageBytesUsed })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(before!.used).toBe(payload.length);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/vault/captures/${id}`,
      cookies: as(cookie),
    });
    expect(del.statusCode).toBe(204);

    const [after] = await db
      .select({ used: schema.users.storageBytesUsed })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    expect(after!.used).toBe(0);
    const gone = await app.inject({
      method: 'GET',
      url: `/v1/vault/captures/${id}/bytes`,
      cookies: as(cookie),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('never lets one owner reach another owner’s capture', async () => {
    const a = await makeOwner('a@example.com');
    const b = await makeOwner('b@example.com');
    await publishKey(a.cookie, a.capture.publicKey);
    const { id } = await sendCapture(a.cookie, a.capture.publicKey, Buffer.from('mine'));

    for (const [method, path] of [
      ['GET', `/v1/vault/captures/${id}`],
      ['GET', `/v1/vault/captures/${id}/bytes`],
      ['DELETE', `/v1/vault/captures/${id}`],
    ] as const) {
      const res = await app.inject({ method, url: path, cookies: as(b.cookie) });
      expect(res.statusCode).toBe(404);
    }
    const list = await app.inject({
      method: 'GET',
      url: '/v1/vault/captures',
      cookies: as(b.cookie),
    });
    expect(list.json().captures).toHaveLength(0);
  });
});

// Flags-off is byte-for-byte pre-capture. Its own app instance, so the flag is
// genuinely off rather than reset between tests.
describeIfDb('vault captures — VAULT_CAPTURE_ENABLED off (docs/34)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    const config = loadConfig({
      TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
      OUTER_LAYER_KEK: Buffer.alloc(32, 5).toString('base64'),
    });
    expect(config.vaultCaptureEnabled).toBe(false);
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('registers no capture transport at all', async () => {
    for (const [method, path] of [
      ['GET', '/v1/vault/capture-key'],
      ['POST', '/v1/vault/captures'],
      ['GET', '/v1/vault/captures'],
    ] as const) {
      const res = await app.inject({ method, url: path });
      // 404 because the route does not exist — not 401/403 from a live route
      // that happens to refuse. A phone can tell the difference.
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
  });

  it('still lets the owner publish the capture key, so flipping the flag strands nobody', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/account/capture-key' });
    expect(res.statusCode).not.toBe(404);
  });
});
