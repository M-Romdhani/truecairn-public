import { schema, type Database } from '@truecairn/db';
import type { AuditLogPort } from '@truecairn/engine';
import type { SessionId, UserId } from '@truecairn/shared';
import { createSession, stampStepUp, type CreatedSession } from '@truecairn/sessions';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { and, eq, isNull } from 'drizzle-orm';
import { badRequest, conflict, unauthorized } from '../errors.js';
import { claimChallenge, createChallenge } from './challenges.js';
import {
  base64urlToBytes,
  bytesToBase64url,
  generateAuthenticationChallenge,
  generateRegistrationChallenge,
  isSignCountRegression,
  type WebAuthnConfig,
  type WebAuthnVerifier,
} from './webauthn.js';

// Challenges are short-lived single-use values (auth_challenges comment).
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface BeginResult {
  options: unknown; // PublicKeyCredential(Creation|Request)OptionsJSON, passed through to the client
  challengeId: string;
}

// ── Registration (sign-up: first passkey for a new/pending account) ───────────

export async function beginRegistration(
  db: Database,
  config: WebAuthnConfig,
  input: { email: string; now: Date },
): Promise<BeginResult> {
  const emailLower = input.email.toLowerCase();
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.emailLower, emailLower))
    .limit(1);

  let userId: string;
  const existingUser = existing[0];
  if (existingUser !== undefined) {
    // Adding a passkey to an account that already has one is a step-up-gated
    // action (post-checkpoint). A pending account with no credential yet (an
    // interrupted sign-up) may resume.
    const cred = await db
      .select({ id: schema.webauthnCredentials.id })
      .from(schema.webauthnCredentials)
      .where(
        and(
          eq(schema.webauthnCredentials.userId, existingUser.id),
          isNull(schema.webauthnCredentials.revokedAt),
        ),
      )
      .limit(1);
    if (cred[0] !== undefined) throw conflict('an account with this email already exists');
    userId = existingUser.id;
  } else {
    const [created] = await db
      .insert(schema.users)
      .values({ email: input.email, accountStatus: 'pending' })
      .returning({ id: schema.users.id });
    if (!created) throw new Error('users insert returned no row');
    userId = created.id;
  }

  const options = await generateRegistrationChallenge(config, { userId, userName: input.email });
  const { id: challengeId } = await createChallenge(db, {
    userId,
    purpose: 'webauthn_register',
    challenge: base64urlToBytes(options.challenge),
    expiresAt: new Date(input.now.getTime() + CHALLENGE_TTL_MS),
    now: input.now,
  });
  return { options, challengeId };
}

export async function finishRegistration(
  db: Database,
  verifier: WebAuthnVerifier,
  input: {
    challengeId: string;
    response: RegistrationResponseJSON;
    now: Date;
    isHardwareKey: boolean;
    // When supplied, an audit entry is written IN THE SAME TRANSACTION as the
    // credential insert (used by the step-up-gated hardware-key path to record
    // the enrolment + its step-up linkage).
    audit?: AuditLogPort;
    auditEventType?: string;
    auditPayload?: Record<string, unknown>;
  },
): Promise<{ credentialId: string }> {
  const result = await db.transaction(async (tx) => {
    const tdb = tx as unknown as Database;
    const claimed = await claimChallenge(tdb, {
      id: input.challengeId,
      purpose: 'webauthn_register',
      now: input.now,
    });
    if (claimed === null || claimed.userId === null) return { kind: 'reject' } as const;

    const verified = await verifier.verifyRegistration({
      response: input.response,
      expectedChallenge: bytesToBase64url(claimed.challenge),
    });
    if (!verified.verified) return { kind: 'reject' } as const;

    const [row] = await tdb
      .insert(schema.webauthnCredentials)
      .values({
        userId: claimed.userId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: verified.counter,
        transports: verified.transports,
        aaguid: verified.aaguid,
        isHardwareKey: input.isHardwareKey,
        createdAt: input.now,
      })
      .returning({ id: schema.webauthnCredentials.id });
    if (!row) throw new Error('webauthn_credentials insert returned no row');

    if (input.audit !== undefined && input.auditEventType !== undefined) {
      await input.audit.append(
        tdb,
        claimed.userId as UserId,
        input.auditEventType,
        input.auditPayload ?? {},
      );
    }
    return { kind: 'ok', credentialId: bytesToBase64url(verified.credentialId) } as const;
  });

  if (result.kind === 'ok') return { credentialId: result.credentialId };
  throw badRequest('registration verification failed');
}

