import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;
const SHARE_CT = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]); // a "wrapped share"
const S1_CT = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]); // a "sealed S1 envelope"

describeIfDb('contact-domain sensitive-action handlers (integration)', () => {
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
    await sql`TRUNCATE release_shares, release_beneficiaries, s1_tier_key_envelopes, contacts, sensitive_actions, notification_deliveries, notification_channels, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
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
    if (!c) throw new Error('contact not created');
    return c.id;
  }
  function b64(b: Uint8Array): string {
    return Buffer.from(b).toString('base64');
  }
  async function applyAt(now: Date) {
    return applyDueActions({ db, audit, now }, 50);
  }

  it('add_contact (S2): pending through the cooldown, then lands the EXACT ciphertext', async () => {
    const ownerId = await makeUser('owner@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    const t0 = new Date('2026-05-01T00:00:00Z');

    const { id, effectiveAt } = await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'add_contact',
      payload: { contactId, tier: 's2', shareIndex: 1, wrappedShareCiphertext: b64(SHARE_CT) },
      now: t0,
    });
    expect(effectiveAt.getTime()).toBe(t0.getTime() + 7 * DAY);

    // (a) BEFORE the cooldown: nothing applies; no release_shares row exists.
    const before = await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect(before.processed).toBe(0);
    expect((await db.select().from(schema.sensitiveActions).where(eq(schema.sensitiveActions.id, id)))[0]!.status).toBe('pending');
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);

    // (b) AFTER the cooldown + a tick: the row lands with byte-identical ciphertext.
    const after = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(after.applied).toBe(1);
    const shares = await db.select().from(schema.releaseShares);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.tier).toBe('s2');
    expect(shares[0]!.shareIndex).toBe(1);
    expect(shares[0]!.shareType).toBe('contact');
    expect(shares[0]!.contactId).toBe(contactId);
    // The load-bearing property: nothing was re-derived or re-wrapped.
    expect(Buffer.from(shares[0]!.wrappedShareCiphertext!)).toEqual(Buffer.from(SHARE_CT));

    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('active');
  });

  it('add_contact (S1): lands an s1_tier_key_envelopes row with the exact sealed bytes', async () => {
    const ownerId = await makeUser('o-s1@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'add_contact',
      payload: { contactId, tier: 's1', s1EnvelopeCiphertext: b64(S1_CT) },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));
    const envelopes = await db.select().from(schema.s1TierKeyEnvelopes);
    expect(envelopes).toHaveLength(1);
    expect(Buffer.from(envelopes[0]!.sealedBoxCiphertext)).toEqual(Buffer.from(S1_CT));
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);
  });

  it('add_contact cancels when the contact is no longer enrolled at apply time', async () => {
    const ownerId = await makeUser('o-gone@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'add_contact',
      payload: { contactId, tier: 's2', shareIndex: 1, wrappedShareCiphertext: b64(SHARE_CT) },
      now: t0,
    });
    // The contact is removed before the cooldown elapses.
    await db.update(schema.contacts).set({ status: 'removed' }).where(eq(schema.contacts.id, contactId));
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    expect(await db.select().from(schema.releaseShares)).toHaveLength(0);
  });

  it('remove_contact revokes (not deletes) shares + envelopes and marks the contact removed', async () => {
    const ownerId = await makeUser('o-rm@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    await db.insert(schema.releaseShares).values({
      userId: ownerId,
      tier: 's2',
      shareIndex: 1,
      shareType: 'contact',
      contactId,
      wrappedShareCiphertext: SHARE_CT,
    });
    await db.insert(schema.s1TierKeyEnvelopes).values({
      userId: ownerId,
      contactId,
      sealedBoxCiphertext: S1_CT,
    });
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'remove_contact',
      payload: { contactId },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));

    const share = (await db.select().from(schema.releaseShares))[0];
    expect(share).toBeDefined(); // row preserved (not deleted)
    expect(share!.revokedAt).not.toBeNull();
    const env = (await db.select().from(schema.s1TierKeyEnvelopes))[0];
    expect(env!.revokedAt).not.toBeNull();
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('removed');
    expect(c!.removedAt).not.toBeNull();
  });

  it('change_contact_role updates the role', async () => {
    const ownerId = await makeUser('o-role@example.com');
    const contactId = await makeEnrolledContact(ownerId); // starts 'professional'
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'change_contact_role',
      payload: { contactId, newRole: 'personal' },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.role).toBe('personal');
  });

  // Regression (2026-08-21). The handler used to set `role` alone. Once contacts
  // carry a recipient_type (0066), that leaves a professional type on a personal
  // row — a pair the database refuses — so the action failed at APPLY time, in the
  // worker, seven days after the owner asked for it. It survived the suite because
  // no fixture had a recipient_type set; the E2E caught it by doing a raw role
  // UPDATE. This pins BOTH columns moving together.
  it('change_contact_role moves the recipient type with the role', async () => {
    const ownerId = await makeUser('o-role-type@example.com');
    const contactId = await makeEnrolledContact(ownerId); // starts 'professional'
    await db
      .update(schema.contacts)
      .set({ recipientType: 'lawyer_accountant' })
      .where(eq(schema.contacts.id, contactId));

    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'change_contact_role',
      payload: { contactId, newRole: 'personal' },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));

    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.role).toBe('personal');
    // The representative type for the NEW role — not the stale professional one,
    // which would have been a contradiction rather than merely a wrong label.
    expect(c!.recipientType).toBe('spouse_family_executor');
  });

  it('rotate_contact revokes the old share, lands the new one, and updates the pubkeys', async () => {
    const ownerId = await makeUser('o-rot@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    await db.insert(schema.releaseShares).values({
      userId: ownerId,
      tier: 's2',
      shareIndex: 1,
      shareType: 'contact',
      contactId,
      wrappedShareCiphertext: SHARE_CT,
    });
    const newX = new Uint8Array(32).fill(7);
    const newEd = new Uint8Array(32).fill(8);
    const newShareCt = new Uint8Array([100, 101, 102]);
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'rotate_contact',
      payload: {
        contactId,
        newX25519Pubkey: b64(newX),
        newEd25519Pubkey: b64(newEd),
        shares: [{ tier: 's2', shareIndex: 1, wrappedShareCiphertext: b64(newShareCt) }],
      },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));

    const active = await db
      .select()
      .from(schema.releaseShares)
      .where(isNull(schema.releaseShares.revokedAt));
    expect(active).toHaveLength(1);
    expect(Buffer.from(active[0]!.wrappedShareCiphertext!)).toEqual(Buffer.from(newShareCt));

    // The old share is preserved-but-revoked, still carrying its original bytes.
    const revoked = await db
      .select()
      .from(schema.releaseShares)
      .where(isNotNull(schema.releaseShares.revokedAt));
    expect(revoked).toHaveLength(1);
    expect(Buffer.from(revoked[0]!.wrappedShareCiphertext!)).toEqual(Buffer.from(SHARE_CT));

    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(Buffer.from(c!.contactX25519Pubkey!)).toEqual(Buffer.from(newX));
    expect(Buffer.from(c!.contactEd25519Pubkey!)).toEqual(Buffer.from(newEd));
  });

  // ── Designated beneficiary (backlog #2) ─────────────────────────────────────
  it('designate_beneficiary: pending through the cooldown, then lands an active designation', async () => {
    const ownerId = await makeUser('o-ben@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    const t0 = new Date('2026-05-01T00:00:00Z');
    const { effectiveAt } = await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'designate_beneficiary',
      payload: { contactId, tier: 's2' },
      now: t0,
    });
    expect(effectiveAt.getTime()).toBe(t0.getTime() + 7 * DAY);

    // BEFORE the cooldown: nothing applies.
    await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect(await db.select().from(schema.releaseBeneficiaries)).toHaveLength(0);

    // AFTER: one active designation for the tier.
    const after = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(after.applied).toBe(1);
    const rows = await db.select().from(schema.releaseBeneficiaries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe('s2');
    expect(rows[0]!.contactId).toBe(contactId);
    expect(rows[0]!.revokedAt).toBeNull();
  });

  it('designate_beneficiary cancels when the contact is no longer enrolled at apply time', async () => {
    const ownerId = await makeUser('o-ben-gone@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'designate_beneficiary',
      payload: { contactId, tier: 's2' },
      now: t0,
    });
    await db.update(schema.contacts).set({ status: 'removed' }).where(eq(schema.contacts.id, contactId));
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1);
    expect(await db.select().from(schema.releaseBeneficiaries)).toHaveLength(0);
  });

  it('remove_beneficiary revokes (not deletes) the active designation', async () => {
    const ownerId = await makeUser('o-ben-rm@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    await db.insert(schema.releaseBeneficiaries).values({ userId: ownerId, tier: 's2', contactId });
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'remove_beneficiary',
      payload: { contactId, tier: 's2' },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));
    const rows = await db.select().from(schema.releaseBeneficiaries);
    expect(rows).toHaveLength(1); // preserved, not deleted
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  // ── S1 designated beneficiary (backlog #4) ──────────────────────────────────
  // S1 has no Shamir shares, so an S1 beneficiary receives their OWN sealed
  // envelope of the S1 tier key (carried in the payload, sealed client-side).
  it('designate_beneficiary (S1): lands the designation AND the beneficiary’s own sealed envelope', async () => {
    const ownerId = await makeUser('o-ben-s1@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'designate_beneficiary',
      payload: { contactId, tier: 's1', s1EnvelopeCiphertext: b64(S1_CT) },
      now: t0,
    });

    // BEFORE the cooldown: nothing applies.
    await applyAt(new Date(t0.getTime() + 1 * DAY));
    expect(await db.select().from(schema.releaseBeneficiaries)).toHaveLength(0);
    expect(await db.select().from(schema.s1TierKeyEnvelopes)).toHaveLength(0);

    // AFTER: an active S1 designation + the beneficiary’s byte-identical envelope.
    const after = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(after.applied).toBe(1);
    const bens = await db.select().from(schema.releaseBeneficiaries);
    expect(bens).toHaveLength(1);
    expect(bens[0]!.tier).toBe('s1');
    expect(bens[0]!.contactId).toBe(contactId);
    const envs = await db.select().from(schema.s1TierKeyEnvelopes);
    expect(envs).toHaveLength(1);
    expect(envs[0]!.contactId).toBe(contactId);
    expect(Buffer.from(envs[0]!.sealedBoxCiphertext)).toEqual(Buffer.from(S1_CT));
  });

  it('designate_beneficiary (S1) cancels when the contact already holds an S1 envelope', async () => {
    const ownerId = await makeUser('o-ben-s1-dup@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    // The contact is already an S1 holder (they already receive S1).
    await db
      .insert(schema.s1TierKeyEnvelopes)
      .values({ userId: ownerId, contactId, sealedBoxCiphertext: S1_CT });
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'designate_beneficiary',
      payload: { contactId, tier: 's1', s1EnvelopeCiphertext: b64(new Uint8Array([42, 43])) },
      now: t0,
    });
    const res = await applyAt(new Date(t0.getTime() + 8 * DAY));
    expect(res.cancelled).toBe(1); // s1_envelope_exists
    expect(await db.select().from(schema.releaseBeneficiaries)).toHaveLength(0);
    const envs = await db.select().from(schema.s1TierKeyEnvelopes);
    expect(envs).toHaveLength(1); // the original holder envelope is untouched
    expect(Buffer.from(envs[0]!.sealedBoxCiphertext)).toEqual(Buffer.from(S1_CT));
  });

  it('remove_beneficiary (S1): revokes both the designation and the sealed envelope', async () => {
    const ownerId = await makeUser('o-ben-s1-rm@example.com');
    const contactId = await makeEnrolledContact(ownerId);
    await db.insert(schema.releaseBeneficiaries).values({ userId: ownerId, tier: 's1', contactId });
    await db
      .insert(schema.s1TierKeyEnvelopes)
      .values({ userId: ownerId, contactId, sealedBoxCiphertext: S1_CT });
    const t0 = new Date('2026-05-01T00:00:00Z');
    await requestSensitiveAction(db, audit, {
      userId: ownerId,
      actionType: 'remove_beneficiary',
      payload: { contactId, tier: 's1' },
      now: t0,
    });
    await applyAt(new Date(t0.getTime() + 8 * DAY));
    const ben = (await db.select().from(schema.releaseBeneficiaries))[0];
    expect(ben!.revokedAt).not.toBeNull();
    const env = (await db.select().from(schema.s1TierKeyEnvelopes))[0];
    expect(env!.revokedAt).not.toBeNull(); // so resolveHolders won't promote them
  });
});
