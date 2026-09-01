import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { SensitiveActionType, UserId } from '@truecairn/shared';
import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import { DEFAULT_COOLDOWN_DAYS } from './types.js';

export interface RequestSensitiveActionInput {
  userId: UserId;
  actionType: SensitiveActionType;
  payload: Record<string, unknown>;
  now: Date;
  cooldownDays?: number;
  // The session that requested this action (PHASE3_1 §"(f)"). Recorded for the
  // 3.4 "list my pending actions" / forensics surface. The action SURVIVES that
  // session's revocation — the cooldown is the control, not the session — so the
  // FK is ON DELETE SET NULL, never CASCADE.
  requestedBySessionId?: string;
  // The step-up proof that authorized this request (PHASE3_1 §c). The signature
  // signs the step-up payload (NOT the audit entry_hash, which the client cannot
  // predict), so it is recorded in the action's audit PAYLOAD for forensic
  // linkage — never as audit_log.user_signature (that would break verifyChain).
  // Mirrors the linkage every 3.1 step-up route records. signature is base64url.
  stepUp?: { challengeId: string; signature: string };
  // WHO initiated this action (plan docs/25 §6). Default 'owner'. 'ai' marks an
  // autonomy-sweep enqueue: it carries NO step-up and is still fully vetoable during
  // the delay — the delay + veto IS autonomy's control. Recorded on the row + audit
  // and reflected in the owner's notice so the AI is named as initiator.
  initiatedBy?: 'owner' | 'ai';
}

export interface RequestSensitiveActionResult {
  id: string;
  effectiveAt: Date;
}

// Called by the Phase 3 API when the user requests a sensitive action. Inserts
// the pending row, writes the audit_log "sensitive_action.requested" entry,
// and enqueues immediate + (effective_at − 24h) notifications across every
// non-removed channel the user has registered.
//
// Per docs/10-threat-5.2: notifications go to channels even if the action
// itself is "remove channel X" — the channel being removed gets the notice
// before the removal is honored. We honor that here by sending to all
// non-removed channels at request time regardless of action_type.
export async function requestSensitiveAction(
  db: Database,
  audit: AuditLogPort,
  input: RequestSensitiveActionInput,
): Promise<RequestSensitiveActionResult> {
  const cooldownDays = input.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const effectiveAt = new Date(input.now.getTime() + cooldownDays * 24 * 60 * 60 * 1000);

  const initiatedBy = input.initiatedBy ?? 'owner';
  const auditPayload: Record<string, unknown> = {
    actionType: input.actionType,
    effectiveAt: effectiveAt.toISOString(),
    cooldownDays,
    initiatedBy,
  };
  if (input.stepUp !== undefined) {
    auditPayload['stepUpChallengeId'] = input.stepUp.challengeId;
    auditPayload['stepUpSignature'] = input.stepUp.signature;
  }
  // Invariant 5 (CLAUDE.md): the audit append and the pending-row insert (plus the
  // notice rows) must commit ATOMICALLY — the audit entry rides the SAME
  // transaction as the state change it records — so a crash can't leave an orphan
  // audit entry without its action. The apply path (processor.ts) already wraps
  // handler+audit+status this way; this is the request/intent path.
  return await db.transaction<RequestSensitiveActionResult>(async (tx) => {
    const tdb = tx as unknown as Database;

    const auditEntry = await audit.append(
      tdb,
      input.userId,
      'sensitive_action.requested',
      auditPayload,
    );

    const [row] = await tdb
      .insert(schema.sensitiveActions)
      .values({
        userId: input.userId,
        actionType: input.actionType,
        status: 'pending',
        initiatedBy,
        actionPayload: input.payload,
        requestedAt: input.now,
        effectiveAt,
        auditIdRequest: auditEntry.id,
        requestedBySessionId: input.requestedBySessionId ?? null,
      })
      .returning({ id: schema.sensitiveActions.id });
    if (!row) throw new Error('sensitive_actions insert returned no row');

    await scheduleNotices(tdb, input.userId, row.id, input.now, effectiveAt, initiatedBy);

    return { id: row.id, effectiveAt };
  });
}

