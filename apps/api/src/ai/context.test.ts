import { createClient, schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_CONTEXT_ALLOWLIST,
  assertContextWithinAllowlist,
  buildAiContext,
  contextLeafPaths,
  type AiContext,
} from './context.js';

// The allowlist IS the zero-knowledge boundary for server-side AI (plan §3.2 /
// P2). This snapshot pins it: any change to the exposed field set forces this
// test AND docs/AI.md to change in the same commit.
describe('AI context allowlist (snapshot)', () => {
  it('is exactly this frozen set of counts + enums + cadence', () => {
    expect([...AI_CONTEXT_ALLOWLIST]).toEqual([
      'engine.state',
      'engine.previousState',
      'engine.inactivityThresholdDays',
      'engine.checkInTimeoutDays',
      'engine.nextScheduledCheckInAt',
      'vault.totalItems',
      'vault.itemsByTier.s1',
      'vault.itemsByTier.s2',
      'vault.itemsByTier.s3',
      'contacts.total',
      'contacts.enrolled',
      'contacts.pending',
      'contacts.byRole.personal',
      'contacts.byRole.professional',
      'contacts.byRole.recovery',
      'ceremony.activeStatuses',
      // docs/40 Phase 4. Present because it REACHES A PROMPT (as a directive
      // about the output language, not as data the model reasons over), and this
      // allowlist governs what a prompt may contain. A closed enum from a
      // CHECK-constrained column — see apps/api/src/ai/language.ts.
      'user.locale',
    ]);
  });

  it('contains NO field name that could carry a secret or free text', () => {
    const forbidden =
      /cipher|nonce|ciphertext|passphrase|share|email|token|hash|pepper|kek|title|label|display|name|content|payload|secret|key/i;
    for (const path of AI_CONTEXT_ALLOWLIST) {
      expect(path, `allowlist path '${path}' looks like it could carry sensitive data`).not.toMatch(
        forbidden,
      );
    }
  });

  it('a hand-built context exposes ONLY allowlisted leaf paths', () => {
    const ctx: AiContext = {
      user: { locale: 'es' },
      engine: {
        state: 'active',
        previousState: 'pre_active',
        inactivityThresholdDays: 30,
        checkInTimeoutDays: 7,
        nextScheduledCheckInAt: new Date().toISOString(),
      },
      vault: { totalItems: 3, itemsByTier: { s1: 1, s2: 1, s3: 1 } },
      contacts: { total: 2, enrolled: 1, pending: 1, byRole: { personal: 1, professional: 1, recovery: 0 } },
      ceremony: { activeStatuses: ['collecting_affirmations'] },
    };
    const allowed = new Set<string>(AI_CONTEXT_ALLOWLIST);
    for (const path of contextLeafPaths(ctx)) expect(allowed.has(path)).toBe(true);
    expect(() => assertContextWithinAllowlist(ctx)).not.toThrow();
  });
});

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('buildAiContext (real DB)', () => {
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
    await sql`TRUNCATE release_ceremonies, vault_items, contacts, engine_states, sessions, users CASCADE`;
  });

  async function seedUser(email: string): Promise<UserId> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    return u!.id as UserId;
  }

  it('counts items by tier and contacts by role/status, enum-only', async () => {
    const userId = await seedUser('ctx@example.com');
    await db.insert(schema.engineStates).values({ userId, state: 'active', inactivityThresholdDays: 21 });
    const s1Key = await outerKey(db, userId, 's1');
    const s3Key = await outerKey(db, userId, 's3');
    const envelope = (title: string) => ({
      outerCiphertext: Buffer.alloc(8, 1),
      outerNonce: Buffer.alloc(24, 2),
      titleCiphertext: Buffer.from(title), // stand-in ciphertext; the builder never reads it
      titleNonce: Buffer.alloc(24, 4),
      contentSizeBytes: 8,
      outerKekId: 'k',
      outerGeneration: 1,
    });
    // Two S1 items, one S3 item. The AI must see counts, never the ciphertext.
    await db.insert(schema.vaultItems).values([
      { userId, tier: 's1', category: 'financial_accounts', outerLayerKeyId: s1Key, ...envelope('t1') },
      { userId, tier: 's1', category: 'identity_documents', outerLayerKeyId: s1Key, ...envelope('t2') },
      { userId, tier: 's3', category: 'personal_archive', outerLayerKeyId: s3Key, ...envelope('t3') },
    ]);
    await db.insert(schema.contacts).values([
      { ownerUserId: userId, role: 'personal', status: 'enrolled', displayLabelCiphertext: Buffer.alloc(8, 5), displayLabelNonce: Buffer.alloc(24, 6) },
      { ownerUserId: userId, role: 'professional', status: 'invited', displayLabelCiphertext: Buffer.alloc(8, 7), displayLabelNonce: Buffer.alloc(24, 8) },
    ]);

    const ctx = await buildAiContext(db, userId);
    expect(ctx.engine.state).toBe('active');
    expect(ctx.engine.inactivityThresholdDays).toBe(21);
    expect(ctx.vault.totalItems).toBe(3);
    expect(ctx.vault.itemsByTier).toEqual({ s1: 2, s2: 0, s3: 1 });
    expect(ctx.contacts).toEqual({
      total: 2,
      enrolled: 1,
      pending: 1,
      byRole: { personal: 1, professional: 1, recovery: 0 },
    });
    // The invariant: nothing outside the allowlist ever appears.
    expect(() => assertContextWithinAllowlist(ctx)).not.toThrow();
    const serialized = JSON.stringify(ctx);
    for (const leak of ['ciphertext', 'passwords', 'documents', 'legacy', 'ctx@example.com']) {
      expect(serialized).not.toContain(leak);
    }
  });

  // Minimal outer-layer key row so a vault_items insert satisfies its FK. The
  // context builder never reads it — this is just fixture plumbing. One active
  // key per (user, tier) is all the unique index permits.
  async function outerKey(dbc: Database, userId: UserId, tier: 's1' | 's2' | 's3'): Promise<string> {
    const [k] = await dbc
      .insert(schema.outerLayerKeys)
      .values({
        userId,
        tier,
        kekId: 'k',
        outerKeyEncrypted: Buffer.alloc(32, 9),
        outerKeyNonce: Buffer.alloc(24, 9),
        outerKeyEncryptionAad: Buffer.alloc(8, 9),
        generation: 1,
      })
      .returning({ id: schema.outerLayerKeys.id });
    return k!.id;
  }
});
