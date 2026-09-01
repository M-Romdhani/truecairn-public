import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import {
  buildShareSigningInput,
  cancelCeremoniesForUser,
  commitDueAffirmations,
  createReleaseReviewCeremonies,
  generateCeremonyEphemeralKeypair,
  reconstructTierKey,
  rewrapShareToRecipient,
  tickCeremonies,
  unwrapShareFromCeremony,
  type CeremonyEngineSignal,
  type CeremonyEphemeralKeypair,
} from '@truecairn/ceremony';
import {
  ed25519KeypairFromSeed,
  ed25519Sign,
  fromBase64Url,
  generateX25519Keypair,
  initCrypto,
  randomBytes,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  type X25519Keypair,
} from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { applyEvent, DbChannelLookup, loadRow } from '@truecairn/engine';
import {
  combineTierKeyForS3Nested,
  createTierKeyCheck,
  decryptItemContent,
  deriveReleasePassphraseShare,
  encryptItemContent,
  generateItemKey,
  generateReleaseKdfSalt,
  generateTierKey,
  releaseShareAsTierShare,
  RELEASE_SHARE_INDEX_S2,
  RELEASE_SHARE_INDEX_S3,
  S3_NESTED_CONTACT_SHARES,
  S3_NESTED_CONTACT_THRESHOLD,
  splitTierKeyForS2,
  splitTierKeyForS3Nested,
  unwrapItemKey,
  wrapItemKey,
  type ReleaseKdfSalt,
  type ReleasePassphrase,
  type ReleasePassphraseShare,
  type TierKeyShare,
  type UnwrappedTierKey,
} from '@truecairn/keys';
import type { ContactRole, UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

// Released items are bound to their id in both AAD layers (F3); these tests
// store and read back one fixed item.
const ITEM_UUID = 'dddddddd-1111-4222-8333-999999999999';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// CEREMONY_COMPLETION Checkpoint B — the Shamir share-collection path at the API
// layer, with REAL crypto end to end: a real constrained split (the Argon2id
// release-passphrase share fixing the last index), real X25519 seals for the
// contact shares, real Ed25519 share signatures, and real subset reconstruction
// validated against the tier-key sentinel. The browser E2E re-proves the same
// properties through the UI; this is the math + state-machine gate.
describeIfDb('S2/S3 share collection + reconstruction (CEREMONY_COMPLETION B)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let audit: AuditLogWriter;
  let channels: DbChannelLookup;
  const config = loadConfig({
    TOTP_KEK: Buffer.alloc(32, 7).toString('base64'),
    CEREMONY_REVOCATION_WINDOW_MS: '1000',
    CEREMONY_SYNC_WINDOW_MS: '60000',
  });
  const WINDOWS = { syncWindowMs: 60_000, revocationWindowMs: 1_000 };

  // The release-passphrase shares constrain the splits. Argon2id at production
  // params is deliberately slow — derive once per tier and reuse across tests
  // (the share value depends only on passphrase + salt, not on any DB state).
  const RELEASE_PASSPHRASE = new TextEncoder().encode('the-release-passphrase');
  let releaseSalt: ReleaseKdfSalt;
  let releaseShareS2: ReleasePassphraseShare;
  let releaseShareS3: ReleasePassphraseShare;

  const signalEngine = async (
    txdb: Database,
    userId: UserId,
    sig: CeremonyEngineSignal,
    when: Date,
  ): Promise<void> => {
    const row = await loadRow(txdb, userId);
    if (row === null) return;
    const event =
      sig === 'release_review_verification_passed'
        ? ({ kind: 'release_review_verification_passed' } as const)
        : sig === 'release_review_verification_failed'
          ? ({ kind: 'release_review_verification_failed' } as const)
          : ({ kind: 'dispute_raised' } as const);
    await applyEvent(row, event, { db: txdb, audit, channels, now: when });
  };

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    audit = new AuditLogWriter(await resolveServerSigner(db));
    channels = new DbChannelLookup(db);
    releaseSalt = generateReleaseKdfSalt();
    releaseShareS2 = deriveReleasePassphraseShare(
      RELEASE_PASSPHRASE as ReleasePassphrase,
      releaseSalt,
      's2',
      RELEASE_SHARE_INDEX_S2,
    );
    releaseShareS3 = deriveReleasePassphraseShare(
      RELEASE_PASSPHRASE as ReleasePassphrase,
      releaseSalt,
      's3',
      RELEASE_SHARE_INDEX_S3,
    );
  }, 120_000);
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE release_ceremonies, ceremony_affirmations, ceremony_recipients, ceremony_affirmation_shares, release_shares, user_tier_keys, outer_layer_keys, s1_tier_key_envelopes, engine_states, contacts, sessions, audit_log_locks, audit_log, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  interface SeededContact {
    contactId: string;
    cookie: string;
    edSecret: Uint8Array;
    xkp: X25519Keypair;
  }
  interface Seeded {
    ownerId: UserId;
    tierKey: UnwrappedTierKey;
    contacts: SeededContact[];
  }

  // Owner in release_review whose S2/S3 tier key is REALLY split: the release-
  // passphrase share fixes the last index; each contact share is sealed to that
  // contact's real X25519 pubkey exactly as the assignment client does.
  async function seedShamirRelease(tier: 's2' | 's3', roles: ContactRole[]): Promise<Seeded> {
    const [owner] = await db
      .insert(schema.users)
      .values({ email: `o${Date.now()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const ownerId = owner!.id as UserId;
    await db.insert(schema.engineStates).values({ userId: ownerId, state: 'release_review' });

    const tierKey = generateTierKey(tier);
    const releaseShare = tier === 's2' ? releaseShareS2 : releaseShareS3;
    // S2 (flat 2-of-3): the passphrase share fixes the last index; filter it out
    // so only contact shares are sealed. S3 (nested, docs/24): the passphrase is
    // the XOR mask and the contacts hold a 2-of-3 split of the masked key — every
    // returned share is a contact share, no passphrase share among them.
    const shares =
      tier === 's2'
        ? splitTierKeyForS2(tierKey, releaseShare)
        : splitTierKeyForS3Nested(tierKey, releaseShare);
    const contactShares =
      tier === 's2' ? shares.filter((s) => s.bytes[0] !== RELEASE_SHARE_INDEX_S2) : shares;
    if (contactShares.length !== roles.length) {
      throw new Error(`seed needs ${contactShares.length} contacts for ${tier}, got ${roles.length}`);
    }

    // The sentinel the recipient validates reconstruction against.
    const check = createTierKeyCheck(tierKey, 1);
    const [olk] = await db
      .insert(schema.outerLayerKeys)
      .values({
        userId: ownerId,
        tier,
        kekId: 'test-kek',
        outerKeyEncrypted: randomBytes(48),
        outerKeyNonce: randomBytes(24),
        outerKeyEncryptionAad: randomBytes(16),
      })
      .returning({ id: schema.outerLayerKeys.id });
    await db.insert(schema.userTierKeys).values({
      userId: ownerId,
      tier,
      tierKeyWrappedByMaster: randomBytes(48),
      tierKeyMasterNonce: randomBytes(24),
      outerLayerKeyId: olk!.id,
      shamirThreshold: tier === 's2' ? 2 : S3_NESTED_CONTACT_THRESHOLD,
      shamirShareCount: tier === 's2' ? 3 : S3_NESTED_CONTACT_SHARES,
      generation: 1,
      tierKeyCheckPlaintext: check.plaintext,
      tierKeyCheckCiphertext: check.ciphertext,
      tierKeyCheckNonce: check.nonce,
    });

    const contacts: SeededContact[] = [];
    for (let i = 0; i < roles.length; i++) {
      const [cu] = await db
        .insert(schema.users)
        .values({ email: `c${i}-${Date.now()}@x.com`, accountStatus: 'active' })
        .returning({ id: schema.users.id });
      const edKp = ed25519KeypairFromSeed(randomBytes(32));
      const xkp = generateX25519Keypair();
      const [contact] = await db
        .insert(schema.contacts)
        .values({
          ownerUserId: ownerId,
          contactUserId: cu!.id,
          role: roles[i]!,
          status: 'enrolled',
          displayLabelCiphertext: randomBytes(16),
          displayLabelNonce: randomBytes(12),
          contactEd25519Pubkey: edKp.publicKey,
          contactX25519Pubkey: xkp.publicKey,
        })
        .returning({ id: schema.contacts.id });
      const share = contactShares[i]!;
      await db.insert(schema.releaseShares).values({
        userId: ownerId,
        tier,
        shareIndex: share.bytes[0]!,
        shareType: 'contact',
        contactId: contact!.id,
        wrappedShareCiphertext: sealedBoxEncrypt({
          recipientPublicKey: xkp.publicKey,
          plaintext: share.bytes,
        }),
      });
      const { token } = await createSession(db, { userId: cu!.id as UserId, now: new Date() });
      contacts.push({ contactId: contact!.id, cookie: token, edSecret: edKp.secretKey, xkp });
    }
    return { ownerId, tierKey, contacts };
  }

  // A designated, NON-affirming beneficiary (backlog #2): an enrolled contact
  // that holds no share but is named to receive the tier. Mirrors a real enrol +
  // the owner's designation row (release_beneficiaries).
  async function seedBeneficiary(ownerId: UserId, tier: 's2' | 's3'): Promise<SeededContact> {
    const [cu] = await db
      .insert(schema.users)
      .values({ email: `ben${Date.now()}-${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const edKp = ed25519KeypairFromSeed(randomBytes(32));
    const xkp = generateX25519Keypair();
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        ownerUserId: ownerId,
        contactUserId: cu!.id,
        role: 'recovery',
        status: 'enrolled',
        displayLabelCiphertext: randomBytes(16),
        displayLabelNonce: randomBytes(12),
        contactEd25519Pubkey: edKp.publicKey,
        contactX25519Pubkey: xkp.publicKey,
      })
      .returning({ id: schema.contacts.id });
    await db
      .insert(schema.releaseBeneficiaries)
      .values({ userId: ownerId, tier, contactId: contact!.id });
    const { token } = await createSession(db, { userId: cu!.id as UserId, now: new Date() });
    return { contactId: contact!.id, cookie: token, edSecret: edKp.secretKey, xkp };
  }

  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });

  async function ceremonyOf(ownerId: UserId): Promise<{ id: string; status: string }> {
    const [c] = await db
      .select()
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, ownerId));
    if (!c) throw new Error('no ceremony');
    return { id: c.id, status: c.status };
  }
  async function engineState(ownerId: UserId): Promise<string> {
    const [e] = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, ownerId));
    return e!.state;
  }

  async function affirmVia(ceremonyId: string, c: SeededContact): Promise<void> {
    const opt = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${ceremonyId}/affirm/options`,
      cookies: as(c.cookie),
    });
    expect(opt.statusCode).toBe(200);
    const signature = Buffer.from(
      ed25519Sign(
        new Uint8Array(
          Buffer.concat([
            Buffer.from(fromBase64Url(opt.json().challenge as string)),
            Buffer.from(ceremonyId, 'utf8'),
          ]),
        ),
        c.edSecret,
      ),
    ).toString('base64');
    const aff = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${ceremonyId}/affirm`,
      cookies: as(c.cookie),
      payload: { challengeId: opt.json().challengeId, signature },
    });
    expect(aff.statusCode).toBe(200);
  }

  // The affirming contact's device-side seal: fetch seal-context, open the OWN
  // wrapped share with the contact X25519 key, re-seal to the recipient's
  // ephemeral pubkey, sign the binding, upload.
  async function sealVia(
    ceremonyId: string,
    c: SeededContact,
    recipientContactId: string,
  ): Promise<TierKeyShare> {
    const ctxRes = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${ceremonyId}/seal-context`,
      cookies: as(c.cookie),
    });
    expect(ctxRes.statusCode).toBe(200);
    const sealCtx = ctxRes.json() as {
      affirmationId: string;
      tier: 's2' | 's3';
      wrappedShareCiphertext: string;
      recipients: Array<{ recipientContactId: string; ephemeralPubkey: string }>;
    };
    const recipient = sealCtx.recipients.find((r) => r.recipientContactId === recipientContactId);
    expect(recipient).toBeDefined();
    const shareBytes = sealedBoxDecrypt({
      recipientPublicKey: c.xkp.publicKey,
      recipientSecretKey: c.xkp.secretKey,
      ciphertext: new Uint8Array(Buffer.from(sealCtx.wrappedShareCiphertext, 'base64')),
    });
    const share = { bytes: shareBytes, tier: sealCtx.tier } as TierKeyShare;
    const recipientEphemeralPubkey = new Uint8Array(Buffer.from(recipient!.ephemeralPubkey, 'base64'));
    const sealed = rewrapShareToRecipient(share, recipientEphemeralPubkey);
    const signature = ed25519Sign(
      buildShareSigningInput({
        affirmationId: sealCtx.affirmationId,
        recipientContactId,
        recipientEphemeralPubkey,
        sealedShareCiphertext: sealed,
      }),
      c.edSecret,
    );
    const res = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${ceremonyId}/seal-share`,
      cookies: as(c.cookie),
      payload: {
        recipientContactId,
        sealedShareCiphertext: Buffer.from(sealed).toString('base64'),
        shareSignature: Buffer.from(signature).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(200);
    return share;
  }

  async function registerEphemeral(
    ceremonyId: string,
    c: SeededContact,
  ): Promise<CeremonyEphemeralKeypair> {
    const kp = generateCeremonyEphemeralKeypair();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${ceremonyId}/recipient/ephemeral`,
      cookies: as(c.cookie),
      payload: { ephemeralPubkey: Buffer.from(kp.publicKey).toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    return kp;
  }

  // Drive collecting → consensus → reconstructing for an already-affirmed
  // ceremony: commit the due affirmations, tick consensus, satisfy the tier's
  // engine release stage (DB precondition — the E2E proves the real ladder),
  // tick the outer key open.
  async function driveToReconstructing(ownerId: UserId, tier: 's2' | 's3'): Promise<void> {
    const t1 = new Date(Date.now() + 5_000);
    await commitDueAffirmations({ db, audit, now: t1 });
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    expect(await engineState(ownerId)).toBe('limited_release');
    expect((await ceremonyOf(ownerId)).status).toBe('awaiting_outer_key');

    // The outer key must NOT open at limited_release for S2/S3 (the engine
    // ladder gates per tier) — the gate stays closed across this tick.
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    expect((await ceremonyOf(ownerId)).status).toBe('awaiting_outer_key');

    await db
      .update(schema.engineStates)
      .set({ state: tier === 's2' ? 'staged_release' : 'full_release' })
      .where(eq(schema.engineStates.userId, ownerId));
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    expect((await ceremonyOf(ownerId)).status).toBe('reconstructing');
  }

  async function getShares(
    ceremonyId: string,
    c: SeededContact,
  ): Promise<ReturnType<FastifyInstance['inject']>> {
    return app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${ceremonyId}/shares`,
      cookies: as(c.cookie),
    });
  }

  function reconstructFromResponse(
    body: {
      tier: 's2' | 's3';
      threshold: number;
      generation: number;
      tierKeyCheck: { plaintext: string; ciphertext: string; nonce: string };
      shares: Array<{ sealedShareCiphertext: string }>;
    },
    ephemeral: CeremonyEphemeralKeypair,
  ): ReturnType<typeof reconstructTierKey> {
    const shares = body.shares.map((s) =>
      unwrapShareFromCeremony(
        new Uint8Array(Buffer.from(s.sealedShareCiphertext, 'base64')),
        ephemeral,
        body.tier,
      ),
    );
    return reconstructTierKey({
      shares,
      threshold: body.threshold,
      generation: body.generation,
      tierKeyCheck: {
        plaintext: new Uint8Array(Buffer.from(body.tierKeyCheck.plaintext, 'base64')),
        ciphertext: new Uint8Array(Buffer.from(body.tierKeyCheck.ciphertext, 'base64')),
        nonce: new Uint8Array(Buffer.from(body.tierKeyCheck.nonce, 'base64')),
      },
    });
  }

  // PROPERTY 1 — S2 2-of-3: the full Shamir path reconstructs the EXACT tier key.
  it('S2 (2-of-3): seal → temporal gate → threshold subset reconstructs the tier key and decrypts a known item', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'professional']);
    const { ownerId, tierKey, contacts } = seeded;
    const [c1, c2] = contacts as [SeededContact, SeededContact];

    // A known item encrypted under the REAL tier key, as the vault client would.
    const itemKey = generateItemKey();
    const wrappedItemKey = wrapItemKey(itemKey, tierKey, ITEM_UUID);
    const content = encryptItemContent(new TextEncoder().encode('the S2 secret'), itemKey);

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);
    expect(cer.status).toBe('collecting_affirmations');

    // Gate closed while collecting; seal-context refused before affirming.
    expect((await getShares(cer.id, c1)).statusCode).toBe(403);
    const early = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/seal-context`,
      cookies: as(c1.cookie),
    });
    expect(early.statusCode).toBe(409);

    // Recipient (an affirming contact — the B decision) registers early.
    const ephemeral = await registerEphemeral(cer.id, c1);

    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);
    // Both seal while TENTATIVE — the contribution rides the affirmation.
    await sealVia(cer.id, c1, c1.contactId);
    await sealVia(cer.id, c2, c1.contactId);

    // Still gated: tentative seals exist, but no consensus yet.
    expect((await getShares(cer.id, c1)).statusCode).toBe(403);

    await driveToReconstructing(ownerId, 's2');

    const sharesRes = await getShares(cer.id, c1);
    expect(sharesRes.statusCode).toBe(200);
    const body = sharesRes.json();
    expect(body.threshold).toBe(2);
    expect(body.shares).toHaveLength(2);

    const result = reconstructFromResponse(body, ephemeral);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.tierKey).equals(Buffer.from(tierKey))).toBe(true);

    // The reconstructed key opens the owner's real content.
    const recoveredKey = unwrapItemKey(wrappedItemKey, result.tierKey, { version: 2, itemId: ITEM_UUID });
    const plaintext = decryptItemContent(content, recoveredKey);
    expect(new TextDecoder().decode(plaintext)).toBe('the S2 secret');

    const done = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${cer.id}/reconstructed`,
      cookies: as(c1.cookie),
    });
    expect(done.statusCode).toBe(200);
    expect((await ceremonyOf(ownerId)).status).toBe('released');
  });

  // C2 / QA 2026-07-21 D9: the FIRST recipient's success flips the ceremony to
  // 'released', and the SECOND recipient must still complete their own
  // independent retrieval — the first recovery must never lock the rest out. And
  // a lagging recipient may still PREPARE (seal-context/seal-share/register)
  // while the reconstruction gate is open, but never once the ceremony is truly
  // terminal (cancelled/failed).
  it('S2: after the first recipient reconstructs (released), the second still retrieves; late contribution allowed within the gate, refused when cancelled', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'professional']);
    const { ownerId, tierKey, contacts } = seeded;
    const [c1, c2] = contacts as [SeededContact, SeededContact];

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);
    expect(cer.status).toBe('collecting_affirmations');

    // BOTH contacts are recipients and register their own ephemerals.
    const e1 = await registerEphemeral(cer.id, c1);
    const e2 = await registerEphemeral(cer.id, c2);
    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);
    // Each contact seals its share to BOTH recipients, so either recipient holds
    // a full 2-of-3 subset sealed to their own ephemeral.
    await sealVia(cer.id, c1, c1.contactId);
    await sealVia(cer.id, c1, c2.contactId);
    await sealVia(cer.id, c2, c1.contactId);
    await sealVia(cer.id, c2, c2.contactId);

    await driveToReconstructing(ownerId, 's2');

    // First recipient reconstructs → ceremony flips to 'released'.
    const first = reconstructFromResponse((await getShares(cer.id, c1)).json(), e1);
    expect(first.ok).toBe(true);
    const done1 = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${cer.id}/reconstructed`,
      cookies: as(c1.cookie),
    });
    expect(done1.statusCode).toBe(200);
    expect((await ceremonyOf(ownerId)).status).toBe('released');

    // THE D9 REGRESSION: the second recipient must still fetch and reconstruct.
    const secondShares = await getShares(cer.id, c2);
    expect(secondShares.statusCode).toBe(200); // NOT 403 gate-closed
    const second = reconstructFromResponse(secondShares.json(), e2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(Buffer.from(second.tierKey).equals(Buffer.from(tierKey))).toBe(true);
    const done2 = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${cer.id}/reconstructed`,
      cookies: as(c2.cookie),
    });
    expect(done2.statusCode).toBe(200);

    // Late CONTRIBUTION is still accepted while the gate is open after 'released'
    // (a lagging recipient could still be catching up) — seal-context is 200,
    // not the old 409 "no longer active".
    const lateCtx = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/seal-context`,
      cookies: as(c1.cookie),
    });
    expect(lateCtx.statusCode).toBe(200);

    // But a truly terminal ceremony (cancelled) refuses — fail closed.
    await db
      .update(schema.releaseCeremonies)
      .set({ status: 'cancelled' })
      .where(eq(schema.releaseCeremonies.id, cer.id));
    const afterCancel = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/seal-context`,
      cookies: as(c1.cookie),
    });
    expect(afterCancel.statusCode).toBe(409);
  });

  // PROPERTY 2 — S3 nested (docs/24): any 2 of 3 diverse contacts PLUS the
  // MANDATORY release passphrase reconstruct the tier key; colluding contacts —
  // even one party holding all three shares — cannot, because the passphrase is
  // the XOR mask, not a Shamir share. This is the anti-collusion guarantee, in
  // code, plus the negative test docs/24 calls for.
  it('S3 (nested 2-of-3 + mandatory passphrase): 2 contacts + passphrase reconstruct; 3 colluding contacts alone cannot', async () => {
    const seeded = await seedShamirRelease('s3', ['personal', 'professional', 'recovery']);
    const { ownerId, tierKey, contacts } = seeded;
    const [c1, c2, c3] = contacts as [SeededContact, SeededContact, SeededContact];

    // The owner's release-passphrase KDF salt (the mask source). Production stores
    // it at enrollment; the seed helper doesn't, so add it with the SAME salt that
    // constrained the split — the /release-salt route serves it for S3.
    await db.insert(schema.userKeyMaterial).values({
      userId: ownerId,
      masterPassphraseSalt: randomBytes(16),
      masterKeyWrappedByPassphrase: randomBytes(48),
      masterKeyPassphraseNonce: randomBytes(24),
      recoveryCodeSalt: randomBytes(16),
      masterKeyWrappedByRecovery: randomBytes(48),
      masterKeyRecoveryNonce: randomBytes(24),
      releasePassphraseSalt: releaseSalt,
      auditSigningPubkey: randomBytes(32),
    });

    // A known item under the REAL tier key.
    const itemKey = generateItemKey();
    const wrappedItemKey = wrapItemKey(itemKey, tierKey, ITEM_UUID);
    const content = encryptItemContent(new TextEncoder().encode('the S3 secret'), itemKey);

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    const ephemeral = await registerEphemeral(cer.id, c1);
    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);
    await affirmVia(cer.id, c3);
    // All three seal to the collecting recipient (c1) — the worst case for
    // collusion: one party ends up holding every contact share.
    await sealVia(cer.id, c1, c1.contactId);
    await sealVia(cer.id, c2, c1.contactId);
    await sealVia(cer.id, c3, c1.contactId);

    await driveToReconstructing(ownerId, 's3');

    const sharesRes = await getShares(cer.id, c1);
    expect(sharesRes.statusCode).toBe(200);
    const body = sharesRes.json();
    expect(body.threshold).toBe(2); // nested CONTACT threshold (the passphrase is the +mask)
    expect(body.shares).toHaveLength(3);

    // NEGATIVE (collusion): the flat combine of the masked shares — even all three —
    // yields only the masked secret and fails the sentinel. Contacts alone never
    // reach S3 without the passphrase.
    const collusion = reconstructFromResponse(body, ephemeral);
    expect(collusion.ok).toBe(false);
    if (!collusion.ok) expect(collusion.reason).toBe('shares_unverifiable');

    // The /release-salt route is load-bearing for S3 (the mask source), served to
    // the committed recipient once the gate is open.
    const saltRes = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/release-salt`,
      cookies: as(c1.cookie),
    });
    expect(saltRes.statusCode).toBe(200);
    const servedSalt = new Uint8Array(
      Buffer.from(saltRes.json().releasePassphraseSalt as string, 'base64'),
    );
    const mask = deriveReleasePassphraseShare(
      RELEASE_PASSPHRASE as ReleasePassphrase,
      servedSalt as ReleaseKdfSalt,
      's3',
      RELEASE_SHARE_INDEX_S3,
    );

    // POSITIVE: with the mandatory passphrase mask, any 2-of-3 contact shares
    // reconstruct the EXACT tier key (the nested combine drives the same subset
    // retry; here all three are present and any valid pair verifies).
    const unwrapped = body.shares.map((s: { sealedShareCiphertext: string }) =>
      unwrapShareFromCeremony(
        new Uint8Array(Buffer.from(s.sealedShareCiphertext, 'base64')),
        ephemeral,
        's3',
      ),
    );
    const result = reconstructTierKey({
      shares: unwrapped,
      threshold: body.threshold,
      generation: body.generation,
      tierKeyCheck: {
        plaintext: new Uint8Array(Buffer.from(body.tierKeyCheck.plaintext, 'base64')),
        ciphertext: new Uint8Array(Buffer.from(body.tierKeyCheck.ciphertext, 'base64')),
        nonce: new Uint8Array(Buffer.from(body.tierKeyCheck.nonce, 'base64')),
      },
      combine: (subset) => combineTierKeyForS3Nested(subset, mask),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.tierKey).equals(Buffer.from(tierKey))).toBe(true);

    const recoveredKey = unwrapItemKey(wrappedItemKey, result.tierKey, { version: 2, itemId: ITEM_UUID });
    expect(new TextDecoder().decode(decryptItemContent(content, recoveredKey))).toBe('the S3 secret');
  });

  // PROPERTY 3 — fail-closed below threshold: the ceremony fails at the sync
  // window, the engine returns to review (never advances), and the only share
  // in hand is insufficient to reconstruct.
  it('threshold-minus-one fails closed: ceremony failed, engine review_required, insufficient_shares', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'professional']);
    const { ownerId, contacts } = seeded;
    const [c1] = contacts as [SeededContact, SeededContact];

    const t0 = new Date();
    await createReleaseReviewCeremonies(
      { db, audit, now: t0, windows: { syncWindowMs: 8_000, revocationWindowMs: 1_000 } },
      10,
    );
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    const ephemeral = await registerEphemeral(cer.id, c1);
    await affirmVia(cer.id, c1); // only ONE of the two
    const share = await sealVia(cer.id, c1, c1.contactId);

    const t1 = new Date(Date.now() + 5_000); // commits c1, still inside the window
    await commitDueAffirmations({ db, audit, now: t1 });
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    expect((await ceremonyOf(ownerId)).status).toBe('collecting_affirmations'); // 1 < 2: no advance
    expect(await engineState(ownerId)).toBe('release_review');

    const past = new Date(t0.getTime() + 60_000); // past the sync window
    await tickCeremonies({ db, audit, now: past, signalEngine }, 10);
    expect((await ceremonyOf(ownerId)).status).toBe('failed');
    expect(await engineState(ownerId)).toBe('review_required');

    // The gate NEVER opened over the Shamir path.
    expect((await getShares(cer.id, c1)).statusCode).toBe(403);

    // And the math agrees: one share cannot reconstruct.
    const tk = await db.select().from(schema.userTierKeys).where(eq(schema.userTierKeys.userId, ownerId));
    const result = reconstructTierKey({
      shares: [share],
      threshold: 2,
      generation: 1,
      tierKeyCheck: {
        plaintext: tk[0]!.tierKeyCheckPlaintext,
        ciphertext: tk[0]!.tierKeyCheckCiphertext,
        nonce: tk[0]!.tierKeyCheckNonce,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_shares');
    void ephemeral;
  });

  // PROPERTY 4 — diverse-role: threshold-count same-role commitments do NOT
  // reach consensus; the ceremony fails closed at the window.
  it('threshold count but same-role: consensus rejected, fail-closed at window expiry', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'personal']);
    const { ownerId, contacts } = seeded;
    const [c1, c2] = contacts as [SeededContact, SeededContact];

    const t0 = new Date();
    await createReleaseReviewCeremonies(
      { db, audit, now: t0, windows: { syncWindowMs: 8_000, revocationWindowMs: 1_000 } },
      10,
    );
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);

    const t1 = new Date(Date.now() + 5_000);
    await commitDueAffirmations({ db, audit, now: t1 });
    await tickCeremonies({ db, audit, now: t1, signalEngine }, 10);
    // BOTH committed — but a single role does not constitute consensus.
    const committed = await db
      .select()
      .from(schema.ceremonyAffirmations)
      .where(
        and(
          eq(schema.ceremonyAffirmations.ceremonyId, cer.id),
          eq(schema.ceremonyAffirmations.status, 'committed'),
        ),
      );
    expect(committed).toHaveLength(2);
    expect((await ceremonyOf(ownerId)).status).toBe('collecting_affirmations');
    expect(await engineState(ownerId)).toBe('release_review');

    const past = new Date(t0.getTime() + 60_000);
    await tickCeremonies({ db, audit, now: past, signalEngine }, 10);
    expect((await ceremonyOf(ownerId)).status).toBe('failed');
    expect(await engineState(ownerId)).toBe('review_required');
    expect((await getShares(cer.id, c1)).statusCode).toBe(403);
  });

  // PROPERTY 5 — abandon-on-cancel over the Shamir path: sealed shares exist,
  // nothing is ever released, the gate stays shut.
  it('abandon-on-cancel: sealed shares are released to no one', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'professional']);
    const { ownerId, contacts } = seeded;
    const [c1, c2] = contacts as [SeededContact, SeededContact];

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    await registerEphemeral(cer.id, c1);
    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);
    await sealVia(cer.id, c1, c1.contactId);
    await sealVia(cer.id, c2, c1.contactId);

    // The owner returns. Everything stops, atomically.
    await cancelCeremoniesForUser(db, audit, ownerId, 'user_returned', new Date());

    expect((await ceremonyOf(ownerId)).status).toBe('cancelled');
    const sealedRows = await db
      .select()
      .from(schema.ceremonyAffirmationShares)
      .innerJoin(
        schema.ceremonyAffirmations,
        eq(schema.ceremonyAffirmationShares.affirmationId, schema.ceremonyAffirmations.id),
      )
      .where(eq(schema.ceremonyAffirmations.ceremonyId, cer.id));
    expect(sealedRows).toHaveLength(2); // the seals happened…
    expect((await getShares(cer.id, c1)).statusCode).toBe(403); // …but the gate never opens
    const released = await db
      .select()
      .from(schema.ceremonyRecipients)
      .where(eq(schema.ceremonyRecipients.status, 'released'));
    expect(released).toHaveLength(0);
    const [e] = await db.select().from(schema.engineStates).where(eq(schema.engineStates.userId, ownerId));
    expect(e!.currentCeremonyId).toBeNull();
  });

  // PROPERTY 6 — the upload boundary: a signature that doesn't verify against
  // the server-known recipient key is rejected; an unregistered recipient
  // cannot be sealed to; a non-committed affirmer cannot collect.
  it('seal/collect boundaries: bad signature 401, unregistered recipient 409, non-affirmer cannot collect', async () => {
    const seeded = await seedShamirRelease('s3', ['personal', 'professional', 'recovery']);
    const { ownerId, contacts } = seeded;
    const [c1, c2, c3] = contacts as [SeededContact, SeededContact, SeededContact];

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    const ephemeral = await registerEphemeral(cer.id, c1);
    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);

    // Sealing to a recipient who never registered an ephemeral key → 409.
    const noKey = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${cer.id}/seal-share`,
      cookies: as(c2.cookie),
      payload: {
        recipientContactId: c3.contactId,
        sealedShareCiphertext: Buffer.from(randomBytes(64)).toString('base64'),
        shareSignature: Buffer.from(randomBytes(64)).toString('base64'),
      },
    });
    expect(noKey.statusCode).toBe(409);

    // A well-formed but WRONG signature (random bytes) → 401, nothing stored.
    const badSig = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${cer.id}/seal-share`,
      cookies: as(c2.cookie),
      payload: {
        recipientContactId: c1.contactId,
        sealedShareCiphertext: Buffer.from(
          rewrapShareToRecipient(
            { bytes: randomBytes(33), tier: 's3' } as TierKeyShare,
            ephemeral.publicKey,
          ),
        ).toString('base64'),
        shareSignature: Buffer.from(randomBytes(64)).toString('base64'),
      },
    });
    expect(badSig.statusCode).toBe(401);
    const stored = await db
      .select()
      .from(schema.ceremonyAffirmationShares)
      .innerJoin(
        schema.ceremonyAffirmations,
        eq(schema.ceremonyAffirmationShares.affirmationId, schema.ceremonyAffirmations.id),
      )
      .where(eq(schema.ceremonyAffirmations.ceremonyId, cer.id));
    expect(stored).toHaveLength(0);

    // Drive to reconstructing with the two valid seals + the third affirmation.
    await affirmVia(cer.id, c3);
    await sealVia(cer.id, c1, c1.contactId);
    await sealVia(cer.id, c2, c1.contactId);
    await sealVia(cer.id, c3, c1.contactId);
    await driveToReconstructing(ownerId, 's3');

    // c2 committed but never registered an ephemeral key → cannot collect.
    const notRegistered = await getShares(cer.id, c2);
    expect(notRegistered.statusCode).toBe(409);

    // The registered, committed affirmer can.
    expect((await getShares(cer.id, c1)).statusCode).toBe(200);
  });

  // PROPERTY 7 — the release-passphrase fallback (+1 factor). Both contacts
  // affirm (consensus), but one never seals its share; the recipient substitutes
  // the owner's OFFLINE release passphrase — re-derived from the served KDF salt
  // — for the missing contact and reconstructs the EXACT tier key. The salt route
  // is temporal-gated exactly like /shares.
  it('release-passphrase fallback: a missing contact share is replaced by the passphrase-derived share', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'professional']);
    const { ownerId, tierKey, contacts } = seeded;
    const [c1, c2] = contacts as [SeededContact, SeededContact];

    // Production stores the owner's release-passphrase KDF salt at enrollment;
    // the seed helper doesn't, so add it here with the SAME salt that constrained
    // the split. The endpoint serves it; the recipient re-derives the share.
    await db.insert(schema.userKeyMaterial).values({
      userId: ownerId,
      masterPassphraseSalt: randomBytes(16),
      masterKeyWrappedByPassphrase: randomBytes(48),
      masterKeyPassphraseNonce: randomBytes(24),
      recoveryCodeSalt: randomBytes(16),
      masterKeyWrappedByRecovery: randomBytes(48),
      masterKeyRecoveryNonce: randomBytes(24),
      releasePassphraseSalt: releaseSalt,
      auditSigningPubkey: randomBytes(32),
    });

    const itemKey = generateItemKey();
    const wrappedItemKey = wrapItemKey(itemKey, tierKey, ITEM_UUID);
    const content = encryptItemContent(new TextEncoder().encode('the fallback secret'), itemKey);

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    const ephemeral = await registerEphemeral(cer.id, c1);
    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);
    // BOTH affirm (consensus is met), but only c1 seals — c2 goes "offline".
    await sealVia(cer.id, c1, c1.contactId);

    // The salt is temporal-gated: refused before the gate opens.
    const saltEarly = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/release-salt`,
      cookies: as(c1.cookie),
    });
    expect(saltEarly.statusCode).toBe(403);

    await driveToReconstructing(ownerId, 's2');

    // Only one contact share was collected — below the 2-of-3 threshold alone.
    const sharesRes = await getShares(cer.id, c1);
    expect(sharesRes.statusCode).toBe(200);
    const body = sharesRes.json();
    expect(body.shares).toHaveLength(1);
    expect(reconstructFromResponse(body, ephemeral).ok).toBe(false);

    // Fetch the salt (now open) and re-derive the reserved release share.
    const saltRes = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/release-salt`,
      cookies: as(c1.cookie),
    });
    expect(saltRes.statusCode).toBe(200);
    const servedSalt = new Uint8Array(
      Buffer.from(saltRes.json().releasePassphraseSalt as string, 'base64'),
    );
    const derived = deriveReleasePassphraseShare(
      RELEASE_PASSPHRASE as ReleasePassphrase,
      servedSalt as ReleaseKdfSalt,
      's2',
      RELEASE_SHARE_INDEX_S2,
    );

    // One contact share + the passphrase-derived share reconstruct the real key.
    const c1Share = unwrapShareFromCeremony(
      new Uint8Array(Buffer.from(body.shares[0].sealedShareCiphertext, 'base64')),
      ephemeral,
      's2',
    );
    const result = reconstructTierKey({
      shares: [c1Share, releaseShareAsTierShare(derived)],
      threshold: body.threshold,
      generation: body.generation,
      tierKeyCheck: {
        plaintext: new Uint8Array(Buffer.from(body.tierKeyCheck.plaintext, 'base64')),
        ciphertext: new Uint8Array(Buffer.from(body.tierKeyCheck.ciphertext, 'base64')),
        nonce: new Uint8Array(Buffer.from(body.tierKeyCheck.nonce, 'base64')),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.tierKey).equals(Buffer.from(tierKey))).toBe(true);

    const recoveredKey = unwrapItemKey(wrappedItemKey, result.tierKey, { version: 2, itemId: ITEM_UUID });
    expect(new TextDecoder().decode(decryptItemContent(content, recoveredKey))).toBe(
      'the fallback secret',
    );
  });

  // PROPERTY 8 — the designated beneficiary (backlog #2). Both holders affirm
  // (consensus) and re-seal their shares to a NON-affirming beneficiary; the
  // beneficiary — who holds no share and never affirms — collects the threshold
  // and reconstructs. Consensus stays with the holders; the beneficiary is purely
  // a recipient, and a non-recipient stranger is refused.
  it('designated beneficiary: a non-affirming beneficiary reconstructs from the holders shares', async () => {
    const seeded = await seedShamirRelease('s2', ['personal', 'professional']);
    const { ownerId, tierKey, contacts } = seeded;
    const [c1, c2] = contacts as [SeededContact, SeededContact];
    const beneficiary = await seedBeneficiary(ownerId, 's2');

    const itemKey = generateItemKey();
    const wrappedItemKey = wrapItemKey(itemKey, tierKey, ITEM_UUID);
    const content = encryptItemContent(new TextEncoder().encode('for the beneficiary'), itemKey);

    const t0 = new Date();
    await createReleaseReviewCeremonies({ db, audit, now: t0, windows: WINDOWS }, 10);
    await tickCeremonies({ db, audit, now: t0, signalEngine }, 10);
    const cer = await ceremonyOf(ownerId);

    // The bridge enrolled the beneficiary as a RECIPIENT but NOT an affirmer.
    const benRecipient = await db
      .select()
      .from(schema.ceremonyRecipients)
      .where(
        and(
          eq(schema.ceremonyRecipients.ceremonyId, cer.id),
          eq(schema.ceremonyRecipients.recipientContactId, beneficiary.contactId),
        ),
      );
    expect(benRecipient).toHaveLength(1);
    const benAffirmation = await db
      .select()
      .from(schema.ceremonyAffirmations)
      .where(
        and(
          eq(schema.ceremonyAffirmations.ceremonyId, cer.id),
          eq(schema.ceremonyAffirmations.contactId, beneficiary.contactId),
        ),
      );
    expect(benAffirmation).toHaveLength(0);

    // The beneficiary registers; the gate is CLOSED while collecting.
    const ephemeral = await registerEphemeral(cer.id, beneficiary);
    expect((await getShares(cer.id, beneficiary)).statusCode).toBe(403);

    // Both holders affirm and seal their shares to the BENEFICIARY (not themselves).
    await affirmVia(cer.id, c1);
    await affirmVia(cer.id, c2);
    await sealVia(cer.id, c1, beneficiary.contactId);
    await sealVia(cer.id, c2, beneficiary.contactId);

    await driveToReconstructing(ownerId, 's2');

    // The non-affirming beneficiary collects the threshold subset and reconstructs.
    const sharesRes = await getShares(cer.id, beneficiary);
    expect(sharesRes.statusCode).toBe(200);
    const body = sharesRes.json();
    expect(body.shares).toHaveLength(2);
    const result = reconstructFromResponse(body, ephemeral);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.tierKey).equals(Buffer.from(tierKey))).toBe(true);
    const recoveredKey = unwrapItemKey(wrappedItemKey, result.tierKey, { version: 2, itemId: ITEM_UUID });
    expect(new TextDecoder().decode(decryptItemContent(content, recoveredKey))).toBe(
      'for the beneficiary',
    );

    // A non-recipient stranger is refused even with the gate open.
    const [stranger] = await db
      .insert(schema.users)
      .values({ email: `stranger${Date.now()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const { token: strangerCookie } = await createSession(db, {
      userId: stranger!.id as UserId,
      now: new Date(),
    });
    const strangerRes = await app.inject({
      method: 'GET',
      url: `/v1/ceremonies/${cer.id}/shares`,
      cookies: as(strangerCookie),
    });
    expect(strangerRes.statusCode).toBe(404);

    // The beneficiary reports success → the ceremony is released.
    const done = await app.inject({
      method: 'POST',
      url: `/v1/ceremonies/${cer.id}/reconstructed`,
      cookies: as(beneficiary.cookie),
    });
    expect(done.statusCode).toBe(200);
    expect((await ceremonyOf(ownerId)).status).toBe('released');
  });
});
