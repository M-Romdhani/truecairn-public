import { createHash } from 'node:crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gatherReadinessInputs, scoreReadiness } from './readiness.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// Proves gatherReadinessInputs assembles the deterministic inputs correctly from
// real rows — in particular the S3 role-diversity join (distinct roles among the
// contacts holding S3 contact shares).
describeIfDb('gatherReadinessInputs (real DB)', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE notification_channels, release_shares, release_beneficiaries, outer_layer_keys, vault_items, contacts, engine_states, users CASCADE`;
  });

  // `destination_hash` carries a CHECK binding it to sha256('<type>:<destination>')
  // (migration 0063), so a fixture cannot fake it with random bytes — the column
  // is not free-form and the database says so. Mirror the real derivation.
  async function addChannel(
    userId: UserId,
    destination: string,
    opts: { verified: boolean; removedAt?: Date },
  ): Promise<void> {
    await db.insert(schema.notificationChannels).values({
      userId,
      channelType: 'email',
      destination,
      destinationHash: createHash('sha256').update(`email:${destination}`).digest(),
      verified: opts.verified,
      ...(opts.removedAt !== undefined ? { removedAt: opts.removedAt } : {}),
    });
  }

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }

  async function outerKey(userId: UserId, tier: 's1' | 's2' | 's3'): Promise<string> {
    const [k] = await db
      .insert(schema.outerLayerKeys)
      .values({
        userId,
        tier,
        kekId: 'k',
        outerKeyEncrypted: Buffer.alloc(32, 9),
        outerKeyNonce: Buffer.alloc(24, 9),
        outerKeyEncryptionAad: Buffer.alloc(8, 9),
        generation: 1,
      })
      .returning({ id: schema.outerLayerKeys.id });
    return k!.id;
  }

  async function addItem(userId: UserId, tier: 's1' | 's2' | 's3', keyId: string): Promise<void> {
    await db.insert(schema.vaultItems).values({
      userId,
      tier,
      category: 'personal_archive',
      outerLayerKeyId: keyId,
      outerKekId: 'k',
      outerGeneration: 1,
      outerCiphertext: Buffer.alloc(8, 1),
      outerNonce: Buffer.alloc(24, 2),
      titleCiphertext: Buffer.alloc(8, 3),
      titleNonce: Buffer.alloc(24, 4),
      contentSizeBytes: 8,
    });
  }

  async function addContact(userId: UserId, role: 'personal' | 'professional' | 'recovery'): Promise<string> {
    const [c] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: userId,
        role,
        status: 'enrolled',
        displayLabelCiphertext: Buffer.alloc(8, 5),
        displayLabelNonce: Buffer.alloc(24, 6),
      })
      .returning({ id: schema.contacts.id });
    return c!.id;
  }

  async function assignShare(userId: UserId, tier: 's2' | 's3', index: number, contactId: string): Promise<void> {
    await db.insert(schema.releaseShares).values({
      userId,
      tier,
      shareIndex: index,
      shareType: 'contact',
      contactId,
      wrappedShareCiphertext: Buffer.alloc(16, 7),
    });
  }

  it('S3 shares all in one role → gather yields distinctRoles=1 → diversity gap', async () => {
    const userId = await makeUser('s3div@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const s3Key = await outerKey(userId, 's3');
    await addItem(userId, 's3', s3Key);
    await addItem(userId, 's3', s3Key);
    // Three enrolled contacts, ALL personal, each holding one S3 contact share.
    for (let idx = 1; idx <= 3; idx++) {
      const c = await addContact(userId, 'personal');
      await assignShare(userId, 's3', idx, c);
    }

    const inputs = await gatherReadinessInputs(db, userId);
    expect(inputs.shares.s3).toEqual({ contactShareCount: 3, distinctRoles: 1 });
    expect(inputs.itemsByTier.s3).toBe(2);
    expect(inputs.enrolledContactCount).toBe(3);

    const codes = scoreReadiness(inputs).gaps.map((g) => g.code);
    expect(codes).toContain('s3_role_diversity_unsatisfiable');
  });

  // F-07 wiring. The scorer's unit tests take verifiedChannelCount as a given;
  // these two prove the DB read actually produces it — and specifically that it
  // uses the SAME predicate `eligibleChannels` uses (verified AND not removed).
  // Counting a row the delivery path would skip is the one way this gap could
  // report reachability the engine does not have.
  it('F-07: an armed engine with no channel row → no_verified_channel from real inputs', async () => {
    const userId = await makeUser('nochannel@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const key = await outerKey(userId, 's1');
    await addItem(userId, 's1', key);
    await addContact(userId, 'personal');

    const inputs = await gatherReadinessInputs(db, userId);
    expect(inputs.verifiedChannelCount).toBe(0);
    expect(scoreReadiness(inputs).gaps.map((g) => g.code)).toContain('no_verified_channel');
  });

  it('F-07: an UNVERIFIED or REMOVED channel does not count as reachable', async () => {
    const userId = await makeUser('unverified-channel@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const key = await outerKey(userId, 's1');
    await addItem(userId, 's1', key);
    await addContact(userId, 'personal');

    // Enrolment started but never completed the code round-trip.
    await addChannel(userId, 'pending@example.com', { verified: false });
    // And one that WAS verified, then removed through the sensitive action.
    await addChannel(userId, 'gone@example.com', { verified: true, removedAt: new Date() });

    const inputs = await gatherReadinessInputs(db, userId);
    expect(inputs.verifiedChannelCount).toBe(0);
    expect(scoreReadiness(inputs).gaps.map((g) => g.code)).toContain('no_verified_channel');

    // Now a genuinely usable one — the gap clears.
    await addChannel(userId, 'real@example.com', { verified: true });
    const after = await gatherReadinessInputs(db, userId);
    expect(after.verifiedChannelCount).toBe(1);
    expect(scoreReadiness(after).gaps.map((g) => g.code)).not.toContain('no_verified_channel');
  });

  // The pin gate is CLIENT-side (the assign control only renders for a contact
  // reading 'verified'), so the server never refuses an unconfirmed contact — it
  // simply never gets a share. These prove the count that makes that visible.
  it('counts an enrolled contact with a key but no confirmation', async () => {
    const userId = await makeUser('unconfirmed@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const key = await outerKey(userId, 's1');
    await addItem(userId, 's1', key);

    // Has a published key, never confirmed.
    await db.insert(schema.contacts).values({
      ownerUserId: userId,
      role: 'personal',
      status: 'enrolled',
      displayLabelCiphertext: Buffer.alloc(8, 5),
      displayLabelNonce: Buffer.alloc(24, 6),
      contactX25519Pubkey: Buffer.alloc(32, 7),
    });

    const inputs = await gatherReadinessInputs(db, userId);
    expect(inputs.unconfirmedKeyPinCount).toBe(1);
    expect(scoreReadiness(inputs).gaps.map((g) => g.code)).toContain('contact_key_unconfirmed');
  });

  it('does NOT count a contact still mid-enrolment, or one already confirmed', async () => {
    const userId = await makeUser('midenrol@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const key = await outerKey(userId, 's1');
    await addItem(userId, 's1', key);

    // No key published yet — there is nothing for the owner to confirm, so
    // flagging this would nag them about a step they cannot take.
    await db.insert(schema.contacts).values({
      ownerUserId: userId,
      role: 'personal',
      status: 'enrolled',
      displayLabelCiphertext: Buffer.alloc(8, 5),
      displayLabelNonce: Buffer.alloc(24, 6),
    });
    // Key published AND confirmed — the good state. All three pin columns must be
    // written together: `contacts_key_pin_complete` (migration 0061) refuses a
    // confirmation timestamp without the pin it confirmed, which is what makes
    // `key_pin_confirmed_at IS NULL` a sound proxy for "no pin at all".
    await db.insert(schema.contacts).values({
      ownerUserId: userId,
      role: 'professional',
      status: 'enrolled',
      displayLabelCiphertext: Buffer.alloc(8, 5),
      displayLabelNonce: Buffer.alloc(24, 6),
      contactX25519Pubkey: Buffer.alloc(32, 8),
      keyPinCiphertext: Buffer.alloc(48, 9),
      keyPinNonce: Buffer.alloc(24, 10),
      keyPinConfirmedAt: new Date(),
    });

    const inputs = await gatherReadinessInputs(db, userId);
    expect(inputs.unconfirmedKeyPinCount).toBe(0);
    expect(scoreReadiness(inputs).gaps.map((g) => g.code)).not.toContain('contact_key_unconfirmed');
  });

  it('S3 shares spanning two roles → distinctRoles=2 → no diversity gap', async () => {
    const userId = await makeUser('s3ok@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active' });
    const s3Key = await outerKey(userId, 's3');
    await addItem(userId, 's3', s3Key);
    const roles: ('personal' | 'professional')[] = ['personal', 'personal', 'professional'];
    for (let idx = 1; idx <= 3; idx++) {
      const c = await addContact(userId, roles[idx - 1]!);
      await assignShare(userId, 's3', idx, c);
    }
    const inputs = await gatherReadinessInputs(db, userId);
    expect(inputs.shares.s3.distinctRoles).toBe(2);
    expect(scoreReadiness(inputs).gaps.map((g) => g.code)).not.toContain(
      's3_role_diversity_unsatisfiable',
    );
  });
});
