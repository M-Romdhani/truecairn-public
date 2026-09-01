import type { GuardianConfig } from './config.js';

// ── Deterministic anomaly detectors (plan docs/25 §7 / D2) ────────────────────
//
// PURE rule-based detectors: (feature values, thresholds) → a verdict. They DECIDE
// whether a review is warranted; the LLM never runs this logic (at most it rewrites
// the resulting explanation). Because there is no model output on the decision
// path, there is no prompt-injection surface into the guardian.
//
// The one action any fired detector can cause — through the chokepoint — is the
// fail-closed `review_required` engine signal, which PAUSES a release for human
// review. A false positive costs the owner one dismissal; a true positive stops a
// wrongful release. Statistics can pause the ladder, never advance it.

export const DETECTOR_IDS = ['affirmation_velocity', 'failed_auth_during_release'] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

export type Severity = 1 | 2;

export interface DetectorVerdict {
  detectorId: DetectorId;
  fired: boolean;
  severity: Severity;
  // Observed values + the threshold that decided it — recorded in the audit
  // (ai_review_signal_emitted) for forensics. Numbers only, never content.
  features: Record<string, number>;
}

// The largest number of timestamps (ms) falling within ANY window of `windowMs` —
// i.e. the tightest cluster. O(n log n). Used to detect "N events within T minutes"
// regardless of where in the history the burst occurred.
export function maxClusterSize(timestampsMs: number[], windowMs: number): number {
  if (timestampsMs.length === 0) return 0;
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  let best = 1;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end]! - sorted[start]! > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

// affirmation_velocity (severity 2): a suspicious burst of committed affirmations —
// contacts affirming near-simultaneously is the signature of a coordinated/coerced
// release. Ceremony-time ⇒ the highest stakes ⇒ bypasses the cooldown.
export function detectAffirmationVelocity(
  commitTimestampsMs: number[],
  cfg: GuardianConfig,
): DetectorVerdict {
  const windowMs = cfg.affirmationVelocity.windowMinutes * 60_000;
  const cluster = maxClusterSize(commitTimestampsMs, windowMs);
  return {
    detectorId: 'affirmation_velocity',
    fired: cluster >= cfg.affirmationVelocity.threshold,
    severity: 2,
    features: {
      clusterSize: cluster,
      threshold: cfg.affirmationVelocity.threshold,
      windowMinutes: cfg.affirmationVelocity.windowMinutes,
    },
  };
}

// failed_auth_during_release (severity 1): a spike of failed auth attempts while a
// release is in progress — someone fumbling or forcing access during the window
// that matters most. The caller only runs this when the engine is release-relevant.
export function detectFailedAuthSpike(
  failedTimestampsMs: number[],
  cfg: GuardianConfig,
): DetectorVerdict {
  const windowMs = cfg.failedAuthSpike.windowMinutes * 60_000;
  const cluster = maxClusterSize(failedTimestampsMs, windowMs);
  return {
    detectorId: 'failed_auth_during_release',
    fired: cluster >= cfg.failedAuthSpike.threshold,
    severity: 1,
    features: {
      clusterSize: cluster,
      threshold: cfg.failedAuthSpike.threshold,
      windowMinutes: cfg.failedAuthSpike.windowMinutes,
    },
  };
}
