import { describe, expect, it } from 'vitest';
import { toPublicStatus } from './public-status.js';
import type { Availability } from './samples.js';
import type { Check, SystemStatus } from './system-status.js';

// The public projection's job is to publish LESS than the admin dashboard. These
// tests pin what must never cross the boundary — see public-status.ts for why
// each one is a leak rather than a nicety.

const AVAILABILITY: Availability = {
  measuringSince: '2026-07-01T00:00:00.000Z',
  observedDays: 29.5,
  requestedWindowDays: 90,
  releasePathOkPercent: 99.4,
  unobservedMinutes: 12,
};

// A realistic internal status, with the detail strings the real collector
// produces — every one of them interpolated from a live value.
function internal(overrides: Partial<SystemStatus> = {}): SystemStatus {
  const checks: Check[] = [
    {
      id: 'database',
      label: 'Database',
      state: 'ok',
      detail: 'reachable',
      releaseCritical: true,
      latencyMs: 3,
    },
    {
      id: 'worker',
      label: 'Release worker',
      state: 'ok',
      detail: 'last tick 41s ago',
      releaseCritical: true,
    },
    {
      id: 'outer_layer_kek',
      label: 'Outer-layer key (release gate)',
      state: 'ok',
      detail: 'wrap/unwrap round-trip verified (kek-2026-prod-07)',
      releaseCritical: true,
    },
    {
      id: 'notifications',
      label: 'Notifications',
      state: 'degraded',
      detail: 'email, sms configured; 3 delivery(s) dead-lettered',
      releaseCritical: true,
    },
    {
      id: 'backups',
      label: 'Database backups',
      state: 'unknown',
      detail: 'not instrumented — managed by the platform; verify in the Railway dashboard',
      releaseCritical: false,
    },
  ];
  return {
    continuityEngine: 'degraded',
    continuitySummary: 'Release path DEGRADED — Notifications',
    checks,
    versions: { api: '1.4.2', worker: '1.4.1', skew: true },
    queues: {
      notificationsQueued: 17,
      notificationsDeadLettered: 3,
      oldestQueuedAgeSeconds: 900,
      sensitiveActionsPending: 4,
      sensitiveActionsOverdue: 1,
      ceremoniesActive: 2,
    },
    observedAt: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('the public projection withholds operational intelligence', () => {
  it('carries no server-composed free text', () => {
    const serialized = JSON.stringify(toPublicStatus(internal(), AVAILABILITY));
    // Every internal detail is built from a live value, so forwarding any one of
    // them would leak the numbers this projection exists to withhold.
    expect(serialized).not.toContain('last tick');
    expect(serialized).not.toContain('round-trip');
    expect(serialized).not.toContain('dead-lettered');
    expect(serialized).not.toContain('Railway');
    expect(serialized).not.toContain('Release path DEGRADED');
  });

  it('leaks neither the active KEK id nor version skew', () => {
    const serialized = JSON.stringify(toPublicStatus(internal(), AVAILABILITY));
    expect(serialized).not.toContain('kek-2026-prod-07');
    expect(serialized).not.toContain('1.4.2');
    expect(serialized).not.toContain('1.4.1');
    expect(serialized).not.toContain('skew');
  });

  it('publishes no queue depths', () => {
    const published = toPublicStatus(internal(), AVAILABILITY);
    expect(published).not.toHaveProperty('queues');
    const serialized = JSON.stringify(published);
    // A backing-up queue plus a version skew tells an attacker exactly when this
    // deployment is least able to respond.
    for (const leak of ['17', '900', 'notificationsQueued', 'ceremoniesActive']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('emits only id, label, state and releaseCritical per check', () => {
    const published = toPublicStatus(internal(), AVAILABILITY);
    for (const check of published.checks) {
      expect(Object.keys(check).sort()).toEqual(['id', 'label', 'releaseCritical', 'state']);
    }
  });

  it('drops latency measurements', () => {
    const published = toPublicStatus(internal(), AVAILABILITY);
    expect(published.checks.every((c) => !('latencyMs' in c))).toBe(true);
  });
});

describe('the allowlist is deny-by-default', () => {
  it('omits a check that has not been deliberately made public', () => {
    // The failure mode of a denylist is that tomorrow's check — named after
    // tomorrow's incident — publishes itself.
    const withNew = internal();
    withNew.checks.push({
      id: 'internal_debug_probe',
      label: 'Customer escalation queue',
      state: 'down',
      detail: 'secret',
      releaseCritical: false,
    });
    const published = toPublicStatus(withNew, AVAILABILITY);
    expect(published.checks.map((c) => c.id)).not.toContain('internal_debug_probe');
    expect(JSON.stringify(published)).not.toContain('Customer escalation queue');
  });

  it('uses its own label, not the internal one', () => {
    const published = toPublicStatus(internal(), AVAILABILITY);
    const kek = published.checks.find((c) => c.id === 'outer_layer_kek');
    // The internal tile is labelled "Outer-layer key (release gate)"; the public
    // wording is owned by the projection so it cannot drift when an operator
    // renames a tile.
    expect(kek?.label).toBe('Outer-layer key');
  });
});

describe('what does cross unchanged', () => {
  it('preserves the composite verdict', () => {
    expect(toPublicStatus(internal(), AVAILABILITY).releasePath).toBe('degraded');
  });

  it('names the failing release-critical checks by id', () => {
    expect(toPublicStatus(internal(), AVAILABILITY).failing).toEqual(['notifications']);
  });

  it('never lists a supporting check as failing', () => {
    // 'backups' is permanently unknown and must not appear as a failure — it is
    // not release-critical, and treating it as one would take the page red
    // forever.
    const published = toPublicStatus(internal(), AVAILABILITY);
    expect(published.failing).not.toContain('backups');
    expect(published.checks.find((c) => c.id === 'backups')?.state).toBe('unknown');
  });

  it('keeps unknown visible rather than rounding it to ok', () => {
    const allUnknown = internal({ continuityEngine: 'unknown' });
    expect(toPublicStatus(allUnknown, AVAILABILITY).releasePath).toBe('unknown');
  });
});
