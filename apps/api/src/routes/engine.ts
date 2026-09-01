import { cancelCeremoniesForUser } from '@truecairn/ceremony';
import { schema, type Database } from '@truecairn/db';
import { applyEvent, DbChannelLookup, loadRow, type ApplyContext } from '@truecairn/engine';
import { S2_THRESHOLD, S3_NESTED_CONTACT_THRESHOLD } from '@truecairn/keys';
import { cancelSensitiveAction, requestSensitiveAction } from '@truecairn/sensitive-actions';
import type { EngineState, UserId } from '@truecairn/shared';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession, requireSessionAllowingLocked } from '../auth/session.js';
import { requireFreshSecondFactor, requireStepUp } from '../auth/stepup.js';
import { ApiError, conflict, notFound, tooManyRequests, unauthorized } from '../errors.js';

const ACK_REQUIRED_TYPE = 'https://truecairn.app/problems/engine-acknowledgment-required';
const NO_ENGINE_TYPE = 'https://truecairn.app/problems/engine-not-armed';
const ARM_PREREQ_TYPE = 'https://truecairn.app/problems/engine-arm-prerequisite';

// Check-in is the most frequent op in the product; it accepts only the
// PRE-RELEASE states (a release-in-flight is stopped via cancel-release, which is
// gated harder). escalation_pending additionally needs an explicit acknowledgment.
const CHECKIN_STATES: ReadonlySet<EngineState> = new Set<EngineState>([
  'active',
  'check_in_pending',
  'notification_stalled',
  'escalation_pending',
]);
const RELEASE_LADDER: ReadonlySet<EngineState> = new Set<EngineState>([
  'release_review',
  'limited_release',
  'staged_release',
]);

// Consensus threshold per tier, mirrored from the ceremony processor (S1 is
// any-one-contact; S2/S3 from @truecairn/keys) — display metadata for the
// owner's progress view, never an enforcement input here.
const TIER_THRESHOLD: Record<string, number> = {
  s1: 1,
  s2: S2_THRESHOLD,
  s3: S3_NESTED_CONTACT_THRESHOLD,
};

// Volume rate limit for check-in (PHASE3_4 §b): keyed on VOLUME, not failures —
// check-ins succeed, so the auth failure-limiter doesn't fit. A legit user checks
// in maybe once a day; this only catches a runaway client.
const CHECKIN_WINDOW_MS = 60 * 60 * 1000;
const CHECKIN_MAX_PER_WINDOW = 60;

