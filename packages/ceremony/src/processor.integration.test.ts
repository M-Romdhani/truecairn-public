// Integration test: real Postgres, real audit chain, the processor driving a
// full S3 ceremony initiated → released, with a real client-side
// reconstruction of the tier key at the end. Skipped unless DATABASE_URL is set.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import {
  bytesToHex,
  initCrypto,
} from '@truecairn/crypto';
import {
  combineTierKeyForS3Nested,
  createTierKeyCheck,
  generateTierKey,
  splitTierKeyForS3Nested,
  type ReleasePassphraseShare,
  type TierKeyShare,
} from '@truecairn/keys';
import { eq } from 'drizzle-orm';
import {
  commitDueAffirmations,
  processCeremony,
  recordRecipientReconstruction,
} from './processor.js';
import {
  generateCeremonyEphemeralKeypair,
  rewrapShareToRecipient,
  unwrapShareFromCeremony,
} from './ephemeral.js';
import { reconstructTierKey } from './reconstruct.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

const DAY = 24 * 60 * 60 * 1000;

describeIfDb('ceremony processor (integration)', () => {
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
    await sql`TRUNCATE
      ceremony_affirmation_shares, ceremony_recipients, ceremony_affirmations,
      release_ceremonies, release_shares, contacts,
      notification_deliveries, notification_channels,
      engine_state_history, engine_states, audit_log_locks, audit_log, users
      CASCADE`;
  });

  it('drives an S3 ceremony initiated → released and the recipient reconstructs the tier key', async () => {
    const now = new Date('2026-04-01T00:00:00Z');

    // ── fixture: user + engine at the S3 release stage ──────────────────────
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'owner@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id;

    await db.insert(schema.engineStates).values({
      userId,
      state: 'full_release', // cooldown complete for S3
      stateEnteredAt: new Date(now.getTime() - 1 * DAY),
    });

    // Three diverse-role contacts (personal + professional + recovery).
    const contactRows = await db
      .insert(schema.contacts)
      .values([
        { ownerUserId: userId, role: 'personal', status: 'active', displayLabelCiphertext: new Uint8Array([1]), displayLabelNonce: new Uint8Array(24) },
        { ownerUserId: userId, role: 'professional', status: 'active', displayLabelCiphertext: new Uint8Array([2]), displayLabelNonce: new Uint8Array(24) },
        { ownerUserId: userId, role: 'recovery', status: 'active', displayLabelCiphertext: new Uint8Array([3]), displayLabelNonce: new Uint8Array(24) },
      ])
      .returning({ id: schema.contacts.id });
    const [c1, c2, c3] = contactRows.map((c) => c.id);

    // ── crypto: tier key, sentinel, Shamir split ────────────────────────────
    const tierKey = generateTierKey('s3');
    const tierKeyCheck = createTierKeyCheck(tierKey, 1);
    // The release passphrase's evaluation is the nested XOR mask (docs/24); these
    // 32 bytes stand in for the Argon2id output, the leading index byte is dropped.
    const releaseShare: ReleasePassphraseShare = (() => {
      const bytes = new Uint8Array(33);
      bytes[0] = 4;
      for (let i = 1; i <= 32; i++) bytes[i] = (i * 9) & 0xff;
      return { bytes, tier: 's3' } as ReleasePassphraseShare;
    })();
    // Nested split: 3 CONTACT shares of a 2-of-3 over the masked key (no passphrase
    // share among them). Reconstruction needs any 2 contact shares + this mask.
    const shares = splitTierKeyForS3Nested(tierKey, releaseShare);
    const contactShares: TierKeyShare[] = [shares[0]!, shares[1]!, shares[2]!];

    // release_shares rows (the affirmations reference these by id).
    const shareRows = await db
      .insert(schema.releaseShares)
      .values(
        [c1!, c2!, c3!].map((contactId, i) => ({
          userId,
          tier: 's3' as const,
          shareIndex: i + 1,
          shareType: 'contact' as const,
          contactId,
          wrappedShareCiphertext: new Uint8Array([0xaa, i]), // placeholder; not read by the processor
        })),
      )
      .returning({ id: schema.releaseShares.id });

    // ── ceremony + recipient (with ephemeral pubkey) + affirmations ─────────
    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({
        userId,
        tier: 's3',
        status: 'initiated',
        initiatedAt: now,
        syncWindowExpiresAt: new Date(now.getTime() + 14 * DAY),
      })
      .returning({ id: schema.releaseCeremonies.id });
    const ceremonyId = ceremony!.id;

    // The reconstructing recipient generates their ceremony ephemeral keypair
    // on-device; only the pubkey is uploaded.
    const recipientEphemeral = generateCeremonyEphemeralKeypair();
    await db.insert(schema.ceremonyRecipients).values({
      ceremonyId,
      recipientContactId: c1!,
      ephemeralPubkey: recipientEphemeral.publicKey,
      registeredAt: now,
      status: 'reconstructing',
    });

    // Three tentative affirmations whose revocation window has already passed.
    const windowPast = new Date(now.getTime() - 1 * DAY);
    const affirmationRows = await db
      .insert(schema.ceremonyAffirmations)
      .values(
        [c1!, c2!, c3!].map((contactId, i) => ({
          ceremonyId,
          contactId,
          shareId: shareRows[i]!.id,
          status: 'tentative' as const,
          affirmedAt: windowPast,
          revocationWindowExpiresAt: windowPast,
        })),
      )
      .returning({ id: schema.ceremonyAffirmations.id });

    // Each affirming contact re-wraps THEIR share to the recipient ephemeral.
    for (let i = 0; i < 3; i++) {
      const sealed = rewrapShareToRecipient(contactShares[i]!, recipientEphemeral.publicKey);
      await db.insert(schema.ceremonyAffirmationShares).values({
        affirmationId: affirmationRows[i]!.id,
        recipientContactId: c1!,
        sealedShareCiphertext: sealed,
        shareSignature: new Uint8Array(64).fill(i + 1), // placeholder; verified at the API layer
      });
    }

    const ctx = { db, audit, now };

    // ── drive the ceremony ──────────────────────────────────────────────────
    expect(await processCeremony(ctx, ceremonyId)).toBe('collecting_affirmations');
    expect(await commitDueAffirmations(ctx)).toBe(3);
    expect(await processCeremony(ctx, ceremonyId)).toBe('awaiting_outer_key');
    expect(await processCeremony(ctx, ceremonyId)).toBe('reconstructing');

    const afterReconstructing = (
      await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.id, ceremonyId))
    )[0]!;
    expect(afterReconstructing.outerKeyReleasedAt).not.toBeNull();
    expect(afterReconstructing.reconstructionStartedAt).not.toBeNull();

    // ── simulate the recipient's client-side reconstruction ─────────────────
    const sealedShares = await db
      .select({ sealed: schema.ceremonyAffirmationShares.sealedShareCiphertext })
      .from(schema.ceremonyAffirmationShares)
      .where(eq(schema.ceremonyAffirmationShares.recipientContactId, c1!));
    const recoveredShares = sealedShares.map((s) =>
      unwrapShareFromCeremony(s.sealed, recipientEphemeral, 's3'),
    );
    // Nested S3: any 2 of 3 contact shares + the mandatory passphrase mask.
    const result = reconstructTierKey({
      shares: recoveredShares,
      threshold: 2,
      tierKeyCheck,
      generation: 1,
      combine: (subset) => combineTierKeyForS3Nested(subset, releaseShare),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(bytesToHex(result.tierKey)).toBe(bytesToHex(tierKey)); // the property the ceremony rests on
    }

    // ── recipient reports success → ceremony released ───────────────────────
    expect(await recordRecipientReconstruction(ctx, ceremonyId, c1!)).toBe('released');

    const final = (
      await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.id, ceremonyId))
    )[0]!;
    expect(final.status).toBe('released');
    expect(final.releasedAt).not.toBeNull();

    const recipient = (
      await db.select().from(schema.ceremonyRecipients).where(eq(schema.ceremonyRecipients.ceremonyId, ceremonyId))
    )[0]!;
    expect(recipient.status).toBe('released');

    // The whole audit chain the processor wrote verifies.
    const chain = await verifyChain(db, userId as never);
    expect(chain.ok).toBe(true);
  });

  it('fails the ceremony when the sync window expires below threshold', async () => {
    const now = new Date('2026-04-01T00:00:00Z');
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'stall@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id;

    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({
        userId,
        tier: 's3',
        status: 'collecting_affirmations',
        initiatedAt: new Date(now.getTime() - 20 * DAY),
        syncWindowExpiresAt: new Date(now.getTime() - 1 * DAY), // window already past
      })
      .returning({ id: schema.releaseCeremonies.id });

    // Zero committed affirmations → below threshold → failed.
    const status = await processCeremony({ db, audit, now }, ceremony!.id);
    expect(status).toBe('failed');
    const row = (
      await db.select().from(schema.releaseCeremonies).where(eq(schema.releaseCeremonies.id, ceremony!.id))
    )[0]!;
    expect(row.failureReason).toBe('sync_window_expired_below_threshold');
  });

  it('does not advance past threshold without diverse roles', async () => {
    const now = new Date('2026-04-01T00:00:00Z');
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'samerole@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = user!.id;

    // Two contacts of the SAME role (both personal) — not diverse.
    const contactRows = await db
      .insert(schema.contacts)
      .values([
        { ownerUserId: userId, role: 'personal', status: 'active', displayLabelCiphertext: new Uint8Array([1]), displayLabelNonce: new Uint8Array(24) },
        { ownerUserId: userId, role: 'personal', status: 'active', displayLabelCiphertext: new Uint8Array([2]), displayLabelNonce: new Uint8Array(24) },
      ])
      .returning({ id: schema.contacts.id });

    const shareRows = await db
      .insert(schema.releaseShares)
      .values(
        contactRows.map((c, i) => ({
          userId,
          tier: 's2' as const,
          shareIndex: i + 1,
          shareType: 'contact' as const,
          contactId: c.id,
          wrappedShareCiphertext: new Uint8Array([0xbb, i]),
        })),
      )
      .returning({ id: schema.releaseShares.id });

    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({
        userId,
        tier: 's2', // threshold 2
        status: 'collecting_affirmations',
        initiatedAt: now,
        syncWindowExpiresAt: new Date(now.getTime() + 14 * DAY),
      })
      .returning({ id: schema.releaseCeremonies.id });

    await db.insert(schema.ceremonyAffirmations).values(
      contactRows.map((c, i) => ({
        ceremonyId: ceremony!.id,
        contactId: c.id,
        shareId: shareRows[i]!.id,
        status: 'committed' as const,
        committedAt: now,
      })),
    );

    // Count meets threshold (2) but roles are not diverse → stays collecting.
    const status = await processCeremony({ db, audit, now }, ceremony!.id);
    expect(status).toBe('collecting_affirmations');
  });

  // PHASE3_5 §g — Property 1: contact-notification recipient resolution. The
  // initiated → collecting_affirmations transition enqueues one
  // ceremony_affirmation_request per (affirming contact-user × verified channel).
  // Contacts hold release_shares for the tier; only their own users' VERIFIED,
  // non-removed channels are targeted. N contacts × M verified channels = N×M
  // deliveries; an unverified channel is never selected.
  it('enqueues one ceremony_affirmation_request per (contact-user × verified channel); unverified excluded', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const N = 2;
    const Mverified = 2;

    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner-notify@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const ownerId = owner!.id;

    const contactIds: string[] = [];
    const verifiedChannelIds: string[] = [];
    const unverifiedChannelIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const [cu] = await db
        .insert(schema.users)
        .values({ email: `contact${i}-notify@example.com`, accountStatus: 'active' })
        .returning({ id: schema.users.id });
      const contactUserId = cu!.id;
      const [contact] = await db
        .insert(schema.contacts)
        .values({
          ownerUserId: ownerId,
          contactUserId,
          role: i === 0 ? 'personal' : 'professional',
          status: 'enrolled',
          displayLabelCiphertext: new Uint8Array([i + 1]),
          displayLabelNonce: new Uint8Array(24),
        })
        .returning({ id: schema.contacts.id });
      contactIds.push(contact!.id);
      for (let j = 0; j < Mverified; j++) {
        const [ch] = await db
          .insert(schema.notificationChannels)
          .values({
            userId: contactUserId,
            channelType: j === 0 ? 'email' : 'sms',
            destination: `c${i}-ch${j}@example.com`,
            destinationHash: channelDestinationHash(
              j === 0 ? 'email' : 'sms',
              `c${i}-ch${j}@example.com`,
            ),
            verified: true,
          })
          .returning({ id: schema.notificationChannels.id });
        verifiedChannelIds.push(ch!.id);
      }
      // An unverified channel for the same contact — must NOT be notified.
      const [unv] = await db
        .insert(schema.notificationChannels)
        .values({
          userId: contactUserId,
          channelType: 'push',
          destination: `c${i}-unverified`,
          destinationHash: channelDestinationHash('push', `c${i}-unverified`),
          verified: false,
        })
        .returning({ id: schema.notificationChannels.id });
      unverifiedChannelIds.push(unv!.id);
    }

    // Active contact-type release shares for tier s2 binding owner → contacts.
    await db.insert(schema.releaseShares).values(
      contactIds.map((contactId, i) => ({
        userId: ownerId,
        tier: 's2' as const,
        shareIndex: i + 1,
        shareType: 'contact' as const,
        contactId,
        wrappedShareCiphertext: new Uint8Array([0xcc, i]),
      })),
    );

    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({
        userId: ownerId,
        tier: 's2',
        status: 'initiated',
        initiatedAt: now,
        syncWindowExpiresAt: new Date(now.getTime() + 14 * DAY),
      })
      .returning({ id: schema.releaseCeremonies.id });

    // Drive the affirmation-collection transition (contacts_notified).
    expect(await processCeremony({ db, audit, now }, ceremony!.id)).toBe('collecting_affirmations');

    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.relatedEntityId, ceremony!.id));
    expect(deliveries).toHaveLength(N * Mverified); // 2 × 2 = 4
    expect(deliveries.every((d) => d.purpose === 'ceremony_affirmation_request')).toBe(true);
    expect(deliveries.every((d) => d.status === 'queued')).toBe(true);
    expect(deliveries.every((d) => d.relatedEntityType === 'release_ceremony')).toBe(true);
    // Every targeted channel is verified; no unverified channel is ever targeted.
    const targeted = new Set(deliveries.map((d) => d.channelId));
    expect(targeted.size).toBe(N * Mverified);
    expect([...targeted].every((id) => verifiedChannelIds.includes(id))).toBe(true);
    expect(unverifiedChannelIds.some((id) => targeted.has(id))).toBe(false);
  });

  // Matrix enforcement for contact_notices (docs/26 §4 follow-on): a contact
  // who opted one of THEIR channels out of contact_notices is not notified
  // there — but their other channel still is. The matrix narrows, never blanks.
  it('skips a contact channel opted out of contact_notices; the same contact still hears elsewhere', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner-matrix@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const ownerId = owner!.id;
    const [cu] = await db
      .insert(schema.users)
      .values({ email: 'contact-matrix@example.com', accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const contactUserId = cu!.id;
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId,
        role: 'personal',
        status: 'enrolled',
        displayLabelCiphertext: new Uint8Array([1]),
        displayLabelNonce: new Uint8Array(24),
      })
      .returning({ id: schema.contacts.id });

    const channelIds: string[] = [];
    for (const [j, type] of (['email', 'sms'] as const).entries()) {
      const [ch] = await db
        .insert(schema.notificationChannels)
        .values({
          userId: contactUserId,
          channelType: type,
          destination: `matrix-ch${j}@example.com`,
          destinationHash: channelDestinationHash(type, `matrix-ch${j}@example.com`),
          verified: true,
        })
        .returning({ id: schema.notificationChannels.id });
      channelIds.push(ch!.id);
    }
    // The contact mutes ceremony requests on their first channel.
    await db.insert(schema.channelPreferences).values({
      userId: contactUserId,
      channelId: channelIds[0]!,
      purposeClass: 'contact_notices',
      enabled: false,
    });

    await db.insert(schema.releaseShares).values({
      userId: ownerId,
      tier: 's2' as const,
      shareIndex: 1,
      shareType: 'contact' as const,
      contactId: contact!.id,
      wrappedShareCiphertext: new Uint8Array([0xcc, 1]),
    });
    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({
        userId: ownerId,
        tier: 's2',
        status: 'initiated',
        initiatedAt: now,
        syncWindowExpiresAt: new Date(now.getTime() + 14 * DAY),
      })
      .returning({ id: schema.releaseCeremonies.id });

    expect(await processCeremony({ db, audit, now }, ceremony!.id)).toBe('collecting_affirmations');

    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.relatedEntityId, ceremony!.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.channelId).toBe(channelIds[1]);
  });
});
