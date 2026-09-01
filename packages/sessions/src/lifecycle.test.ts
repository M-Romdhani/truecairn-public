import { describe, expect, it } from 'vitest';
import type { SessionId, UserId } from '@truecairn/shared';
import { isStepUpFresh } from './lifecycle.js';
import { DEFAULT_STEPUP_FRESHNESS_MS, type SessionContext } from './types.js';

function ctx(lastStepupAt: Date | null): SessionContext {
  return {
    id: 's' as SessionId,
    userId: 'u' as UserId,
    deviceRegistrationId: null,
    createdAt: new Date(0),
    lastSeenAt: new Date(0),
    idleExpiresAt: new Date(0),
    absoluteExpiresAt: new Date(0),
    lastStepupAt,
  };
}

describe('isStepUpFresh', () => {
  const now = new Date('2026-05-29T12:00:00Z');

  it('is false when there is no step-up on record', () => {
    expect(isStepUpFresh(ctx(null), now)).toBe(false);
  });

  it('is true within the 10-minute freshness window', () => {
    const recent = new Date(now.getTime() - (DEFAULT_STEPUP_FRESHNESS_MS - 1000));
    expect(isStepUpFresh(ctx(recent), now)).toBe(true);
  });

  it('is false at or beyond the freshness window', () => {
    expect(isStepUpFresh(ctx(new Date(now.getTime() - DEFAULT_STEPUP_FRESHNESS_MS)), now)).toBe(
      false,
    );
    expect(
      isStepUpFresh(ctx(new Date(now.getTime() - DEFAULT_STEPUP_FRESHNESS_MS - 60_000)), now),
    ).toBe(false);
  });

  it('honours an explicit freshness override', () => {
    const t = new Date(now.getTime() - 30_000);
    expect(isStepUpFresh(ctx(t), now, 20_000)).toBe(false);
    expect(isStepUpFresh(ctx(t), now, 60_000)).toBe(true);
  });
});
