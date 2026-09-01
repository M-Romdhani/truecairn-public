import type { Availability } from './samples.js';
import type { CheckState, SystemStatus } from './system-status.js';

// ── The public projection of the operations dashboard ────────────────────────
//
// /v1/ops/system is admin-gated and says everything: queue depths, dead-letter
// counts, the active KEK id, API/worker version skew, the round-trip error text,
// an engine-event stream. None of that can go on an unauthenticated page. Half
// of it is operational intelligence (a queue backing up and a version skew
// together tell an attacker exactly when this deployment is least able to
// respond), and the rest is detail no visitor can act on.
//
// So this module is a REDUCTION, not a rename, and it is built on two rules.
//
// 1. NO FREE TEXT CROSSES THE BOUNDARY. The public payload carries IDs, enums
//    and integers — never a detail string assembled server-side. Every internal
//    detail is interpolated from live values ("last tick 41s ago", "3 delivery(s)
//    dead-lettered", the KEK id), so forwarding even one of them would leak the
//    numbers this projection exists to withhold. The web page owns the prose and
//    keys it by check ID; the server sends no sentence at all. That makes the
//    safety property testable by shape rather than by reviewing wording:
//    public-status.test.ts asserts the payload contains no internal detail.
//
// 2. ALLOWLIST, NOT DENYLIST. PUBLIC_CHECKS below is a fixed set of IDs. A check
//    added to system-status.ts does NOT appear here until someone adds it
//    deliberately — the same deny-by-default posture as the AI context
//    allowlist. The failure mode of a denylist is that tomorrow's check, named
//    after tomorrow's incident, publishes itself.
//
// What is NOT reduced: the composite state, and the fact that 'unknown' is not
// healthy. Those are the honest core of the page and they cross unchanged.

// Public labels, owned here rather than inherited from the internal check, so
// the wording a visitor sees cannot drift when an operator renames a tile.
const PUBLIC_CHECKS: Readonly<Record<string, string>> = {
  worker: 'Release worker',
  database: 'Database',
  outer_layer_kek: 'Outer-layer key',
  crypto: 'Cryptography',
  audit_signing: 'Audit signing',
  notifications: 'Notification delivery',
  audit_chain: 'Audit chain integrity',
  backups: 'Database backups',
};

export interface PublicCheck {
  id: string;
  label: string;
  state: CheckState;
  releaseCritical: boolean;
}

export interface PublicStatus {
  // The headline: could a release ceremony complete right now? Conjunction over
  // release-critical checks, worst state wins, 'unknown' never healthy.
  releasePath: CheckState;
  checks: PublicCheck[];
  // IDs of the release-critical checks that are not ok, so the page can name
  // them without the server composing a sentence. Empty when releasePath is ok.
  failing: string[];
  availability: Availability;
  observedAt: string;
}

export function toPublicStatus(status: SystemStatus, availability: Availability): PublicStatus {
  const checks: PublicCheck[] = [];
  for (const check of status.checks) {
    const label = PUBLIC_CHECKS[check.id];
    // Deny by default: an unrecognised check is omitted entirely rather than
    // published under its internal label.
    if (label === undefined) continue;
    checks.push({
      id: check.id,
      label,
      state: check.state,
      releaseCritical: check.releaseCritical,
    });
  }

  return {
    releasePath: status.continuityEngine,
    checks,
    failing: checks.filter((c) => c.releaseCritical && c.state !== 'ok').map((c) => c.id),
    availability,
    observedAt: status.observedAt,
  };
}