export function engineRoutes(app: FastifyInstance, db: Database): void {
  const channels = new DbChannelLookup(db);

  // ── Status (read) ──────────────────────────────────────────────────────────
  // Also allowed while locked: without it the client cannot render the engine
  // page, so the check-in carve-out above would exist but be unreachable in the
  // real app. Read-only, and it exposes nothing a valid session did not already
  // have.
  app.get('/v1/engine/status', { preHandler: [requireSessionAllowingLocked] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const [es] = await db
      .select()
      .from(schema.engineStates)
      .where(eq(schema.engineStates.userId, session.userId))
      .limit(1);
    const pending = await db
      .select({
        id: schema.sensitiveActions.id,
        actionType: schema.sensitiveActions.actionType,
        initiatedBy: schema.sensitiveActions.initiatedBy,
        requestedAt: schema.sensitiveActions.requestedAt,
        effectiveAt: schema.sensitiveActions.effectiveAt,
      })
      .from(schema.sensitiveActions)
      .where(
        and(
          eq(schema.sensitiveActions.userId, session.userId),
          eq(schema.sensitiveActions.status, 'pending'),
        ),
      )
      .orderBy(schema.sensitiveActions.effectiveAt);
    const enrolledContactCount = await countEnrolledContacts(db, session.userId);
    return {
      state: es?.state ?? null,
      previousState: es?.previousState ?? null,
      nextActionAt: es?.nextActionAt?.toISOString() ?? null,
      snoozeUntil: es?.snoozeUntil?.toISOString() ?? null,
      // The arm prerequisite (audit B2) the UI gates the Arm button on. Owner
      // metadata only (a count of the owner's own contacts) — no contact identity.
      enrolledContactCount,
      // The owner's own check-in cadence, so a settings screen can show what it
      // currently is before offering to change it. Null before the engine row
      // exists (pre-arm), which the UI renders as "not set yet" rather than
      // inventing the default — the default lives in CONFIG, and echoing it here
      // would state a value this account does not actually have.
      inactivityThresholdDays: es?.inactivityThresholdDays ?? null,
      pendingSensitiveActions: pending.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        // 'owner' | 'ai' (Phase 2) — the UI names an AI-initiated action so the
        // owner can veto it during the delay window.
        initiatedBy: a.initiatedBy,
        requestedAt: a.requestedAt.toISOString(),
        effectiveAt: a.effectiveAt.toISOString(),
      })),
    };
  });

  // ── Check-in cadence (change_inactivity_threshold) ────────────────────────
  //
  // How long the owner may be silent before the engine asks. The APPLIER for
  // this has existed in packages/sensitive-actions since the engine was built —
  // it recomputes next_action_at, and it re-checks the AI tighten-only rule at
  // apply time — but nothing could ever REQUEST one: no route referenced
  // `change_inactivity_threshold` anywhere in apps/api. So the most personal
  // setting in a continuity product was one the owner could not reach.
  //
  // Enqueue only. Like every sensitive change it waits the standard delay and is
  // cancellable from the Engine page throughout; the current value stays in
  // effect for the whole window. Nothing here writes engine_states.
  app.post(
    '/v1/engine/cadence',
    {
      preHandler: [requireSession, requireStepUp('change_inactivity_threshold')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['days'],
          // Bounded at the edge as well as in the handler. The floor is 1 because
          // a zero-day threshold would put the account permanently overdue; the
          // ceiling is 365 because beyond a year the engine stops being a
          // continuity mechanism and becomes a reminder nobody will live to see.
          properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
        },
        response: {
          202: {
            type: 'object',
            additionalProperties: false,
            required: ['sensitiveActionId', 'effectiveAt'],
            properties: { sensitiveActionId: { type: 'string' }, effectiveAt: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      const stepUp = request.stepUp;
      if (session === null || stepUp === null || audit === null)
        throw unauthorized('auth backend unavailable');
      const { days } = request.body as { days: number };

      const row = await loadRow(db, session.userId);
      if (row === null) throw new ApiError(409, NO_ENGINE_TYPE, 'engine not armed');
      if (row.inactivityThresholdDays === days) {
        throw conflict('check-in cadence is already set to that many days');
      }

      // A retried submission converges on the existing pending action rather than
      // stacking a second one — the add_contact idempotency idiom. Keyed on the
      // action type alone, because only one cadence change can be in flight.
      const dupRows = await db
        .select({ id: schema.sensitiveActions.id, effectiveAt: schema.sensitiveActions.effectiveAt })
        .from(schema.sensitiveActions)
        .where(
          and(
            eq(schema.sensitiveActions.userId, session.userId),
            eq(schema.sensitiveActions.actionType, 'change_inactivity_threshold'),
            eq(schema.sensitiveActions.status, 'pending'),
          ),
        )
        .limit(1);
      const dup = dupRows[0];
      if (dup !== undefined) {
        void reply.status(202);
        return { sensitiveActionId: dup.id, effectiveAt: dup.effectiveAt.toISOString() };
      }

      const result = await requestSensitiveAction(db, audit, {
        userId: session.userId,
        actionType: 'change_inactivity_threshold',
        payload: { days },
        now: new Date(),
        requestedBySessionId: session.id,
        stepUp: {
          challengeId: stepUp.challengeId,
          signature: Buffer.from(stepUp.signature).toString('base64url'),
        },
      });
      void reply.status(202);
      return { sensitiveActionId: result.id, effectiveAt: result.effectiveAt.toISOString() };
    },
  );

  // ── Release progress (read) — the owner's live view of their ceremonies ────
  // Transparency doubling as a collusion alarm (the docs/10 §5.2 posture: the
  // affected party always sees what is happening to them). If a release episode
  // is a false positive the owner sees exactly who affirmed and how long the
  // windows have left; if contacts are colluding while the owner is alive, this
  // is where it shows. METADATA ONLY, strictly the owner's own rows: status
  // enums, role enums, timestamps, and the contact labels the owner encrypted
  // client-side (opaque to the server — returned for the owner's own device to
  // decrypt). Never key material, signatures, shares, or envelope bytes.
  // Read-only by design: the protective actions remain check-in/cancel-release —
  // this panel must never grow its own lever a session thief could pull.
  app.get('/v1/engine/release-progress', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const ceremonies = await db
      .select({
        id: schema.releaseCeremonies.id,
        tier: schema.releaseCeremonies.tier,
        status: schema.releaseCeremonies.status,
        initiatedAt: schema.releaseCeremonies.initiatedAt,
        syncWindowExpiresAt: schema.releaseCeremonies.syncWindowExpiresAt,
        outerKeyReleasedAt: schema.releaseCeremonies.outerKeyReleasedAt,
        reconstructionStartedAt: schema.releaseCeremonies.reconstructionStartedAt,
        releasedAt: schema.releaseCeremonies.releasedAt,
        cancellationReason: schema.releaseCeremonies.cancellationReason,
        failureReason: schema.releaseCeremonies.failureReason,
      })
      .from(schema.releaseCeremonies)
      .where(eq(schema.releaseCeremonies.userId, session.userId))
      .orderBy(desc(schema.releaseCeremonies.initiatedAt))
      .limit(12);
    if (ceremonies.length === 0) return { ceremonies: [] };
    const ids = ceremonies.map((c) => c.id);
    const affirmations = await db
      .select({
        ceremonyId: schema.ceremonyAffirmations.ceremonyId,
        contactId: schema.ceremonyAffirmations.contactId,
        status: schema.ceremonyAffirmations.status,
        affirmedAt: schema.ceremonyAffirmations.affirmedAt,
        revocationWindowExpiresAt: schema.ceremonyAffirmations.revocationWindowExpiresAt,
        committedAt: schema.ceremonyAffirmations.committedAt,
        revokedAt: schema.ceremonyAffirmations.revokedAt,
        role: schema.contacts.role,
        displayLabelCiphertext: schema.contacts.displayLabelCiphertext,
        contactPinVersion: schema.contacts.contactPinVersion,
        displayLabelNonce: schema.contacts.displayLabelNonce,
      })
      .from(schema.ceremonyAffirmations)
      .innerJoin(schema.contacts, eq(schema.ceremonyAffirmations.contactId, schema.contacts.id))
      .where(inArray(schema.ceremonyAffirmations.ceremonyId, ids));
    const recipients = await db
      .select({
        ceremonyId: schema.ceremonyRecipients.ceremonyId,
        contactId: schema.ceremonyRecipients.recipientContactId,
        status: schema.ceremonyRecipients.status,
        completedAt: schema.ceremonyRecipients.completedAt,
        role: schema.contacts.role,
        displayLabelCiphertext: schema.contacts.displayLabelCiphertext,
        contactPinVersion: schema.contacts.contactPinVersion,
        displayLabelNonce: schema.contacts.displayLabelNonce,
      })
      .from(schema.ceremonyRecipients)
      .innerJoin(schema.contacts, eq(schema.ceremonyRecipients.recipientContactId, schema.contacts.id))
      .where(inArray(schema.ceremonyRecipients.ceremonyId, ids));
    const b64 = (v: Uint8Array): string => Buffer.from(v).toString('base64');
    const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
    return {
      ceremonies: ceremonies.map((c) => {
        const affs = affirmations.filter((a) => a.ceremonyId === c.id);
        return {
          ceremonyId: c.id,
          tier: c.tier,
          status: c.status,
          threshold: TIER_THRESHOLD[c.tier] ?? 1,
          committed: affs.filter((a) => a.status === 'committed').length,
          initiatedAt: c.initiatedAt.toISOString(),
          syncWindowExpiresAt: c.syncWindowExpiresAt.toISOString(),
          outerKeyReleasedAt: iso(c.outerKeyReleasedAt),
          reconstructionStartedAt: iso(c.reconstructionStartedAt),
          releasedAt: iso(c.releasedAt),
          cancellationReason: c.cancellationReason,
          failureReason: c.failureReason,
          affirmations: affs.map((a) => ({
            contactId: a.contactId,
            role: a.role,
            status: a.status,
            affirmedAt: iso(a.affirmedAt),
            revocationWindowExpiresAt: iso(a.revocationWindowExpiresAt),
            committedAt: iso(a.committedAt),
            revokedAt: iso(a.revokedAt),
            displayLabelCiphertext: b64(a.displayLabelCiphertext),
            contactPinVersion: a.contactPinVersion,
            displayLabelNonce: b64(a.displayLabelNonce),
          })),
          recipients: recipients
            .filter((r) => r.ceremonyId === c.id)
            .map((r) => ({
              contactId: r.contactId,
              role: r.role,
              status: r.status,
              completedAt: iso(r.completedAt),
              displayLabelCiphertext: b64(r.displayLabelCiphertext),
              contactPinVersion: r.contactPinVersion,
              displayLabelNonce: b64(r.displayLabelNonce),
            })),
        };
      }),
    };
  });

  // ── Check-in (immediate, session-only, volume-limited) ─────────────────────
  // requireSessionAllowingLocked, not requireSession: a locked account must
  // still be able to say it is alive. See the reasoning on that helper — the
  // lock is set over an unauthenticated route keyed on an email, so gating
  // check-in behind it handed anyone who knew an address a remote lever on the
  // release ladder.
  app.post(
    '/v1/engine/check-in',
    {
      preHandler: [requireSessionAllowingLocked],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { acknowledgedState: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const now = new Date();
      await enforceCheckinVolume(db, session.userId, now);
      const ack = (request.body as { acknowledgedState?: string }).acknowledgedState;

      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const row = await loadRow(tx, session.userId);
        if (!row) throw new ApiError(409, 'Engine not armed', 'no engine state for this account', NO_ENGINE_TYPE);
        if (!CHECKIN_STATES.has(row.state)) {
          if (RELEASE_LADDER.has(row.state)) {
            throw conflict('a release is in progress — use POST /v1/engine/cancel-release');
          }
          // RETURNING pauses a release pending the owner's identity confirmation;
          // point at its door rather than a bare "not valid here" (the state is
          // reached by the owner showing up, so this 409 is one they WILL hit).
          if (row.state === 'returning') {
            throw conflict('confirm your return — use POST /v1/engine/confirm-return');
          }
          throw conflict(`check-in is not valid in state "${row.state}"`);
        }
        // escalation_pending = contacts already notified. Require deliberate
        // dismissal: a daily auto-check-in script won't carry the ack; a UI that
        // showed the user the escalating state will.
        if (row.state === 'escalation_pending' && ack !== 'escalation_pending') {
          throw new ApiError(
            409,
            'Acknowledgment required',
            'the engine is escalating; resend with acknowledgedState="escalation_pending" to confirm you saw it',
            ACK_REQUIRED_TYPE,
          );
        }
        const ctx: ApplyContext = { db: tx, audit, channels, now };
        await applyEvent(row, { kind: 'user_confirms_active' }, ctx);
        return engineSnapshot(tx, session.userId);
      });
    },
  );

  // ── Arm the engine (explicit owner action, session-only) ───────────────────
  // docs/01: the owner confirms continuity monitoring should run. This is the
  // only path out of pre_active — the documented `engine_armed` transition
  // (docs/02). A freshly enrolled account has no engine_states row yet, so create
  // it pre_active first, then arm. Idempotent: arming an already-running engine
  // just returns the current snapshot. Low-risk + reversible (a check-in resets
  // the clock), so session-only like check-in — no step-up.
  app.post('/v1/engine/arm', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    const audit = app.audit;
    if (session === null || audit === null) throw unauthorized('auth backend unavailable');
    const now = new Date();
    return db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      let row = await loadRow(tx, session.userId);
      // Enforce the documented prerequisite (audit B2): the owner must have at
      // least one ENROLLED contact before arming. A contactless engine is fail-
      // closed but useless — release_review never reaches consensus, so the
      // engine could never actually hand the vault over, while the
      // owner believes they're protected. Gate only the real arm transition (no
      // row yet, or pre_active); an idempotent re-arm of an already-running
      // engine must not be blocked by a contact removed afterwards.
      if ((!row || row.state === 'pre_active') && (await countEnrolledContacts(tx, session.userId)) === 0) {
        throw new ApiError(
          409,
          'No enrolled contact',
          'enrol at least one trusted contact before arming — a release needs someone to hand your vault to',
          ARM_PREREQ_TYPE,
        );
      }
      if (!row) {
        await tx
          .insert(schema.engineStates)
          .values({ userId: session.userId, state: 'pre_active', stateEnteredAt: now, updatedAt: now })
          .onConflictDoNothing();
        row = await loadRow(tx, session.userId);
      }
      if (row && row.state === 'pre_active') {
        const ctx: ApplyContext = { db: tx, audit, channels, now };
        await applyEvent(row, { kind: 'engine_armed' }, ctx);
        await tx
          .update(schema.users)
          .set({ armedAt: now, updatedAt: now })
          .where(eq(schema.users.id, session.userId));
      }
      return engineSnapshot(tx, session.userId);
    });
  });

  // ── Snooze (immediate, session-only) ───────────────────────────────────────
  app.post(
    '/v1/engine/snooze',
    {
      preHandler: [requireSession],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['snoozeDays'],
          properties: { snoozeDays: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { snoozeDays } = request.body as { snoozeDays: number };
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const row = await loadRow(tx, session.userId);
        if (!row) throw new ApiError(409, 'Engine not armed', 'no engine state for this account', NO_ENGINE_TYPE);
        if (row.state !== 'check_in_pending') {
          throw conflict('snooze is only valid while a check-in is pending');
        }
        const ctx: ApplyContext = { db: tx, audit, channels, now };
        const result = await applyEvent(row, { kind: 'user_snoozes', snoozeDays }, ctx);
        if (result.kind !== 'transition') {
          throw conflict(`snoozeDays must be between 1 and the inactivity threshold (${row.inactivityThresholdDays})`);
        }
        return engineSnapshot(tx, session.userId);
      });
    },
  );

  // ── Cancel-release (immediate, fresh second factor) ────────────────────────
  // The threat-5.5 "I'm alive, stop the release" path. One tap (fresh second
  // factor), straight to active — NOT via returning (that's the passive
  // vault-access path). full_release is excluded (the engine can't un-release).
  app.post(
    '/v1/engine/cancel-release',
    { preHandler: [requireSession, requireFreshSecondFactor] },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const row = await loadRow(tx, session.userId);
        if (!row) throw new ApiError(409, 'Engine not armed', 'no engine state for this account', NO_ENGINE_TYPE);
        if (!RELEASE_LADDER.has(row.state)) {
          throw conflict(`no release in progress to cancel (state "${row.state}")`);
        }
        const ctx: ApplyContext = { db: tx, audit, channels, now };
        await applyEvent(row, { kind: 'user_confirms_active' }, ctx);
        // Abandon-on-cancel (Bridge 1): a release the owner stops must take its
        // ceremony down too — cancelled + currentCeremonyId cleared, atomically.
        await cancelCeremoniesForUser(tx, audit, session.userId, 'user_returned', now);
        return { state: 'active' };
      });
    },
  );

  // ── Resolve a review hold (immediate, fresh second factor) ─────────────────
  // REVIEW_REQUIRED used to be an owner dead end (QA 2026-07-21 #3): a failed
  // ceremony parked the engine there and the page offered nothing. The owner —
  // with a FRESH second factor, the same protective lane as cancel-release, so
  // a bare stolen cookie still can't clear a review — resolves it back to
  // ACTIVE. Protective direction only: the ceremony that raised the review
  // stays terminal; nothing about this advances a release.
  app.post(
    '/v1/engine/resolve-review',
    { preHandler: [requireSession, requireFreshSecondFactor] },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const row = await loadRow(tx, session.userId);
        if (!row) throw new ApiError(409, 'Engine not armed', 'no engine state for this account', NO_ENGINE_TYPE);
        if (row.state !== 'review_required') {
          throw conflict(`no review to resolve (state "${row.state}")`);
        }
        const ctx: ApplyContext = { db: tx, audit, channels, now };
        await applyEvent(row, { kind: 'owner_resolves_review' }, ctx);
        return { state: 'active' };
      });
    },
  );

  // ── Confirm a return (immediate, fresh second factor) ──────────────────────
  // RETURNING was the LAST owner dead end, and the worst-placed one: the state
  // is entered by the owner reading their own vault during a release
  // (user_authenticated_during_release), so the very act of showing up locked
  // them out of every exit — check-in refuses the state, cancel-release sees no
  // ladder state to cancel, and after the 7-day grace the engine RESUMED the
  // release at previousState. docs/02 §9 specifies "user confirms with
  // passphrase → ACTIVE (full revert)" and lists RETURNING among the one-tap
  // cancel paths; the engine event existed but nothing ever emitted it.
  // Gated exactly like cancel-release / resolve-review: a fresh second factor,
  // so a bare stolen cookie can't clear it, but never the full step-up lane —
  // cancellation must stay EASIER than progression (docs/02 asymmetry).
  app.post(
    '/v1/engine/confirm-return',
    { preHandler: [requireSession, requireFreshSecondFactor] },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const row = await loadRow(tx, session.userId);
        if (!row) throw new ApiError(409, 'Engine not armed', 'no engine state for this account', NO_ENGINE_TYPE);
        if (row.state !== 'returning') {
          throw conflict(`no return to confirm (state "${row.state}")`);
        }
        const ctx: ApplyContext = { db: tx, audit, channels, now };
        await applyEvent(row, { kind: 'user_passphrase_confirm_return' }, ctx);
        // A confirmed return is the owner saying "I'm here" — the release that
        // prompted it must come down with it, exactly as cancel-release does.
        await cancelCeremoniesForUser(tx, audit, session.userId, 'user_returned', now);
        return { state: 'active' };
      });
    },
  );

  // ── Cancel a pending sensitive action (immediate, session-only) ────────────
  // The cancel-from-any-device path for a queued rotation/delete. Ownership is
  // verified before cancelling (a user can only cancel their own actions).
  app.post(
    '/v1/account/sensitive-actions/cancel',
    {
      preHandler: [requireSession],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sensitiveActionId'],
          properties: {
            sensitiveActionId: {
              type: 'string',
              pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { sensitiveActionId } = request.body as { sensitiveActionId: string };
      const [action] = await db
        .select({ userId: schema.sensitiveActions.userId, status: schema.sensitiveActions.status })
        .from(schema.sensitiveActions)
        .where(eq(schema.sensitiveActions.id, sensitiveActionId))
        .limit(1);
      if (!action || action.userId !== session.userId) throw notFound('pending action not found');
      const ok = await cancelSensitiveAction(db, audit, {
        sensitiveActionId,
        via: 'user',
        reason: 'user_cancelled',
        now: new Date(),
      });
      if (!ok) throw conflict('action is no longer pending');
      return { cancelled: true };
    },
  );
}

// The arm prerequisite (audit B2) and the status hint: how many of the owner's
// contacts have completed key enrolment — status enrolled/active, not removed.
// Same "usable contact" predicate the share-assignment and beneficiary gates use.
async function countEnrolledContacts(db: Database, userId: UserId): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.ownerUserId, userId),
        isNull(schema.contacts.removedAt),
        inArray(schema.contacts.status, ['enrolled', 'active']),
      ),
    );
  return row?.n ?? 0;
}

