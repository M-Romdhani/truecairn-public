import { verifyChainForUser } from '@truecairn/audit';
import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { asc, gt } from 'drizzle-orm';

// Periodic audit-chain verification (2026-07-25).
//
// The audit chain is hash-linked and server-signed, and audit_log is append-only
// at the database layer (migration 0007 triggers). None of that is worth
// anything unless somebody actually CHECKS — until now `verifyChain` had no
// production caller at all and existed only in tests, which made the chain
// tamper-evident in principle and unexamined in practice.
//
// This sweep is the "somebody". It walks users round-robin, a bounded batch per
// pass, and screams if a chain fails to verify.
//
// Deliberately does NOT write an audit event on failure: the failure means that
// user's chain is already broken, and appending to a broken chain would both
// compound the damage and bury the evidence. The alert is the log line
// `worker.audit_chain_broken` at error level — see docs/RUNBOOK-AI.md for the
// operator response. The cursor is in-memory: a restart simply restarts the
// rotation, which is fine for a continuous background check.

export interface AuditVerifySweepDeps {
  db: Database;
  // Injected so the loop's structured logger is used and this module stays
  // testable without capturing global console output.
  onBroken: (info: { userId: UserId; failureSeq: number; reason: string }) => void;
}

export interface AuditVerifySweepResult {
  checked: number;
  broken: number;
  // Pass back into the next call to continue the rotation.
  nextCursor: string | null;
}

export async function runAuditVerifySweep(
  deps: AuditVerifySweepDeps,
  batchSize: number,
  cursor: string | null,
): Promise<AuditVerifySweepResult> {
  const { db, onBroken } = deps;

  // Round-robin by user id. When the page comes back short we've reached the
  // end and the next pass restarts from the beginning.
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(cursor === null ? undefined : gt(schema.users.id, cursor))
    .orderBy(asc(schema.users.id))
    .limit(batchSize);

  let broken = 0;
  for (const r of rows) {
    const userId = r.id as UserId;
    const result = await verifyChainForUser(db, userId);
    if (!result.ok) {
      broken += 1;
      onBroken({ userId, failureSeq: result.failureSeq, reason: result.reason });
    }
  }

  return {
    checked: rows.length,
    broken,
    nextCursor: rows.length < batchSize ? null : (rows[rows.length - 1]!.id ?? null),
  };
}
