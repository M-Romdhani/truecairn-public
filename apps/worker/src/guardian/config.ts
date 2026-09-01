// ── Guardian thresholds (plan docs/25 §7) ─────────────────────────────────────
//
// Every guardian threshold is CONFIG (GUARDIAN_* env), listed in docs/AI.md, so a
// deployment can tune sensitivity without a code change and a reviewer can see
// exactly what fires a review. Deterministic — these bound rule-based detectors,
// never model output.

export interface GuardianConfig {
  // affirmation_velocity (severity 2): >= `threshold` committed affirmations within
  // any `windowMinutes` span during a ceremony → a review (bypasses cooldown).
  affirmationVelocity: { windowMinutes: number; threshold: number };
  // failed_auth_during_release (severity 1): >= `threshold` failed auth attempts
  // within any `windowMinutes` span while a release is in progress → a review.
  failedAuthSpike: { windowMinutes: number; threshold: number };
  // Per-user hysteresis: at most one AUTOMATIC review per this many days, UNLESS a
  // severity-2 (ceremony-time) detector fires, which bypasses the cooldown.
  cooldownDays: number;
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  affirmationVelocity: { windowMinutes: 5, threshold: 3 },
  failedAuthSpike: { windowMinutes: 15, threshold: 5 },
  cooldownDays: 7,
};

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadGuardianConfig(env: NodeJS.ProcessEnv = process.env): GuardianConfig {
  const d = DEFAULT_GUARDIAN_CONFIG;
  return {
    affirmationVelocity: {
      windowMinutes: intEnv(env['GUARDIAN_AFFIRMATION_WINDOW_MIN'], d.affirmationVelocity.windowMinutes),
      threshold: intEnv(env['GUARDIAN_AFFIRMATION_THRESHOLD'], d.affirmationVelocity.threshold),
    },
    failedAuthSpike: {
      windowMinutes: intEnv(env['GUARDIAN_FAILED_AUTH_WINDOW_MIN'], d.failedAuthSpike.windowMinutes),
      threshold: intEnv(env['GUARDIAN_FAILED_AUTH_THRESHOLD'], d.failedAuthSpike.threshold),
    },
    cooldownDays: intEnv(env['GUARDIAN_COOLDOWN_DAYS'], d.cooldownDays),
  };
}
