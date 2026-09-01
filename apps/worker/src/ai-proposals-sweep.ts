import type { Database } from '@truecairn/db';
import { schema } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { and, eq, lte } from 'drizzle-orm';

// ── Proposal expiry sweep (plan docs/25 §5, 1.4b) ─────────────────────────────
//
// Expires open ('proposed') AI proposals past their expires_at (default 14 days).
// Follows the worker processor pattern: claim a batch FOR UPDATE SKIP LOCKED so two
// concurrent workers never expire the same row twice, and record an
// ai_proposal_decided(expired) audit event in the SAME transaction as the status
// change. Errors are the caller's to isolate (the loop wraps each batch in
// try/catch).
//
// The audit actor defaults to 'owner' (the AuditLogPort interface carries no actor
// arg); expiry is system-driven but the important invariant — that only the
// ai-authority chokepoint ever writes actor='ai' — is untouched.

export interface SweepContext {
  db: Database;
  audit: AuditLogPort;
  now: Date;
}

export async function sweepExpiredProposals(
  ctx: SweepContext,
  batchSize: number,
): Promise<{ expired: number }> {
  const { db, audit, now } = ctx;
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const due = await tx
      .select({ id: schema.aiProposals.id, userId: schema.aiProposals.userId })
      .from(schema.aiProposals)
      .where(and(eq(schema.aiProposals.status, 'proposed'), lte(schema.aiProposals.expiresAt, now)))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    for (const p of due) {
      await tx
        .update(schema.aiProposals)
        .set({ status: 'expired', decidedAt: now })
        .where(eq(schema.aiProposals.id, p.id));
      await audit.append(tx, p.userId as UserId, 'ai_proposal_decided', {
        proposalId: p.id,
        decision: 'expired',
      });
    }
    return { expired: due.length };
  });
}
