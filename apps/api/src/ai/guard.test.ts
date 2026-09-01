import { verifyChain } from '@truecairn/audit';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BriefingGenerator } from './gemini.js';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// A fake generator that always answers and records how many times it was called —
// so a test can prove the guard blocked BEFORE the model was invoked.
function countingGenerator(): BriefingGenerator & { calls: number } {
  return {
    calls: 0,
    async generate() {
      this.calls += 1;
      return { text: 'ok', usage: { inputTokens: 100, outputTokens: 100 } };
    },
  };
}

describeIfDb('AI guard: rate limit, opt-out, breaker (via the assist route)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  let gen: ReturnType<typeof countingGenerator>;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  afterEach(async () => {
    await app.close();
  });

  // Build an app with an injected generator and env overrides for this test's
  // budgets/limits. TRUNCATE first so counters/usage start clean.
  async function boot(env: Record<string, string>): Promise<void> {
    await sql`TRUNCATE ai_usage_daily, auth_attempts, security_events, audit_log, audit_log_locks, ai_briefings, vault_items, contacts, engine_states, sessions, users CASCADE`;
    const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64'), ...env });
    gen = countingGenerator();
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql, aiGenerator: gen });
    await app.ready();
  }

  async function seedSession(email: string): Promise<{ userId: UserId; cookie: { [k: string]: string } }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: { [SESSION_COOKIE]: token } };
  }

  const assist = (cookie: { [k: string]: string }) =>
    app.inject({ method: 'POST', url: '/v1/ai/assist', cookies: cookie, payload: { question: 'hi' } });

  it('per-user rate limit returns 429 after the ceiling, before calling the model', async () => {
    await boot({ AI_RATE_ASSIST_PER_USER: '3', AI_RATE_ASSIST_PER_IP: '1000' });
    const { cookie } = await seedSession('rl-user@example.com');
    for (let i = 0; i < 3; i++) expect((await assist(cookie)).statusCode).toBe(200);
    const blocked = await assist(cookie);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().retryAfterSeconds).toBeGreaterThan(0);
    // The 4th call never reached the model.
    expect(gen.calls).toBe(3);
  });

  it('CONCURRENT calls cannot exceed the ceiling (audit finding 5)', async () => {
    // The ceiling used to be checked with a count(*) and recorded by a separate
    // insert later, so N simultaneous requests all read the same sub-ceiling
    // total and all proceeded — the limit bounded nothing under concurrency,
    // which for a metered model API is money. AI_DAILY_TOKEN_BUDGET is unbounded
    // by default, so on a stock config nothing caught it underneath.
    await boot({ AI_RATE_ASSIST_PER_USER: '3', AI_RATE_ASSIST_PER_IP: '1000' });
    const { cookie } = await seedSession('rl-race@example.com');

    const results = await Promise.all(Array.from({ length: 10 }, () => assist(cookie)));
    const ok = results.filter((r) => r.statusCode === 200).length;
    const limited = results.filter((r) => r.statusCode === 429).length;

    expect(ok).toBe(3);
    expect(limited).toBe(7);
    // The decisive assertion: the model was invoked exactly as many times as the
    // ceiling allows, not once per concurrent request.
    expect(gen.calls).toBe(3);
  });

  it('records a FAILED model call, so a dead model stops being invisible', async () => {
    // Fix plan Part A. ai_usage_daily counted successes only — a failure wrote
    // nothing anywhere but stderr, so "the model is broken" and "nobody used the
    // app today" were the same query result: no row. Every AI surface is
    // fail-soft, so without this a provider outage degrades four surfaces to
    // their templates with nothing to alert on.
    await boot({});
    const { userId, cookie } = await seedSession('ai-fail@example.com');
    gen.generate = async () => {
      throw new Error('model exploded');
    };

    const res = await assist(cookie);
    expect(res.statusCode).toBe(200); // fail-soft: the route still answers
    expect(res.json().reason).toBe('unavailable');

    const rows = await db
      .select({
        userId: schema.aiUsageDaily.userId,
        calls: schema.aiUsageDaily.calls,
        failures: schema.aiUsageDaily.failures,
      })
      .from(schema.aiUsageDaily);
    const user = rows.find((r) => r.userId === userId);
    const global = rows.find((r) => r.userId === null);
    // Both counters: the ops check reads the global row, the per-user row is
    // what makes a single account's breakage attributable.
    expect(Number(user?.failures)).toBe(1);
    expect(Number(global?.failures)).toBe(1);
    // And no success was invented on the way.
    expect(Number(user?.calls)).toBe(0);
    expect(Number(global?.calls)).toBe(0);
  });

  it('per-IP rate limit returns 429 across different users sharing an IP', async () => {
    await boot({ AI_RATE_ASSIST_PER_USER: '1000', AI_RATE_ASSIST_PER_IP: '2' });
    const a = await seedSession('rl-ip-a@example.com');
    const b = await seedSession('rl-ip-b@example.com');
    // Same forwarded IP for all three requests.
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    const r1 = await app.inject({ method: 'POST', url: '/v1/ai/assist', cookies: a.cookie, headers: ip, payload: { question: 'hi' } });
    const r2 = await app.inject({ method: 'POST', url: '/v1/ai/assist', cookies: b.cookie, headers: ip, payload: { question: 'hi' } });
    const r3 = await app.inject({ method: 'POST', url: '/v1/ai/assist', cookies: a.cookie, headers: ip, payload: { question: 'hi' } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429); // per-IP ceiling hit regardless of user
  });

  it('ai_opt_out=true ⇒ zero model calls, fail-soft disabled', async () => {
    await boot({});
    const { userId, cookie } = await seedSession('optout@example.com');
    await db.update(schema.users).set({ aiOptOut: true }).where(eq(schema.users.id, userId));
    const res = await assist(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('disabled');
    expect(res.json().answer).toBeNull();
    expect(gen.calls).toBe(0); // the model was never called with this user's context
    // And no rate token was spent (the call short-circuited before recordAiCall).
    const spent = await db
      .select({ id: schema.authAttempts.id })
      .from(schema.authAttempts)
      .where(eq(schema.authAttempts.scope, 'ai_assist'));
    expect(spent.length).toBe(0);
  });

  it('breaker: a tripped user budget fails soft (unavailable) and stops model calls', async () => {
    // Tiny user budget; the first call spends 200 tokens and trips it for the next.
    await boot({ AI_USER_DAILY_TOKEN_BUDGET: '150' });
    const { userId, cookie } = await seedSession('breaker@example.com');
    const first = await assist(cookie);
    expect(first.statusCode).toBe(200); // first call allowed (budget checked pre-spend)
    const second = await assist(cookie);
    expect(second.statusCode).toBe(200);
    expect(second.json().reason).toBe('unavailable'); // breaker now tripped
    expect(gen.calls).toBe(1); // the second call never reached the model

    // Usage was recorded (per-user + global rows) and the edge event emitted once.
    const day = new Date().toISOString().slice(0, 10);
    const [userRow] = await db
      .select({ tin: schema.aiUsageDaily.tokensIn, tout: schema.aiUsageDaily.tokensOut })
      .from(schema.aiUsageDaily)
      .where(and(eq(schema.aiUsageDaily.day, day), eq(schema.aiUsageDaily.userId, userId)));
    expect(Number(userRow!.tin) + Number(userRow!.tout)).toBe(200);

    const breakerEvents = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_breaker_tripped')));
    expect(breakerEvents.length).toBe(1);
    // The ai_breaker_tripped row is actor='ai' and the chain still verifies.
    const [actorRow] = await db
      .select({ actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.userId, userId), eq(schema.auditLog.eventType, 'ai_breaker_tripped')));
    expect(actorRow!.actor).toBe('ai');
    const verified = await verifyChain(db, userId);
    expect(verified.ok).toBe(true);
  });

  it('breaker tripped ⇒ the vault/engine/auth surfaces are untouched', async () => {
    // Global budget already exhausted before this session even starts.
    await boot({ AI_DAILY_TOKEN_BUDGET: '1' });
    const { cookie } = await seedSession('breaker-core@example.com');
    // Prime the breaker by spending once (over the 1-token budget).
    await assist(cookie);
    // AI is now unavailable...
    expect((await assist(cookie)).json().reason).toBe('unavailable');
    // ...but non-AI product surfaces still answer normally.
    const engine = await app.inject({ method: 'GET', url: '/v1/engine/status', cookies: cookie });
    expect(engine.statusCode).toBe(200);
    const contacts = await app.inject({ method: 'GET', url: '/v1/contacts', cookies: cookie });
    expect(contacts.statusCode).toBe(200);
  });

  it('breaker: the GLOBAL budget is a shared pool — one account can starve every other', async () => {
    // The property every other breaker test misses by using a single session:
    // AI_DAILY_TOKEN_BUDGET is deployment-wide, so it is spent on a first-come
    // basis with no per-account reservation of any kind. One heavy user exhausts
    // it and every OTHER user's AI surfaces go 'unavailable' for the rest of the
    // UTC day, having spent nothing themselves.
    //
    // Recorded as an executable fact because it is the thing to know before
    // deciding how the budget should be divided: today the answer is "it isn't".
    // Nothing here is a defect — the breaker is doing exactly what it says — and
    // the test asserts current behaviour so that a future per-plan or per-user
    // reservation has a red test to turn green.
    await boot({ AI_DAILY_TOKEN_BUDGET: '150' });
    const heavy = await seedSession('pool-heavy@example.com');
    const quiet = await seedSession('pool-quiet@example.com');

    // One call from `heavy` spends 200 tokens, past the 150 global budget.
    expect((await assist(heavy.cookie)).statusCode).toBe(200);

    // `quiet` has never made a call, and is refused anyway.
    const refused = await assist(quiet.cookie);
    expect(refused.statusCode).toBe(200); // fail-soft, not an error status
    expect(refused.json().reason).toBe('unavailable');

    // And the refusal happened WITHOUT reaching the model: the guard blocks
    // before spending, so the starved user cannot even push the bill higher.
    const callsBefore = gen.calls;
    await assist(quiet.cookie);
    expect(gen.calls).toBe(callsBefore);

    // `quiet` spent nothing: no per-user usage row exists for them at all.
    const quietUsage = await db
      .select({ id: schema.aiUsageDaily.userId })
      .from(schema.aiUsageDaily)
      .where(eq(schema.aiUsageDaily.userId, quiet.userId));
    expect(quietUsage).toEqual([]);
  });

  // The two-pool split (PLAN_LIMITS.aiGatedByGlobalBudget). Paid capacity is
  // GUARANTEED: the deployment-wide ceiling does not gate it, so nothing another
  // account spends can switch a paying customer's AI off. This is the direct
  // remedy for the starvation proven in the test above.
  it('breaker: an exhausted GLOBAL pool starves a free account but NOT a paid one', async () => {
    await boot({ AI_DAILY_TOKEN_BUDGET: '150' });
    const heavy = await seedSession('pool2-heavy@example.com');
    const free = await seedSession('pool2-free@example.com');
    const paid = await seedSession('pool2-paid@example.com');
    await db.insert(schema.billingSubscriptions).values({
      userId: paid.userId,
      lsSubscriptionId: 'sub_pool2',
      status: 'active',
    });

    // Drain the shared ceiling with one 200-token call.
    expect((await assist(heavy.cookie)).statusCode).toBe(200);

    // Free: opportunistic capacity, and there is none left.
    expect((await assist(free.cookie)).json().reason).toBe('unavailable');

    // Paid: guaranteed capacity — answers normally, and actually reaches the model.
    const callsBefore = gen.calls;
    const paidRes = await assist(paid.cookie);
    expect(paidRes.statusCode).toBe(200);
    expect(paidRes.json().reason).toBeUndefined();
    expect(paidRes.json().answer).toBe('ok');
    expect(gen.calls).toBe(callsBefore + 1);
  });

  // The 3x itself. Base budget 200, one call costs 200 (100 in + 100 out), and
  // the breaker checks BEFORE spending — so a free account gets exactly one call
  // (the second sees a 200 total against a 200 budget) and a paid account gets
  // three (600 against 600 on the fourth). 1 vs 3 IS the multiplier; neither
  // number means anything without the other, which is why these ship as a pair.
  it('breaker: a paid account is still bound by its OWN budget, at the plan multiple', async () => {
    await boot({ AI_USER_DAILY_TOKEN_BUDGET: '200' });
    const paid = await seedSession('cap-paid@example.com');
    await db.insert(schema.billingSubscriptions).values({
      userId: paid.userId,
      lsSubscriptionId: 'sub_cap',
      status: 'active',
    });

    // Guaranteed capacity is not unlimited capacity.
    for (let i = 0; i < 3; i++) expect((await assist(paid.cookie)).json().answer).toBe('ok');
    expect((await assist(paid.cookie)).json().reason).toBe('unavailable');
  });

  it('breaker: a free account gets the base budget, not the multiple', async () => {
    await boot({ AI_USER_DAILY_TOKEN_BUDGET: '200' });
    const free = await seedSession('cap-free@example.com');
    expect((await assist(free.cookie)).json().answer).toBe('ok');
    expect((await assist(free.cookie)).json().reason).toBe('unavailable');
  });

  // NOTE ON FINDING THESE. They drive the budget path through the real assist
  // route with a real `billing_subscriptions` row, so the names `checkBreaker` and
  // `maybeEmitBreakerEdge` never appear in any test file. A grep for those
  // identifiers concludes the fix is untested; it is not (QA 2026-08-12 reached
  // exactly that conclusion, reasonably). Search for `billingSubscriptions` in
  // `apps/api/src/ai/*.test.ts` instead — five tests here run the paid plan.
  //
  // The plan id is `pro` in code; the product calls it **Personal**.
  //
  // QA 2026-08-12 Bug 1. The gate multiplies the per-account budget by the plan;
  // the EDGE EVENT must be computed against the same number. Getting this wrong
  // is not cosmetic: `ai_breaker_tripped` rides the tamper-evident chain with
  // actor='ai', so a mis-computed edge writes a trip that never happened AND
  // stays silent at the moment service is actually withdrawn.
  //
  // Base 200, pro multiplier 3 ⇒ real budget 600. One call costs 200.
  it('breaker: a paid account records NO trip while still inside its multiplied budget', async () => {
    await boot({ AI_USER_DAILY_TOKEN_BUDGET: '200' });
    const paid = await seedSession('edge-paid-early@example.com');
    await db.insert(schema.billingSubscriptions).values({
      userId: paid.userId,
      lsSubscriptionId: 'sub_edge1',
      status: 'active',
    });

    // Crosses the BARE budget (200) but is nowhere near the real one (600).
    expect((await assist(paid.cookie)).json().answer).toBe('ok');

    const events = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.userId, paid.userId), eq(schema.auditLog.eventType, 'ai_breaker_tripped')),
      );
    expect(events).toEqual([]); // a trip here is a trip that never happened
  });

  it('breaker: a paid account records the trip exactly when its real budget is crossed', async () => {
    await boot({ AI_USER_DAILY_TOKEN_BUDGET: '200' });
    const paid = await seedSession('edge-paid-real@example.com');
    await db.insert(schema.billingSubscriptions).values({
      userId: paid.userId,
      lsSubscriptionId: 'sub_edge2',
      status: 'active',
    });

    const trips = async (): Promise<{ actor: string | null }[]> =>
      db
        .select({ actor: schema.auditLog.actor })
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.userId, paid.userId), eq(schema.auditLog.eventType, 'ai_breaker_tripped')),
        );

    // Two calls = 400, still inside 600. Asserting the ABSENCE here is what makes
    // this test about TIMING: a false trip at 1x would satisfy a bare "exactly one
    // event" check at the end, because emitUserBreakerOnce dedupes per day. Ask
    // only "is there one?" and the bug passes.
    for (let i = 0; i < 2; i++) expect((await assist(paid.cookie)).json().answer).toBe('ok');
    expect(await trips()).toEqual([]);

    // The third call crosses 600 — this is the moment service is withdrawn.
    expect((await assist(paid.cookie)).json().answer).toBe('ok');

    const events = await trips();
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe('ai');
    expect((await verifyChain(db, paid.userId)).ok).toBe(true);
  });

  it('breaker: a tripped GLOBAL budget records a non-user security_event', async () => {
    await boot({ AI_DAILY_TOKEN_BUDGET: '150' });
    const { cookie } = await seedSession('breaker-global@example.com');
    expect((await assist(cookie)).statusCode).toBe(200);
    const second = await assist(cookie);
    expect(second.json().reason).toBe('unavailable');
    const globalEvents = await db
      .select({ id: schema.securityEvents.id })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.eventType, 'ai_breaker_tripped'));
    expect(globalEvents.length).toBe(1);
  });
});
