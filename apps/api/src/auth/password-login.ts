import { schema, type Database } from '@truecairn/db';
import { createSession, type CreatedSession } from '@truecairn/sessions';
import type { UserId } from '@truecairn/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { TotpKekSet } from '../config.js';
import { hashPassword, needsRehash, SENTINEL_PASSWORD_HASH, verifyPassword } from './password.js';
import { verifyUserTotp } from './totp-store.js';

export type PasswordLoginResult =
  | { kind: 'ok'; userId: UserId; session: CreatedSession }
  | { kind: 'blocked_by_passkey' }
  | { kind: 'reject' };

export interface PasswordLoginInput {
  email: string;
  password: string;
  totp: string;
  now: Date;
  totpKeks: TotpKekSet;
  userAgent?: string;
}

// Password + TOTP login. Order matters for two reasons:
//   1. Enumeration: the full Argon2id verify ALWAYS runs (against the real hash
//      or the in-memory sentinel), so unknown email / wrong password / wrong
//      TOTP are indistinguishable in shape and timing — all 'reject'.
//   2. Q9: the passkey hard-block is checked ONLY AFTER password+TOTP verify, so
//      a blind attacker never sees 'blocked_by_passkey' (it leaks no account
//      existence). When it fires, the route REFUSES (no session).
export async function passwordLogin(
  db: Database,
  input: PasswordLoginInput,
): Promise<PasswordLoginResult> {
  const users = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.emailLower, input.email.toLowerCase()))
    .limit(1);
  const user = users[0];

  // Always run Argon2id — real hash when present, sentinel otherwise.
  let storedHash = SENTINEL_PASSWORD_HASH;
  if (user !== undefined) {
    const rows = await db
      .select({ phc: schema.passwordCredentials.argon2Phc })
      .from(schema.passwordCredentials)
      .where(eq(schema.passwordCredentials.userId, user.id))
      .limit(1);
    if (rows[0] !== undefined) storedHash = rows[0].phc;
  }
  const passwordOk =
    verifyPassword(input.password, storedHash) && storedHash !== SENTINEL_PASSWORD_HASH;

  const totpOk =
    user !== undefined && (await verifyUserTotp(db, input.totpKeks, user.id, input.totp, input.now));

  if (user === undefined || !passwordOk || !totpOk) return { kind: 'reject' };

  // Rehash-on-verify: if the stored hash used older Argon2id params, transparently
  // upgrade it now that we have the plaintext. Cost-parameter changes drain
  // organically as users log in — no forced rehash sweep.
  if (needsRehash(storedHash)) {
    await db
      .update(schema.passwordCredentials)
      .set({ argon2Phc: hashPassword(input.password), updatedAt: input.now })
      .where(eq(schema.passwordCredentials.userId, user.id));
  }

  // Authenticated. Q9 hard-block — refuse, never downgrade.
  const passkey = await db
    .select({ id: schema.webauthnCredentials.id })
    .from(schema.webauthnCredentials)
    .where(
      and(eq(schema.webauthnCredentials.userId, user.id), isNull(schema.webauthnCredentials.revokedAt)),
    )
    .limit(1);
  if (passkey[0] !== undefined) return { kind: 'blocked_by_passkey' };

  const session = await createSession(db, {
    userId: user.id as UserId,
    now: input.now,
    ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
  });
  return { kind: 'ok', userId: user.id as UserId, session };
}
