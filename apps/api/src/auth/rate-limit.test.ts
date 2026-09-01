import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import {
  ACCOUNT_MAX_FAILURES,
  IP_MAX_FAILURES,
  SUSTAINED_ABUSE_THRESHOLD,
  checkAccountLock,
  checkIpThrottle,
  hashIp,
  recordAttempt,
  recordSustainedAbuseIfNeeded,
} from './rate-limit.js';

describe('hashIp', () => {
  const pepper = new Uint8Array(32).fill(9);
  it('is deterministic and 32 bytes', () => {
    const a = hashIp('203.0.113.7', pepper);
    const b = hashIp('203.0.113.7', pepper);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });
  it('differs by IP and by pepper', () => {
    expect(Buffer.from(hashIp('1.1.1.1', pepper))).not.toEqual(
      Buffer.from(hashIp('2.2.2.2', pepper)),
    );
    expect(Buffer.from(hashIp('1.1.1.1', pepper))).not.toEqual(
      Buffer.from(hashIp('1.1.1.1', new Uint8Array(32).fill(1))),
    );
  });
});

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('rate limiting + lockout (integration)', () => {
  let db: Database;
  let sql: Sql;
  const pepper = new Uint8Array(32).fill(3);
  const now = new Date('2026-05-29T12:00:00Z');

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE auth_attempts, security_events, users CASCADE`;
  });

  // Bulk-insert N failed login attempts for one IP (fast — no per-attempt work).
  async function seedIpFailures(ipHash: Uint8Array, n: number): Promise<void> {
    const rows = Array.from({ length: n }, (_, i) => ({
      scope: 'login',
      identifier: `probe${i}@example.com`,
      ipHash,
      succeeded: false,
      attemptedAt: new Date(now.getTime() + i),
    }));
    await db.insert(schema.authAttempts).values(rows);
  }

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('user not created');
    return u.id as UserId;
  }

  it('per-IP throttle blocks after the threshold, with a positive Retry-After', async () => {
    const ipHash = hashIp('198.51.100.5', pepper);
    expect(await checkIpThrottle(db, 'login', ipHash, now)).toBeNull();

    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      await recordAttempt(db, {
        scope: 'login',
        identifier: `probe${i}@example.com`,
        ipHash,
        succeeded: false,
        now: new Date(now.getTime() + i),
      });
    }
    const block = await checkIpThrottle(db, 'login', ipHash, new Date(now.getTime() + 1000));
    expect(block).not.toBeNull();
    expect(block!.scope).toBe('ip');
    expect(block!.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('per-IP throttle catches the fast-probe-many-emails pattern (each email once)', async () => {
    const ipHash = hashIp('198.51.100.9', pepper);
    // Many DISTINCT emails, one failure each — per-account limits would never
    // fire, but the per-IP counter does.
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      await recordAttempt(db, {
        scope: 'login',
        accountEmail: `victim${i}@example.com`,
        identifier: `victim${i}@example.com`,
        ipHash,
        succeeded: false,
        now: new Date(now.getTime() + i),
      });
    }
    expect(await checkIpThrottle(db, 'login', ipHash, new Date(now.getTime() + 1000))).not.toBeNull();
  });

  it('locks an account after the per-account threshold and reports the lock', async () => {
    const email = 'target@example.com';
    await makeUser(email);
    const ipHash = hashIp('203.0.113.1', pepper);

    let triggered = null;
    for (let i = 0; i < ACCOUNT_MAX_FAILURES; i++) {
      triggered = await recordAttempt(db, {
        scope: 'login',
        accountEmail: email,
        identifier: email,
        ipHash,
        succeeded: false,
        now: new Date(now.getTime() + i),
      });
    }
    expect(triggered).not.toBeNull();
    expect(triggered!.scope).toBe('account');

    const [u] = await db.select().from(schema.users).where(eq(schema.users.emailLower, email));
    expect(u!.accountStatus).toBe('locked');
    expect(u!.lockedUntil).not.toBeNull();

    // A subsequent precheck reports the lock with a Retry-After up to ~1h.
    const block = await checkAccountLock(db, email, new Date(now.getTime() + 1000));
    expect(block).not.toBeNull();
    expect(block!.retryAfterSeconds).toBeGreaterThan(0);
    expect(block!.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it('a lock enqueues a security_alert to every verified channel (PHASE3_5)', async () => {
    const email = 'alerted@example.com';
    const userId = await makeUser(email);
    // Two verified channels + one unverified (which must NOT be notified).
    await db.insert(schema.notificationChannels).values([
      {
        userId,
        channelType: 'email' as const,
        destination: 'e@example.com',
        destinationHash: channelDestinationHash('email', 'e@example.com'),
        verified: true,
      },
      {
        userId,
        channelType: 'sms' as const,
        destination: '+15550001',
        destinationHash: channelDestinationHash('sms', '+15550001'),
        verified: true,
      },
      {
        userId,
        channelType: 'push' as const,
        destination: 'tok',
        destinationHash: channelDestinationHash('push', 'tok'),
        verified: false,
      },
    ]);
    const ipHash = hashIp('203.0.113.9', pepper);
    for (let i = 0; i < ACCOUNT_MAX_FAILURES; i++) {
      await recordAttempt(db, { scope: 'login', accountEmail: email, identifier: email, ipHash, succeeded: false, now: new Date(now.getTime() + i) });
    }
    const deliveries = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.userId, userId));
    expect(deliveries).toHaveLength(2); // verified channels only
    expect(deliveries.every((d) => d.purpose === 'security_alert')).toBe(true);
    expect(deliveries.every((d) => d.status === 'queued')).toBe(true);
  });

  it('auto-unlocks an account once the lock window elapses', async () => {
    const email = 'expire@example.com';
    const userId = await makeUser(email);
    await db
      .update(schema.users)
      .set({ accountStatus: 'locked', lockedUntil: new Date(now.getTime() + 60_000) })
      .where(eq(schema.users.id, userId));

    // Still locked inside the window.
    expect(await checkAccountLock(db, email, now)).not.toBeNull();

    // After the window: precheck clears it and returns null.
    const after = new Date(now.getTime() + 120_000);
    expect(await checkAccountLock(db, email, after)).toBeNull();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u!.accountStatus).toBe('active');
    expect(u!.lockedUntil).toBeNull();
  });

  it('a successful attempt never locks and never blocks', async () => {
    const email = 'good@example.com';
    await makeUser(email);
    const ipHash = hashIp('203.0.113.2', pepper);
    for (let i = 0; i < ACCOUNT_MAX_FAILURES + 3; i++) {
      const r = await recordAttempt(db, {
        scope: 'login',
        accountEmail: email,
        identifier: email,
        ipHash,
        succeeded: true,
        now: new Date(now.getTime() + i),
      });
      expect(r).toBeNull();
    }
    const [u] = await db.select().from(schema.users).where(eq(schema.users.emailLower, email));
    expect(u!.accountStatus).toBe('active');
  });

  it('an unknown email never creates a lockable row but still feeds the IP bucket', async () => {
    const ipHash = hashIp('203.0.113.3', pepper);
    const triggered = await recordAttempt(db, {
      scope: 'login',
      accountEmail: 'ghost@example.com',
      identifier: 'ghost@example.com',
      ipHash,
      succeeded: false,
      now,
    });
    // No user row -> no account lock, even though the failure is recorded.
    expect(triggered).toBeNull();
    expect(await db.select().from(schema.users)).toHaveLength(0);
    expect(await db.select().from(schema.authAttempts)).toHaveLength(1);
  });

  it('emits one ip.sustained_abuse signal past the hourly floor, deduped', async () => {
    const ipHash = hashIp('198.51.100.250', pepper);

    // Just under the floor: no signal.
    await seedIpFailures(ipHash, SUSTAINED_ABUSE_THRESHOLD - 1);
    await recordSustainedAbuseIfNeeded(db, ipHash, new Date(now.getTime() + 1000));
    expect(await db.select().from(schema.securityEvents)).toHaveLength(0);

    // Crossing the floor: exactly one signal with the documented payload.
    await db.insert(schema.authAttempts).values({
      scope: 'login',
      identifier: 'last@example.com',
      ipHash,
      succeeded: false,
      attemptedAt: new Date(now.getTime() + SUSTAINED_ABUSE_THRESHOLD),
    });
    await recordSustainedAbuseIfNeeded(db, ipHash, new Date(now.getTime() + 2000));
    const events = await db.select().from(schema.securityEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('ip.sustained_abuse');
    const payload = events[0]!.payload as { hourFailureCount?: number; action?: string };
    expect(payload.hourFailureCount).toBe(SUSTAINED_ABUSE_THRESHOLD);
    expect(payload.action).toBe('log_only');

    // Dedup: a second call within the window adds no further row.
    await recordSustainedAbuseIfNeeded(db, ipHash, new Date(now.getTime() + 3000));
    expect(await db.select().from(schema.securityEvents)).toHaveLength(1);
  });
});
