import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { KekProvider } from '@truecairn/vault';
import {
  collectSystemStatus,
  type AiSubsystemDeps,
  type SystemStatusDeps,
} from './system-status.js';

// The release-critical checks that are not ok — the exact set the composite is a
// conjunction over, and what N-1 had permanently non-empty.
const failingCritical = (s: { checks: { id: string; state: string; releaseCritical: boolean }[] }): string[] =>
  s.checks.filter((c) => c.releaseCritical && c.state !== 'ok').map((c) => c.id);

// Identity KEK: this file tests the AI check, not the key hierarchy. Same stub
// shape system-status.test.ts uses.
const echoKeks: KekProvider = {
  currentKekId: 'test',
  wrap: async (key: Uint8Array) => key,
  unwrap: async (_id: string, wrapped: Uint8Array) => wrapped,
} as unknown as KekProvider;

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// The AI health check (fix plan Part A). Its reason for existing: every AI call
// site is fail-soft, so a dead model degrades four surfaces to their templates
// and NOTHING alerts. That resilience is correct; the silence is the gap. And it
// is on a clock — an empty GEMINI_MODEL resolves to the auto-updating
// `gemini-2.5-flash` alias, and the 2.5 family retires 2026-10-16.
describeIfDb('AI subsystem check', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai_usage_daily`;
  });

  async function seedGlobal(calls: number, failures: number): Promise<void> {
    await seedGlobalOn(0, calls, failures);
  }

  // The global rollup for a day N days ago — how the evidence window is tested.
  async function seedGlobalOn(daysAgo: number, calls: number, failures: number): Promise<void> {
    await db.insert(schema.aiUsageDaily).values({
      day: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      userId: null,
      tokensIn: 0,
      tokensOut: 0,
      calls,
      failures,
    });
  }

  const wired: AiSubsystemDeps = {
    killSwitch: true,
    credentialResolved: true,
    model: 'gemini-2.5-flash',
    capabilities: ['proposer', 'autonomy', 'guardian'],
  };

  function deps(overrides: Partial<SystemStatusDeps> = {}): SystemStatusDeps {
    return {
      db,
      outerLayerKeks: echoKeks,
      auditReady: true,
      apiVersion: '0.0.0',
      configuredNotificationTypes: ['email'],
      cryptoReady: () => true,
      backups: { kind: 'none' },
      ai: wired,
      ...overrides,
    };
  }
  const aiCheck = async (o: Partial<SystemStatusDeps> = {}) =>
    (await collectSystemStatus(deps(o))).checks.find((c) => c.id === 'ai');

  it('is NEVER release-critical — a dead model must not move the release composite', async () => {
    // Load-bearing. No release has ever depended on a model call (the worker is
    // AI-free by import fence), and worstReleaseCriticalCheck filters on exactly
    // this flag — so a degraded AI tile must not drag the published availability
    // figure or the release verdict.
    await seedGlobal(0, 25);
    const status = await collectSystemStatus(deps());
    expect(status.checks.find((c) => c.id === 'ai')?.releaseCritical).toBe(false);
    expect(status.continuityEngine).not.toBe('degraded');
  });

  it('reports DEGRADED when every call today failed', async () => {
    await seedGlobal(0, 12);
    const check = await aiCheck();
    expect(check?.state).toBe('degraded');
    expect(check?.detail).toMatch(/every model call today failed/i);
  });

  it('reports OK once anything succeeded, even alongside failures', async () => {
    // A partial failure rate is normal for a network call; the signal this check
    // exists for is TOTAL failure, which is what a retired model looks like.
    await seedGlobal(9, 3);
    const check = await aiCheck();
    expect(check?.state).toBe('ok');
    expect(check?.detail).toMatch(/3 failed/);
  });

  it('reports UNKNOWN — never ok — when nothing was attempted', async () => {
    // Rule 1 of this module: never green for something not actually checked. An
    // idle day is not evidence of health, and 'unknown' does not count as healthy.
    const check = await aiCheck();
    expect(check?.state).toBe('unknown');
    expect(check?.detail).toMatch(/nothing to infer/i);
  });

  it('reports UNKNOWN when AI is off by configuration, not degraded', async () => {
    // Calling a deliberately-disabled feature "degraded" is how an operator
    // learns to ignore a tile.
    await seedGlobal(0, 40);
    const check = await aiCheck({ ai: { ...wired, killSwitch: false } });
    expect(check?.state).toBe('unknown');
    expect(check?.detail).toMatch(/AI_ENABLED=false/);
  });

  // ── What the tile says when nothing has been attempted (2026-08-11) ────────
  //
  // The operator's report was that the three capability flags were ON in
  // production and the tile still read "no model calls attempted today —
  // nothing to infer" and nothing else. That sentence was true, and it was the
  // same sentence a deployment with no credential at all would show, which is
  // exactly the ambiguity this check exists to remove. State stays 'unknown' —
  // an idle day still proves nothing — but the detail now carries the half of
  // the subsystem the application CAN observe.
  it('names the model and the enabled capabilities even with no usage at all', async () => {
    const check = await aiCheck();
    expect(check?.detail).toContain('gemini-2.5-flash');
    expect(check?.detail).toContain('proposer, autonomy, guardian');
    // And points at the one thing that actually proves the credential, rather
    // than leaving the operator with a dead end.
    expect(check?.detail).toMatch(/ai-live-eval/);
  });

  it('says when the model last answered, instead of forgetting at midnight', async () => {
    // Usage on this deployment is sparse, so "today" is empty most days. Reading
    // only today threw away the last observation every midnight — the tile could
    // never distinguish a quiet week from a dead credential.
    await seedGlobalOn(3, 5, 0);
    const check = await aiCheck();
    expect(check?.state).toBe('unknown'); // a success 3 days ago is not health today
    expect(check?.detail).toMatch(/last success .* \(3 days ago\)/);
  });

  it('is DEGRADED when nothing has succeeded all week and attempts were made', async () => {
    // A retired model or a revoked credential looks exactly like this, and it is
    // the failure this whole check was written for: every AI call site is
    // fail-soft, so four surfaces quietly fall back to their templates.
    await seedGlobalOn(2, 0, 6);
    const check = await aiCheck();
    expect(check?.state).toBe('degraded');
    expect(check?.detail).toMatch(/nothing succeeded in the last 7 days \(6 failed\)/);
  });

  it('is DEGRADED when a capability is enabled with no model credential', async () => {
    // The invisible misconfiguration: AI_ENABLED on, capability flags on, no
    // Gemini credential resolved. Every AI surface serves its template, nothing
    // throws, and until now the tile said "disabled by configuration" — which
    // reads as deliberate.
    const check = await aiCheck({ ai: { ...wired, credentialResolved: false } });
    expect(check?.state).toBe('degraded');
    expect(check?.detail).toMatch(/NO model credential resolved/);
  });

  it('but stays QUIET when nobody asked for AI at all', async () => {
    // AI_ENABLED defaults to true, so an unconfigured self-host must not read as
    // a fault. Degrading every deployment that never wanted AI is how a tile
    // becomes background noise.
    const check = await aiCheck({
      ai: { ...wired, credentialResolved: false, capabilities: [] },
    });
    expect(check?.state).toBe('unknown');
    expect(check?.detail).toMatch(/inert/);
  });
});

// 2026-08-08 re-audit, N-1. The dead-letter trigger was an ALL-TIME count feeding
// a release-critical check, so one failed delivery — ever — pinned the composite
// and therefore the PUBLISHED availability figure at 0% permanently. The metric
// was saturated: a real outage could not move it, because it was already at the
// floor. Live on truecairn.app/status at the time of the audit.
describeIfDb('notifications dead-letter window (N-1)', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE notification_deliveries, notification_channels, users CASCADE`;
  });

  async function seedFailed(ageHours: number): Promise<void> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `dl${Date.now()}${Math.random()}@x.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const [ch] = await db
      .insert(schema.notificationChannels)
      .values({
        userId: u!.id,
        channelType: 'email',
        destination: 'x@y.z',
        destinationHash: channelDestinationHash('email', 'x@y.z'),
        verified: true,
      })
      .returning({ id: schema.notificationChannels.id });
    const at = new Date(Date.now() - ageHours * 60 * 60 * 1000);
    await db.insert(schema.notificationDeliveries).values({
      channelId: ch!.id,
      userId: u!.id,
      purpose: 'check_in_request',
      status: 'failed',
      updatedAt: at,
    });
  }

  const deps = (): SystemStatusDeps => ({
    db,
    outerLayerKeks: echoKeks,
    auditReady: true,
    apiVersion: '0.0.0',
    configuredNotificationTypes: ['email'],
    cryptoReady: () => true,
    backups: { kind: 'none' },
  });

  it('an OLD dead letter no longer degrades the check — or pins the availability figure', async () => {
    await seedFailed(72); // three days ago
    const status = await collectSystemStatus(deps());
    const n = status.checks.find((c) => c.id === 'notifications');
    expect(n?.state).toBe('ok');
    // The composite is a conjunction over release-critical checks, so this is
    // what was pinning the published figure: notifications must no longer be
    // among the failing ones. (Other checks can still be down in a bare test
    // database — the worker has never ticked — so assert on THIS check rather
    // than on the worst-severity winner.)
    expect(failingCritical(status)).not.toContain('notifications');
  });

  it('but still says the history exists — windowing is not forgetting', async () => {
    await seedFailed(72);
    const status = await collectSystemStatus(deps());
    const n = status.checks.find((c) => c.id === 'notifications');
    expect(n?.detail).toMatch(/none in the last 24h \(1 older\)/);
    // And the admin queues panel keeps the all-time total.
    expect(status.queues?.notificationsDeadLettered).toBe(1);
  });

  it('a RECENT dead letter still degrades it — the signal is not lost', async () => {
    await seedFailed(1);
    const status = await collectSystemStatus(deps());
    const n = status.checks.find((c) => c.id === 'notifications');
    expect(n?.state).toBe('degraded');
    expect(n?.detail).toMatch(/dead-lettered in the last 24h/);
    expect(failingCritical(status)).toContain('notifications');
  });
});
