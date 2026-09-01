import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { channelDestinationHash, schema, type Database } from '@truecairn/db';
import { isChannelEnabled } from '@truecairn/notifications';
import { requestSensitiveAction } from '@truecairn/sensitive-actions';
import {
  CV_PURPOSE_CLASSES,
  type CvPurposeClass,
  type NotificationChannelType,
} from '@truecairn/shared';
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { requireStepUp } from '../auth/stepup.js';
import { configuredChannelTypes } from '../ops/notification-config.js';
import {
  enrollableChannelTypes,
  getEntitlement,
  PRO_CHANNEL_TYPES,
  WITHDRAWN_CHANNEL_TYPES,
} from '../billing/entitlement.js';
import type { ApiConfig } from '../config.js';
import {
  ApiError,
  badRequest,
  conflict,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../errors.js';

const UPGRADE_REQUIRED_TYPE = 'https://truecairn.app/problems/upgrade-required';
const CHANNEL_WITHDRAWN_TYPE = 'https://truecairn.app/problems/channel-type-withdrawn';

// Channel enrolment (Continuity Verification CV-0.0/CV-2/CV-3, docs/26).
// Owners add their own notification channels and prove possession with a code
// round-trip: the code goes OUT through the very channel being verified (that
// is the point), is hashed at rest, expires, and is attempt-bounded. Only
// verified channels are ever selected for notices — pickPrimaryChannel, the
// security-alert fanout, and the CV cadence all filter on verified — so this
// route family is the single door into that invariant.
//
// The round-trip is channel-agnostic: email carries the code in the body,
// SMS/WhatsApp in the message text, push in the notification — the owner
// types it back in the app either way. A type whose adapter isn't configured
// simply never receives its code (the delivery dead-letters honestly), so an
// unconfigured deployment cannot mint verified channels of that type.

const ENROLLABLE_TYPES: ReadonlySet<NotificationChannelType> = new Set([
  'email',
  'sms',
  'whatsapp',
  'push',
]);
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_CHANNELS_PER_USER = 10;
// Volume limit on code issuance (add + re-request share it): a runaway client
// or an abuser probing destinations is capped per user per hour.
const ISSUE_WINDOW_MS = 60 * 60 * 1000;
const ISSUE_MAX_PER_WINDOW = 6;

const VERIFICATION_EXPIRED_TYPE = 'https://truecairn.app/problems/channel-verification-expired';
// A verified channel can only be removed through the sensitive-actions lane —
// the stable type lets the client route the user to the step-up flow.
const CHANNEL_REMOVAL_STEPUP_TYPE =
  'https://truecairn.app/problems/channel-removal-requires-stepup';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Transport sanity only (the round-trip is the real validation): something@something.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164 for sms/whatsapp (after stripping spaces/dashes/parens).
const E164_RE = /^\+[1-9]\d{6,14}$/;

// Normalize + validate a destination per channel type. Returns null when the
// destination cannot be a valid address of that type. Push destinations are
// the browser's PushSubscription JSON, re-serialized canonically so the
// per-user uniqueness hash is stable across key orderings.
function normalizeDestination(
  channelType: NotificationChannelType,
  rawDestination: string,
): string | null {
  const trimmed = rawDestination.trim();
  if (channelType === 'email') {
    const email = trimmed.toLowerCase();
    return EMAIL_RE.test(email) ? email : null;
  }
  if (channelType === 'sms' || channelType === 'whatsapp') {
    const phone = trimmed.replace(/[\s\-().]/g, '');
    return E164_RE.test(phone) ? phone : null;
  }
  if (channelType === 'push') {
    try {
      const sub = JSON.parse(trimmed) as {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
      };
      if (
        typeof sub.endpoint !== 'string' ||
        !sub.endpoint.startsWith('https://') ||
        typeof sub.keys?.p256dh !== 'string' ||
        sub.keys.p256dh === '' ||
        typeof sub.keys.auth !== 'string' ||
        sub.keys.auth === ''
      ) {
        return null;
      }
      return JSON.stringify({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
    } catch {
      return null;
    }
  }
  return null;
}

export function channelRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const welcomeEmailEnabled = config.welcomeEmailEnabled;
  // ── List: the owner's channels ──────────────────────────────────────────────
  app.get('/v1/settings/channels', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const now = new Date();
    const entitlement = await getEntitlement(db, session.userId, now);
    const rows = await db
      .select({
        id: schema.notificationChannels.id,
        channelType: schema.notificationChannels.channelType,
        destination: schema.notificationChannels.destination,
        verified: schema.notificationChannels.verified,
        health: schema.notificationChannels.health,
        createdAt: schema.notificationChannels.createdAt,
        verificationExpiresAt: schema.notificationChannels.verificationExpiresAt,
      })
      .from(schema.notificationChannels)
      .where(
        and(
          eq(schema.notificationChannels.userId, session.userId),
          isNull(schema.notificationChannels.removedAt),
        ),
      )
      .orderBy(schema.notificationChannels.createdAt);
    return {
      channels: rows.map((r) => ({
        id: r.id,
        channelType: r.channelType,
        destination: r.destination,
        verified: r.verified,
        health: r.health,
        createdAt: r.createdAt.toISOString(),
        // A code is out and still enterable — the UI shows the code input.
        pendingVerification:
          !r.verified && r.verificationExpiresAt !== null && r.verificationExpiresAt > now,
      })),
      // The VAPID public key (public by definition) — the SPA needs it to
      // subscribe this browser for web push. null hides the push UI.
      pushPublicKey: config.vapidPublicKey ?? null,
      // The caller's plan + the channel types they may enrol, so the picker
      // renders only what they can add (paid channels are pro-gated, docs/28).
      plan: entitlement.plan,
      // Intersected with what this deployment can actually deliver, so a paid
      // plan on a box with no TWILIO_* never offers a channel whose verification
      // code would dead-letter (2026-08-31).
      enrollableChannelTypes: enrollableChannelTypes(entitlement.plan, configuredChannelTypes()),
    };
  });

  // ── Add (or re-request a code for) a channel ────────────────────────────────
  // Idempotent on destination: a brand-new destination inserts (201); an
  // existing unverified or previously removed one is revived/re-issued (200).
  // An already-verified live channel is a 409 — nothing to verify.
  app.post(
    '/v1/settings/channels',
    {
      preHandler: [requireSession],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channelType', 'destination'],
          properties: {
            channelType: { type: 'string', enum: ['email', 'sms', 'whatsapp', 'push'] },
            // 2048 accommodates a push subscription JSON; per-type validation
            // below is the real gate.
            destination: { type: 'string', minLength: 3, maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as { channelType: NotificationChannelType; destination: string };
      if (!ENROLLABLE_TYPES.has(body.channelType)) {
        throw badRequest(`channel type "${body.channelType}" cannot be enrolled yet`);
      }
      // Withdrawn types are refused before the plan check, because no plan buys
      // them: the type is unavailable to everyone pending an external unblock
      // (WITHDRAWN_CHANNEL_TYPES in billing/entitlement.ts explains which and
      // why). Checked ahead of the 402 so a paying user is never told to upgrade
      // for something upgrading cannot deliver. The picker already hides these —
      // this is the enforcing backstop, same shape as the plan gate below.
      if (WITHDRAWN_CHANNEL_TYPES.has(body.channelType)) {
        throw new ApiError(
          409,
          'Channel type unavailable',
          `${body.channelType} channels cannot be added right now — enrolment needs a provider approval we do not have yet. Existing verified channels are unaffected.`,
          CHANNEL_WITHDRAWN_TYPE,
        );
      }
      // Paid channels (SMS) are gated to pro — the channels that cost per
      // message require an active plan (docs/28). The Settings picker hides
      // them for free users; this is the enforcing backstop (402, stable type).
      if (PRO_CHANNEL_TYPES.has(body.channelType)) {
        const ent = await getEntitlement(db, session.userId, new Date());
        if (ent.plan !== 'pro') {
          throw new ApiError(
            402,
            'Upgrade Required',
            `${body.channelType} channels are available on the Pro plan`,
            UPGRADE_REQUIRED_TYPE,
          );
        }
      }
      const destination = normalizeDestination(body.channelType, body.destination);
      if (destination === null) {
        throw badRequest(`destination is not a valid ${body.channelType} address`);
      }
      const destinationHash = channelDestinationHash(body.channelType, destination);
      const now = new Date();
      await enforceIssueVolume(db, session.userId, now);

      const code = generateCode();
      const result = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const existing = await tx
          .select()
          .from(schema.notificationChannels)
          .where(
            and(
              eq(schema.notificationChannels.userId, session.userId),
              eq(schema.notificationChannels.channelType, body.channelType),
              eq(schema.notificationChannels.destinationHash, destinationHash),
            ),
          )
          .for('update');
        const row = existing[0];
        if (row !== undefined && row.removedAt === null && row.verified) {
          throw conflict('this channel is already enrolled and verified');
        }

        let channelId: string;
        let created = false;
        if (row === undefined) {
          const [liveCount] = await tx
            .select({ n: count() })
            .from(schema.notificationChannels)
            .where(
              and(
                eq(schema.notificationChannels.userId, session.userId),
                isNull(schema.notificationChannels.removedAt),
              ),
            );
          if ((liveCount?.n ?? 0) >= MAX_CHANNELS_PER_USER) {
            throw conflict(`channel limit reached (${MAX_CHANNELS_PER_USER})`);
          }
          const [inserted] = await tx
            .insert(schema.notificationChannels)
            .values({
              userId: session.userId,
              channelType: body.channelType,
              destination,
              destinationHash,
              verified: false,
              verificationCodeHash: hashCode(code),
              verificationExpiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
              verificationAttempts: 0,
            })
            .returning({ id: schema.notificationChannels.id });
          channelId = inserted!.id;
          created = true;
          await audit.append(tx, session.userId, 'notification_channel.added', {
            channelId,
            channelType: body.channelType,
          });
        } else {
          // Revive a removed row / re-issue for an unverified one. Never carry
          // stale trust: verified resets false, health resets, attempts reset.
          channelId = row.id;
          await tx
            .update(schema.notificationChannels)
            .set({
              removedAt: null,
              verified: false,
              verifiedAt: null,
              health: 'healthy',
              consecutiveFailures: 0,
              verificationCodeHash: hashCode(code),
              verificationExpiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
              verificationAttempts: 0,
            })
            .where(eq(schema.notificationChannels.id, row.id));
          if (row.removedAt !== null) {
            await audit.append(tx, session.userId, 'notification_channel.added', {
              channelId,
              channelType: body.channelType,
              revived: true,
            });
          }
        }

        // The code goes out through the channel being verified — the one
        // delivery legitimately addressed to an unverified channel.
        await tx.insert(schema.notificationDeliveries).values({
          channelId,
          userId: session.userId,
          purpose: 'channel_verification',
          status: 'queued',
          nextAttemptAt: now,
          payloadSummary: 'channel verification code',
          payloadParams: { code },
        });
        return { channelId, created };
      });

      void reply.status(result.created ? 201 : 200);
      return {
        id: result.channelId,
        channelType: body.channelType,
        destination,
        verified: false,
      };
    },
  );

  // ── Verify: the code round-trip ─────────────────────────────────────────────
  app.post(
    '/v1/settings/channels/:id/verify',
    {
      preHandler: [requireSession],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code'],
          properties: { code: { type: 'string', minLength: 4, maxLength: 16 } },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) throw notFound('channel not found');
      const code = (request.body as { code: string }).code.trim();
      const now = new Date();

      // The transaction returns an outcome and the throw happens OUTSIDE it:
      // throwing inside would roll back the attempt increment / code burn, and
      // a guesser must consume attempts on every failure, not reset them.
      type Outcome = 'ok' | 'already' | 'not_found' | 'expired' | 'exhausted' | 'mismatch';
      const outcome = await db.transaction(async (txRaw): Promise<Outcome> => {
        const tx = txRaw as unknown as Database;
        const [row] = await tx
          .select()
          .from(schema.notificationChannels)
          .where(
            and(
              eq(schema.notificationChannels.id, id),
              eq(schema.notificationChannels.userId, session.userId),
              isNull(schema.notificationChannels.removedAt),
            ),
          )
          .for('update');
        if (row === undefined) return 'not_found';
        if (row.verified) return 'already';
        if (
          row.verificationCodeHash === null ||
          row.verificationExpiresAt === null ||
          row.verificationExpiresAt <= now
        ) {
          return 'expired';
        }
        if (row.verificationAttempts >= MAX_VERIFY_ATTEMPTS) {
          // Exhausted: burn the code so further guessing is pointless; the
          // owner re-requests via POST /v1/settings/channels.
          await tx
            .update(schema.notificationChannels)
            .set({ verificationCodeHash: null, verificationExpiresAt: null })
            .where(eq(schema.notificationChannels.id, row.id));
          return 'exhausted';
        }
        await tx
          .update(schema.notificationChannels)
          .set({ verificationAttempts: row.verificationAttempts + 1 })
          .where(eq(schema.notificationChannels.id, row.id));
        if (!codeMatches(code, row.verificationCodeHash)) return 'mismatch';
        await tx
          .update(schema.notificationChannels)
          .set({
            verified: true,
            verifiedAt: now,
            verificationCodeHash: null,
            verificationExpiresAt: null,
            verificationAttempts: 0,
          })
          .where(eq(schema.notificationChannels.id, row.id));
        await audit.append(tx, session.userId, 'notification_channel.verified', {
          channelId: row.id,
          channelType: row.channelType,
        });
        // Onboarding welcome (CV-brand pass): exactly-once, on the FIRST verified
        // EMAIL channel. Gated on users.welcome_email_sent_at (locked + set in
        // this same tx) so a second verified email, or a retry, never re-sends;
        // sms/whatsapp/push verifications never trigger it. Enqueued to the
        // just-verified channel through the normal pipeline.
        if (row.channelType === 'email' && welcomeEmailEnabled) {
          const [u] = await tx
            .select({ sentAt: schema.users.welcomeEmailSentAt })
            .from(schema.users)
            .where(eq(schema.users.id, session.userId))
            .for('update');
          if (u !== undefined && u.sentAt === null) {
            await tx
              .update(schema.users)
              .set({ welcomeEmailSentAt: now })
              .where(eq(schema.users.id, session.userId));
            await tx.insert(schema.notificationDeliveries).values({
              channelId: row.id,
              userId: session.userId,
              purpose: 'welcome',
              status: 'queued',
              nextAttemptAt: now,
              payloadSummary: 'welcome',
            });
          }
        }
        return 'ok';
      });

      switch (outcome) {
        case 'ok':
        case 'already':
          return { id, verified: true };
        case 'not_found':
          throw notFound('channel not found');
        case 'expired':
          throw new ApiErrorExpired();
        case 'exhausted':
          throw new ApiErrorExpired('too many attempts — request a new code');
        case 'mismatch':
          throw badRequest('incorrect verification code');
      }
    },
  );

  // ── Remove, UNVERIFIED channels only (soft — the delivery history keeps its
  // FK). A verified channel is a live continuity guard: removing one goes
  // through the sensitive-actions lane below (step-up + cooldown, docs/26 §4),
  // so a stolen session can never instantly silence check-in reminders. An
  // unverified channel is never selected for notices — removing a typo'd
  // destination stays a one-click cleanup.
  app.delete(
    '/v1/settings/channels/:id',
    { preHandler: [requireSession] },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) throw notFound('channel not found');
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const rows = await tx
          .select({
            id: schema.notificationChannels.id,
            channelType: schema.notificationChannels.channelType,
            verified: schema.notificationChannels.verified,
          })
          .from(schema.notificationChannels)
          .where(
            and(
              eq(schema.notificationChannels.id, id),
              eq(schema.notificationChannels.userId, session.userId),
              isNull(schema.notificationChannels.removedAt),
            ),
          )
          .for('update');
        const row = rows[0];
        if (row === undefined) throw notFound('channel not found');
        if (row.verified) {
          throw new ApiError(
            409,
            'Step-Up Required For Verified Channel',
            'removing a verified channel is a sensitive action — use POST /v1/settings/channels/remove',
            CHANNEL_REMOVAL_STEPUP_TYPE,
          );
        }
        await tx
          .update(schema.notificationChannels)
          .set({ removedAt: now, verificationCodeHash: null, verificationExpiresAt: null })
          .where(eq(schema.notificationChannels.id, row.id));
        await audit.append(tx, session.userId, 'notification_channel.removed', {
          channelId: row.id,
          channelType: row.channelType,
        });
        return { removed: true };
      });
    },
  );

  // ── Remove a VERIFIED channel (remove_channel — step-up + cooldown) ─────────
  // The same lane as every other change that could weaken the owner's safety
  // net: fresh second factor + passphrase signature over this exact body, then
  // the delay during which the action is cancellable from the Engine page and
  // every channel — including the one being removed — carries the notice
  // (docs/10-threat-5.2). channelId lives in the BODY so the signature binds it.
  app.post(
    '/v1/settings/channels/remove',
    {
      preHandler: [requireSession, requireStepUp('remove_channel')],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channelId'],
          properties: {
            channelId: {
              type: 'string',
              pattern:
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            },
          },
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
      const { channelId } = request.body as { channelId: string };

      const rows = await db
        .select({ id: schema.notificationChannels.id })
        .from(schema.notificationChannels)
        .where(
          and(
            eq(schema.notificationChannels.id, channelId),
            eq(schema.notificationChannels.userId, session.userId),
            isNull(schema.notificationChannels.removedAt),
          ),
        )
        .limit(1);
      if (rows[0] === undefined) throw notFound('channel not found');

      // A retried submission converges on the EXISTING pending action (the
      // add_contact idempotency idiom, QA Pass 2 Finding B) — duplicates would
      // read as phantom pending work and double-apply harmlessly but noisily.
      const dupRows = await db
        .select({ id: schema.sensitiveActions.id, effectiveAt: schema.sensitiveActions.effectiveAt })
        .from(schema.sensitiveActions)
        .where(
          and(
            eq(schema.sensitiveActions.userId, session.userId),
            eq(schema.sensitiveActions.actionType, 'remove_channel'),
            eq(schema.sensitiveActions.status, 'pending'),
            sql`${schema.sensitiveActions.actionPayload} ->> 'channelId' = ${channelId}`,
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
        actionType: 'remove_channel',
        payload: { channelId },
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

  // ── Channel matrix (docs/26 §3.1): which channel serves which purpose class ─
  // GET returns the EFFECTIVE matrix for every live channel (absent preference
  // = enabled — the default that preserves today's behaviour). PUT flips one
  // cell. The matrix can only narrow selection; verified-and-live filtering
  // happens before it everywhere.
  app.get(
    '/v1/settings/channels/preferences',
    { preHandler: [requireSession] },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const channels = await db
        .select({
          id: schema.notificationChannels.id,
          channelType: schema.notificationChannels.channelType,
          destination: schema.notificationChannels.destination,
          verified: schema.notificationChannels.verified,
        })
        .from(schema.notificationChannels)
        .where(
          and(
            eq(schema.notificationChannels.userId, session.userId),
            isNull(schema.notificationChannels.removedAt),
          ),
        )
        .orderBy(schema.notificationChannels.createdAt);
      const preferences = await db
        .select({
          channelId: schema.channelPreferences.channelId,
          purposeClass: schema.channelPreferences.purposeClass,
          enabled: schema.channelPreferences.enabled,
        })
        .from(schema.channelPreferences)
        .where(eq(schema.channelPreferences.userId, session.userId));
      return {
        channels: channels.map((ch) => ({
          id: ch.id,
          channelType: ch.channelType,
          destination: ch.destination,
          verified: ch.verified,
          classes: Object.fromEntries(
            CV_PURPOSE_CLASSES.map((pc) => [pc, isChannelEnabled(preferences, ch.id, pc)]),
          ),
        })),
      };
    },
  );

  app.put(
    '/v1/settings/channels/preferences',
    {
      preHandler: [requireSession],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channelId', 'purposeClass', 'enabled'],
          properties: {
            channelId: { type: 'string', minLength: 36, maxLength: 36 },
            purposeClass: { type: 'string', enum: [...CV_PURPOSE_CLASSES] },
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      const body = request.body as {
        channelId: string;
        purposeClass: CvPurposeClass;
        enabled: boolean;
      };
      if (!UUID_RE.test(body.channelId)) throw notFound('channel not found');
      const now = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [ch] = await tx
          .select({ id: schema.notificationChannels.id })
          .from(schema.notificationChannels)
          .where(
            and(
              eq(schema.notificationChannels.id, body.channelId),
              eq(schema.notificationChannels.userId, session.userId),
              isNull(schema.notificationChannels.removedAt),
            ),
          );
        if (ch === undefined) throw notFound('channel not found');
        await tx
          .insert(schema.channelPreferences)
          .values({
            userId: session.userId,
            channelId: body.channelId,
            purposeClass: body.purposeClass,
            enabled: body.enabled,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.channelPreferences.channelId, schema.channelPreferences.purposeClass],
            set: { enabled: body.enabled, updatedAt: now },
          });
        await audit.append(tx, session.userId, 'notification_channel.preference_set', {
          channelId: body.channelId,
          purposeClass: body.purposeClass,
          enabled: body.enabled,
        });
        return { channelId: body.channelId, purposeClass: body.purposeClass, enabled: body.enabled };
      });
    },
  );

  async function enforceIssueVolume(dbx: Database, userId: string, now: Date): Promise<void> {
    const since = new Date(now.getTime() - ISSUE_WINDOW_MS);
    const [row] = await dbx
      .select({ n: count() })
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.userId, userId),
          eq(schema.notificationDeliveries.purpose, 'channel_verification'),
          gte(schema.notificationDeliveries.createdAt, since),
        ),
      );
    if ((row?.n ?? 0) >= ISSUE_MAX_PER_WINDOW) {
      throw tooManyRequests(
        Math.ceil(ISSUE_WINDOW_MS / 1000),
        'too many verification codes requested — try again later',
      );
    }
  }
}

// 400 with a stable problem type so the client can distinguish "code expired /
// exhausted, request a new one" from a plain wrong-code 400.
class ApiErrorExpired extends ApiError {
  constructor(detail = 'the verification code has expired — request a new one') {
    super(400, 'Verification Code Expired', detail, VERIFICATION_EXPIRED_TYPE);
  }
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(code, 'utf8').digest());
}

function codeMatches(code: string, storedHash: Uint8Array): boolean {
  const candidate = hashCode(code);
  if (candidate.length !== storedHash.length) return false;
  return timingSafeEqual(candidate, storedHash);
}

// hashDestination moved to @truecairn/db as channelDestinationHash — it is the
// counterpart of a CHECK constraint (migration 0063), so it belongs beside the
// column it validates rather than private to one route. Every writer, including
// test fixtures, now derives it the same way; before, none of the fixtures did.