// Begin adding an authenticator to an EXISTING account (e.g. a hardware key, or
// an additional passkey). Targets the logged-in user and excludes their current
// credentials. The verify step is step-up-gated; this options step is not.
export async function beginAddAuthenticator(
  db: Database,
  config: WebAuthnConfig,
  input: { userId: string; now: Date },
): Promise<BeginResult> {
  const users = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  const userName = users[0]?.email ?? input.userId;

  const creds = await db
    .select({
      credentialId: schema.webauthnCredentials.credentialId,
      transports: schema.webauthnCredentials.transports,
    })
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.userId, input.userId),
        isNull(schema.webauthnCredentials.revokedAt),
      ),
    );

  const options = await generateRegistrationChallenge(config, {
    userId: input.userId,
    userName,
    excludeCredentials: creds.map((c) => ({
      id: bytesToBase64url(c.credentialId),
      transports: c.transports,
    })),
  });
  const { id: challengeId } = await createChallenge(db, {
    userId: input.userId,
    purpose: 'webauthn_register',
    challenge: base64urlToBytes(options.challenge),
    expiresAt: new Date(input.now.getTime() + CHALLENGE_TTL_MS),
    now: input.now,
  });
  return { options, challengeId };
}

// ── Authentication (login) ────────────────────────────────────────────────────

export async function beginAuthentication(
  db: Database,
  config: WebAuthnConfig,
  input: { email: string | undefined; now: Date },
): Promise<BeginResult> {
  let userId: string | null = null;
  let allowCredentials: { id: string; transports: string[] | null }[] | undefined;

  if (input.email !== undefined) {
    const user = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.emailLower, input.email.toLowerCase()))
      .limit(1);
    const u = user[0];
    if (u !== undefined) {
      userId = u.id;
      const creds = await db
        .select({
          credentialId: schema.webauthnCredentials.credentialId,
          transports: schema.webauthnCredentials.transports,
        })
        .from(schema.webauthnCredentials)
        .where(
          and(
            eq(schema.webauthnCredentials.userId, u.id),
            isNull(schema.webauthnCredentials.revokedAt),
          ),
        );
      allowCredentials = creds.map((c) => ({
        id: bytesToBase64url(c.credentialId),
        transports: c.transports,
      }));
    }
    // Unknown email: leave allowCredentials undefined so the response looks the
    // same as a discoverable-login prompt — no account-existence disclosure.
  }

  const options = await generateAuthenticationChallenge(config, allowCredentials);
  const { id: challengeId } = await createChallenge(db, {
    userId,
    purpose: 'webauthn_auth',
    challenge: base64urlToBytes(options.challenge),
    expiresAt: new Date(input.now.getTime() + CHALLENGE_TTL_MS),
    now: input.now,
  });
  return { options, challengeId };
}

export interface FinishAuthenticationResult {
  userId: UserId;
  session: CreatedSession;
}

export async function finishAuthentication(
  db: Database,
  verifier: WebAuthnVerifier,
  audit: AuditLogPort,
  input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
    now: Date;
    userAgent?: string;
  },
): Promise<FinishAuthenticationResult> {
  type TxResult =
    | { kind: 'ok'; userId: UserId; session: CreatedSession }
    | { kind: 'reject' }
    | { kind: 'regression' };

  const result: TxResult = await db.transaction(async (tx): Promise<TxResult> => {
    const tdb = tx as unknown as Database;

    const claimed = await claimChallenge(tdb, {
      id: input.challengeId,
      purpose: 'webauthn_auth',
      now: input.now,
    });
    if (claimed === null) return { kind: 'reject' };

    const credentialId = base64urlToBytes(input.response.id);
    const found = await tdb
      .select()
      .from(schema.webauthnCredentials)
      .where(
        and(
          eq(schema.webauthnCredentials.credentialId, credentialId),
          isNull(schema.webauthnCredentials.revokedAt),
        ),
      )
      .limit(1);
    const cred = found[0];
    if (cred === undefined) return { kind: 'reject' };

    const verified = await verifier.verifyAuthentication({
      response: input.response,
      expectedChallenge: bytesToBase64url(claimed.challenge),
      credential: {
        id: input.response.id,
        publicKey: cred.publicKey,
        counter: cred.signCount,
        transports: cred.transports,
      },
    });
    if (!verified.verified) return { kind: 'reject' };

    // Clone detection: a non-increasing counter is rejected AND audited. The
    // audit append shares this transaction, so it commits atomically with the
    // challenge consume even though the login is refused.
    if (isSignCountRegression(cred.signCount, verified.newCounter)) {
      await audit.append(tdb, cred.userId as UserId, 'webauthn.signcount_regression', {
        action: 'reject',
        credentialId: input.response.id,
        storedCount: cred.signCount,
        presentedCount: verified.newCounter,
      });
      return { kind: 'regression' };
    }

    await tdb
      .update(schema.webauthnCredentials)
      .set({ signCount: verified.newCounter, lastUsedAt: input.now })
      .where(eq(schema.webauthnCredentials.id, cred.id));

    const session = await createSession(tdb, {
      userId: cred.userId as UserId,
      now: input.now,
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });
    return { kind: 'ok', userId: cred.userId as UserId, session };
  });

  if (result.kind === 'ok') return { userId: result.userId, session: result.session };
  // Generic failure for unknown-credential, unverified, replay, AND regression
  // (which is audited internally): the client learns nothing about which.
  throw unauthorized('authentication failed');
}

