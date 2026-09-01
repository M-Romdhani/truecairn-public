import type { Database } from '@truecairn/db';
import type { AppendedAuditEntry } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import {
  AiAuthorityError,
  assertActionKindAllowed,
  assertAllowedEngineSignal,
  toEngineEvent,
  type AiActionTier,
  type AiAutonomousKind,
  type AiEngineSignal,
} from './capabilities.js';
import { isAiAuditEventType, type AiAuditEventType } from './audit-events.js';

// ── The authority chokepoint (plan docs/25 §3.1 / D1) ─────────────────────────
//
// ONE module owns every side effect the AI can cause. Nothing else under an AI
// code path (apps/api/src/ai/**, the guardian worker) imports the engine,
// ceremony, or sensitive-actions packages directly — enforced by the import-fence
// test (apps/api/src/ai/authority-fence.test.ts). Every AI effect flows through an
// instance of this class, which (a) runs the type + runtime guards, and (b) writes
// the audit event in the SAME transaction as the effect, always with actor='ai'.
//
// The concrete engine / sensitive-action effects are INJECTED as ports so this
// package never depends on the engine applier and stays unit-testable with fakes.
// Phases 1–3 provide the real ports; Phase 0 ships the guards + audit surface that
// the invariant tests and the cost breaker rely on.

// The audit port, structurally the engine's AuditLogPort plus the forensic actor.
// The real implementation is @truecairn/audit's AuditLogWriter.
export interface AiAuditPort {
  append(
    db: Database,
    userId: UserId,
    eventType: string,
    payload: Record<string, unknown>,
    opts: { actor: 'ai' },
  ): Promise<AppendedAuditEntry>;
}

// The single fail-closed engine effect, injected. The implementation maps the AI
// signal to the engine's dispute_raised event (→ review_required state). Returns
// whether the engine actually changed state (it is a no-op if already terminal).
export interface ReviewRequiredPort {
  raiseReviewRequired(
    db: Database,
    userId: UserId,
    now: Date,
  ): Promise<{ changed: boolean; toState: string | null }>;
}

export interface AiAuthorityPorts {
  audit: AiAuditPort;
  // Optional until Phase 3 wires the guardian; emitEngineSignal throws a clear
  // error if invoked without it, rather than silently no-op.
  engine?: ReviewRequiredPort;
}

export class AiAuthority {
  constructor(private readonly ports: AiAuthorityPorts) {}

  // Append an AI audit event. Guards: the event type MUST be an AI event type,
  // and the actor is FORCED to 'ai' — a caller cannot launder a non-AI event or a
  // different actor through this method. This is the single writer of AI audit
  // rows; the cost breaker (ai_breaker_tripped), proposal lifecycle, and output
  // rejection all go through it.
  async appendAiAudit(
    db: Database,
    userId: UserId,
    eventType: AiAuditEventType,
    payload: Record<string, unknown>,
  ): Promise<AppendedAuditEntry> {
    if (!isAiAuditEventType(eventType)) {
      throw new AiAuthorityError(`'${eventType}' is not an AI audit event type`);
    }
    return this.ports.audit.append(db, userId, eventType, payload, { actor: 'ai' });
  }

  // Emit the ONE allowed engine signal. The guard runs FIRST: any signal other
  // than 'review_required' throws before any effect or audit write. On success it
  // records ai_review_signal_emitted (actor='ai') and delegates the concrete
  // state change to the injected engine port — the same transaction, so the audit
  // append and the transition commit or roll back together.
  async emitEngineSignal(
    db: Database,
    userId: UserId,
    signal: AiEngineSignal,
    detail: { detectorId: string; payload: Record<string, unknown>; now: Date },
  ): Promise<{ changed: boolean; toState: string | null }> {
    assertAllowedEngineSignal(signal);
    // Materialise the concrete event through the single mapping (proves the only
    // reachable event is dispute_raised); the port performs it.
    toEngineEvent(signal);
    if (this.ports.engine === undefined) {
      throw new AiAuthorityError('engine port not wired: emitEngineSignal is unavailable');
    }
    await this.appendAiAudit(db, userId, 'ai_review_signal_emitted', {
      detectorId: detail.detectorId,
      ...detail.payload,
    });
    return this.ports.engine.raiseReviewRequired(db, userId, detail.now);
  }

  // Guard a proposal/autonomy action by kind + tier before it is created or
  // enqueued. Throws for an unregistered kind, a wrong tier, or a protection-
  // loosening kind at the autonomous tier. Pure delegation to the registry guard;
  // exposed on the chokepoint so every call site goes through one door.
  assertActionAllowed(kind: string, tier: AiActionTier): void {
    assertActionKindAllowed(kind, tier);
  }

  // Enqueue a bounded-autonomy action (plan §6). The guard runs FIRST: an
  // unregistered kind, a non-autonomous kind, or a protection-LOOSENING kind
  // ('open' safety direction) throws before any effect — so a loosening action can
  // never execute unattended. On success, the caller-supplied `enqueue` (which uses
  // the EXISTING sensitive-actions / notification machinery — the AI gets no new
  // execution path) runs inside ONE transaction with the ai_autonomous_enqueued
  // audit (actor='ai'), so the effect and its forensic record commit together.
  async enqueueAutonomous(
    db: Database,
    userId: UserId,
    kind: AiAutonomousKind,
    auditSummary: Record<string, unknown>,
    enqueue: (tx: Database) => Promise<{ reference: string | null }>,
  ): Promise<{ reference: string | null }> {
    assertActionKindAllowed(kind, 'autonomous');
    return db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const result = await enqueue(tx);
      await this.appendAiAudit(tx, userId, 'ai_autonomous_enqueued', {
        kind,
        reference: result.reference,
        ...auditSummary,
      });
      return result;
    });
  }
}
