// F-1 from the 2026-08-10 restore drill: the outer-layer KEK check could not
// detect a WRONG key.
//
// It wrapped a freshly generated probe and unwrapped it with the same key. Any
// well-formed 32-byte value round-trips green against itself, so the check
// proved the key was USABLE and said nothing about whether it was THE key —
// while /status published it as RELEASE-CRITICAL and "verified with a real
// wrap-and-unwrap round-trip on the live key". If OUTER_LAYER_KEK were ever
// replaced with a wrong-but-valid value (a bad transcription, a rotation
// mistake, an environment seeded from the wrong copy), the public page stayed
// green while every existing vault item was permanently unopenable, and the
// first symptom would have been a real ceremony failing at its last step.
//
// This test is the demonstration the fix was asked to provide: the same stored
// ciphertext, read with the right key and with a wrong-but-valid one, and the
// check going ok → down between them. It needs real Postgres and real AEAD —
// a mock provider would prove nothing here, because the whole failure was that
// a self-consistent round-trip proves nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initCrypto } from '@truecairn/crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { envKekProvider, type KekProvider } from '@truecairn/vault';
import { collectSystemStatus, type SystemStatusDeps } from './system-status.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

type Sql = ReturnType<typeof createClient>['sql'];

const KEK_ID = 'kek-drill-1';

// A ring holding ONE key under a fixed id. Two rings built with the same id and
// different bytes is exactly the production accident being modelled: the config
// still names the key the rows were sealed under, and the bytes behind that name
// are not the ones that sealed them.
function ringOf(key: Uint8Array): KekProvider {
  return envKekProvider({ currentId: KEK_ID, byId: new Map([[KEK_ID, { id: KEK_ID, key }]]) });
}

describeIfDb('outer-layer KEK check: identity, not just usability (drill F-1)', () => {
  let db: Database;
  let sql: Sql;
  const rightKey = randomBytes(32);
  const wrongKey = randomBytes(32); // well-formed, 32 bytes, and not the key

  const deps = (keks: KekProvider): SystemStatusDeps => ({
    db,
    outerLayerKeks: keks,
    auditReady: true,
    apiVersion: '0.0.0',
    configuredNotificationTypes: ['email'],
    cryptoReady: () => true,
    backups: { kind: 'none' },
  });

  const kekCheck = async (keks: KekProvider) =>
    (await collectSystemStatus(deps(keks))).checks.find((c) => c.id === 'outer_layer_kek')!;

  beforeAll(async () => {
    await initCrypto();
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE outer_layer_keys, audit_log_locks, audit_log, users CASCADE`;
  });

  // Seal one outer-layer key under `rightKey` and store it the way the vault
  // does — this is the ciphertext a release would have to open.
  async function storeOuterLayerKey(): Promise<void> {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `kek${Date.now()}@example.com`, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const aad = Buffer.from(`${user!.id}:s1:${KEK_ID}:1`, 'utf8');
    const wrapped = await ringOf(rightKey).wrap(randomBytes(32), aad);
    await db.insert(schema.outerLayerKeys).values({
      userId: user!.id,
      tier: 's1',
      kekId: KEK_ID,
      outerKeyEncrypted: wrapped.ciphertext,
      outerKeyNonce: wrapped.nonce,
      outerKeyEncryptionAad: aad,
    });
  }

  it('a WRONG-but-valid KEK turns the check red once a key is stored', async () => {
    await storeOuterLayerKey();

    const right = await kekCheck(ringOf(rightKey));
    expect(right.state).toBe('ok');
    // The wording has to say what was actually checked — a detail claiming a
    // round-trip while the identity half silently skipped is the same class of
    // dishonesty the original check shipped with.
    expect(right.detail).toMatch(/opened a stored outer-layer key/);

    const wrong = await kekCheck(ringOf(wrongKey));
    expect(wrong.state).toBe('down');
    expect(wrong.detail).toMatch(/no release can be completed/);
  });

  it('the OLD check passes both keys — which is why it had to change', async () => {
    // The negative control, and the reason this file exists. A self-consistent
    // wrap→unwrap on a fresh probe is what the check used to do, and it cannot
    // tell these two rings apart. If a future refactor quietly reverts to it,
    // the assertion above goes green again and this one explains why that is
    // not reassuring.
    const probe = randomBytes(32);
    const aad = Buffer.from('ops-probe', 'utf8');
    for (const key of [rightKey, wrongKey]) {
      const ring = ringOf(key);
      const back = await ring.unwrap(KEK_ID, await ring.wrap(probe, aad), aad);
      expect(Buffer.compare(Buffer.from(back), probe)).toBe(0);
    }
  });

  it('with no keys stored the detail says the identity is unproven, not that it passed', async () => {
    // A fresh deployment has nothing to open, so the check cannot be red — but
    // it must not imply it verified something it could not (rule 1). Distinct
    // from a database outage, which says THAT instead.
    const check = await kekCheck(ringOf(rightKey));
    expect(check.state).toBe('ok');
    expect(check.detail).toMatch(/no outer-layer keys stored yet/);
    expect(check.detail).toMatch(/IDENTITY is not yet provable/);
  });
});
