import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { attachmentFilePath, LocalDiskBlobStore } from '@truecairn/vault';
import { eq } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const bytes = (n: number, len = 8): Uint8Array => new Uint8Array(len).fill(n);

describeIfDb('account-lifecycle handlers (integration)', () => {
  let db: Database;
  let sql: Sql;
  let audit: AuditLogWriter;
  let dir: string;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
    dir = await mkdtemp(join(tmpdir(), 'tc-del-'));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await sql`TRUNCATE attachments, vault_items, outer_layer_keys, user_tier_keys, release_shares, s1_tier_key_envelopes, contacts, release_ceremonies, engine_states, user_key_material, webauthn_credentials, password_credentials, totp_credentials, notification_channels, notification_deliveries, device_registrations, sessions, sensitive_actions, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db.insert(schema.users).values({ email, accountStatus: 'active' }).returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function addWebauthn(userId: UserId, credSeed: number, isHardwareKey: boolean): Promise<string> {
    const [r] = await db
      .insert(schema.webauthnCredentials)
      .values({ userId, credentialId: bytes(credSeed), publicKey: bytes(credSeed + 1), isHardwareKey })
      .returning({ id: schema.webauthnCredentials.id });
    return r!.id;
  }
  function applyAt(now: Date) {
    return applyDueActions({ db, audit, now, blobStore: new LocalDiskBlobStore(dir) }, 50);
  }
  async function enqueueAndApply(userId: UserId, actionType: 'remove_hardware_key' | 'delete_account', payload: Record<string, unknown>) {
    const t0 = new Date('2026-07-01T00:00:00Z');
    await requestSensitiveAction(db, audit, { userId, actionType, payload, now: t0 });
    return applyAt(new Date(t0.getTime() + 8 * DAY));
  }

  // ── remove_hardware_key — the surviving-auth-path check ────────────────────

  it('REFUSES to remove the last hardware key when no other auth path exists (credential stays active)', async () => {
    const userId = await makeUser('last@example.com');
    const credId = await addWebauthn(userId, 1, true); // the only factor
    const res = await enqueueAndApply(userId, 'remove_hardware_key', { credentialId: credId });
    expect(res.cancelled).toBe(1);
    // CRITICAL: the credential is STILL active (the check preceded the revocation).
    const [cred] = await db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.id, credId));
    expect(cred!.revokedAt).toBeNull();
  });

  it('removes the last hardware key when password + confirmed TOTP remain', async () => {
    const userId = await makeUser('pwtotp@example.com');
    const credId = await addWebauthn(userId, 1, true);
    await db.insert(schema.passwordCredentials).values({ userId, argon2Phc: 'v1$argon2id$...' });
    await db.insert(schema.totpCredentials).values({ userId, secretCiphertext: bytes(1), secretNonce: bytes(2, 24), kekId: 'k', confirmedAt: new Date() });
    const res = await enqueueAndApply(userId, 'remove_hardware_key', { credentialId: credId });
    expect(res.applied).toBe(1);
    const [cred] = await db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.id, credId));
    expect(cred!.revokedAt).not.toBeNull();
  });

  it('removes one of three hardware keys with no password (two remain)', async () => {
    const userId = await makeUser('three@example.com');
    const credId = await addWebauthn(userId, 1, true);
    await addWebauthn(userId, 2, true);
    await addWebauthn(userId, 3, true);
    const res = await enqueueAndApply(userId, 'remove_hardware_key', { credentialId: credId });
    expect(res.applied).toBe(1);
  });

  it('removes the last hardware key when a non-hardware passkey remains', async () => {
    const userId = await makeUser('passkey@example.com');
    const credId = await addWebauthn(userId, 1, true); // hardware key
    await addWebauthn(userId, 2, false); // a passkey — any non-revoked webauthn counts
    const res = await enqueueAndApply(userId, 'remove_hardware_key', { credentialId: credId });
    expect(res.applied).toBe(1);
  });

  // ── delete_account — purge data, keep audit + users row ────────────────────

  // Seed the FK-order-sensitive tables so a wrong purge order would throw.
  async function seedFullAccount(userId: UserId): Promise<{ attachmentId: string }> {
    const [olk] = await db
      .insert(schema.outerLayerKeys)
      .values({ userId, tier: 's2', kekId: 'k', outerKeyEncrypted: bytes(1), outerKeyNonce: bytes(2, 24), outerKeyEncryptionAad: bytes(3), generation: 1 })
      .returning({ id: schema.outerLayerKeys.id });
    await db.insert(schema.userTierKeys).values({
      userId, tier: 's2', tierKeyWrappedByMaster: bytes(1), tierKeyMasterNonce: bytes(2), outerLayerKeyId: olk!.id,
      shamirThreshold: 2, shamirShareCount: 3, tierKeyCheckPlaintext: bytes(3), tierKeyCheckCiphertext: bytes(4), tierKeyCheckNonce: bytes(5),
    });
    const [item] = await db
      .insert(schema.vaultItems)
      .values({
        userId, tier: 's2', category: 'personal_archive', outerCiphertext: bytes(1), outerNonce: bytes(2, 24), outerLayerKeyId: olk!.id,
        outerKekId: 'k', outerGeneration: 1, contentSizeBytes: 4, titleCiphertext: bytes(3), titleNonce: bytes(4),
      })
      .returning({ id: schema.vaultItems.id });
    const [att] = await db
      .insert(schema.attachments)
      .values({ vaultItemId: item!.id, userId, sizeBytes: 3, status: 'stored', storagePath: 'x' })
      .returning({ id: schema.attachments.id });
    const contactUser = await makeUser(`c-${Math.random()}@example.com`);
    const [contact] = await db
      .insert(schema.contacts)
      .values({ ownerUserId: userId, contactUserId: contactUser, role: 'professional', status: 'enrolled', displayLabelCiphertext: bytes(1), displayLabelNonce: bytes(2) })
      .returning({ id: schema.contacts.id });
    await db.insert(schema.releaseShares).values({ userId, tier: 's2', shareIndex: 1, shareType: 'contact', contactId: contact!.id, wrappedShareCiphertext: bytes(1) });
    await db.insert(schema.s1TierKeyEnvelopes).values({ userId, contactId: contact!.id, sealedBoxCiphertext: bytes(1) });
    await db.insert(schema.userKeyMaterial).values({
      userId, masterPassphraseSalt: bytes(1), masterKeyWrappedByPassphrase: bytes(2), masterKeyPassphraseNonce: bytes(3),
      recoveryCodeSalt: bytes(4), masterKeyWrappedByRecovery: bytes(5), masterKeyRecoveryNonce: bytes(6), releasePassphraseSalt: bytes(7), auditSigningPubkey: new Uint8Array(32),
    });
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    await db.insert(schema.sessions).values({ userId, tokenHash: bytes(9), idleExpiresAt: new Date(Date.now() + DAY), absoluteExpiresAt: new Date(Date.now() + DAY) });
    const path = attachmentFilePath(dir, userId, att!.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes(3));
    return { attachmentId: att!.id };
  }

  it('purges all data, removes blobs, tombstones the users row, and the audit log SURVIVES + verifies', async () => {
    const userId = await makeUser('delete@example.com');
    const { attachmentId } = await seedFullAccount(userId);

    const res = await enqueueAndApply(userId, 'delete_account', {});
    expect(res.applied).toBe(1);

    // Every data table empty for the user (no FK violation — the order was right).
    expect(await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.userId, userId))).toHaveLength(0);
    expect(await db.select().from(schema.attachments).where(eq(schema.attachments.userId, userId))).toHaveLength(0);
    expect(await db.select().from(schema.outerLayerKeys).where(eq(schema.outerLayerKeys.userId, userId))).toHaveLength(0);
    expect(await db.select().from(schema.contacts).where(eq(schema.contacts.ownerUserId, userId))).toHaveLength(0);
    expect(await db.select().from(schema.releaseShares).where(eq(schema.releaseShares.userId, userId))).toHaveLength(0);
    expect(await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).toHaveLength(0);
    // Blob gone from disk.
    await expect(access(attachmentFilePath(dir, userId, attachmentId))).rejects.toThrow();
    // users row PRESERVED + tombstoned.
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.accountStatus).toBe('deleted');
    expect(user!.email).toBe(`deleted-${userId}@deleted.truecairn.local`);
    // The audit log survives and still verifies — the deletion can't erase its own evidence.
    const auditRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    expect(auditRows.length).toBeGreaterThan(0);
    const v = await verifyChain(db, userId);
    expect(v.ok).toBe(true);
  });

  it('completes the delete even when the attachment blob is already gone', async () => {
    const userId = await makeUser('delete-nofile@example.com');
    const { attachmentId } = await seedFullAccount(userId);
    await rm(attachmentFilePath(dir, userId, attachmentId), { force: true }); // remove the file first
    const res = await enqueueAndApply(userId, 'delete_account', {});
    expect(res.applied).toBe(1);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user!.accountStatus).toBe('deleted');
  });

  it('tombstoning frees the original email for re-registration', async () => {
    const email = 'reuse@example.com';
    const userId = await makeUser(email);
    await db.insert(schema.userKeyMaterial).values({
      userId, masterPassphraseSalt: bytes(1), masterKeyWrappedByPassphrase: bytes(2), masterKeyPassphraseNonce: bytes(3),
      recoveryCodeSalt: bytes(4), masterKeyWrappedByRecovery: bytes(5), masterKeyRecoveryNonce: bytes(6), releasePassphraseSalt: bytes(7), auditSigningPubkey: new Uint8Array(32),
    });
    await enqueueAndApply(userId, 'delete_account', {});
    // The original email is free again — a new account can take it (no unique collision).
    const newId = await makeUser(email);
    expect(newId).not.toBe(userId);
  });
});
