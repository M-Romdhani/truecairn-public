import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { initCrypto, randomBytes, secretboxDecrypt, secretboxEncrypt } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq, isNull } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const bytes = (n: number, len = 8): Uint8Array => new Uint8Array(len).fill(n);
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describeIfDb('key-rotation handlers (integration)', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE release_shares, release_ceremonies, ceremony_affirmations, contacts, user_tier_keys, outer_layer_keys, user_key_material, sensitive_actions, sessions, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function seedMaster(
    userId: UserId,
    opts: { pubkey?: Uint8Array; recWrap?: Uint8Array; recNonce?: Uint8Array } = {},
  ): Promise<void> {
    await db.insert(schema.userKeyMaterial).values({
      userId,
      masterPassphraseSalt: bytes(1),
      masterKeyWrappedByPassphrase: bytes(2),
      masterKeyPassphraseNonce: bytes(3),
      recoveryCodeSalt: bytes(4),
      masterKeyWrappedByRecovery: opts.recWrap ?? bytes(5),
      masterKeyRecoveryNonce: opts.recNonce ?? bytes(6),
      releasePassphraseSalt: bytes(7),
      auditSigningPubkey: opts.pubkey ?? new Uint8Array(32).fill(8),
      generation: 1,
    });
  }
  async function seedTier(userId: UserId, tier: 's1' | 's2' | 's3'): Promise<void> {
    const [olk] = await db
      .insert(schema.outerLayerKeys)
      .values({
        userId,
        tier,
        kekId: 'test-kek',
        outerKeyEncrypted: bytes(1),
        outerKeyNonce: bytes(2, 24),
        outerKeyEncryptionAad: bytes(3),
        generation: 1,
      })
      .returning({ id: schema.outerLayerKeys.id });
    // S2 flat 2-of-3 and S3 nested 2-of-3 (docs/24) both store (threshold 2,
    // shares 3) contact-share metadata; S1 has no Shamir scheme.
    const shamir = tier === 's1' ? {} : { shamirThreshold: 2, shamirShareCount: 3 };
    await db.insert(schema.userTierKeys).values({
      userId,
      tier,
      tierKeyWrappedByMaster: bytes(10),
      tierKeyMasterNonce: bytes(11),
      outerLayerKeyId: olk!.id,
      ...shamir,
      generation: 1,
      tierKeyCheckPlaintext: bytes(12),
      tierKeyCheckCiphertext: bytes(13),
      tierKeyCheckNonce: bytes(14),
    });
  }
  function tierRewrap(tier: string): Record<string, unknown> {
    return { tier, tierKeyWrappedByMaster: b64(bytes(99)), tierKeyMasterNonce: b64(bytes(98)) };
  }
  function masterPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      masterPassphraseSalt: b64(bytes(21)),
      masterKeyWrappedByPassphrase: b64(bytes(22)),
      masterKeyPassphraseNonce: b64(bytes(23)),
      masterKeyWrappedByRecovery: b64(bytes(24)),
      masterKeyRecoveryNonce: b64(bytes(25)),
      auditSigningPubkey: b64(new Uint8Array(32).fill(77)),
      generation: 2,
      tierRewraps: [tierRewrap('s1'), tierRewrap('s2'), tierRewrap('s3')],
      ...over,
    };
  }
  function applyAt(now: Date) {
    return applyDueActions({ db, audit, now }, 50);
  }

  // ── rotate_master_passphrase ──────────────────────────────────────────────

  // THE structural-validation test: a payload that omits a tier's re-wrap must be
  // rejected BEFORE any state mutation — catching a client bug / hostile client
  // that strips a tier's access by simply not re-wrapping it.
  it('rotate_master_passphrase REJECTS a payload missing a tier, leaving state byte-unchanged', async () => {
    const userId = await makeUser('reject@example.com');
    await seedMaster(userId);
    await seedTier(userId, 's1');
    await seedTier(userId, 's2');
    await seedTier(userId, 's3');

    const kmBefore = (await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId)))[0]!;
    const tiersBefore = await db.select().from(schema.userTierKeys).where(eq(schema.userTierKeys.userId, userId));

    const t0 = new Date('2026-06-20T00:00:00Z');
    const { id } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_master_passphrase',
      // Only S1 + S2 — S3 omitted.
      payload: masterPayload({ tierRewraps: [tierRewrap('s1'), tierRewrap('s2')] }),
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);

    // The action cancelled with the tier-count reason.
    const [action] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id));
    expect(action!.status).toBe('cancelled');
    expect(action!.cancelledReason).toBe('tier_count_mismatch');
    // The cancellation audit entry records the reason.
    const cancelled = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId))).find(
      (e) => e.eventType === 'sensitive_action.cancelled',
    );
    expect((cancelled!.eventPayload as { reason?: string }).reason).toBe('tier_count_mismatch');

    // Crucially: NO partial mutation. Key material + every tier row byte-for-byte unchanged.
    const kmAfter = (await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId)))[0]!;
    expect(kmAfter.generation).toBe(kmBefore.generation);
    expect(Buffer.from(kmAfter.masterKeyWrappedByPassphrase)).toEqual(Buffer.from(kmBefore.masterKeyWrappedByPassphrase));
    expect(Buffer.from(kmAfter.auditSigningPubkey)).toEqual(Buffer.from(kmBefore.auditSigningPubkey));
    const tiersAfter = await db.select().from(schema.userTierKeys).where(eq(schema.userTierKeys.userId, userId));
    for (const before of tiersBefore) {
      const after = tiersAfter.find((t) => t.tier === before.tier)!;
      expect(Buffer.from(after.tierKeyWrappedByMaster)).toEqual(Buffer.from(before.tierKeyWrappedByMaster));
    }
  });

  it('rotate_master_passphrase applies a full re-wrap, revokes sessions, audits key hashes, and keeps recovery working', async () => {
    const userId = await makeUser('happy@example.com');
    const oldPubkey = new Uint8Array(32).fill(8);
    await seedMaster(userId, { pubkey: oldPubkey });
    await seedTier(userId, 's1');
    await seedTier(userId, 's2');
    await seedTier(userId, 's3');
    const { id: sessionId } = await createSession(db, { userId, now: new Date() });

    // Recovery round-trip: wrap the NEW master key under a recovery KEK and feed
    // that as the recovery re-wrap; post-rotation it must still unwrap.
    const recoveryKek = randomBytes(32);
    const recNonce = randomBytes(24);
    const newMasterKey = randomBytes(32);
    const recWrap = secretboxEncrypt({ key: recoveryKek, nonce: recNonce, plaintext: newMasterKey });
    const newPubkey = new Uint8Array(32).fill(77);

    const t0 = new Date('2026-06-20T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_master_passphrase',
      payload: masterPayload({
        masterKeyWrappedByRecovery: b64(recWrap),
        masterKeyRecoveryNonce: b64(recNonce),
        auditSigningPubkey: b64(newPubkey),
      }),
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);

    const km = (await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId)))[0]!;
    expect(km.generation).toBe(2);
    expect(Buffer.from(km.auditSigningPubkey)).toEqual(Buffer.from(newPubkey));
    // Every tier re-wrapped.
    const tiers = await db.select().from(schema.userTierKeys).where(eq(schema.userTierKeys.userId, userId));
    for (const t of tiers) expect(Buffer.from(t.tierKeyWrappedByMaster)).toEqual(Buffer.from(bytes(99)));
    // Sessions force-revoked.
    const [sess] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(sess!.revokedAt).not.toBeNull();
    expect(sess!.revokedReason).toBe('master_passphrase_rotated');
    // Recovery still unlocks the new master key.
    const recovered = secretboxDecrypt({ key: recoveryKek, nonce: km.masterKeyRecoveryNonce, ciphertext: km.masterKeyWrappedByRecovery });
    expect(Buffer.from(recovered)).toEqual(Buffer.from(newMasterKey));
    // Audit records from/to key hashes (proving rotation without leaking the key).
    const applied = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId))).find(
      (e) => e.eventType === 'sensitive_action.applied',
    );
    const details = (applied!.eventPayload as { details?: { fromKeyHash?: string; toKeyHash?: string } }).details;
    expect(details!.fromKeyHash).toBeDefined();
    expect(details!.toKeyHash).toBeDefined();
    expect(details!.fromKeyHash).not.toBe(details!.toKeyHash);
  });

  it('force-revoking sessions does NOT cancel an unrelated pending action (revoke ≠ cancel)', async () => {
    const userId = await makeUser('survive@example.com');
    await seedMaster(userId);
    await seedTier(userId, 's2');
    const { id: sessionId } = await createSession(db, { userId, now: new Date() });
    const t0 = new Date('2026-06-20T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_master_passphrase',
      payload: masterPayload({ tierRewraps: [tierRewrap('s2')] }),
      now: t0,
      requestedBySessionId: sessionId,
    });
    // An unrelated action requested by the SAME session, due later.
    const unrelated = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_recovery_code',
      payload: { recoveryCodeSalt: b64(bytes(1)), masterKeyWrappedByRecovery: b64(bytes(2)), masterKeyRecoveryNonce: b64(bytes(3)) },
      now: new Date(t0.getTime() + 7 * DAY),
      requestedBySessionId: sessionId,
    });
    // Apply the master rotation (force-revokes the session).
    await applyAt(new Date(t0.getTime() + 8 * DAY - 1));
    const [stillPending] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, unrelated.id));
    expect(stillPending!.status).toBe('pending');
    // The session was revoked (not deleted), so the FK link survives.
    expect(stillPending!.requestedBySessionId).toBe(sessionId);
  });

  // ── rotate_release_passphrase ─────────────────────────────────────────────

  async function seedContact(ownerId: UserId): Promise<string> {
    const cu = await makeUser(`c-${Math.random()}@example.com`);
    const [c] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId: cu,
        role: 'professional',
        status: 'enrolled',
        displayLabelCiphertext: bytes(1),
        displayLabelNonce: bytes(2),
        contactX25519Pubkey: new Uint8Array(32),
        contactEd25519Pubkey: new Uint8Array(32),
      })
      .returning({ id: schema.contacts.id });
    return c!.id;
  }
  async function seedS3Shares(userId: UserId, contactId: string): Promise<void> {
    // Nested S3 (docs/24): three CONTACT shares (1..3) of the masked key — the
    // passphrase is the XOR mask, NOT a distributed share, so there is no index-4.
    for (const idx of [1, 2, 3]) {
      await db.insert(schema.releaseShares).values({
        userId, tier: 's3', shareIndex: idx, shareType: 'contact', contactId, wrappedShareCiphertext: bytes(idx),
      });
    }
  }
  function reSplitShare(idx: number, contactId: string): Record<string, unknown> {
    return { tier: 's3', shareIndex: idx, shareType: 'contact', contactId, wrappedShareCiphertext: b64(bytes(100 + idx)) };
  }

  it('rotate_release_passphrase REJECTS an omitted active share, leaving shares + salt unchanged', async () => {
    const userId = await makeUser('rel-reject@example.com');
    await seedMaster(userId);
    const contactId = await seedContact(userId);
    await seedS3Shares(userId, contactId);

    const t0 = new Date('2026-06-20T00:00:00Z');
    const { id } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_release_passphrase',
      // Omit contact share 3 — one of the three active S3 shares.
      payload: { releasePassphraseSalt: b64(bytes(200)), shares: [reSplitShare(1, contactId), reSplitShare(2, contactId)] },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    const [action] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id));
    expect(action!.cancelledReason).toBe('share_count_mismatch');
    // Salt + shares unchanged (no revocations, original 3 still active).
    const km = (await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId)))[0]!;
    expect(Buffer.from(km.releasePassphraseSalt)).toEqual(Buffer.from(bytes(7)));
    const active = await db.select().from(schema.releaseShares).where(and(eq(schema.releaseShares.userId, userId), isNull(schema.releaseShares.revokedAt)));
    expect(active).toHaveLength(3);
  });

  it('rotate_release_passphrase re-splits all shares and swaps the salt when complete', async () => {
    const userId = await makeUser('rel-ok@example.com');
    await seedMaster(userId);
    const contactId = await seedContact(userId);
    await seedS3Shares(userId, contactId);
    const t0 = new Date('2026-06-20T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_release_passphrase',
      payload: { releasePassphraseSalt: b64(bytes(200)), shares: [1, 2, 3].map((i) => reSplitShare(i, contactId)) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);
    const active = await db.select().from(schema.releaseShares).where(and(eq(schema.releaseShares.userId, userId), isNull(schema.releaseShares.revokedAt)));
    expect(active).toHaveLength(3); // old revoked, new set active
    const share1 = active.find((s) => s.shareIndex === 1)!;
    expect(Buffer.from(share1.wrappedShareCiphertext!)).toEqual(Buffer.from(bytes(101)));
    const km = (await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId)))[0]!;
    expect(Buffer.from(km.releasePassphraseSalt)).toEqual(Buffer.from(bytes(200)));
    expect(await db.select().from(schema.releaseShares).where(eq(schema.releaseShares.userId, userId))).toHaveLength(6); // 3 revoked + 3 active
  });

  it('rotate_release_passphrase is BLOCKED while a ceremony is in flight', async () => {
    const userId = await makeUser('rel-ceremony@example.com');
    await seedMaster(userId);
    const contactId = await seedContact(userId);
    await seedS3Shares(userId, contactId);
    await db.insert(schema.releaseCeremonies).values({
      userId,
      tier: 's3',
      status: 'collecting_affirmations',
      syncWindowExpiresAt: new Date(Date.now() + 14 * DAY),
    });
    const t0 = new Date('2026-06-20T00:00:00Z');
    const { id } = await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_release_passphrase',
      payload: { releasePassphraseSalt: b64(bytes(200)), shares: [1, 2, 3].map((i) => reSplitShare(i, contactId)) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    const [action] = await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id));
    expect(action!.cancelledReason).toBe('ceremony_in_flight');
    // Salt + shares untouched.
    const active = await db.select().from(schema.releaseShares).where(and(eq(schema.releaseShares.userId, userId), isNull(schema.releaseShares.revokedAt)));
    expect(active).toHaveLength(3);
  });
});
