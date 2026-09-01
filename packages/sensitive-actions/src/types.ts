import type { SensitiveActionType, UserId } from '@truecairn/shared';
import type { BlobStore, KekProvider } from '@truecairn/vault';

// Default cooldown: 7 days per docs/10-threat-5.2 §"the seven-day delay".
export const DEFAULT_COOLDOWN_DAYS = 7;

// Loaded representation of a sensitive_actions row. Kept narrow so handlers
// don't get access to raw audit/timestamp internals.
export interface PendingAction {
  id: string;
  userId: UserId;
  actionType: SensitiveActionType;
  payload: Record<string, unknown>;
  requestedAt: Date;
  effectiveAt: Date;
  // Who enqueued the action. Handlers use this to hold AI-initiated actions to
  // stricter, fail-closed bounds (asymmetric authority: AI may tighten, never
  // loosen — re-checked at APPLY time, not just enqueue time).
  initiatedBy: 'owner' | 'ai';
}

// What a handler returns when it processes a pending action. Handlers run
// inside the same transaction as the audit append + status update, so a
// thrown error rolls everything back.
export type HandlerOutcome =
  | { kind: 'applied'; details?: Record<string, unknown> }
  | { kind: 'cancelled'; reason: string };

export interface HandlerContext {
  now: Date;
  // The handler MUST use this tx db for any reads or writes so its changes
  // are committed atomically with the status update + audit entry.
  db: import('@truecairn/db').Database;
  // The outer-layer KEK provider, present only for handlers that re-wrap vault
  // content (set_vault_item_tier). The worker supplies it (env- or KMS-backed);
  // absent for handlers that don't need it. A vault handler that finds it
  // missing cancels cleanly rather than corrupting state.
  outerLayerKeks?: KekProvider;
  // Blob store for attachment blobs, for the purge_attachment + delete_account
  // handlers (blob delete). The worker supplies it (local disk or S3) via
  // createBlobStore; absent ⇒ those handlers throw and retry rather than orphan
  // blobs.
  blobStore?: BlobStore;
}

export type HandlerFn = (action: PendingAction, ctx: HandlerContext) => Promise<HandlerOutcome>;
