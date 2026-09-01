import { schema, type Database } from '@truecairn/db';
import type { AppendedAuditEntry, AuditLogPort } from '@truecairn/engine';
import type { AuditActor, UserId } from '@truecairn/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { CanonicalEntry } from './canonical.js';
import { entryHash } from './hash.js';
import type { ServerSigner } from './keys.js';

export interface AppendOptions {
  userSignature?: Uint8Array;
  clientTimestamp?: Date;
  // WHO caused this entry (plan docs/25 §3.4). Defaults to 'owner'; the
  // ai-authority chokepoint passes 'ai'. NOT part of the signed canonical hash —
  // it is forensic metadata written atomically with the entry it labels.
  actor?: AuditActor;
}

// AuditLogWriter implements the engine's AuditLogPort but, beyond the engine
// interface, also accepts user signatures for sensitive-event entries when
// callers (e.g. the Phase 3 sensitive-action processor) supply them.
export class AuditLogWriter implements AuditLogPort {
  constructor(private readonly signer: ServerSigner) {}

  async append(
    db: Database,
    userId: UserId,
    eventType: string,
    payload: Record<string, unknown>,
    opts: AppendOptions = {},
  ): Promise<AppendedAuditEntry> {
    // 1. Serialize per-user. The lock row exists once per user; ON CONFLICT
    //    is a no-op for users we've seen before. SELECT FOR UPDATE on that
    //    row blocks concurrent writers and pairs naturally with the trigger's
    //    chain check.
    await db
      .insert(schema.auditLogLocks)
      .values({ userId })
      .onConflictDoNothing({ target: schema.auditLogLocks.userId });
    await db.execute(sql`SELECT 1 FROM audit_log_locks WHERE user_id = ${userId} FOR UPDATE`);

    // 2. Read the head of the chain for this user.
    const head = await db
      .select({ seq: schema.auditLog.seq, entryHash: schema.auditLog.entryHash })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);

    const nextSeq: bigint = head[0] ? head[0].seq + 1n : 1n;
    const prevHash: Uint8Array | null = head[0] ? head[0].entryHash : null;

    // 3. Build the canonical entry + signatures. Server timestamp is "now"
    //    inside the transaction.
    const serverTimestamp = new Date();
    const canonical: CanonicalEntry = {
      seq: nextSeq,
      userId,
      eventType,
      eventPayload: payload,
      prevEntryHash: prevHash,
      serverTimestamp,
      serverKeyId: this.signer.keyId,
      clientTimestamp: opts.clientTimestamp ?? null,
    };
    const hash = entryHash(canonical);
    const serverSig = this.signer.sign(hash);

    // 4. Insert. The DB trigger re-verifies (seq, prev_entry_hash); a mismatch
    //    means the chain advanced between step 2 and step 4 — which the lock
    //    above prevents within a single tx, so we throw.
    const [inserted] = await db
      .insert(schema.auditLog)
      .values({
        userId,
        seq: nextSeq,
        eventType,
        eventPayload: payload,
        prevEntryHash: prevHash,
        entryHash: hash,
        serverSignature: serverSig,
        serverKeyId: this.signer.keyId,
        userSignature: opts.userSignature ?? null,
        serverTimestamp,
        clientTimestamp: opts.clientTimestamp ?? null,
        actor: opts.actor ?? 'owner',
      })
      .returning({ id: schema.auditLog.id });
    if (!inserted) throw new Error('audit_log insert returned no row');
    return { id: inserted.id, seq: nextSeq, entryHash: hash };
  }
}
