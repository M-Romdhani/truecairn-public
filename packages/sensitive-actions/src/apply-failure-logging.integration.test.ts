import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter, resolveServerSigner } from '@truecairn/audit';
import type { AuditLogPort } from '@truecairn/engine';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import { applyDueActions } from './processor.js';
import { requestSensitiveAction } from './scheduler.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// A production stall on 2026-07-18 (share-assignments throwing at apply time,
// every worker tick, for 15h) was invisible because applyOne swallowed the
// throw into a bare counter. This pins the fix: a per-action apply THROW is
// reported through logActionFailure with the action's id + type — never
// silently — and the action stays pending (batch not poisoned).
describeIfDb('applyDueActions surfaces per-action apply failures (2026-07-18)', () => {
  let db: Database;
  let sql: Sql;
  let realAudit: AuditLogWriter;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    realAudit = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE sensitive_actions, notification_deliveries, notification_channels, audit_log_locks, audit_log, users CASCADE`;
  });

  async function makeUser(): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `u-${Math.random()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }

  it('a throwing apply is logged (id + type) and leaves the action pending', async () => {
    const userId = await makeUser();
    // Enqueue a well-formed remove_channel; requestSensitiveAction uses the REAL
    // audit so the enqueue itself succeeds and the row exists.
    const { id } = await requestSensitiveAction(db, realAudit, {
      userId,
      actionType: 'remove_channel',
      payload: { channelId: '00000000-0000-0000-0000-000000000000' },
      now: new Date('2026-06-01T00:00:00Z'),
    });

    // At APPLY time, inject an audit port that throws — the same shape as a
    // signer/chain fault in production: the handler runs, then the audit append
    // throws, rolling the tx back. The action must be reported, not vanish.
    const throwingAudit: AuditLogPort = {
      async append() {
        throw new Error('audit signer unavailable');
      },
    };
    const failures: Array<{ actionId: string; actionType: string | null; error: string }> = [];

    const result = await applyDueActions(
      {
        db,
        audit: throwingAudit,
        now: new Date('2026-06-10T00:00:00Z'), // past the 7-day cooldown
        logActionFailure: (info) => failures.push(info),
      },
      50,
    );

    // Reported, not swallowed.
    expect(result.failed).toBe(1);
    expect(result.applied).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.actionId).toBe(id);
    expect(failures[0]!.actionType).toBe('remove_channel');
    expect(failures[0]!.error).toContain('audit signer unavailable');

    // The action is untouched — still pending, retryable next tick (not poisoned
    // into a wrong terminal state).
    const [row] = await db
      .select({ status: schema.sensitiveActions.status })
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.id, id));
    expect(row!.status).toBe('pending');
  });

  it('a clean apply does NOT invoke the failure logger', async () => {
    const userId = await makeUser();
    const [ch] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType: 'email',
        destination: 'x@example.com',
        destinationHash: channelDestinationHash('email', 'x@example.com'),
        verified: true,
      })
      .returning({ id: schema.notificationChannels.id });
    await requestSensitiveAction(db, realAudit, {
      userId,
      actionType: 'remove_channel',
      payload: { channelId: ch!.id },
      now: new Date('2026-06-01T00:00:00Z'),
    });

    const failures: unknown[] = [];
    const result = await applyDueActions(
      {
        db,
        audit: realAudit,
        now: new Date('2026-06-10T00:00:00Z'),
        logActionFailure: (info) => failures.push(info),
      },
      50,
    );

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(failures).toHaveLength(0);
  });
});
