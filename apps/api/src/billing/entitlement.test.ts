import { describe, expect, it } from 'vitest';
import {
  enrollableChannelTypes,
  PRO_CHANNEL_TYPES,
  WITHDRAWN_CHANNEL_TYPES,
} from './entitlement.js';
import type { NotificationChannelType } from '@truecairn/shared';

// Everything configured — the baseline for the tests that are about PLAN gating
// rather than provider gating. Named rather than inlined so the provider-gating
// tests below read as the deliberate exception they are.
const ALL: ReadonlySet<NotificationChannelType> = new Set<NotificationChannelType>([
  'email',
  'push',
  'sms',
  'whatsapp',
]);

// Pure (no DB): these are the two channel-type sets whose MEANINGS are easy to
// collapse into each other, and collapsing them changes production behaviour in
// ways nothing else would catch. PRO_CHANNEL_TYPES is a BILLING set — the
// downgrade sweep reads it to find residual paid channels a lapsed account still
// holds. WITHDRAWN_CHANNEL_TYPES is an AVAILABILITY set — types nobody can enrol
// at any price. A type can be in both, and WhatsApp is (2026-08-01).
describe('channel-type gating', () => {
  it('whatsapp is withdrawn from enrolment on every plan, paid or not', () => {
    // The bug this pins: a withdrawn type leaking back into the picker for pro
    // users, sending someone who just paid into a flow that cannot complete —
    // Meta will not approve the verification template that gates enrolment, so
    // the code round-trip can never succeed.
    expect(enrollableChannelTypes('free', ALL)).not.toContain('whatsapp');
    expect(enrollableChannelTypes('pro', ALL)).not.toContain('whatsapp');
  });

  it('whatsapp stays in PRO_CHANNEL_TYPES, because that set is about billing', () => {
    // Deliberately NOT symmetric with the test above. Removing whatsapp here
    // would look like tidying up after the withdrawal and would silently stop
    // enqueueDowngradeNotice (billing/webhook.ts) from seeing a grandfathered
    // WhatsApp row — so a lapsed subscriber holding one would get no
    // plan_downgraded notice at all. Withdrawing a type must not re-gate the
    // rows that already exist (docs/28).
    expect(PRO_CHANNEL_TYPES.has('whatsapp')).toBe(true);
  });

  it('withdrawing a type never widens what a plan grants', () => {
    // Monotonicity: the withdrawal filter can only ever SUBTRACT. If a future
    // edit reorders the filter and the subtraction lands before the plan
    // expansion, pro would regain the withdrawn type — which is exactly the
    // shape of the 2026-08-01 engine bug, a guard that stopped applying in the
    // one case it mattered.
    const free = enrollableChannelTypes('free', ALL);
    const pro = enrollableChannelTypes('pro', ALL);
    for (const t of [...free, ...pro]) {
      expect(WITHDRAWN_CHANNEL_TYPES.has(t)).toBe(false);
    }
    expect(free.every((t) => pro.includes(t))).toBe(true);
  });

  it('email and push stay free, and sms stays the paid difference', () => {
    expect(enrollableChannelTypes('free', ALL)).toEqual(['email', 'push']);
    expect(enrollableChannelTypes('pro', ALL)).toContain('sms');
  });

  // ── Provider gating (2026-08-31) ──────────────────────────────────────────
  //
  // Entitlement alone used to decide this, which is the WhatsApp bug arrived at
  // from the other direction: a pro plan on a deployment with no TWILIO_* would
  // offer `sms`, the verification code would dead-letter, and the channel could
  // NEVER become verified — the code round-trip IS how a channel becomes
  // verified. Same "flow that cannot complete", different cause.
  it('does NOT offer a paid channel the deployment has no provider for', () => {
    const noTwilio: ReadonlySet<NotificationChannelType> = new Set<NotificationChannelType>([
      'email',
      'push',
    ]);
    expect(enrollableChannelTypes('pro', noTwilio)).not.toContain('sms');
  });

  it('offers it once the provider IS configured — the gate is provider state, not a ban', () => {
    const withTwilio: ReadonlySet<NotificationChannelType> = new Set<NotificationChannelType>([
      'email',
      'push',
      'sms',
    ]);
    expect(enrollableChannelTypes('pro', withTwilio)).toContain('sms');
  });

  it('an unconfigured email provider removes email even on the free plan', () => {
    // The gate is not "paid channels only". A deployment that cannot send email
    // must not offer it either, or the same dead-letter trap appears on the free
    // plan, where most users are.
    const pushOnly: ReadonlySet<NotificationChannelType> = new Set<NotificationChannelType>([
      'push',
    ]);
    expect(enrollableChannelTypes('free', pushOnly)).toEqual(['push']);
  });

  it('a configured provider still cannot resurrect a withdrawn type', () => {
    // Subtraction order: withdrawn is subtracted LAST. Configuring the WhatsApp
    // credentials must not undo the 2026-08-01 withdrawal — that is a reviewed
    // commit, deliberately not an env-derived decision.
    expect(enrollableChannelTypes('pro', ALL)).not.toContain('whatsapp');
  });
});
