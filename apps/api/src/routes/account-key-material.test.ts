import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex, initCrypto } from '@truecairn/crypto';
import {
  decodeKeyMaterial,
  encodeKeyMaterial,
  generateEnrollmentMaterial,
  isUnlocked,
  lock,
  unlock,
  withTierKey,
} from '@truecairn/client-crypto';
import { createClient, schema, type Database } from '@truecairn/db';
import { validateTierKeyCheck } from '@truecairn/keys';
import type { UserId } from '@truecairn/shared';
import { createSession } from '@truecairn/sessions';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../auth/session.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// PHASE4 C1 — the deferred R0.4 endpoints, exercised end-to-end with the REAL
// @truecairn/client-crypto library: the client generates its key material,
// uploads it (provision), fetches it back (bootstrap), and unlocks. If the wire
// contract or the byte encoding disagreed, the unlock or the tier-key check would
// fail — so this is the cross-process interop proof, not just an HTTP smoke test.
describeIfDb('key-material provision + bootstrap (PHASE4 C1)', () => {
  let db: Database;
  let sql: Sql;
  let app: FastifyInstance;
  const config = loadConfig({ TOTP_KEK: Buffer.alloc(32, 4).toString('base64') });

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
    await sql`TRUNCATE user_tier_keys, outer_layer_keys, user_key_material, sessions, users CASCADE`;
    app = buildApp({ ...config, logLevel: 'silent' }, { db, sql });
    await app.ready();
  });
  afterEach(async () => {
    lock();
    await app.close();
  });

  async function makeUserSession(email: string): Promise<{ userId: UserId; cookie: string }> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, accountStatus: 'active' })
      .returning({ id: schema.users.id });
    const userId = u!.id as UserId;
    const { token } = await createSession(db, { userId, now: new Date() });
    return { userId, cookie: token };
  }
  const as = (cookie: string): Record<string, string> => ({ [SESSION_COOKIE]: cookie });

  it('client provisions → bootstrap returns byte-identical material → it unlocks', async () => {
    const { userId, cookie } = await makeUserSession('enroll@example.com');
    const { material } = generateEnrollmentMaterial(utf8('pw-e2e'));

    const prov = await app.inject({
      method: 'POST',
      url: '/v1/account/key-material',
      cookies: as(cookie),
      payload: encodeKeyMaterial(material),
    });
    expect(prov.statusCode).toBe(201);

    // Persisted: one key-material row + three tier keys + three (server-generated)
    // outer keys.
    expect(
      await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.userTierKeys).where(eq(schema.userTierKeys.userId, userId)),
    ).toHaveLength(3);
    expect(
      await db.select().from(schema.outerLayerKeys).where(eq(schema.outerLayerKeys.userId, userId)),
    ).toHaveLength(3);

    const boot = await app.inject({
      method: 'GET',
      url: '/v1/account/key-material',
      cookies: as(cookie),
    });
    expect(boot.statusCode).toBe(200);
    const fetched = decodeKeyMaterial(boot.json());

    // Byte-identical to what the client uploaded.
    expect(bytesToHex(fetched.masterKeyWrappedByPassphrase)).toBe(
      bytesToHex(material.masterKeyWrappedByPassphrase),
    );
    expect(bytesToHex(fetched.masterPassphraseSalt)).toBe(bytesToHex(material.masterPassphraseSalt));
    expect(fetched.tierKeys).toHaveLength(3);

    // The fetched material UNLOCKS and every tier key validates against its check.
    unlock(utf8('pw-e2e'), fetched);
    expect(isUnlocked()).toBe(true);
    for (const t of fetched.tierKeys) {
      const ok = withTierKey(t.tier, (tk) =>
        validateTierKeyCheck(
          tk,
          {
            plaintext: t.tierKeyCheckPlaintext,
            ciphertext: t.tierKeyCheckCiphertext,
            nonce: t.tierKeyCheckNonce,
          },
          t.generation,
        ),
      );
      expect(ok).toBe(true);
    }
  });

  it('rejects a second provision with 409, leaving the original untouched (seed-once)', async () => {
    const { userId, cookie } = await makeUserSession('double@example.com');
    const dto = encodeKeyMaterial(generateEnrollmentMaterial(utf8('pw-first')).material);

    expect(
      (await app.inject({ method: 'POST', url: '/v1/account/key-material', cookies: as(cookie), payload: dto }))
        .statusCode,
    ).toBe(201);
    const before = (
      await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId))
    )[0]!;

    // A retry / re-submit (even with DIFFERENT material) must not overwrite — that
    // would orphan every vault item wrapped under the first tier keys.
    const dto2 = encodeKeyMaterial(generateEnrollmentMaterial(utf8('pw-second')).material);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/account/key-material',
      cookies: as(cookie),
      payload: dto2,
    });
    expect(second.statusCode).toBe(409);

    const after = (
      await db.select().from(schema.userKeyMaterial).where(eq(schema.userKeyMaterial.userId, userId))
    )[0]!;
    expect(bytesToHex(after.masterKeyWrappedByPassphrase)).toBe(
      bytesToHex(before.masterKeyWrappedByPassphrase),
    );
    expect(
      await db.select().from(schema.userTierKeys).where(eq(schema.userTierKeys.userId, userId)),
    ).toHaveLength(3); // not doubled
  });

  it('bootstrap requires a session but NOT unlock (logged-in-but-locked can fetch)', async () => {
    // No session → 401.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/account/key-material' })).statusCode,
    ).toBe(401);

    // Session but not yet provisioned → 404 (not an error state — just nothing yet).
    const { cookie } = await makeUserSession('notprov@example.com');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/account/key-material', cookies: as(cookie) }))
        .statusCode,
    ).toBe(404);

    // After provisioning, a plain session (no step-up, no unlock) fetches it — the
    // material is exactly what you need TO unlock, so gating on unlock is circular.
    const dto = encodeKeyMaterial(generateEnrollmentMaterial(utf8('pw-gate')).material);
    await app.inject({ method: 'POST', url: '/v1/account/key-material', cookies: as(cookie), payload: dto });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/account/key-material', cookies: as(cookie) }))
        .statusCode,
    ).toBe(200);
  });
});
