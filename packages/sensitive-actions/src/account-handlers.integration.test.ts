import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describeIfDb('account/key-domain sensitive-action handlers (integration)', () => {
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
    await sql`TRUNCATE release_shares, contacts, sensitive_actions, user_key_material, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function seedKeyMaterial(userId: UserId, fill: number): Promise<void> {
    const b = (n: number) => new Uint8Array(16).fill(n);
    await db.insert(schema.userKeyMaterial).values({
      userId,
      masterPassphraseSalt: b(1),
      masterKeyWrappedByPassphrase: b(2),
      masterKeyPassphraseNonce: b(3),
      recoveryCodeSalt: b(fill),
      masterKeyWrappedByRecovery: b(fill),
      masterKeyRecoveryNonce: b(fill),
      releasePassphraseSalt: b(7),
      auditSigningPubkey: new Uint8Array(32),
    });
  }
  async function makeEnrolledContact(ownerId: UserId): Promise<string> {
    const contactUser = await makeUser(`c-${Math.random()}@example.com`);
    const [c] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId: contactUser,
        role: 'professional',
        status: 'enrolled',
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array([2]),
        contactX25519Pubkey: new Uint8Array(32),
        contactEd25519Pubkey: new Uint8Array(32),
      })
      .returning({ id: schema.contacts.id });
    return c!.id;
  }
  function applyAt(now: Date) {
    return applyDueActions({ db, audit, now }, 50);
  }

  it('rotate_recovery_code re-wraps the master key under the new recovery KEK', async () => {
    const userId = await makeUser('rc@example.com');
    await seedKeyMaterial(userId, 9);
    const newSalt = new Uint8Array(16).fill(42);
    const newWrap = new Uint8Array(48).fill(43);
    const newNonce = new Uint8Array(24).fill(44);
    const t0 = new Date('2026-06-10T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'rotate_recovery_code',
      payload: {
        recoveryCodeSalt: b64(newSalt),
        masterKeyWrappedByRecovery: b64(newWrap),
        masterKeyRecoveryNonce: b64(newNonce),
      },
      now: t0,
    });
    // Before cooldown: unchanged (still fill 9).
    await applyAt(new Date(t0.getTime() + 1 * DAY));
    let [km] = await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId));
    expect(Buffer.from(km!.recoveryCodeSalt)).toEqual(Buffer.from(new Uint8Array(16).fill(9)));

    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);
    [km] = await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId));
    expect(Buffer.from(km!.recoveryCodeSalt)).toEqual(Buffer.from(newSalt));
    expect(Buffer.from(km!.masterKeyWrappedByRecovery)).toEqual(Buffer.from(newWrap));
    expect(Buffer.from(km!.masterKeyRecoveryNonce)).toEqual(Buffer.from(newNonce));
    // The passphrase wrap (the master key itself) is untouched.
    expect(Buffer.from(km!.masterKeyWrappedByPassphrase)).toEqual(Buffer.from(new Uint8Array(16).fill(2)));
  });

  it('change_share_composition swaps a slot from a contact to a hardware_key share', async () => {
    const userId = await makeUser('csc@example.com');
    const contactId = await makeEnrolledContact(userId);
    await db.insert(schema.releaseShares).values({
      userId,
      tier: 's3',
      shareIndex: 1,
      shareType: 'contact',
      contactId,
      wrappedShareCiphertext: new Uint8Array([1, 2, 3]),
    });
    const newCt = new Uint8Array([9, 8, 7, 6]);
    const t0 = new Date('2026-06-10T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'change_share_composition',
      payload: { tier: 's3', shareIndex: 1, newShareType: 'hardware_key', wrappedShareCiphertext: b64(newCt) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.applied).toBe(1);

    const active = await db
      .select()
      .from(schema.releaseShares)
      .where(and(eq(schema.releaseShares.userId, userId), isNull(schema.releaseShares.revokedAt)));
    expect(active).toHaveLength(1);
    expect(active[0]!.shareType).toBe('hardware_key');
    expect(active[0]!.contactId).toBeNull();
    expect(Buffer.from(active[0]!.wrappedShareCiphertext!)).toEqual(Buffer.from(newCt));

    const revoked = await db
      .select()
      .from(schema.releaseShares)
      .where(and(eq(schema.releaseShares.userId, userId), isNotNull(schema.releaseShares.revokedAt)));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.shareType).toBe('contact');
  });

  it('change_share_composition cancels when swapping to a non-enrolled contact', async () => {
    const userId = await makeUser('csc2@example.com');
    // A contact that is NOT enrolled (still pending_keygen).
    const contactUser = await makeUser('pend@example.com');
    const [c] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: userId,
        contactUserId: contactUser,
        role: 'professional',
        status: 'pending_keygen',
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array([2]),
      })
      .returning({ id: schema.contacts.id });
    const t0 = new Date('2026-06-10T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'change_share_composition',
      payload: {
        tier: 's2',
        shareIndex: 1,
        newShareType: 'contact',
        contactId: c!.id,
        wrappedShareCiphertext: b64(new Uint8Array([1])),
      },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);
  });

  // Nested S3 (docs/24) has no distributed passphrase share (the passphrase is
  // the XOR mask) and only 1..3 contact slots — so neither a release_passphrase
  // factor nor an index-4 slot can be recomposed for S3.
  it('change_share_composition rejects a release_passphrase factor for nested S3', async () => {
    const userId = await makeUser('csc-s3pass@example.com');
    const t0 = new Date('2026-06-10T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'change_share_composition',
      payload: { tier: 's3', shareIndex: 3, newShareType: 'release_passphrase', passphraseSalt: b64(new Uint8Array(16)) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);
  });

  it('change_share_composition rejects an out-of-range S3 shareIndex (nested is 1..3)', async () => {
    const userId = await makeUser('csc-s3idx@example.com');
    const contactId = await makeEnrolledContact(userId);
    const t0 = new Date('2026-06-10T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId,
      actionType: 'change_share_composition',
      payload: { tier: 's3', shareIndex: 4, newShareType: 'contact', contactId, wrappedShareCiphertext: b64(new Uint8Array([1])) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);
  });
});
