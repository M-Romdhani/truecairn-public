import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { AuditLogWriter, resolveServerSigner, type AuditKeyLineage } from '@truecairn/audit';
import type { ContinuityReportPort } from '@truecairn/ceremony';
import { initCrypto } from '@truecairn/crypto';
import { createClient, type Database } from '@truecairn/db';
import { type AuditLogPort, DbChannelLookup } from '@truecairn/engine';
import {
  buildContinuityReport,
  ResendEmailAdapter,
  TwilioMessagingAdapter,
  WebPushAdapter,
  WhatsappCloudAdapter,
  type NotificationProvider,
} from '@truecairn/notifications';
import type { NotificationChannelType, UserId } from '@truecairn/shared';
import {
  createBlobStore,
  EnvKekProvider,
  GcpKmsClient,
  KmsKekProvider,
  resolveOuterLayerKekSet,
  type KekProvider,
} from '@truecairn/vault';
import { LoggingAuditPort } from './audit-stub.js';
import { loadGuardianConfig } from './guardian/config.js';
import { runLoop } from './loop.js';
import { log } from './log.js';

async function main(): Promise<void> {
  // libsodium loads asynchronously. The set_vault_item_tier handler re-wraps the
  // outer layer through @truecairn/crypto, so libsodium MUST be ready before the
  // loop applies actions — otherwise every tier-move throws "initCrypto() must be
  // awaited before calling crypto operations", fails, and retries forever (the
  // 2026-07-18 production stall: three tier-moves failing every tick, invisibly).
  // The API inits the same way in app.ts's onReady hook; the worker had no equivalent.
  await initCrypto();

  const url = process.env['DATABASE_URL'];
  if (!url) {
    log.error('worker.missing_env', { var: 'DATABASE_URL' });
    process.exit(1);
  }
  const pollIntervalMs = parseIntEnv('WORKER_POLL_INTERVAL_MS', 10_000);
  const batchSize = parseIntEnv('WORKER_BATCH_SIZE', 50);
  // Audit-chain verification cadence; 0 disables the sweep entirely.
  const auditVerifyIntervalMs = parseIntEnv('AUDIT_VERIFY_INTERVAL_MS', 60 * 60 * 1000);

  const { db, sql } = createClient({ url });
  const auditMode = (process.env['AUDIT_MODE'] ?? 'signed').toLowerCase();
  let audit: AuditLogPort;
  // Carried to the status sampler so the worker's published health reports the
  // same audit-key lineage the API's dashboard does (F-5).
  let auditKeyLineage: AuditKeyLineage | undefined;
  if (auditMode === 'log') {
    audit = new LoggingAuditPort();
    log.warn('worker.audit_logging_only', { reason: 'AUDIT_MODE=log' });
  } else {
    const signer = await resolveServerSigner(db);
    audit = new AuditLogWriter(signer);
    auditKeyLineage = signer.lineage;
    log.info('worker.audit_signer_loaded', {
      keyId: signer.keyId,
      lineage: signer.lineage?.kind ?? 'unknown',
    });
  }
  const channels = new DbChannelLookup(db);
  // The set_vault_item_tier handler re-wraps content under the destination tier's
  // outer key, so the worker needs the SAME outer-layer KEK the API stores under —
  // env-backed (OUTER_LAYER_KEK) or HSM-backed (GCP Cloud KMS), selected the same
  // way as the API config. Unusable ⇒ tier-moves fail + retry (never a wrong key).
  const outerLayerKeks: KekProvider = resolveWorkerOuterKekProvider();
  // The purge_attachment + delete_account handlers delete blobs through this store
  // (local disk or S3); its backend/credentials must match the API's.
  const blobStore = createBlobStore(process.env);
  // Notification provider registry (CV-2/CV-3 adapters join email here). A
  // type with no configured adapter dead-letters honestly
  // (no_provider_configured) rather than silently succeeding and masking the
  // threat-5.3 channel-health signal — and, downstream, an unconfigured type
  // can never mint verified channels (its verification code never sends).
  const notificationProviders = new Map<NotificationChannelType, NotificationProvider>();
  const resendKey = process.env['RESEND_API_KEY'];
  const from = process.env['NOTIFICATIONS_FROM'];
  if (resendKey && from) {
    notificationProviders.set('email', new ResendEmailAdapter(resendKey, from));
  } else {
    log.warn('worker.no_email_provider', { effect: 'email deliveries will dead-letter until RESEND_API_KEY + NOTIFICATIONS_FROM are set' });
  }
  // Twilio — SMS ONLY. Its adapter still carries a WhatsApp branch (kept, with
  // its tests, so the move is reversible), but nothing constructs it for
  // 'whatsapp' any more: see the Cloud API block below for why the two channels
  // must not share a vendor. StatusCallback points delivered/undelivered at our
  // twilio webhook when the public URL is known.
  const twilioSid = process.env['TWILIO_ACCOUNT_SID'];
  const twilioToken = process.env['TWILIO_AUTH_TOKEN'];
  const publicBaseUrl = process.env['PUBLIC_BASE_URL'];
  const statusCallbackUrl = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/$/, '')}/v1/notifications/webhook/twilio`
    : undefined;
  const twilioSmsFrom = process.env['TWILIO_SMS_FROM'];
  if (twilioSid && twilioToken && twilioSmsFrom) {
    notificationProviders.set(
      'sms',
      new TwilioMessagingAdapter({
        channelType: 'sms',
        accountSid: twilioSid,
        authToken: twilioToken,
        from: twilioSmsFrom,
        ...(statusCallbackUrl !== undefined ? { statusCallbackUrl } : {}),
      }),
    );
  } else {
    log.warn('worker.no_sms_provider', { effect: 'sms deliveries will dead-letter until TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM are set' });
  }
  // WhatsApp goes DIRECT to Meta's Cloud API, deliberately not through Twilio
  // (CV-3). Routing SMS and WhatsApp through one vendor made docs/04 §4.4's
  // "we never depend on one channel" false by correlated failure: one outage,
  // one suspended account or one leaked token took both at once. Keep these two
  // blocks on separate vendors — that separation IS the second channel.
  const whatsappPhoneNumberId = process.env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'];
  const whatsappAccessToken = process.env['WHATSAPP_CLOUD_ACCESS_TOKEN'];
  if (whatsappPhoneNumberId && whatsappAccessToken) {
    notificationProviders.set(
      'whatsapp',
      new WhatsappCloudAdapter({
        phoneNumberId: whatsappPhoneNumberId,
        accessToken: whatsappAccessToken,
      }),
    );
  } else {
    log.warn('worker.no_whatsapp_provider', { effect: 'whatsapp deliveries will dead-letter until WHATSAPP_CLOUD_PHONE_NUMBER_ID + WHATSAPP_CLOUD_ACCESS_TOKEN are set' });
  }
  // Web push (CV-2): VAPID keypair; the SPA reads the public half via the API.
  const vapidPublic = process.env['VAPID_PUBLIC_KEY'];
  const vapidPrivate = process.env['VAPID_PRIVATE_KEY'];
  if (vapidPublic && vapidPrivate) {
    notificationProviders.set(
      'push',
      new WebPushAdapter({
        publicKey: vapidPublic,
        privateKey: vapidPrivate,
        subject: process.env['VAPID_SUBJECT'] ?? 'mailto:security@truecairn.app',
      }),
    );
  } else {
    log.warn('worker.no_push_provider', { effect: 'push deliveries will dead-letter until VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are set' });
  }

  // Continuity Verification (docs/26). Both flags default OFF: absent config
  // objects mean the loop skips the cadence entirely and the ceremony bridge
  // attaches no report — behaviour is byte-for-byte pre-CV.
  const cvFanoutEnabled = boolFlag(process.env['CV_FANOUT_ENABLED'], false);
  const cvReportEnabled = boolFlag(process.env['CV_REPORT_ENABLED'], false);
  const cvCadence = cvFanoutEnabled
    ? {
        attemptSpacingMs:
          parseIntEnv('CV_ATTEMPT_SPACING_HOURS', 24) * 60 * 60 * 1000,
        maxAttemptsPerChannel: parseIntEnv('CV_MAX_ATTEMPTS_PER_CHANNEL', 3),
      }
    : undefined;
  // The report port: payload + its sha256 (hex) — the hash is what the bridge
  // anchors in the audit chain, so a served report is verifiable against it.
  const continuityReport: ContinuityReportPort | undefined = cvReportEnabled
    ? {
        build: async (bdb: Database, userId: UserId, when: Date) => {
          const payload = await buildContinuityReport(bdb, userId, when);
          const payloadJson = JSON.stringify(payload);
          const payloadHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
          return { payload, payloadJson, payloadHash };
        },
      }
    : undefined;

  const controller = new AbortController();
  const shutdown = (sig: string): void => {
    log.info('worker.signal', { signal: sig });
    controller.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runLoop({
      db,
      audit,
      auditKeyLineage,
      channels,
      pollIntervalMs,
      batchSize,
      outerLayerKeks,
      blobStore,
      notificationProviders,
      ceremonyWindows: resolveCeremonyWindows(),
      // Bounded-autonomy config (Phase 2). Reads the SAME AI flags the API uses so
      // both agree on suppression; every gate is re-checked inside the sweep.
      autonomy: {
        aiEnabled: boolFlag(process.env['AI_ENABLED'], true),
        autonomyEnabled: boolFlag(process.env['AI_AUTONOMY_ENABLED'], false),
        dailyTokenBudget: optionalPositiveInt(process.env['AI_DAILY_TOKEN_BUDGET']),
      },
      // Guardian config (Phase 3). Deterministic detectors + the ONE fail-closed
      // review_required signal; thresholds are GUARDIAN_* env (docs/AI.md).
      guardian: {
        aiEnabled: boolFlag(process.env['AI_ENABLED'], true),
        guardianEnabled: boolFlag(process.env['AI_GUARDIAN_ENABLED'], false),
        thresholds: loadGuardianConfig(process.env),
      },
      ...(cvCadence !== undefined ? { cvCadence } : {}),
      ...(continuityReport !== undefined ? { continuityReport } : {}),
      // The external liveness monitor (docs/23): unset ⇒ no pings (dev/test).
      ...(process.env['HEARTBEAT_URL'] ? { heartbeatUrl: process.env['HEARTBEAT_URL'] } : {}),
      // DB-backed liveness (migration 0052), read by GET /health/worker. Always
      // on: this is the floor beneath the optional outbound ping, so a
      // deployment cannot silently end up with no watchdog on its release
      // driver. WORKER_ID distinguishes horizontally-scaled instances; the
      // hostname is the natural default on Railway/containers.
      workerId: process.env['WORKER_ID'] ?? hostname(),
      workerVersion: process.env['RAILWAY_GIT_COMMIT_SHA'] ?? process.env['WORKER_VERSION'] ?? '0.0.0',
      // Periodic audit-chain verification. Default 1h: the chain is append-only
      // at the DB layer, so this is a background integrity check whose value is
      // in eventually noticing, not in noticing fast. 0 ⇒ disabled.
      ...(auditVerifyIntervalMs > 0 ? { auditVerifyIntervalMs } : {}),
      signal: controller.signal,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Build the outer-layer KEK provider for the worker — env-backed by default, or
// GCP Cloud KMS when OUTER_LAYER_KEK_PROVIDER=gcp-kms (the KEK stays in the HSM).
// Mirrors the API config's selection so both wrap/unwrap under the same key. A
// misconfigured provider is still returned; the tier-move handler fails + retries
// on use rather than applying with a wrong key.
function resolveWorkerOuterKekProvider(): KekProvider {
  if ((process.env['OUTER_LAYER_KEK_PROVIDER'] ?? '').toLowerCase() === 'gcp-kms') {
    const keyName = process.env['OUTER_LAYER_KMS_KEY'] ?? '';
    if (keyName === '') {
      log.warn('worker.no_outer_layer_kms_key', { effect: 'set_vault_item_tier will not apply' });
    }
    return new KmsKekProvider(new GcpKmsClient(keyName), keyName);
  }
  const kekSet = resolveOuterLayerKekSet(
    process.env['OUTER_LAYER_KEK'],
    process.env['OUTER_LAYER_KEK_PREVIOUS'],
  );
  if (kekSet.byId.size === 0) {
    log.warn('worker.no_outer_layer_kek', { effect: 'set_vault_item_tier will not apply' });
  }
  return new EnvKekProvider(kekSet);
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Mirror the API's permissive boolean-flag parsing (config.ts) so AI_ENABLED /
// AI_AUTONOMY_ENABLED behave identically in the worker.
function boolFlag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Mirror of the API config's production floor (config.ts, QA 2026-07-21 D5):
// the WORKER is the process that actually commits tentative→committed, so a
// compressed CEREMONY_REVOCATION_WINDOW_MS here erases the contacts'
// change-your-mind time no matter what the API believes. Production refuses a
// sub-hour window unless ALLOW_COMPRESSED_CEREMONY_WINDOWS=true (deliberate
// staging drills); the 48h public promise is the default.
const REVOCATION_WINDOW_PRODUCTION_FLOOR_MS = 60 * 60 * 1000;

function resolveCeremonyWindows(): { syncWindowMs: number; revocationWindowMs: number } {
  const windows = {
    syncWindowMs: parseIntEnv('CEREMONY_SYNC_WINDOW_MS', 48 * 60 * 60 * 1000),
    revocationWindowMs: parseIntEnv('CEREMONY_REVOCATION_WINDOW_MS', 48 * 60 * 60 * 1000),
  };
  if (
    (process.env['NODE_ENV'] ?? 'development') === 'production' &&
    process.env['ALLOW_COMPRESSED_CEREMONY_WINDOWS'] !== 'true' &&
    windows.revocationWindowMs < REVOCATION_WINDOW_PRODUCTION_FLOOR_MS
  ) {
    throw new Error(
      `CEREMONY_REVOCATION_WINDOW_MS=${windows.revocationWindowMs} is below the production floor ` +
        `(${REVOCATION_WINDOW_PRODUCTION_FLOOR_MS} ms): contacts must get real time to revoke an ` +
        'affirmation. Set ALLOW_COMPRESSED_CEREMONY_WINDOWS=true only for a deliberately compressed drill.',
    );
  }
  return windows;
}

main().catch((err: unknown) => {
  log.error('worker.fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
