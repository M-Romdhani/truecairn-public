import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { NotificationChannelType, NotificationPurpose, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import { tickDeliveries } from './processor.js';
import { ProviderError, type NotificationProvider, type SendInput, type SendResult } from './types.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];
const DAY = 24 * 60 * 60 * 1000;

// A fake email provider with the three modes the lifecycle proofs need.
class FakeProvider implements NotificationProvider {
  readonly channelType: NotificationChannelType = 'email';
  readonly name = 'fake';
  actualSendCount = 0;
  failuresLeft = 0;
  alwaysFailRetryable = false;
  private readonly dedup = new Map<string, string>();

  // Simulate a send that already happened (pre-crash): seed the dedup map + count.
  seedSent(idempotencyKey: string, providerMessageId: string): void {
    this.dedup.set(idempotencyKey, providerMessageId);
    this.actualSendCount += 1;
  }

  async send(input: SendInput): Promise<SendResult> {
    if (this.alwaysFailRetryable) throw new ProviderError('always-fail', true);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new ProviderError('transient', true);
    }
    const existing = this.dedup.get(input.idempotencyKey);
    if (existing !== undefined) return { providerMessageId: existing }; // dedup: no new send
    const id = `msg-${input.idempotencyKey}`;
    this.dedup.set(input.idempotencyKey, id);
    this.actualSendCount += 1;
    return { providerMessageId: id };
  }
}

describeIfDb('notification delivery processor (integration)', () => {
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

  async function makeUser(): Promise<UserId> {
    const [u] = await db.insert(schema.users).values({ email: `u-${Math.random()}@example.com`, accountStatus: 'active' }).returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function makeChannel(userId: UserId, channelType: NotificationChannelType = 'email'): Promise<string> {
    const [c] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType,
        destination: 'x@example.com',
        destinationHash: channelDestinationHash(channelType, 'x@example.com'),
        verified: true,
      })
      .returning({ id: schema.notificationChannels.id });
    return c!.id;
  }
  async function enqueue(channelId: string, userId: UserId, now: Date, purpose: NotificationPurpose = 'check_in_request'): Promise<string> {
    const [d] = await db
      .insert(schema.notificationDeliveries)
      .values({ channelId, userId, purpose, status: 'queued', nextAttemptAt: now })
      .returning({ id: schema.notificationDeliveries.id });
    return d!.id;
  }
  const registry = (p: NotificationProvider): Map<NotificationChannelType, NotificationProvider> =>
    new Map([[p.channelType, p]]);
  async function delivery(id: string) {
    const [d] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, id));
    return d!;
  }
  async function channel(id: string) {
    const [c] = await db.select().from(schema.notificationChannels).where(eq(schema.notificationChannels.id, id));
    return c!;
  }

  it('sends a queued delivery and marks the channel healthy', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId);
    const now = new Date('2026-08-01T00:00:00Z');
    const id = await enqueue(channelId, userId, now);
    const fake = new FakeProvider();

    const res = await tickDeliveries({ db, providers: registry(fake), now }, 50);
    expect(res.sent).toBe(1);
    const d = await delivery(id);
    expect(d.status).toBe('sent');
    expect(d.provider).toBe('fake');
    expect(d.providerMessageId).toBe(`msg-${id}`);
    expect((await channel(channelId)).health).toBe('healthy');
    expect(fake.actualSendCount).toBe(1);
  });

  it('dead-letters a delivery whose channel type has no provider', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId, 'sms'); // no SMS provider registered
    const now = new Date('2026-08-01T00:00:00Z');
    const id = await enqueue(channelId, userId, now);
    const res = await tickDeliveries({ db, providers: registry(new FakeProvider()), now }, 50);
    expect(res.deadLettered).toBe(1);
    const d = await delivery(id);
    expect(d.status).toBe('failed');
    expect(d.lastError).toBe('no_provider_configured');
  });

  // PROPERTY 1 — crash between send and record. A stuck 'sending' row (a worker
  // that sent then died before recording) is reclaimed and re-sent with the SAME
  // idempotency key; the provider dedups, so there is exactly ONE actual send.
  it('a stuck-sending reclaim re-sends with the same key and the provider dedups (no double send)', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId);
    const now = new Date('2026-08-01T00:00:00Z');
    // The row a crashed worker left behind: status='sending', attempted once, stale.
    const [d0] = await db
      .insert(schema.notificationDeliveries)
      .values({
        channelId,
        userId,
        purpose: 'check_in_request',
        status: 'sending',
        attemptCount: 1,
        nextAttemptAt: now,
        updatedAt: new Date(now.getTime() - 10 * 60 * 1000), // > stuck timeout
      })
      .returning({ id: schema.notificationDeliveries.id });
    const id = d0!.id;
    const fake = new FakeProvider();
    fake.seedSent(id, 'msg-original'); // the pre-crash send already happened

    const res = await tickDeliveries({ db, providers: registry(fake), now }, 50);
    expect(res.sent).toBe(1);
    // Exactly ONE actual send despite two send() calls with the same key.
    expect(fake.actualSendCount).toBe(1);
    const d = await delivery(id);
    expect(d.status).toBe('sent');
    expect(d.providerMessageId).toBe('msg-original');
  });

  it('retries a transient failure then succeeds', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId);
    const t0 = new Date('2026-08-01T00:00:00Z');
    const id = await enqueue(channelId, userId, t0);
    const fake = new FakeProvider();
    fake.failuresLeft = 2; // fail twice, then succeed

    let res = await tickDeliveries({ db, providers: registry(fake), now: t0 }, 50);
    expect(res.retried).toBe(1);
    expect((await delivery(id)).status).toBe('queued');
    res = await tickDeliveries({ db, providers: registry(fake), now: new Date(t0.getTime() + DAY) }, 50);
    expect(res.retried).toBe(1);
    res = await tickDeliveries({ db, providers: registry(fake), now: new Date(t0.getTime() + 2 * DAY) }, 50);
    expect(res.sent).toBe(1);
    expect((await delivery(id)).status).toBe('sent');
  });

  // PROPERTY 2 — dead-letter + channel-health degradation across the retry budget.
  it('degrades channel health healthy -> degraded -> failing and dead-letters after the retry budget', async () => {
    const userId = await makeUser();
    const channelId = await makeChannel(userId);
    const t0 = new Date('2026-08-01T00:00:00Z');
    const id = await enqueue(channelId, userId, t0);
    const fake = new FakeProvider();
    fake.alwaysFailRetryable = true;

    const healths: string[] = [];
    // 6 ticks (MAX_ATTEMPTS): each advances now well past the backoff so the
    // requeued row is due. attempt 6 hits the budget -> dead-letter.
    for (let i = 0; i < 6; i++) {
      await tickDeliveries({ db, providers: registry(fake), now: new Date(t0.getTime() + i * DAY) }, 50);
      healths.push((await channel(channelId)).health);
    }
    // healthy -> degraded (cf 1,2) -> failing (cf >= 3).
    expect(healths[0]).toBe('degraded');
    expect(healths[1]).toBe('degraded');
    expect(healths[2]).toBe('failing');
    expect(healths[5]).toBe('failing');
    expect((await channel(channelId)).consecutiveFailures).toBe(6);
    // The delivery is permanently failed after the budget.
    expect((await delivery(id)).status).toBe('failed');
  });
});
