import { schema, type Database } from '@truecairn/db';
import { eq } from 'drizzle-orm';
import type { TotpKekSet } from '../config.js';
import { decryptTotpSecret, encryptTotpSecret, generateTotpSecret, verifyTotp } from './totp.js';

// DB-touching TOTP operations, including KEK versioning. The secret is always
// decrypted with the KEK named by the row's kek_id; on a successful verify, if
// that is not the current KEK, the secret is transparently re-wrapped under the
// current KEK — so a KEK rotation drains organically as users authenticate,
// never a forced re-enrol.

// Verify a presented code for a user. Returns false if the user has no confirmed
// TOTP, the code is wrong, or the row's KEK is unknown. Re-wraps on success when
// the row is on a stale KEK.
export async function verifyUserTotp(
  db: Database,
  keks: TotpKekSet,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .select({
      ciphertext: schema.totpCredentials.secretCiphertext,
      nonce: schema.totpCredentials.secretNonce,
      kekId: schema.totpCredentials.kekId,
      confirmedAt: schema.totpCredentials.confirmedAt,
    })
    .from(schema.totpCredentials)
    .where(eq(schema.totpCredentials.userId, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.confirmedAt === null) return false;

  const kek = keks.byId.get(row.kekId);
  if (kek === undefined) return false; // unknown KEK -> cannot decrypt; fail closed
  const secret = decryptTotpSecret(kek.key, { ciphertext: row.ciphertext, nonce: row.nonce });
  if (!verifyTotp(secret, code, now)) return false;

  if (row.kekId !== keks.currentId) {
    const current = keks.byId.get(keks.currentId);
    if (current !== undefined) {
      const rewrapped = encryptTotpSecret(current.key, secret);
      await db
        .update(schema.totpCredentials)
        .set({
          secretCiphertext: rewrapped.ciphertext,
          secretNonce: rewrapped.nonce,
          kekId: current.id,
        })
        .where(eq(schema.totpCredentials.userId, userId));
    }
  }
  return true;
}

export interface TotpSetup {
  secret: Uint8Array; // returned ONCE so the route can render the otpauth URI / QR
}

// Begin TOTP enrolment: generate a secret, wrap it under the current KEK, store
// it UNCONFIRMED (confirmed_at NULL). Overwrites any prior unconfirmed/expired
// row for the user (a re-setup). Returns the raw secret for the QR.
export async function setupTotp(
  db: Database,
  keks: TotpKekSet,
  userId: string,
  now: Date,
): Promise<TotpSetup> {
  const current = keks.byId.get(keks.currentId);
  if (current === undefined) throw new Error('no current TOTP KEK');
  const secret = generateTotpSecret();
  const enc = encryptTotpSecret(current.key, secret);
  await db
    .insert(schema.totpCredentials)
    .values({
      userId,
      secretCiphertext: enc.ciphertext,
      secretNonce: enc.nonce,
      kekId: current.id,
      confirmedAt: null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: schema.totpCredentials.userId,
      set: {
        secretCiphertext: enc.ciphertext,
        secretNonce: enc.nonce,
        kekId: current.id,
        confirmedAt: null,
      },
    });
  return { secret };
}

// Confirm enrolment by verifying the first code; sets confirmed_at. Returns
// false if there is no pending secret or the code is wrong.
export async function confirmTotp(
  db: Database,
  keks: TotpKekSet,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .select({
      ciphertext: schema.totpCredentials.secretCiphertext,
      nonce: schema.totpCredentials.secretNonce,
      kekId: schema.totpCredentials.kekId,
    })
    .from(schema.totpCredentials)
    .where(eq(schema.totpCredentials.userId, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return false;
  const kek = keks.byId.get(row.kekId);
  if (kek === undefined) return false;
  const secret = decryptTotpSecret(kek.key, { ciphertext: row.ciphertext, nonce: row.nonce });
  if (!verifyTotp(secret, code, now)) return false;
  await db
    .update(schema.totpCredentials)
    .set({ confirmedAt: now })
    .where(eq(schema.totpCredentials.userId, userId));
  return true;
}
