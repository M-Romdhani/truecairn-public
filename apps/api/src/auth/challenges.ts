import { schema, type Database } from '@truecairn/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

export type ChallengePurpose =
  | 'webauthn_register'
  | 'webauthn_auth'
  // A session-scoped WebAuthn assertion that proves a FRESH second factor for
  // step-up (PHASE4 C5A). Kept distinct from 'webauthn_auth' so a login challenge
  // can never be redeemed to stamp step-up, nor a step-up challenge to log in —
  // claimChallenge filters by purpose, so the two challenge types never cross.
  | 'stepup_webauthn'
  | 'stepup_signature'
  | 'contact_ed25519_proof'
  | 'contact_x25519_proof'
  // CEREMONY_COMPLETION Bridge 3: a release-ceremony affirmation possession proof.
  // The contact signs this challenge with their C4 Ed25519 affirmation key.
  | 'ceremony_affirmation';

// Persist a single-use, server-issued challenge. `challenge` is the raw bytes
// the authenticator signs (we store the base64url-decoded bytes). Returns the
// row id — an opaque handle the client echoes back so we can claim THIS exact
// challenge atomically on verification.
export async function createChallenge(
  db: Database,
  input: {
    userId: string | null;
    purpose: ChallengePurpose;
    challenge: Uint8Array;
    expiresAt: Date;
    now: Date;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.authChallenges)
    .values({
      userId: input.userId,
      purpose: input.purpose,
      challenge: input.challenge,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    })
    .returning({ id: schema.authChallenges.id });
  if (!row) throw new Error('auth_challenges insert returned no row');
  return { id: row.id };
}

export interface ClaimedChallenge {
  userId: string | null;
  challenge: Uint8Array;
}

// Atomically consume a challenge: set consumed_at IFF it is currently
// unconsumed, unexpired, and of the expected purpose, returning its bytes and
// user binding. This single guarded UPDATE is THE replay defense — two requests
// racing on the same challenge: only one matches the `consumed_at IS NULL`
// predicate and gets a row; the loser gets null. MUST be called inside the same
// transaction as the success write (credential insert / session creation) so
// the consume commits atomically with it — not "delete after success".
export async function claimChallenge(
  tx: Database,
  input: { id: string; purpose: ChallengePurpose; now: Date },
): Promise<ClaimedChallenge | null> {
  const rows = await tx
    .update(schema.authChallenges)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(schema.authChallenges.id, input.id),
        eq(schema.authChallenges.purpose, input.purpose),
        isNull(schema.authChallenges.consumedAt),
        gt(schema.authChallenges.expiresAt, input.now),
      ),
    )
    .returning({
      userId: schema.authChallenges.userId,
      challenge: schema.authChallenges.challenge,
    });
  const row = rows[0];
  if (!row) return null;
  return { userId: row.userId, challenge: row.challenge };
}
