// Engine-state gating for the vault path (PHASE3_3 §c). The engine decides what
// the vault may do: writes are refused once a release is engaged, and an owner
// READ during a release state is the "user showed up" signal that pauses the
// ladder (the engine's existing user_authenticated_during_release → returning).
// 3.3 reads state and fires the event; it does not invent control flow.

import { schema, type Database } from '@truecairn/db';
import {
  applyEvent,
  loadRow,
  type ApplyContext,
  type AuditLogPort,
  type NotificationChannelLookup,
} from '@truecairn/engine';
import type { EngineState, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import { ApiError } from '../errors.js';

const VAULT_LOCKED_TYPE = 'https://truecairn.app/problems/vault-locked-during-release';

// Vault content cannot change while a release is engaged or under manual review
// (you can't rewrite what's being released; you can't edit while paused in
// returning). Writes are permitted in ACTIVE + the monitoring states (the owner
// is still in control and hasn't begun releasing).
const LOCKED_FOR_WRITE: ReadonlySet<EngineState> = new Set<EngineState>([
  'release_review',
  'limited_release',
  'staged_release',
  'full_release',
  'returning',
  'review_required',
]);

// States where an owner read can still PAUSE the ladder: the engine's
// user_authenticated_during_release transitions exactly these → returning.
const READ_PAUSES_LADDER: ReadonlySet<EngineState> = new Set<EngineState>([
  'release_review',
  'limited_release',
  'staged_release',
]);

// States where an owner read is security-relevant (audited) but cannot transition
// (full_release is terminal; returning is already paused; review_required is
// manual). No engine event, just the audit entry.
const READ_AUDIT_ONLY: ReadonlySet<EngineState> = new Set<EngineState>([
  'full_release',
  'returning',
  'review_required',
]);

// Refuse a vault MUTATION when the engine is in a release/review/returning state.
// No engine_states row (engine not armed) ⇒ writable. Throws 409 otherwise.
export async function assertVaultWritable(db: Database, userId: UserId): Promise<void> {
  const [row] = await db
    .select({ state: schema.engineStates.state })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);
  if (row && LOCKED_FOR_WRITE.has(row.state)) {
    throw new ApiError(
      409,
      'Vault locked during release',
      'vault content cannot be modified while a release is in progress — confirm you are active to resume editing',
      VAULT_LOCKED_TYPE,
      { engineState: row.state },
    );
  }
}

export interface OwnerAccessContext {
  db: Database;
  audit: AuditLogPort;
  channels: NotificationChannelLookup;
  now: Date;
}

export interface OwnerAccessResult {
  stateBefore: EngineState | null;
  // The state the engine transitioned to (e.g. 'returning'), or null if no
  // transition fired.
  transitionedTo: EngineState | null;
}

// Record an owner READ. In a release state it emits user_authenticated_during_release
// (→ returning, pausing the cooldown ladder) and audits vault.fetched_during_release;
// in the audit-only release states it just audits; in ACTIVE/monitoring it does
// nothing (a routine read isn't audited — that would flood the per-user chain).
// Runs in its own transaction so the FOR UPDATE load + the transition commit
// atomically. The read itself is served regardless — this only records/pauses.
export async function noteOwnerReadAccess(
  base: OwnerAccessContext,
  userId: UserId,
): Promise<OwnerAccessResult> {
  return base.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const row = await loadRow(tx, userId);
    if (!row) return { stateBefore: null, transitionedTo: null };

    if (READ_PAUSES_LADDER.has(row.state)) {
      const ctx: ApplyContext = { db: tx, audit: base.audit, channels: base.channels, now: base.now };
      const result = await applyEvent(row, { kind: 'user_authenticated_during_release' }, ctx);
      await base.audit.append(tx, userId, 'vault.fetched_during_release', {
        stateBefore: row.state,
      });
      return {
        stateBefore: row.state,
        transitionedTo: result.kind === 'transition' ? result.toState : null,
      };
    }
    if (READ_AUDIT_ONLY.has(row.state)) {
      await base.audit.append(tx, userId, 'vault.fetched_during_release', {
        stateBefore: row.state,
      });
      return { stateBefore: row.state, transitionedTo: null };
    }
    return { stateBefore: row.state, transitionedTo: null };
  });
}
