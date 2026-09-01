import type { DeviceRegistrationId, SessionId, UserId } from '@truecairn/shared';

// Session lifetime defaults (PHASE3_1_AUTH_PROPOSAL §1/§2, approved 2026-05-29).
export const DEFAULT_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, sliding
export const DEFAULT_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, hard cap
export const DEFAULT_STEPUP_FRESHNESS_MS = 10 * 60 * 1000; // 10 min (Q6, resolved)

// The safe, non-secret view of a session handed to request handlers. It never
// carries token_hash. `lastStepupAt` drives the step-up freshness check used by
// the (later) tier-2 gate.
export interface SessionContext {
  id: SessionId;
  userId: UserId;
  deviceRegistrationId: DeviceRegistrationId | null;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastStepupAt: Date | null;
}