async function scheduleNotices(
  db: Database,
  userId: UserId,
  sensitiveActionId: string,
  now: Date,
  effectiveAt: Date,
  initiatedBy: 'owner' | 'ai',
): Promise<void> {
  // sensitive_action_notice is a routine owner notice (docs/26 §3.1): the
  // owner's channel matrix applies — a channel opted out of owner_notices is
  // skipped (absent preference row = enabled). Everything else about the
  // fanout stands, including docs/10-threat-5.2: a channel whose own removal
  // is the pending action still receives this notice.
  const channels = await db
    .select({ id: schema.notificationChannels.id })
    .from(schema.notificationChannels)
    .where(
      and(
        eq(schema.notificationChannels.userId, userId),
        isNull(schema.notificationChannels.removedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(schema.channelPreferences)
            .where(
              and(
                eq(schema.channelPreferences.channelId, schema.notificationChannels.id),
                eq(schema.channelPreferences.purposeClass, 'owner_notices'),
                eq(schema.channelPreferences.enabled, false),
              ),
            ),
        ),
      ),
    );
  if (channels.length === 0) return;

  // Name the AI as initiator in the notice (plan §6) so an autonomous action is
  // never a silent change — the owner sees it was AI-initiated and can veto.
  const requested =
    initiatedBy === 'ai'
      ? 'The AI proposed a sensitive action on your behalf — veto it if unwanted'
      : 'A sensitive action has been requested';
  const reminder =
    initiatedBy === 'ai'
      ? 'An AI-proposed action applies in 24h — veto it if unwanted'
      : 'Sensitive action applies in 24h';

  const reminderAt = new Date(effectiveAt.getTime() - 24 * 60 * 60 * 1000);
  const rows: Array<typeof schema.notificationDeliveries.$inferInsert> = [];
  for (const c of channels) {
    rows.push({
      channelId: c.id,
      userId,
      purpose: 'sensitive_action_notice',
      relatedEntityType: 'sensitive_action',
      relatedEntityId: sensitiveActionId,
      status: 'queued',
      nextAttemptAt: now,
      payloadSummary: requested,
    });
    if (reminderAt > now) {
      rows.push({
        channelId: c.id,
        userId,
        purpose: 'sensitive_action_notice',
        relatedEntityType: 'sensitive_action',
        relatedEntityId: sensitiveActionId,
        status: 'queued',
        nextAttemptAt: reminderAt,
        payloadSummary: reminder,
      });
    }
  }
  await db.insert(schema.notificationDeliveries).values(rows);
}

// Cancel a pending action. The terminal audit entry records why and which
// session/channel triggered the cancel.
export interface CancelInput {
  sensitiveActionId: string;
  via: string;
  reason: string;
  now: Date;
}

export async function cancelSensitiveAction(
  db: Database,
  audit: AuditLogPort,
  input: CancelInput,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.sensitiveActions)
    .where(eq(schema.sensitiveActions.id, input.sensitiveActionId))
    .for('update');
  const row = rows[0];
  if (!row) return false;
  if (row.status !== 'pending') return false;

  const auditEntry = await audit.append(
    db,
    row.userId as UserId,
    'sensitive_action.cancelled',
    {
      sensitiveActionId: input.sensitiveActionId,
      actionType: row.actionType,
      via: input.via,
      reason: input.reason,
    },
  );

  await db
    .update(schema.sensitiveActions)
    .set({
      status: 'cancelled',
      cancelledAt: input.now,
      cancelledVia: input.via,
      cancelledReason: input.reason,
      auditIdTerminal: auditEntry.id,
      updatedAt: input.now,
    })
    .where(eq(schema.sensitiveActions.id, input.sensitiveActionId));

  await clearPendingMarker(db, row.actionType, row.userId as UserId, row.actionPayload, input.now);

  return true;
}

// Undo the marker the ENQUEUE set, if the action type set one.
//
// Two action types write a `pending_delete_at` onto the thing they will destroy,
// so the UI can show "pending deletion" during the cooldown. The APPLY handlers
// clear it; cancelling did not, because cancel only ever touched the
// sensitive_actions row. A cancelled deletion therefore left the row flagged
// forever, and on attachments that is user-visible: the item reads "pending
// deletion" permanently, with no way to clear it and no pending action behind
// it (QA P3-4).
//
// A per-type map rather than an `if` because the set will grow: any future
// action that marks its target at enqueue owes a clearer here, and the pairing
// is easier to see when both directions are named in one place. Types absent
// from the map mark nothing and need nothing.
//
// Runs in the caller's transaction alongside the status write, so a cancel
// cannot half-apply — the marker and the action row move together or not at all.
type MarkerClearer = (
  db: Database,
  userId: UserId,
  payload: Record<string, unknown>,
  now: Date,
) => Promise<void>;

const PENDING_MARKER_CLEARERS: Partial<Record<SensitiveActionType, MarkerClearer>> = {
  delete_vault_item: async (db, userId, payload, now) => {
    const itemId = payload['itemId'];
    if (typeof itemId !== 'string') return;
    await db
      .update(schema.vaultItems)
      .set({ pendingDeleteAt: null, updatedAt: now })
      .where(and(eq(schema.vaultItems.id, itemId), eq(schema.vaultItems.userId, userId)));
  },
  purge_attachment: async (db, userId, payload, now) => {
    const attachmentId = payload['attachmentId'];
    if (typeof attachmentId !== 'string') return;
    await db
      .update(schema.attachments)
      .set({ pendingDeleteAt: null, updatedAt: now })
      .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.userId, userId)));
  },
};

async function clearPendingMarker(
  db: Database,
  actionType: string,
  userId: UserId,
  payload: unknown,
  now: Date,
): Promise<void> {
  const clear = PENDING_MARKER_CLEARERS[actionType as SensitiveActionType];
  if (clear === undefined) return;
  // A malformed payload cannot be cleaned up, but it must not fail the cancel:
  // refusing to cancel is strictly worse than a stale marker (docs/02 — cancel
  // is always easier than progression).
  if (typeof payload !== 'object' || payload === null) return;
  await clear(db, userId, payload as Record<string, unknown>, now);
}