// The post-transition snapshot for a response (loadRow's narrow view omits
// next_action_at, so read the table directly).
async function engineSnapshot(
  db: Database,
  userId: UserId,
): Promise<{ state: EngineState | 'active'; nextActionAt: string | null }> {
  const [row] = await db
    .select({ state: schema.engineStates.state, nextActionAt: schema.engineStates.nextActionAt })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);
  return { state: row?.state ?? 'active', nextActionAt: row?.nextActionAt?.toISOString() ?? null };
}

async function enforceCheckinVolume(db: Database, userId: UserId, now: Date): Promise<void> {
  const since = new Date(now.getTime() - CHECKIN_WINDOW_MS);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.authAttempts)
    .where(
      and(
        eq(schema.authAttempts.scope, 'engine.checkin'),
        eq(schema.authAttempts.identifier, userId),
        gte(schema.authAttempts.attemptedAt, since),
      ),
    );
  if ((row?.n ?? 0) >= CHECKIN_MAX_PER_WINDOW) {
    throw tooManyRequests(Math.ceil(CHECKIN_WINDOW_MS / 1000), 'check-in rate limit exceeded');
  }
  await db
    .insert(schema.authAttempts)
    .values({ scope: 'engine.checkin', identifier: userId, succeeded: true, attemptedAt: now });
}
