import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { asc, eq } from 'drizzle-orm';
import {
  AuditLogWriter,
  generateServerSigner,
  decodeServerSigner,
  resolveServerSigner,
  verifyChain,
} from './index.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('AuditLogWriter (integration)', () => {
  let db: Database;
  let sql: Sql;
  let writer: AuditLogWriter;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE audit_log_locks, audit_log, users, server_signing_keys CASCADE`;
    const signer = await resolveServerSigner(db);
    writer = new AuditLogWriter(signer);
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('writes a seq=1 entry with NULL prev_entry_hash', async () => {
    const userId = await makeUser('a@example.com');

    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', { x: 1 });
    });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(1n);
    expect(rows[0]?.prevEntryHash).toBeNull();
    expect(rows[0]?.entryHash).toHaveLength(32);
    expect(rows[0]?.serverSignature.length).toBe(64);
    expect(rows[0]?.serverKeyId).toMatch(/^audit-/);
  });

  it('chains seq=2 to seq=1 via prev_entry_hash', async () => {
    const userId = await makeUser('b@example.com');

    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 1 });
    });
    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 2 });
    });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId))
      .orderBy(asc(schema.auditLog.seq));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.seq).toBe(2n);
    expect(rows[1]?.prevEntryHash).not.toBeNull();
    expect(Buffer.from(rows[1]!.prevEntryHash!).equals(Buffer.from(rows[0]!.entryHash))).toBe(true);
  });

  it('rolls back the audit entry when the outer transaction fails', async () => {
    const userId = await makeUser('c@example.com');

    await expect(
      db.transaction(async (tx) => {
        await writer.append(tx as unknown as Database, userId, 'engine.test', { x: 1 });
        throw new Error('outer transition failed');
      }),
    ).rejects.toThrow('outer transition failed');

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('serializes concurrent appends via audit_log_locks', async () => {
    const userId = await makeUser('d@example.com');

    // Two transactions writing in parallel. The lock row + FOR UPDATE forces
    // them to serialize; both should land with consecutive seqs, no failure.
    await Promise.all([
      db.transaction(async (tx) => {
        await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 1 });
      }),
      db.transaction(async (tx) => {
        await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 2 });
      }),
    ]);

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId))
      .orderBy(asc(schema.auditLog.seq));
    expect(rows.map((r) => r.seq)).toEqual([1n, 2n]);
  });

  it('records the configured server_key_id', async () => {
    const userId = await makeUser('e@example.com');
    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', {});
    });
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(row?.serverKeyId.startsWith('audit-')).toBe(true);
    const keys = await db.select().from(schema.serverSigningKeys);
    expect(keys.some((k) => k.keyId === row?.serverKeyId)).toBe(true);
  });

  it('accepts a user signature when provided', async () => {
    const userId = await makeUser('f@example.com');
    const sigBytes = new Uint8Array(64).fill(0xab);
    const clientTs = new Date('2026-02-02T02:02:02.000Z');
    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.sensitive', { kind: 'x' }, {
        userSignature: sigBytes,
        clientTimestamp: clientTs,
      });
    });
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(row?.userSignature).not.toBeNull();
    expect(row?.userSignature!.length).toBe(64);
    expect(row?.clientTimestamp?.toISOString()).toBe(clientTs.toISOString());
  });
});

describeIfDb('verifyChain (integration)', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE audit_log_locks, audit_log, users, server_signing_keys CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('verifies a clean chain end-to-end', async () => {
    const signer = await resolveServerSigner(db);
    const writer = new AuditLogWriter(signer);
    const userId = await makeUser('v1@example.com');

    for (let i = 0; i < 5; i++) {
      await db.transaction(async (tx) => {
        await writer.append(tx as unknown as Database, userId, 'engine.test', { i });
      });
    }

    const result = await verifyChain(db, userId);
    expect(result).toEqual({ ok: true, entriesChecked: 5 });
  });

  it('detects an unknown server_key_id', async () => {
    const signer = await resolveServerSigner(db);
    const writer = new AuditLogWriter(signer);
    const userId = await makeUser('v2@example.com');
    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 1 });
    });

    // Wipe the signing-key registry so the recorded server_key_id is unknown.
    await sql`DELETE FROM server_signing_keys`;
    const result = await verifyChain(db, userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('server_key_unknown');
  });

  it('detects a tampered server signature (wrong key registered)', async () => {
    const signer = await resolveServerSigner(db);
    const writer = new AuditLogWriter(signer);
    const userId = await makeUser('v3@example.com');
    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 1 });
    });

    // Replace the registered public key with a different valid Ed25519 pubkey.
    const decoy = generateServerSigner();
    await sql`UPDATE server_signing_keys SET public_key = ${Buffer.from(decoy.publicKey)} WHERE key_id = ${signer.keyId}`;

    const result = await verifyChain(db, userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('server_signature_invalid');
  });

  it('verifies a user signature when supplied with the user public key', async () => {
    const signer = await resolveServerSigner(db);
    const writer = new AuditLogWriter(signer);
    const userId = await makeUser('v4@example.com');

    // Generate a Ed25519 keypair for the "user" and sign an entry hash on
    // their behalf. The user pubkey is the verifier input.
    const userSigner = decodeServerSigner(generateServerSigner().envSerialized);

    // We have to compute entry_hash to sign — easiest path: write a dummy
    // entry first, read it back, recompute, sign, re-insert in a fresh tx
    // would break the chain. Instead simulate: write a normal entry, then
    // overwrite its user_signature column with a signature over the actual
    // entry_hash. (audit_log triggers reject UPDATE — we use a direct DB
    // workaround through a privileged session via raw SQL on the test DB.)
    await db.transaction(async (tx) => {
      await writer.append(tx as unknown as Database, userId, 'engine.test', { i: 1 });
    });
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    const userSig = userSigner.sign(row!.entryHash);

    // Disable + reenable the UPDATE trigger just for this row injection.
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`;
    try {
      await sql`UPDATE audit_log SET user_signature = ${Buffer.from(userSig)} WHERE id = ${row!.id}`;
    } finally {
      await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`;
    }

    const ok = await verifyChain(db, userId, { userPublicKey: userSigner.publicKey });
    expect(ok).toEqual({ ok: true, entriesChecked: 1 });

    const badResult = await verifyChain(db, userId, {
      userPublicKey: decodeServerSigner(generateServerSigner().envSerialized).publicKey,
    });
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) expect(badResult.reason).toBe('user_signature_invalid');
  });
});
