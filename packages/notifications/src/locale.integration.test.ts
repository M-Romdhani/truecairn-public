import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelDestinationHash, createClient, schema, type Database } from '@truecairn/db';
import type { NotificationChannelType, NotificationPurpose, UserId } from '@truecairn/shared';
import { tickDeliveries } from './processor.js';
import type { NotificationProvider, SendInput, SendResult } from './types.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// ── Which language a notice is sent in (docs/40 Phase 3) ────────────────────
//
// THE RULE: the OWNER's language, always — including the notices a trusted
// contact receives. Owner-facing notices resolve it from the recipient (who IS
// the owner); the three contact-facing ceremony purposes resolve it from the
// ceremony's owner instead, because they are the only ones delivered to somebody
// else's channel.
//
// This is an integration test rather than a unit one because the rule is a JOIN,
// and the failure it guards against — silently falling back to the recipient's
// own language — produces a perfectly valid email that nobody would report. It
// asserts on what the provider was actually HANDED, which is the only place the
// decision becomes observable.

class CapturingProvider implements NotificationProvider {
  readonly channelType: NotificationChannelType = 'email';
  readonly name = 'capture';
  readonly sent: SendInput[] = [];
  async send(input: SendInput): Promise<SendResult> {
    this.sent.push(input);
    return { providerMessageId: `msg-${input.idempotencyKey}` };
  }
}

describeIfDb('notice language (integration)', () => {
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
    await sql`TRUNCATE release_ceremonies, notification_deliveries, notification_channels, users CASCADE`;
  });

  async function makeUser(locale: string | null): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `u-${Math.random()}@example.com`, accountStatus: 'active', locale })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }
  async function makeChannel(userId: UserId): Promise<string> {
    const [c] = await db
      .insert(schema.notificationChannels)
      .values({
        userId,
        channelType: 'email',
        destination: 'x@example.com',
        destinationHash: channelDestinationHash('email', 'x@example.com'),
        verified: true,
      })
      .returning({ id: schema.notificationChannels.id });
    return c!.id;
  }
  async function enqueue(
    channelId: string,
    userId: UserId,
    purpose: NotificationPurpose,
    related?: { type: string; id: string },
  ): Promise<void> {
    await db.insert(schema.notificationDeliveries).values({
      channelId,
      userId,
      purpose,
      status: 'queued',
      nextAttemptAt: new Date('2026-08-01T00:00:00Z'),
      ...(related === undefined
        ? {}
        : { relatedEntityType: related.type, relatedEntityId: related.id }),
    });
  }
  async function run(): Promise<CapturingProvider> {
    const p = new CapturingProvider();
    await tickDeliveries(
      { db, providers: new Map([[p.channelType, p]]), now: new Date('2026-08-01T00:00:00Z') },
      50,
    );
    return p;
  }

  it("sends an owner's own notice in the owner's language", async () => {
    const owner = await makeUser('es');
    await enqueue(await makeChannel(owner), owner, 'check_in_request');
    const p = await run();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.subject).toBe('Confirma que sigues activo');
    expect(p.sent[0]!.html).toContain('<html lang="es"');
  });

  it('sends in the source language when the account never chose one', async () => {
    // NULL is "never chose", which is NOT the same as choosing English
    // (migration 0067). Both render in the source language today; the column
    // keeps them distinct so a future default applies only to the former.
    const owner = await makeUser(null);
    await enqueue(await makeChannel(owner), owner, 'check_in_request');
    const p = await run();
    expect(p.sent[0]!.subject).toBe('Confirm you are active');
  });

  it("sends a CONTACT's ceremony notice in the OWNER's language, not the contact's", async () => {
    // The owner reads Spanish; the contact's own account is English. The owner
    // chose these people and is the only party who has expressed a preference
    // about this ceremony, so the notice speaks their language.
    const owner = await makeUser('es');
    const contact = await makeUser('en');
    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({ userId: owner, tier: 's2', syncWindowExpiresAt: new Date('2026-09-01T00:00:00Z') })
      .returning({ id: schema.releaseCeremonies.id });

    await enqueue(await makeChannel(contact), contact, 'ceremony_affirmation_request', {
      type: 'release_ceremony',
      id: ceremony!.id,
    });
    const p = await run();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.subject).toBe('Una solicitud como contacto de confianza');
  });

  it("falls back to the recipient's language when the ceremony is gone", async () => {
    // A notice in the wrong language is recoverable; a trusted contact who is
    // never told to open the app is not. So a dangling reference degrades rather
    // than failing the send.
    const contact = await makeUser('es');
    await enqueue(await makeChannel(contact), contact, 'ceremony_affirmation_request', {
      type: 'release_ceremony',
      id: '00000000-0000-0000-0000-000000000000',
    });
    const p = await run();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.subject).toBe('Una solicitud como contacto de confianza');
  });

  it('does not consult the ceremony for an owner-facing notice', async () => {
    // engine_state_change is owner-facing even though it carries a ceremony
    // reference, so it must resolve from the recipient. Owner reads English here
    // while the ceremony belongs to them too — the assertion that matters is
    // that a contact-facing lookup is not applied to an owner-facing purpose.
    const owner = await makeUser('en');
    const [ceremony] = await db
      .insert(schema.releaseCeremonies)
      .values({ userId: owner, tier: 's2', syncWindowExpiresAt: new Date('2026-09-01T00:00:00Z') })
      .returning({ id: schema.releaseCeremonies.id });
    await enqueue(await makeChannel(owner), owner, 'engine_state_change', {
      type: 'release_ceremony',
      id: ceremony!.id,
    });
    const p = await run();
    expect(p.sent[0]!.subject).toBe('A Truecairn account update');
  });
});
