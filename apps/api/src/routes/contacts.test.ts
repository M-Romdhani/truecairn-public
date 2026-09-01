import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ed25519Sign,
  generateEd25519Keypair,
  generateX25519Keypair,
  initCrypto,
  sealedBoxDecrypt,
  type X25519Keypair,
} from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const LABEL_CT = Buffer.from('encrypted-label').toString('base64');
const LABEL_NONCE = Buffer.from(new Uint8Array(24)).toString('base64');

describeIfDb('contact lifecycle: invite -> accept -> enrol (integration)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;

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
    await sql`TRUNCATE contacts, auth_challenges, audit_log_locks, audit_log, sessions, users CASCADE`;
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }
  async function cookieFor(userId: UserId): Promise<string> {
    const { token } = await createSession(db, { userId, now: new Date() });
    return token;
  }

  async function inviteAndAccept(): Promise<{
    ownerId: UserId;
    contactId: string;
    contactCookie: string;
  }> {
    const ownerId = await makeUser('owner@example.com');
    const contactId2 = await makeUser('contact@example.com');
    const ownerCookie = await cookieFor(ownerId);
    const contactCookie = await cookieFor(contactId2);

    const inv = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { role: 'professional', displayLabelCiphertext: LABEL_CT, displayLabelNonce: LABEL_NONCE },
    });
    expect(inv.statusCode).toBe(200);
    const { contactId, inviteToken } = inv.json();

    const acc = await app.inject({
      method: 'POST',
      url: '/v1/contacts/accept',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: { inviteToken },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().contactId).toBe(contactId);
    return { ownerId, contactId, contactCookie };
  }

  // Simulate the contact's device completing one enrolment round and return the
  // /enroll/verify body for a valid pair of proofs.
  async function enrollOptions(
    contactCookie: string,
    contactId: string,
    x: X25519Keypair,
    ed: ReturnType<typeof generateEd25519Keypair>,
  ): Promise<Record<string, string>> {
    const opts = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/options',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: {
        contactId,
        x25519Pubkey: Buffer.from(x.publicKey).toString('base64'),
        ed25519Pubkey: Buffer.from(ed.publicKey).toString('base64'),
      },
    });
    expect(opts.statusCode).toBe(200);
    const o = opts.json();
    const openedNonce = sealedBoxDecrypt({
      recipientPublicKey: x.publicKey,
      recipientSecretKey: x.secretKey,
      ciphertext: new Uint8Array(Buffer.from(o.x25519SealedNonce, 'base64url')),
    });
    const sig = ed25519Sign(new Uint8Array(Buffer.from(o.ed25519Challenge, 'base64url')), ed.secretKey);
    return {
      contactId,
      ed25519ChallengeId: o.ed25519ChallengeId,
      ed25519Signature: Buffer.from(sig).toString('base64'),
      x25519ChallengeId: o.x25519ChallengeId,
      x25519Nonce: Buffer.from(openedNonce).toString('base64'),
    };
  }

  it('enrols a contact who proves possession of both keys', async () => {
    const { ownerId, contactId, contactCookie } = await inviteAndAccept();
    const x = generateX25519Keypair();
    const ed = generateEd25519Keypair();
    const verifyBody = await enrollOptions(contactCookie, contactId, x, ed);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/verify',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: verifyBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enrolled).toBe(true);

    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('enrolled');
    expect(c!.affirmationKeyType).toBe('ed25519');
    expect(Buffer.from(c!.contactX25519Pubkey!)).toEqual(Buffer.from(x.publicKey));
    expect(Buffer.from(c!.contactEd25519Pubkey!)).toEqual(Buffer.from(ed.publicKey));

    // The owner's audit log records invite + accept + enrol.
    const events = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, ownerId))
    ).map((e) => e.eventType);
    expect(events).toContain('contact.invited');
    expect(events).toContain('contact.accepted');
    expect(events).toContain('contact.enrolled');
  });

  it('rejects a bad Ed25519 signature and stays pending_keygen', async () => {
    const { contactId, contactCookie } = await inviteAndAccept();
    const x = generateX25519Keypair();
    const ed = generateEd25519Keypair();
    const body = await enrollOptions(contactCookie, contactId, x, ed);
    // Replace the signature with a valid signature over the WRONG message.
    body.ed25519Signature = Buffer.from(
      ed25519Sign(new Uint8Array(32), ed.secretKey),
    ).toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/verify',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('pending_keygen');
  });

  it('rejects a wrong X25519 nonce (no private key) and stays pending_keygen', async () => {
    const { contactId, contactCookie } = await inviteAndAccept();
    const x = generateX25519Keypair();
    const ed = generateEd25519Keypair();
    const body = await enrollOptions(contactCookie, contactId, x, ed);
    body.x25519Nonce = Buffer.from(new Uint8Array(32).fill(9)).toString('base64'); // not the sealed nonce

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/verify',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('pending_keygen');
  });

  it('lets the contact re-request /enroll/options and complete with the fresh challenge', async () => {
    const { contactId, contactCookie } = await inviteAndAccept();
    const x = generateX25519Keypair();
    const ed = generateEd25519Keypair();

    // First round: get a challenge but DON'T verify (simulate a dropped attempt).
    const first = await enrollOptions(contactCookie, contactId, x, ed);
    // Second round: a fresh challenge — different id — and verifying with it works.
    const second = await enrollOptions(contactCookie, contactId, x, ed);
    expect(second['x25519ChallengeId']).not.toBe(first['x25519ChallengeId']);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/verify',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: second,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unknown invite token and a self-invite', async () => {
    const ownerId = await makeUser('o2@example.com');
    const ownerCookie = await cookieFor(ownerId);

    // Unknown token.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/contacts/accept',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { inviteToken: Buffer.alloc(32, 1).toString('base64url') },
    });
    expect(bad.statusCode).toBe(400);

    // Self-invite: owner cannot accept their own invite.
    const inv = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { role: 'personal', displayLabelCiphertext: LABEL_CT, displayLabelNonce: LABEL_NONCE },
    });
    const self = await app.inject({
      method: 'POST',
      url: '/v1/contacts/accept',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { inviteToken: inv.json().inviteToken },
    });
    expect(self.statusCode).toBe(400);
  });

  // ── Cancel a not-yet-enrolled invite (session-only) ──────────────────────────
  it('cancels an invited (not yet accepted) contact and removes it from the list', async () => {
    const ownerId = await makeUser('canc-owner@example.com');
    const ownerCookie = await cookieFor(ownerId);
    const inv = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { role: 'personal', displayLabelCiphertext: LABEL_CT, displayLabelNonce: LABEL_NONCE },
    });
    const { contactId } = inv.json();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/cancel-invite',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { contactId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(true);

    // Gone from the owner's list, and marked removed (history preserved, not deleted).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/contacts',
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(list.json().contacts).toHaveLength(0);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('removed');
    expect(c!.removedAt).not.toBeNull();

    const events = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, ownerId))
    ).map((e) => e.eventType);
    expect(events).toContain('contact.invite_cancelled');
  });

  it('cancels a pending_keygen (accepted, not yet enrolled) contact', async () => {
    const { ownerId, contactId } = await inviteAndAccept();
    const ownerCookie = await cookieFor(ownerId);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/cancel-invite',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { contactId },
    });
    expect(res.statusCode).toBe(200);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('removed');
  });

  // Fail closed: the session-only path must NEVER drop a contact that may hold a
  // release share — enrolled removal stays behind the step-up sensitive action.
  it('refuses to cancel an ENROLLED contact (409) and leaves it enrolled', async () => {
    const { ownerId, contactId, contactCookie } = await inviteAndAccept();
    const x = generateX25519Keypair();
    const ed = generateEd25519Keypair();
    const verifyBody = await enrollOptions(contactCookie, contactId, x, ed);
    const enrolled = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/verify',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: verifyBody,
    });
    expect(enrolled.statusCode).toBe(200);

    const ownerCookie = await cookieFor(ownerId);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/cancel-invite',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { contactId },
    });
    expect(res.statusCode).toBe(409);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.status).toBe('enrolled');
    expect(c!.removedAt).toBeNull();
  });

  it("cannot cancel another owner's contact (404, owner-scoped)", async () => {
    const { contactId } = await inviteAndAccept();
    const otherOwner = await makeUser('canc-other@example.com');
    const otherCookie = await cookieFor(otherOwner);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/cancel-invite',
      cookies: { [SESSION_COOKIE]: otherCookie },
      payload: { contactId },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── The owner's out-of-band key confirmation (migration 0061) ──────────────
  //
  // The server's role here is deliberately small: it stores a blob it cannot
  // read, produced by a key it does not have. These tests pin that smallness —
  // that the pin round-trips untouched, that it is owner-scoped, and that the
  // enrolment gate still applies. What the pin MEANS is checked client-side
  // (apps/web/tests/contact-key-verification.test.ts); nothing here can verify
  // a comparison that happened on a phone call.
  const PIN_CT = Buffer.from('sealed-pin-ciphertext').toString('base64');
  const PIN_NONCE = Buffer.from(new Uint8Array(24)).toString('base64');

  async function enrolled(): Promise<{ ownerId: UserId; ownerCookie: string; contactId: string }> {
    const { ownerId, contactId, contactCookie } = await inviteAndAccept();
    const x = generateX25519Keypair();
    const ed = generateEd25519Keypair();
    const verifyBody = await enrollOptions(contactCookie, contactId, x, ed);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/enroll/verify',
      cookies: { [SESSION_COOKIE]: contactCookie },
      payload: verifyBody,
    });
    expect(res.statusCode).toBe(200);
    return { ownerId, ownerCookie: await cookieFor(ownerId), contactId };
  }

  it('stores the pin byte-for-byte and reports it as a first confirmation', async () => {
    const { ownerId, ownerCookie, contactId } = await enrolled();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/key-pin',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { contactId, keyPinCiphertext: PIN_CT, keyPinNonce: PIN_NONCE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ confirmed: true, replaced: false });

    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    // Byte-for-byte: the client compares the decrypted pin against the served
    // keys, so any re-encoding on this side would read as tampering.
    expect(Buffer.from(c!.keyPinCiphertext!).toString('base64')).toBe(PIN_CT);
    expect(Buffer.from(c!.keyPinNonce!).toString('base64')).toBe(PIN_NONCE);
    expect(c!.keyPinConfirmedAt).not.toBeNull();

    // A re-pin is audited as its own event: it is exactly what an attacker who
    // substituted a key needs the owner to do, so it must not look routine.
    const events = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, ownerId));
    expect(events.map((e) => e.eventType)).toContain('contact.key_pin_confirmed');
  });

  it('marks a re-confirmation as replaced and audits it distinctly', async () => {
    const { ownerId, ownerCookie, contactId } = await enrolled();
    const post = async (ct: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/contacts/key-pin',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload: { contactId, keyPinCiphertext: ct, keyPinNonce: PIN_NONCE },
      });
    expect((await post(PIN_CT)).json().replaced).toBe(false);
    const second = await post(Buffer.from('a-different-pin').toString('base64'));
    expect(second.json().replaced).toBe(true);

    const events = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, ownerId));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('contact.key_pin_confirmed');
    expect(types).toContain('contact.key_pin_replaced');
  });

  it('returns the pin and BOTH public keys on the owner list', async () => {
    const { ownerCookie, contactId } = await enrolled();
    await app.inject({
      method: 'POST',
      url: '/v1/contacts/key-pin',
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { contactId, keyPinCiphertext: PIN_CT, keyPinNonce: PIN_NONCE },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/v1/contacts',
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().contacts.find((c: { contactId: string }) => c.contactId === contactId);
    // Ed25519 must travel with X25519: the safety number covers both, and a
    // number over the sealing key alone would miss a partial substitution.
    expect(row.x25519Pubkey).toBeTruthy();
    expect(row.ed25519Pubkey).toBeTruthy();
    expect(row.keyPinCiphertext).toBe(PIN_CT);
    expect(row.keyPinNonce).toBe(PIN_NONCE);
    expect(row.keyPinConfirmedAt).toBeTruthy();
  });

  it('refuses to pin a contact that has not enrolled (409)', async () => {
    const { ownerId, contactId } = await inviteAndAccept();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/key-pin',
      cookies: { [SESSION_COOKIE]: await cookieFor(ownerId) },
      payload: { contactId, keyPinCiphertext: PIN_CT, keyPinNonce: PIN_NONCE },
    });
    // Staged keys can still change before /enroll/verify, so a pin taken now
    // would go stale the moment enrolment finishes.
    expect(res.statusCode).toBe(409);
  });

  it("cannot pin another owner's contact (404, owner-scoped)", async () => {
    const { contactId } = await enrolled();
    const otherCookie = await cookieFor(await makeUser('pin-other@example.com'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/key-pin',
      cookies: { [SESSION_COOKIE]: otherCookie },
      payload: { contactId, keyPinCiphertext: PIN_CT, keyPinNonce: PIN_NONCE },
    });
    expect(res.statusCode).toBe(404);
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    expect(c!.keyPinCiphertext).toBeNull();
  });

  it('rejects an unauthenticated pin', async () => {
    const { contactId } = await enrolled();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts/key-pin',
      payload: { contactId, keyPinCiphertext: PIN_CT, keyPinNonce: PIN_NONCE },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── F1+F2 backfill: moving v1 rows off the S1 tier key ─────────────────────
  //
  // Migration 0068 was forward-only, so pre-0068 rows are still v1 and still
  // readable by an S1 beneficiary. This route is the other half. The client does
  // the crypto — only it holds both the S1 tier key (to read v1) and the master
  // key (to write v2) — so the server's whole job is refusing the states that
  // would leave a row lying about its own contents.
  describe('POST /v1/contacts/metadata-rekey', () => {
    const NEW_CT = Buffer.from('relabelled-under-tc-cmeta').toString('base64');
    const NEW_NONCE = Buffer.from('nonce-2222222222222222').toString('base64');

    async function ownerWithV1Contact(): Promise<{ ownerCookie: string; contactId: string }> {
      const ownerId = await makeUser('rekey-owner@example.com');
      const ownerCookie = await cookieFor(ownerId);
      const inv = await app.inject({
        method: 'POST',
        url: '/v1/contacts',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload: {
          role: 'professional',
          displayLabelCiphertext: LABEL_CT,
          displayLabelNonce: LABEL_NONCE,
          // v1 explicitly: this is a row as it existed before 0068.
          contactPinVersion: 1,
        },
      });
      expect(inv.statusCode).toBe(200);
      return { ownerCookie, contactId: inv.json().contactId as string };
    }

    it('moves a v1 row to v2 and rewrites the label', async () => {
      const { ownerCookie, contactId } = await ownerWithV1Contact();
      const r = await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload: {
          contacts: [
            { contactId, displayLabelCiphertext: NEW_CT, displayLabelNonce: NEW_NONCE },
          ],
        },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().rekeyed).toBe(1);

      const list = await app.inject({
        method: 'GET',
        url: '/v1/contacts',
        cookies: { [SESSION_COOKIE]: ownerCookie },
      });
      const row = (list.json().contacts as Array<Record<string, unknown>>)[0]!;
      expect(row['contactPinVersion']).toBe(2);
      expect(row['displayLabelCiphertext']).toBe(NEW_CT);
    });

    it('is idempotent: re-running skips the row instead of downgrading it', async () => {
      // Property 1, and the case a retry after a dropped response produces.
      const { ownerCookie, contactId } = await ownerWithV1Contact();
      const payload = {
        contacts: [{ contactId, displayLabelCiphertext: NEW_CT, displayLabelNonce: NEW_NONCE }],
      };
      const first = await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload,
      });
      expect(first.json().rekeyed).toBe(1);
      const second = await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().rekeyed).toBe(0);

      const list = await app.inject({
        method: 'GET',
        url: '/v1/contacts',
        cookies: { [SESSION_COOKIE]: ownerCookie },
      });
      // Still v2 — never back to 1.
      expect((list.json().contacts as Array<Record<string, unknown>>)[0]!['contactPinVersion']).toBe(2);
    });

    it('refuses to rewrite one owner’s contact from another’s session', async () => {
      const { contactId } = await ownerWithV1Contact();
      const strangerId = await makeUser('stranger@example.com');
      const strangerCookie = await cookieFor(strangerId);
      const r = await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: strangerCookie },
        payload: {
          contacts: [
            { contactId, displayLabelCiphertext: NEW_CT, displayLabelNonce: NEW_NONCE },
          ],
        },
      });
      // 404, not 403: an id belonging to someone else must read as absent, or
      // this becomes an existence oracle for other people's contact ids.
      expect(r.statusCode).toBe(404);
    });

    it('rejects a duplicated contactId in one batch', async () => {
      const { ownerCookie, contactId } = await ownerWithV1Contact();
      const r = await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload: {
          contacts: [
            { contactId, displayLabelCiphertext: NEW_CT, displayLabelNonce: NEW_NONCE },
            { contactId, displayLabelCiphertext: NEW_CT, displayLabelNonce: NEW_NONCE },
          ],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it('rejects a pin for a row that has none — the version must not outrun the contents', async () => {
      // Property 2. This row has no pin; accepting one here would write a
      // confirmation the owner never made.
      const { ownerCookie, contactId } = await ownerWithV1Contact();
      const r = await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload: {
          contacts: [
            {
              contactId,
              displayLabelCiphertext: NEW_CT,
              displayLabelNonce: NEW_NONCE,
              keyPinCiphertext: NEW_CT,
              keyPinNonce: NEW_NONCE,
            },
          ],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it('leaves the row untouched when the batch is rejected', async () => {
      // Property 4: one transaction. A 400 on any member must roll the whole
      // batch back, or a partial apply leaves rows claiming a version their
      // ciphertext does not match.
      const { ownerCookie, contactId } = await ownerWithV1Contact();
      await app.inject({
        method: 'POST',
        url: '/v1/contacts/metadata-rekey',
        cookies: { [SESSION_COOKIE]: ownerCookie },
        payload: {
          contacts: [
            {
              contactId,
              displayLabelCiphertext: NEW_CT,
              displayLabelNonce: NEW_NONCE,
              keyPinCiphertext: NEW_CT,
              keyPinNonce: NEW_NONCE,
            },
          ],
        },
      });
      const list = await app.inject({
        method: 'GET',
        url: '/v1/contacts',
        cookies: { [SESSION_COOKIE]: ownerCookie },
      });
      const row = (list.json().contacts as Array<Record<string, unknown>>)[0]!;
      expect(row['contactPinVersion']).toBe(1);
      expect(row['displayLabelCiphertext']).toBe(LABEL_CT);
    });
  });
});
