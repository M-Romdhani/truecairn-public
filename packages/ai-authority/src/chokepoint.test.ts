import type { Database } from '@truecairn/db';
import type { AppendedAuditEntry } from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  AiAuthority,
  AiAuthorityError,
  assertActionSpecAllowed,
  type AiAuditPort,
  type ReviewRequiredPort,
} from './index.js';

// A fake audit port that records every append so the tests can assert the actor
// and event type without a database.
function fakeAudit(): AiAuditPort & {
  calls: { eventType: string; actor: string; payload: Record<string, unknown> }[];
} {
  const calls: { eventType: string; actor: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    async append(_db, _userId, eventType, payload, opts): Promise<AppendedAuditEntry> {
      calls.push({ eventType, actor: opts.actor, payload });
      return { id: 'a', seq: 1n, entryHash: new Uint8Array() };
    },
  };
}

const db = {} as Database;
const userId = 'u1' as UserId;

describe('AiAuthority.appendAiAudit', () => {
  it('forces actor=ai and passes the event through', async () => {
    const audit = fakeAudit();
    const authority = new AiAuthority({ audit });
    await authority.appendAiAudit(db, userId, 'ai_breaker_tripped', { scope: 'global' });
    expect(audit.calls).toEqual([
      { eventType: 'ai_breaker_tripped', actor: 'ai', payload: { scope: 'global' } },
    ]);
  });

  it('refuses a non-AI event type (cannot launder a forward event)', async () => {
    const audit = fakeAudit();
    const authority = new AiAuthority({ audit });
    await expect(
      // Cast through unknown: the type system already forbids this; the runtime
      // guard is the defence-in-depth beneath it.
      authority.appendAiAudit(db, userId, 'engine.release_review_passed' as never, {}),
    ).rejects.toThrow(AiAuthorityError);
    expect(audit.calls).toHaveLength(0);
  });
});

describe('AiAuthority.emitEngineSignal', () => {
  it('writes ai_review_signal_emitted and delegates to the engine port', async () => {
    const audit = fakeAudit();
    const engine: ReviewRequiredPort = {
      raiseReviewRequired: vi.fn(async () => ({ changed: true, toState: 'review_required' })),
    };
    const authority = new AiAuthority({ audit, engine });
    const res = await authority.emitEngineSignal(db, userId, 'review_required', {
      detectorId: 'affirmation_velocity',
      payload: { observed: 9, threshold: 5 },
      now: new Date(),
    });
    expect(res).toEqual({ changed: true, toState: 'review_required' });
    expect(audit.calls[0]?.eventType).toBe('ai_review_signal_emitted');
    expect(audit.calls[0]?.actor).toBe('ai');
    expect(engine.raiseReviewRequired).toHaveBeenCalledOnce();
  });

  it('throws for any signal other than review_required, before any audit or effect', async () => {
    const audit = fakeAudit();
    const engine: ReviewRequiredPort = { raiseReviewRequired: vi.fn() };
    const authority = new AiAuthority({ audit, engine });
    await expect(
      authority.emitEngineSignal(db, userId, 'release_review_verification_passed' as never, {
        detectorId: 'x',
        payload: {},
        now: new Date(),
      }),
    ).rejects.toThrow(AiAuthorityError);
    expect(audit.calls).toHaveLength(0);
    expect(engine.raiseReviewRequired).not.toHaveBeenCalled();
  });

  it('throws (never silently no-ops) when the engine port is not wired', async () => {
    const audit = fakeAudit();
    const authority = new AiAuthority({ audit });
    await expect(
      authority.emitEngineSignal(db, userId, 'review_required', {
        detectorId: 'x',
        payload: {},
        now: new Date(),
      }),
    ).rejects.toThrow(/engine port not wired/);
  });
});

describe('AiAuthority.enqueueAutonomous', () => {
  // A fake db.transaction that just runs the callback with the same handle.
  const txDb = { transaction: async (fn: (tx: unknown) => unknown) => fn(txDb) } as unknown as Database;

  it('guards first: a protection-loosening (open) kind is rejected at enqueue', () => {
    // No 'open' kind is registered as autonomous — prove the guard would reject one.
    expect(() =>
      assertActionSpecAllowed('hypothetical_loosener', 'autonomous', {
        safetyDirection: 'open',
        tiers: ['autonomous'],
      }),
    ).toThrow(AiAuthorityError);
  });

  it('rejects a proposal-only kind at the autonomous tier, before any effect', async () => {
    const audit = fakeAudit();
    const authority = new AiAuthority({ audit });
    let enqueued = false;
    await expect(
      authority.enqueueAutonomous(txDb, userId, 'draft_contact_message' as never, {}, async () => {
        enqueued = true;
        return { reference: 'x' };
      }),
    ).rejects.toThrow(AiAuthorityError);
    expect(enqueued).toBe(false);
    expect(audit.calls).toHaveLength(0);
  });

  it('runs the enqueue + writes ai_autonomous_enqueued (actor=ai) for a valid kind', async () => {
    const audit = fakeAudit();
    const authority = new AiAuthority({ audit });
    const res = await authority.enqueueAutonomous(
      txDb,
      userId,
      'send_reminder_nudge',
      { reason: 'miss_likely' },
      async () => ({ reference: 'notif-1' }),
    );
    expect(res).toEqual({ reference: 'notif-1' });
    expect(audit.calls[0]?.eventType).toBe('ai_autonomous_enqueued');
    expect(audit.calls[0]?.actor).toBe('ai');
    expect(audit.calls[0]?.payload).toMatchObject({ kind: 'send_reminder_nudge', reference: 'notif-1', reason: 'miss_likely' });
  });
});
