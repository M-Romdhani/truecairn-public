import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveServerSigner } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import { ENGINE_STATES, type EngineState, type SessionId, type UserId } from '@truecairn/shared';
import { createSession, stampStepUp } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

// ── The reachability gate (2026-07-25) ───────────────────────────────────────
//
// WHY THIS EXISTS. Twice now the engine has shipped a state the owner could
// enter but not leave: REVIEW_REQUIRED (found by QA 2026-07-21) and RETURNING
// (found 2026-07-24, and reached by the owner READING THEIR OWN VAULT during a
// release — the most sympathetic user in the system). Both times the engine
// transition itself existed and was unit-tested in isolation; what was missing
// was any test asking whether a human could actually CALL it. Unit tests of a
// pure transition function cannot see that gap by construction, which is why
// three full QA passes and a green release-candidate sign-off missed it.
//
// This test closes the class. It asserts, for EVERY member of the EngineState
// union, that the owner has a route out — exercised end-to-end against the real
// app, not asserted against the transition table. The one documented exception
// (FULL_RELEASE) is pinned NEGATIVELY rather than skipped, so "terminal" stays a
// deliberate decision with a reason attached.
//
// The table is keyed by EngineState with no index signature, so adding a state
// to @truecairn/shared fails TYPECHECK here until someone declares its exit. The
// runtime exhaustiveness check below catches the reverse (a state removed from
// the union but left in the table). Between them, a new engine state cannot
// reach production without an owner exit or an explicit terminal ruling.
//
// A "fix" that deletes an entry, loosens an expectation, or adds a state to the
// terminal list without a docs/02 amendment is a bug — see CLAUDE.md invariant 2
// and the docs/02 asymmetry principle (cancellation is always easier than
// progression; FULL_RELEASE is the ONLY state without a cancel path).

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

interface OwnerExit {
  kind: 'owner_exit';
  route: string;
  body?: Record<string, unknown>;
  // The protective state the exit must land in. Every one of these is 'active':
  // an owner exit that left the engine anywhere else would not be a cancel path.
  toState: EngineState;
  note: string;
}
interface Terminal {
  kind: 'terminal';
  why: string;
}

// Every owner-driven engine route, so the terminal case can be pinned against
// ALL of them rather than a hand-picked subset.
const ALL_OWNER_ROUTES: ReadonlyArray<{ route: string; body: Record<string, unknown> }> = [
  { route: '/v1/engine/check-in', body: {} },
  { route: '/v1/engine/check-in', body: { acknowledgedState: 'escalation_pending' } },
  { route: '/v1/engine/cancel-release', body: {} },
  { route: '/v1/engine/resolve-review', body: {} },
  { route: '/v1/engine/confirm-return', body: {} },
  { route: '/v1/engine/arm', body: {} },
  { route: '/v1/engine/snooze', body: { snoozeDays: 3 } },
];

const EXITS: Record<EngineState, OwnerExit | Terminal> = {
  pre_active: {
    kind: 'owner_exit',
    route: '/v1/engine/arm',
    toState: 'active',
    note: 'not a release-path state; the owner arms monitoring deliberately',
  },
  active: {
    kind: 'owner_exit',
    route: '/v1/engine/check-in',
    toState: 'active',
    note: 'the safe state; check-in refreshes the inactivity clock',
  },
  check_in_pending: {
    kind: 'owner_exit',
    route: '/v1/engine/check-in',
    toState: 'active',
    note: 'docs/02 §3 one-tap cancel path',
  },
  notification_stalled: {
    kind: 'owner_exit',
    route: '/v1/engine/check-in',
    toState: 'active',
    note: 'docs/02 §4 — the owner can always check in even when we cannot reach them',
  },
  escalation_pending: {
    kind: 'owner_exit',
    route: '/v1/engine/check-in',
    body: { acknowledgedState: 'escalation_pending' },
    toState: 'active',
    note: 'docs/02 §5 — deliberate acknowledgment required (contacts already notified)',
  },
  release_review: {
    kind: 'owner_exit',
    route: '/v1/engine/cancel-release',
    toState: 'active',
    note: 'docs/02 §"Cancel paths" — release ladder, fresh second factor',
  },
  limited_release: {
    kind: 'owner_exit',
    route: '/v1/engine/cancel-release',
    toState: 'active',
    note: 'docs/02 §"Cancel paths" — release ladder, fresh second factor',
  },
  staged_release: {
    kind: 'owner_exit',
    route: '/v1/engine/cancel-release',
    toState: 'active',
    note: 'docs/02 §"Cancel paths" — release ladder, fresh second factor',
  },
  returning: {
    kind: 'owner_exit',
    route: '/v1/engine/confirm-return',
    toState: 'active',
    note: 'docs/02 §9 — THE 2026-07-24 dead end; entered by the owner reading their own vault',
  },
  review_required: {
    kind: 'owner_exit',
    route: '/v1/engine/resolve-review',
    toState: 'active',
    note: 'docs/02 §"Side state" — THE QA-2026-07-21 dead end',
  },
  full_release: {
    kind: 'terminal',
    why: 'docs/02 §8 — the cryptographic release has completed and contents are out; we cannot un-release. This is the ONLY state without a cancel path, which is why the ladder before it is deliberately long.',
  },
};

