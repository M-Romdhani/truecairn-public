import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARDIAN_CONFIG } from './config.js';
import {
  detectAffirmationVelocity,
  detectFailedAuthSpike,
  maxClusterSize,
} from './detectors.js';

const cfg = DEFAULT_GUARDIAN_CONFIG; // affirmation: 3 in 5min; failed auth: 5 in 15min

// Build `n` timestamps spread evenly across `spanMinutes`, ending at t0.
function spread(t0: number, n: number, spanMinutes: number): number[] {
  if (n <= 1) return n === 1 ? [t0] : [];
  const step = (spanMinutes * 60_000) / (n - 1);
  return Array.from({ length: n }, (_, i) => t0 - i * step);
}

const T0 = Date.parse('2026-07-04T12:00:00Z');

describe('maxClusterSize', () => {
  it('finds the tightest burst regardless of position in history', () => {
    // Three within 4 minutes, plus two stragglers hours earlier.
    const ts = [T0, T0 - 60_000, T0 - 2 * 60_000, T0 - 3 * 3_600_000, T0 - 4 * 3_600_000];
    expect(maxClusterSize(ts, 5 * 60_000)).toBe(3);
  });
  it('is 0 for empty and 1 for a lone event', () => {
    expect(maxClusterSize([], 60_000)).toBe(0);
    expect(maxClusterSize([T0], 60_000)).toBe(1);
  });
});

describe('affirmation_velocity (severity 2)', () => {
  it('FIRES: 3 commits within 5 minutes', () => {
    const v = detectAffirmationVelocity(spread(T0, 3, 4), cfg);
    expect(v.fired).toBe(true);
    expect(v.severity).toBe(2);
    expect(v.features['clusterSize']).toBe(3);
  });
  it('NEAR-MISS: 3 commits spread over 20 minutes does NOT fire', () => {
    expect(detectAffirmationVelocity(spread(T0, 3, 20), cfg).fired).toBe(false);
  });
  it('NEAR-MISS: only 2 commits within 5 minutes does NOT fire', () => {
    expect(detectAffirmationVelocity(spread(T0, 2, 3), cfg).fired).toBe(false);
  });
});

describe('failed_auth_during_release (severity 1)', () => {
  it('FIRES: 5 failed attempts within 15 minutes', () => {
    const v = detectFailedAuthSpike(spread(T0, 5, 10), cfg);
    expect(v.fired).toBe(true);
    expect(v.severity).toBe(1);
  });
  it('NEAR-MISS: 5 failures spread over 2 hours does NOT fire', () => {
    expect(detectFailedAuthSpike(spread(T0, 5, 120), cfg).fired).toBe(false);
  });
  it('NEAR-MISS: 4 failures within 15 minutes does NOT fire', () => {
    expect(detectFailedAuthSpike(spread(T0, 4, 10), cfg).fired).toBe(false);
  });
});
