// Integration test: DbChannelLookup vs the owner's channel matrix (docs/26
// §3.1 + the §4 follow-on). The load-bearing asymmetry proven here:
//   - routine classes (engine_state_change → owner_notices) honour an opt-out;
//   - the check-in/escalation SAFETY FLOOR ignores the matrix entirely — no
//     preference row can silence "are you alive?".
// Real Postgres; skipped without DATABASE_URL, same as the applier suite.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { DbChannelLookup } from './channels.js';

type Sql = ReturnType<typeof createClient>['sql'];

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

describeIfDb('DbChannelLookup + channel matrix (integration)', () => {
  let db: Database;
  let sql: Sql;
  let lookup: DbChannelLookup;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    lookup = new DbChannelLookup(db);
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE channel_preferences, notification_channels, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function makeChannel(userId: UserId, destination: string, createdAt: Date): Promise<string> {
    const [c] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType: 'email',
        destination,
        destinationHash: channelDestinationHash('email', destination),
        verified: true,
        createdAt,
      })
      .returning({ id: schema.notificationChannels.id });
    return c!.id;
  }
  async function optOut(userId: UserId, channelId: string, purposeClass: 'owner_notices' | 'contact_notices') {
    await db
      .insert(schema.channelPreferences)
      .values({ userId, channelId, purposeClass, enabled: false });
  }

  it('a routine purpose skips an opted-out channel and falls to the next enabled one', async () => {
    const userId = await makeUser('matrix-a@example.com');
    const older = await makeChannel(userId, 'older@example.com', new Date('2026-01-01T00:00:00Z'));
    const newer = await makeChannel(userId, 'newer@example.com', new Date('2026-02-01T00:00:00Z'));
    await optOut(userId, older, 'owner_notices');

    // Without a purpose (and for the primary pick generally) the oldest wins.
    expect(await lookup.pickPrimaryChannel(userId)).toBe(older);
    // engine_state_change is owner_notices-class → the opt-out narrows to the
    // newer channel instead of dropping the notice.
    expect(await lookup.pickPrimaryChannel(userId, 'engine_state_change')).toBe(newer);
  });

  it('SAFETY FLOOR: check-in/escalation ignore the matrix even when every channel is opted out', async () => {
    const userId = await makeUser('matrix-b@example.com');
    const only = await makeChannel(userId, 'only@example.com', new Date('2026-01-01T00:00:00Z'));
    await optOut(userId, only, 'owner_notices');
    // Also an (ineffective) owner_verification opt-out — the primary continuity
    // notice is exempt BY PURPOSE, not by class arithmetic: the matrix's
    // owner_verification class narrows only the CV cadence's extra waves.
    await db
      .insert(schema.channelPreferences)
      .values({ userId, channelId: only, purposeClass: 'owner_verification', enabled: false });

    // The routine class is genuinely silenced — every channel opted out…
    expect(await lookup.pickPrimaryChannel(userId, 'engine_state_change')).toBeNull();
    // …but the check-in and escalation requests still land. A "fix" that flips
    // these two assertions is a bug (CLAUDE.md invariant 2 — fail closed on
    // release, fail OPEN on reaching the owner).
    expect(await lookup.pickPrimaryChannel(userId, 'check_in_request')).toBe(only);
    expect(await lookup.pickPrimaryChannel(userId, 'escalation_request')).toBe(only);
    // security_alert is equally untouchable from a session.
    expect(await lookup.pickPrimaryChannel(userId, 'security_alert')).toBe(only);
  });

  it('absent preference rows change nothing: routine purposes see every verified channel', async () => {
    const userId = await makeUser('matrix-c@example.com');
    const older = await makeChannel(userId, 'c-older@example.com', new Date('2026-01-01T00:00:00Z'));
    await makeChannel(userId, 'c-newer@example.com', new Date('2026-02-01T00:00:00Z'));
    expect(await lookup.pickPrimaryChannel(userId, 'engine_state_change')).toBe(older);
    expect(await lookup.pickPrimaryChannel(userId, 'sensitive_action_notice')).toBe(older);
  });
});
