import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ed25519Sign, generateEd25519Keypair, initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { SessionId, UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildStepUpSigningInput } from '../auth/stepup.js';
import { encryptTotpSecret, totpCode } from '../auth/totp.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const TOTP_SECRET = new Uint8Array(Buffer.from('12345678901234567890', 'ascii'));
const N24 = (fill: number): string => Buffer.from(new Uint8Array(24).fill(fill)).toString('base64');
const b64 = (arr: number[]): string => Buffer.from(new Uint8Array(arr)).toString('base64');

describeIfDb('vault sensitive paths (step-up gated, end-to-end)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({
    TOTP_KEK: Buffer.alloc(32, 4).toString('base64'),
    OUTER_LAYER_KEK: Buffer.alloc(32, 5).toString('base64'),
  });
  const currentKek = config.totpKeks.byId.get(config.totpKeks.currentId)!;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE vault_items, outer_layer_keys, sensitive_actions, auth_challenges, totp_credentials, user_key_material, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  // An owner with confirmed TOTP (the second-factor sub-step) + an enrolled audit
  // signing key (the step-up signature verifies against its public half).
  async function makeOwner(
    email: string,
  ): Promise<{ userId: UserId; cookie: string; sessionId: SessionId; signingSecret: Uint8Array }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const enc = encryptTotpSecret(currentKek.key, TOTP_SECRET);
    await db.insert(schema.totpCredentials).values({
      userId,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: currentKek.id,
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
    const { id, token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token, sessionId: id, signingSecret: kp.secretKey };
  }
  function as(cookie: string): { [k: string]: string } {
    return { [SESSION_COOKIE]: cookie };
  }

  // Drive the R1 → 403 → second-factor → R2-with-signature handshake for a POST.
  async function stepUp(
    actionType: string,
    routeUrl: string,
    body: Record<string, unknown>,
    cookie: string,
    userId: UserId,
    signingSecret: Uint8Array,
  ) {
    const r1 = await app.inject({ method: 'POST', url: routeUrl, cookies: as(cookie), payload: body });
    expect(r1.statusCode).toBe(403);
    const su = r1.json().stepUp;
    const challenge = new Uint8Array(Buffer.from(su.challenge as string, 'base64url'));
    await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/second-factor',
      cookies: as(cookie),
      payload: { method: 'totp', code: totpCode(TOTP_SECRET, new Date()) },
    });
    const sig = ed25519Sign(buildStepUpSigningInput(userId, actionType, challenge, body), signingSecret);
    return app.inject({
      method: 'POST',
      url: routeUrl,
      cookies: as(cookie),
      headers: {
        'x-truecairn-stepup-challenge': su.challengeId as string,
        'x-truecairn-stepup-signature': Buffer.from(sig).toString('base64url'),
      },
      payload: body,
    });
  }

  async function createItem(cookie: string, tier: 's1' | 's2' | 's3', contentB64: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/items',
      cookies: as(cookie),
      payload: {
        id: randomUUID(),
        tier,
        category: 'crypto_wallets',
        contentCiphertext: contentB64,
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
  async function getItem(cookie: string, id: string): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'GET', url: `/v1/vault/items/${id}`, cookies: as(cookie) });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('tier move enqueues a delayed action; the item stays S3 during the cooldown', async () => {
    const { userId, cookie, sessionId, signingSecret } = await makeOwner('move@example.com');
    const itemId = await createItem(cookie, 's3', b64([1, 2, 3, 4]));

    const body = {
      itemId,
      newTier: 's1',
      wrappedPerItemKey: b64([42, 42, 42]),
      wrappedPerItemKeyNonce: N24(11),
      // The title rides along, re-encrypted under the destination tier.
      titleCiphertext: b64([9, 9]),
      titleNonce: b64([3, 3]),
      aadVersion: 2,
    };
    const res = await stepUp('set_vault_item_tier', '/v1/vault/items/tier', body, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);
    const { sensitiveActionId } = res.json();

    // The action is pending + attributed to the session; the user-visible tier is
    // STILL S3 during the cooldown.
    const [action] = await db
      .select()
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, sensitiveActionId));
    expect(action!.status).toBe('pending');
    expect(action!.actionType).toBe('set_vault_item_tier');
    expect(action!.requestedBySessionId).toBe(sessionId);
    expect((await getItem(cookie, itemId)).tier).toBe('s3');

    // The step-up proof is recorded in the action's audit payload.
    const requested = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId))
    ).find((e) => e.eventType === 'sensitive_action.requested');
    expect((requested!.eventPayload as { stepUpChallengeId?: string }).stepUpChallengeId).toBeDefined();
  });

  it('a same-tier move is rejected before any step-up cost (400)', async () => {
    const { cookie } = await makeOwner('noop@example.com');
    const itemId = await createItem(cookie, 's2', b64([1, 2, 3, 4]));
    // No step-up headers; the cheap precondition (already in tier) 400s first.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/items/tier',
      cookies: as(cookie),
      payload: {
        itemId,
        newTier: 's2',
        wrappedPerItemKey: b64([1]),
        wrappedPerItemKeyNonce: N24(1),
        // The title is re-encrypted under the destination tier and moves with
        // the key — a move that omits it strands the title (F3 / 2026-08-09).
        titleCiphertext: b64([9, 9]),
        titleNonce: b64([3, 3]),
        aadVersion: 2,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(schema.sensitiveActions)).toHaveLength(0);
  });

  // ── Renaming while a tier move is pending (2026-08-09) ────────────────────
  //
  // The pending move already carries a title re-encrypted under the DESTINATION
  // tier, fixed at enqueue. A rename accepted now would be silently reverted
  // when the move applies — the handler cannot tell, both are opaque ciphertext
  // to it. Refuse, and give the owner the deadline and the action id so the
  // error itself is actionable.
  it('REFUSES a rename while a tier move is pending, and hands back the cancel affordance', async () => {
    const { cookie, signingSecret, userId } = await makeOwner('rename-blocked@example.com');
    const itemId = await createItem(cookie, 's3', b64([1, 2, 3, 4]));
    const body = {
      itemId,
      newTier: 's1',
      wrappedPerItemKey: b64([42]),
      wrappedPerItemKeyNonce: N24(11),
      titleCiphertext: b64([9, 9]),
      titleNonce: b64([3, 3]),
      aadVersion: 2,
    };
    const enq = await stepUp('set_vault_item_tier', '/v1/vault/items/tier', body, cookie, userId, signingSecret);
    expect(enq.statusCode).toBe(202);
    const { sensitiveActionId, effectiveAt } = enq.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/vault/items/${itemId}`,
      cookies: as(cookie),
      payload: { titleCiphertext: b64([7, 7]), titleNonce: b64([1, 1]) },
    });
    expect(res.statusCode).toBe(409);
    const problem = res.json();
    expect(problem.type).toContain('rename-blocked-by-pending-tier-move');
    // The affordance: which action to cancel, and by when.
    expect(problem.sensitiveActionId).toBe(sensitiveActionId);
    expect(problem.effectiveAt).toBe(effectiveAt);

    // And the title on disk is untouched — refused, not partially applied.
    const [item] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
    expect(Buffer.from(item!.titleCiphertext).toString('base64')).not.toBe(b64([7, 7]));
  });

  // A rename with NO pending move is unaffected — the guard is scoped to the
  // conflict, not a blanket lock on the field.
  it('allows a rename when no tier move is pending', async () => {
    const { cookie } = await makeOwner('rename-ok@example.com');
    const itemId = await createItem(cookie, 's2', b64([1, 2, 3, 4]));
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/vault/items/${itemId}`,
      cookies: as(cookie),
      payload: { titleCiphertext: b64([7, 7]), titleNonce: b64([1, 1]) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('delete enqueues a delayed soft-delete and flags the item pending (still visible)', async () => {
    const { cookie, signingSecret, userId } = await makeOwner('del@example.com');
    const itemId = await createItem(cookie, 's2', b64([1, 2, 3, 4]));
    const res = await stepUp('delete_vault_item', '/v1/vault/items/delete', { itemId }, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(202);

    const item = await getItem(cookie, itemId); // still fetchable during the cooldown
    expect(item.deletedAt).toBeNull();
    expect(item.pendingDeleteAt).not.toBeNull();
  });

  // The Q4 anti-footgun: a malicious double-overwrite cannot destroy the backup —
  // seed-once-per-window keeps the ORIGINAL, and one-way revert restores it (NOT
  // the attacker's first overwrite).
  it('revert restores the ORIGINAL after a double-overwrite (seed-once-per-window)', async () => {
    const { cookie, signingSecret, userId } = await makeOwner('revert@example.com');
    const ORIG = b64([1, 1, 1, 1]);
    const ATK1 = b64([2, 2, 2, 2]);
    const ATK2 = b64([3, 3, 3, 3]);
    const itemId = await createItem(cookie, 's2', ORIG);

    // Two overwrites in the window. The slot seeds with ORIG on the first and is
    // NOT touched by the second.
    const patch = async (content: string, nonceFill: number): Promise<void> => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vault/items/${itemId}`,
        cookies: as(cookie),
        payload: {
          contentCiphertext: content,
          contentNonce: N24(nonceFill),
          wrappedPerItemKey: b64([5, 6, 7]),
          wrappedPerItemKeyNonce: N24(8),
          contentSizeBytes: 4,
        },
      });
      expect(res.statusCode).toBe(200);
    };
    await patch(ATK1, 21);
    await patch(ATK2, 22);
    expect((await getItem(cookie, itemId)).contentCiphertext).toBe(ATK2);

    const res = await stepUp('revert_vault_item', '/v1/vault/items/revert', { itemId }, cookie, userId, signingSecret);
    expect(res.statusCode).toBe(200);
    expect(res.json().reverted).toBe(true);

    // The recovered content is the ORIGINAL — not ATK1, not ATK2.
    expect((await getItem(cookie, itemId)).contentCiphertext).toBe(ORIG);

    // The slot is one-shot: a second revert has nothing to restore.
    const second = await stepUp('revert_vault_item', '/v1/vault/items/revert', { itemId }, cookie, userId, signingSecret);
    expect(second.statusCode).toBe(409);
    expect(second.json().type).toBe('https://truecairn.app/problems/vault-no-restorable-backup');
  });
});
