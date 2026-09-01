// F-5 from the 2026-08-10 restore drill: a mis-transcribed SERVER_AUDIT_SIGNING_KEY
// is undetectable.
//
// Same shape as F-1 (the outer-layer KEK check that could not detect a WRONG
// key), applied to the audit signer, and arguably worse: F-1's check was at
// least trying to prove something. Here the key id is derived from the key's own
// bytes, so a wrong value cannot fail a lookup — it defines a new lineage and
// registers it. Existing entries keep verifying because the verifier resolves
// each entry under ITS OWN key id, which is still in the registry. The
// audit-chain check in Settings shows green throughout, and the production boot
// guard throws only on a MISSING variable, never a different one.
//
// So the demonstration this test owes is: the same database, read with the right
// key and with a wrong-but-well-formed one, and the difference being VISIBLE.
// It needs real Postgres — the whole failure is about what rows are there.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import {
  auditChainKeyIds,
  describeAuditKeyLineage,
  inspectAuditKeyLineage,
} from './lineage.js';
import { decodeServerSigner, generateServerSigner, resolveServerSigner } from './keys.js';
import { AuditLogWriter } from './writer.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('audit key lineage: identity, not just well-formedness (drill F-5)', () => {
  let db: Database;
  let sql: Sql;
  let userId: UserId;

  // The key the chain gets built with, and a second one that is every bit as
  // valid — 32 bytes, decodes, passes the production boot guard. That is exactly
  // what a transcription slip produces: not garbage, a different key.
  const real = generateServerSigner();
  const mistyped = generateServerSigner();

  beforeAll(async () => {
    const client = createClient({ url: url! });
    db = client.db;
    sql = client.sql;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE audit_log_locks, audit_log, server_signing_keys, users CASCADE`;
    const [u] = await db
      .insert(schema.users)
      .values({ email: `lineage-${Date.now()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    userId = u!.id as UserId;
  });

  // Build a chain under `real` the way the product does — through the writer, so
  // the rows carry a genuine server_key_id rather than one this test chose.
  async function signOneEntry(): Promise<void> {
    const writer = new AuditLogWriter(decodeServerSigner(real.envSerialized));
    await db
      .insert(schema.serverSigningKeys)
      .values({ keyId: real.keyId, publicKey: real.publicKey })
      .onConflictDoNothing({ target: schema.serverSigningKeys.keyId });
    await writer.append(db, userId, 'engine.armed', { drill: true });
  }

  it('says nothing is proven when there is no chain to compare against', async () => {
    // The honest verdict on an empty database, and the same one the 2026-08-10
    // drill recorded for this secret. It must not read as a pass.
    const lineage = await inspectAuditKeyLineage(db, real.keyId);
    expect(lineage.kind).toBe('no_entries');
    expect(describeAuditKeyLineage(lineage)).toContain('not yet provable');
  });

  it('recognises the key that actually signed the chain', async () => {
    await signOneEntry();
    const lineage = await inspectAuditKeyLineage(db, real.keyId);
    expect(lineage).toEqual({ kind: 'current', keyId: real.keyId });
  });

  it('detects a wrong-but-well-formed key — the finding itself', async () => {
    await signOneEntry();

    // Both keys are structurally perfect. Nothing about the VALUE distinguishes
    // them; only the chain does.
    expect(mistyped.publicKey).toHaveLength(32);
    expect(mistyped.keyId).not.toBe(real.keyId);

    const lineage = await inspectAuditKeyLineage(db, mistyped.keyId);
    expect(lineage).toEqual({
      kind: 'split',
      keyId: mistyped.keyId,
      chainKeyId: real.keyId,
    });
    expect(describeAuditKeyLineage(lineage)).toContain('not the one the chain was built with');
  });

  it('resolveServerSigner reports the split rather than refusing to boot', async () => {
    await signOneEntry();

    const prev = process.env['SERVER_AUDIT_SIGNING_KEY'];
    process.env['SERVER_AUDIT_SIGNING_KEY'] = mistyped.envSerialized;
    try {
      // It must still return a working signer: rotation is legitimate, retired
      // keys must keep verifying, and refusing to boot would break the one
      // operation that legitimately produces a lineage change.
      const signer = await resolveServerSigner(db);
      expect(signer.keyId).toBe(mistyped.keyId);
      expect(signer.lineage).toEqual({
        kind: 'split',
        keyId: mistyped.keyId,
        chainKeyId: real.keyId,
      });
    } finally {
      if (prev === undefined) delete process.env['SERVER_AUDIT_SIGNING_KEY'];
      else process.env['SERVER_AUDIT_SIGNING_KEY'] = prev;
    }
  });

  it('registers the wrong key only AFTER the lineage is read', async () => {
    // Ordering is the load-bearing part: registering is what makes a wrong key
    // look like it belongs, so the check has to happen first. If this ever flips,
    // the finding comes back silently.
    await signOneEntry();
    const prev = process.env['SERVER_AUDIT_SIGNING_KEY'];
    process.env['SERVER_AUDIT_SIGNING_KEY'] = mistyped.envSerialized;
    try {
      const signer = await resolveServerSigner(db);
      expect(signer.lineage?.kind).toBe('split');
    } finally {
      if (prev === undefined) delete process.env['SERVER_AUDIT_SIGNING_KEY'];
      else process.env['SERVER_AUDIT_SIGNING_KEY'] = prev;
    }
    // Both keys are now registered — which is why "is it registered?" would have
    // been the wrong question to ask, and why the chain is the authority.
    const registered = await db.select({ keyId: schema.serverSigningKeys.keyId }).from(schema.serverSigningKeys);
    expect(registered.map((r) => r.keyId).sort()).toEqual([real.keyId, mistyped.keyId].sort());
  });

  it('lists every key that has signed, for the drill script', async () => {
    await signOneEntry();
    expect(await auditChainKeyIds(db)).toEqual([real.keyId]);
  });
});
