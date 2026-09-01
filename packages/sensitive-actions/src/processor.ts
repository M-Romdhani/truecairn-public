import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { SensitiveActionType, UserId } from '@truecairn/shared';
import type { BlobStore, KekProvider } from '@truecairn/vault';
import { and, eq, lte } from 'drizzle-orm';
import { runHandler } from './handlers.js';
import type { HandlerOutcome, PendingAction } from './types.js';

export interface ApplyContext {
  db: Database;
  audit: AuditLogPort;
  now: Date;
  // Passed through to handlers that re-wrap vault content (set_vault_item_tier).
  // The worker resolves it (env- or KMS-backed); tests supply it directly.
  outerLayerKeks?: KekProvider;
  // Passed through to purge_attachment + delete_account for blob deletes.
  blobStore?: BlobStore;
  // Observability (2026-07-18): a per-action apply failure used to be swallowed
  // silently — a poison action retried forever with nothing logged, which made
  // a real production stall (share-assignments throwing every tick) invisible.
  // The worker injects a logger; the fields are diagnostic ONLY (action id +
  // type + the error's message/SQLSTATE), never the payload (no ciphertext,
  // no secret rides here). Absent ⇒ silent, as before (keeps tests quiet).
  logActionFailure?: (info: {
    actionId: string;
    actionType: string | null;
    error: string;
  }) => void;
}

export interface ApplyResult {
  processed: number;
  applied: number;
  cancelled: number;
  failed: number;
}

// Find pending sensitive_actions whose effective_at is due and apply each
// inside its own transaction. One bad action does not block the rest.
// FOR UPDATE SKIP LOCKED lets multiple workers process in parallel.
export async function applyDueActions(ctx: ApplyContext, limit: number): Promise<ApplyResult> {
  const result: ApplyResult = { processed: 0, applied: 0, cancelled: 0, failed: 0 };

  // Step 1: claim ids outside any longer-held transaction. Each id is then
  // processed in its own tx so a slow handler doesn't bottleneck others.
  const claimedIds: string[] = [];
  await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.sensitiveActions.id })
      .from(schema.sensitiveActions)
      .where(
        and(
          eq(schema.sensitiveActions.status, 'pending'),
          lte(schema.sensitiveActions.effectiveAt, ctx.now),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(limit);
    for (const r of rows) claimedIds.push(r.id);
  });

  for (const id of claimedIds) {
    const outcome = await applyOne(id, ctx);
    // A 'skipped' row (another worker moved it past pending between claim and
    // apply) is neither work done nor a failure — don't count it either way.
    if (outcome === 'skipped') continue;
    result.processed += 1;
    if (outcome === 'applied') result.applied += 1;
    else if (outcome === 'cancelled') result.cancelled += 1;
    else result.failed += 1;
  }

  return result;
}

type ApplyOutcomeTag = 'applied' | 'cancelled' | 'failed' | 'skipped';

async function applyOne(actionId: string, ctx: ApplyContext): Promise<ApplyOutcomeTag> {
  // Captured inside the tx before the handler runs so the catch below can name
  // WHICH action type failed even though the tx itself rolled back.
  let actionType: string | null = null;
  try {
    return await ctx.db.transaction<ApplyOutcomeTag>(async (tx) => {
      const tdb = tx as unknown as Database;

      // Re-lock the row inside this tx. If something else has already moved
      // it past 'pending' between the claim and now, skip cleanly — a benign
      // race (another worker won it), NOT a failure.
      const rows = await tdb
        .select()
        .from(schema.sensitiveActions)
        .where(eq(schema.sensitiveActions.id, actionId))
        .for('update');
      const row = rows[0];
      if (!row || row.status !== 'pending') return 'skipped';
      actionType = row.actionType;

      const pending: PendingAction = {
        id: row.id,
        userId: row.userId as UserId,
        actionType: row.actionType as SensitiveActionType,
        payload: row.actionPayload as Record<string, unknown>,
        requestedAt: row.requestedAt,
        effectiveAt: row.effectiveAt,
        initiatedBy: row.initiatedBy === 'ai' ? 'ai' : 'owner',
      };

      const handlerOutcome: HandlerOutcome = await runHandler(pending, {
        db: tdb,
        now: ctx.now,
        ...(ctx.outerLayerKeks !== undefined ? { outerLayerKeks: ctx.outerLayerKeks } : {}),
        ...(ctx.blobStore !== undefined ? { blobStore: ctx.blobStore } : {}),
      });

      const eventType =
        handlerOutcome.kind === 'applied'
          ? 'sensitive_action.applied'
          : 'sensitive_action.cancelled';
      const auditPayload: Record<string, unknown> = {
        sensitiveActionId: row.id,
        actionType: row.actionType,
        ...(handlerOutcome.kind === 'applied'
          ? { details: handlerOutcome.details ?? {} }
          : { reason: handlerOutcome.reason }),
      };
      const auditEntry = await ctx.audit.append(
        tdb,
        row.userId as UserId,
        eventType,
        auditPayload,
      );

      if (handlerOutcome.kind === 'applied') {
        await tdb
          .update(schema.sensitiveActions)
          .set({
            status: 'applied',
            appliedAt: ctx.now,
            auditIdTerminal: auditEntry.id,
            updatedAt: ctx.now,
          })
          .where(eq(schema.sensitiveActions.id, row.id));
        return 'applied';
      }

      await tdb
        .update(schema.sensitiveActions)
        .set({
          status: 'cancelled',
          cancelledAt: ctx.now,
          cancelledVia: 'processor',
          cancelledReason: handlerOutcome.reason,
          auditIdTerminal: auditEntry.id,
          updatedAt: ctx.now,
        })
        .where(eq(schema.sensitiveActions.id, row.id));
      return 'cancelled';
    });
  } catch (err) {
    // Don't let one bad row poison the BATCH — the action stays 'pending' and
    // is reclaimed next tick. But it must not fail SILENTLY: log the action id,
    // type, and error so a persistent throw (a poison action retrying forever)
    // is diagnosable, not a mystery in a batch counter. Diagnostic fields only —
    // never the payload.
    ctx.logActionFailure?.({ actionId, actionType, error: errorMessage(err) });
    return 'failed';
  }
}

// A safe, bounded error string for logs: the message + SQLSTATE code when the
// driver provides one. Never the payload; pg constraint details name only
// scalar columns (uuid/enum/int), not ciphertext.
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const base = err.message.slice(0, 300);
    return typeof code === 'string' && code !== '' ? `[${code}] ${base}` : base;
  }
  return String(err).slice(0, 300);
}
