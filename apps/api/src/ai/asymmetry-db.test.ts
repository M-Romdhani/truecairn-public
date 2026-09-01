import { AI_AUDIT_EVENT_TYPES, AiAuthority, AiAuthorityError } from '@truecairn/ai-authority';
import { AuditLogWriter, resolveServerSigner, verifyChain } from '@truecairn/audit';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

// The asymmetry invariant at the DATABASE layer (plan §0.5 / §3.4): AI audit
// events ride the real hash chain with actor='ai', the chain still verifies, and
// an actor='ai' row can only ever carry an allowlisted AI event type. Also asserts
// the D6 payload discipline — hashes/ids, never a raw prompt.
describeIfDb('AI audit events on the real chain (actor=ai)', () => {
  let db: Database;
  let sql: Sql;
  let writer: AuditLogWriter;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
    writer = new AuditLogWriter(await resolveServerSigner(db));
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE audit_log, audit_log_locks, users CASCADE`;
  });

  async function makeUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }

  it('every AI event type appends with actor=ai and the chain verifies', async () => {
    const userId = await makeUser('ai-audit@example.com');
    const authority = new AiAuthority({ audit: writer });
    // A D6-style payload: template + hashes + model + token counts, no raw text.
    const d6Payload = {
      promptTemplateId: 'guardian.v1',
      promptHash: 'sha256:abc',
      outputHash: 'sha256:def',
      modelId: 'gemini-2.5-flash',
      tokensIn: 42,
      tokensOut: 7,
    };
    for (const type of AI_AUDIT_EVENT_TYPES) {
      await authority.appendAiAudit(db, userId, type, d6Payload);
    }

    const rows = await db
      .select({ eventType: schema.auditLog.eventType, actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    expect(rows).toHaveLength(AI_AUDIT_EVENT_TYPES.length);
    expect(rows.every((r) => r.actor === 'ai')).toBe(true);

    // No actor='ai' row carries a non-AI event type.
    const aiTypes = new Set<string>(AI_AUDIT_EVENT_TYPES);
    expect(rows.every((r) => aiTypes.has(r.eventType))).toBe(true);

    const verified = await verifyChain(db, userId);
    expect(verified.ok).toBe(true);
  });

  it('the chokepoint refuses to write a non-AI event type as actor=ai', async () => {
    const userId = await makeUser('ai-refuse@example.com');
    const authority = new AiAuthority({ audit: writer });
    await expect(
      authority.appendAiAudit(db, userId, 'engine.full_release' as never, {}),
    ).rejects.toThrow(AiAuthorityError);
    // Nothing was written — so no actor='ai' row exists for a forward event.
    const forward = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(ne(schema.auditLog.eventType, 'ai_review_signal_emitted'));
    expect(forward).toHaveLength(0);
  });

  it('AI audit payloads carry no raw prompt/answer fields (D6 discipline)', async () => {
    const userId = await makeUser('ai-d6@example.com');
    const authority = new AiAuthority({ audit: writer });
    await authority.appendAiAudit(db, userId, 'ai_output_rejected', {
      promptTemplateId: 'assist.v1',
      promptHash: 'sha256:xyz',
      reason: 'schema_violation',
    });
    const [row] = await db
      .select({ payload: schema.auditLog.eventPayload })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId));
    const keys = Object.keys(row!.payload as Record<string, unknown>);
    for (const forbidden of ['prompt', 'question', 'answer', 'plaintext', 'content', 'text']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