describeIfDb('engine reachability gate — every state has an owner exit', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    await resolveServerSigner(db);
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE engine_states, engine_state_history, sensitive_actions, notification_deliveries, notification_channels, auth_attempts, sessions, audit_log_locks, audit_log, contacts, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function ownerIn(
    state: EngineState,
  ): Promise<{ userId: UserId; cookie: string; sessionId: SessionId }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `${state}-${randomBytes(4).toString('hex')}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    // The arm prerequisite (an enrolled contact) — harmless for the other states.
    await db.insert(schema.contacts).values({
      ownerUserId: userId,
      role: 'personal',
      status: 'enrolled',
      displayLabelCiphertext: randomBytes(16),
      displayLabelNonce: randomBytes(12),
    });
    await db.insert(schema.engineStates).values({
      userId,
      state,
      // RETURNING resumes previousState when its grace expires; give it a real
      // ladder rung so the fixture matches how the state is actually reached.
      ...(state === 'returning' ? { previousState: 'limited_release' as const } : {}),
    });
    const { id, token } = await createSession(db, { userId, now: new Date() });
    // Every protective exit is gated on at most a FRESH SECOND FACTOR (never the
    // full step-up lane — that would make cancelling harder than progressing).
    await stampStepUp(db, id, new Date());
    return { userId, cookie: token, sessionId: id };
  }
  const as = (cookie: string): { [k: string]: string } => ({ [SESSION_COOKIE]: cookie });
  async function stateOf(userId: UserId): Promise<EngineState> {
    const [r] = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, userId));
    return r!.state;
  }

  it('the exit table covers the EngineState union exactly', () => {
    // Guards the direction TypeScript cannot: a state removed from the shared
    // union but left behind here (a stale entry would silently stop testing).
    expect(Object.keys(EXITS).sort()).toEqual([...ENGINE_STATES].sort());
  });

  const exitCases = ENGINE_STATES.filter(
    (s): s is EngineState => EXITS[s].kind === 'owner_exit',
  );

  it.each(exitCases)('%s — the owner can reach ACTIVE', async (state) => {
    const spec = EXITS[state] as OwnerExit;
    const { userId, cookie } = await ownerIn(state);

    const res = await app.inject({
      method: 'POST',
      url: spec.route,
      cookies: as(cookie),
      payload: spec.body ?? {},
    });

    // The assertion that would have caught BOTH dead ends: the route the owner
    // is told to use actually works from this state, and lands them somewhere
    // protective. A 409 here means the state is a trap.
    expect(
      res.statusCode,
      `${state}: POST ${spec.route} returned ${res.statusCode} — ${spec.note}. ` +
        `A non-2xx means the owner is TRAPPED in "${state}". Body: ${res.body.slice(0, 300)}`,
    ).toBeLessThan(300);
    expect(await stateOf(userId)).toBe(spec.toState);
  });

  const terminalCases = ENGINE_STATES.filter(
    (s): s is EngineState => EXITS[s].kind === 'terminal',
  );

  it.each(terminalCases)('%s — terminal by design, no owner route moves it', async (state) => {
    const spec = EXITS[state] as Terminal;
    const { userId, cookie } = await ownerIn(state);

    // Pinned negatively rather than skipped: every owner route is tried, and the
    // state must survive all of them. If a future change gives FULL_RELEASE an
    // exit, this fails and forces a docs/02 amendment rather than silently
    // creating an un-release path.
    //
    // The invariant is "no owner route CHANGES the state", not "every route
    // 4xxs": /v1/engine/arm is deliberately idempotent (it fires engine_armed
    // only from pre_active, and engine_armed itself no-ops elsewhere), so a 200
    // that moves nothing is correct there. Asserting on the state rather than
    // the status code is both stricter and truer to what we actually care about.
    for (const { route, body } of ALL_OWNER_ROUTES) {
      const res = await app.inject({ method: 'POST', url: route, cookies: as(cookie), payload: body });
      expect(
        await stateOf(userId),
        `${state}: POST ${route} (${res.statusCode}) MOVED a terminal state. ${spec.why}`,
      ).toBe(state);
    }

    // The cancel-path routes specifically must also REFUSE, not merely no-op: a
    // 2xx from one of these would tell the owner the release had been stopped
    // when it had not, which is worse than the 409 they get today.
    for (const route of [
      '/v1/engine/check-in',
      '/v1/engine/cancel-release',
      '/v1/engine/resolve-review',
      '/v1/engine/confirm-return',
    ]) {
      const res = await app.inject({ method: 'POST', url: route, cookies: as(cookie), payload: {} });
      expect(
        res.statusCode,
        `${state}: POST ${route} returned ${res.statusCode}; a cancel path must not claim success here. ${spec.why}`,
      ).toBeGreaterThanOrEqual(400);
    }
  });

  it('every non-terminal state resolves to ACTIVE (the asymmetry principle holds)', () => {
    // A structural restatement of docs/02: the cancel path always ends at ACTIVE.
    // An exit that landed on another ladder rung would satisfy "has an exit"
    // while still walking the owner toward release.
    for (const state of ENGINE_STATES) {
      const spec = EXITS[state];
      if (spec.kind === 'owner_exit') {
        expect(spec.toState, `${state} exits to ${spec.toState}, not active`).toBe('active');
      }
    }
    // And exactly one state is allowed to be terminal.
    expect(terminalCases).toEqual(['full_release']);
  });
});