// ── Step-up second factor via WebAuthn (PHASE4 C5A) ──────────────────────────

// Begin a step-up second-factor assertion. Session-scoped twin of
// beginAuthentication: the user is known, so allowCredentials is THIS user's
// non-revoked credentials and the challenge is bound to them (purpose
// 'stepup_webauthn'). The verify step stamps last_stepup_at — re-tapping the
// passkey the user ALREADY holds is the fresh second factor that bootstraps every
// step-up gate, with no TOTP dependency. Options-only here; no verification, so no
// verifier needed.
export async function beginStepUpAssertion(
  db: Database,
  config: WebAuthnConfig,
  input: { userId: string; now: Date },
): Promise<BeginResult> {
  const creds = await db
    .select({
      credentialId: schema.webauthnCredentials.credentialId,
      transports: schema.webauthnCredentials.transports,
    })
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.userId, input.userId),
        isNull(schema.webauthnCredentials.revokedAt),
      ),
    );
  const options = await generateAuthenticationChallenge(
    config,
    creds.map((c) => ({ id: bytesToBase64url(c.credentialId), transports: c.transports })),
  );
  const { id: challengeId } = await createChallenge(db, {
    userId: input.userId,
    purpose: 'stepup_webauthn',
    challenge: base64urlToBytes(options.challenge),
    expiresAt: new Date(input.now.getTime() + CHALLENGE_TTL_MS),
    now: input.now,
  });
  return { options, challengeId };
}

export type StepUpAssertionResult = { kind: 'ok' } | { kind: 'reject' };

// Verify a step-up WebAuthn assertion and, on success, STAMP last_stepup_at on the
// session — the analogue of finishAuthentication, but it proves a fresh second
// factor for an EXISTING session instead of creating one. The assertion is bound
// to the session user two ways: the claimed challenge's userId AND the credential's
// userId must both equal it — never stamp from someone else's authenticator. Clone
// detection reuses the EXACT isSignCountRegression (with its platform-passkey 0/0
// exception); a regression is the same clone signal regardless of purpose, so we
// reject and do NOT stamp. No separate audit event: like the TOTP second-factor
// path, the proof is attested by the action's own R2 step-up linkage (challengeId +
// signature), keeping the two methods symmetric (Q1).
export async function verifyStepUpAssertion(
  db: Database,
  verifier: WebAuthnVerifier,
  input: {
    userId: string;
    sessionId: SessionId;
    challengeId: string;
    response: AuthenticationResponseJSON;
    now: Date;
  },
): Promise<StepUpAssertionResult> {
  return db.transaction(async (tx): Promise<StepUpAssertionResult> => {
    const tdb = tx as unknown as Database;
    const claimed = await claimChallenge(tdb, {
      id: input.challengeId,
      purpose: 'stepup_webauthn',
      now: input.now,
    });
    if (claimed === null || claimed.userId !== input.userId) return { kind: 'reject' };

    const credentialId = base64urlToBytes(input.response.id);
    const found = await tdb
      .select()
      .from(schema.webauthnCredentials)
      .where(
        and(
          eq(schema.webauthnCredentials.credentialId, credentialId),
          isNull(schema.webauthnCredentials.revokedAt),
        ),
      )
      .limit(1);
    const cred = found[0];
    if (cred === undefined || cred.userId !== input.userId) return { kind: 'reject' };

    const verified = await verifier.verifyAuthentication({
      response: input.response,
      expectedChallenge: bytesToBase64url(claimed.challenge),
      credential: {
        id: input.response.id,
        publicKey: cred.publicKey,
        counter: cred.signCount,
        transports: cred.transports,
      },
    });
    if (!verified.verified) return { kind: 'reject' };
    if (isSignCountRegression(cred.signCount, verified.newCounter)) return { kind: 'reject' };

    await tdb
      .update(schema.webauthnCredentials)
      .set({ signCount: verified.newCounter, lastUsedAt: input.now })
      .where(eq(schema.webauthnCredentials.id, cred.id));
    await stampStepUp(tdb, input.sessionId, input.now);
    return { kind: 'ok' };
  });
}
