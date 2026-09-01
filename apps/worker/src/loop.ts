import type { Database } from '@truecairn/db';
import {
  applyEvent,
  loadRow,
  tickBatch,
  type AuditLogPort,
  type NotificationChannelLookup,
} from '@truecairn/engine';
import type { AuditKeyLineage } from '@truecairn/audit';
import { applyDueActions } from '@truecairn/sensitive-actions';
import {
  createReleaseReviewCeremonies,
  tickCeremonies,
  type CeremonyEngineSignal,
  type CeremonyWindows,
  type ContinuityReportPort,
} from '@truecairn/ceremony';
import { tickDeliveries, type NotificationProvider } from '@truecairn/notifications';
import type { BlobStore, KekProvider } from '@truecairn/vault';
import type { NotificationChannelType, UserId } from '@truecairn/shared';
import { AiAuthority } from '@truecairn/ai-authority';
import { runAutonomySweep, type AutonomyConfig } from './ai-autonomy.js';
import { sweepExpiredProposals } from './ai-proposals-sweep.js';
import { runAuditVerifySweep } from './audit-verify-sweep.js';
import { pruneAuthAttempts, pruneAuthChallenges } from './retention-sweep.js';
import { recordHeartbeat } from './heartbeat.js';
import { recordStatusSampleTick, sampleDue } from './status-sample.js';
import { runCvCadence, type CvCadenceConfig } from './cv-cadence.js';
import { EngineReviewPort } from './engine-review-port.js';
import { runGuardianSweep, type GuardianSweepConfig } from './guardian/sweep.js';
import { log } from './log.js';

export interface LoopOptions {
  db: Database;
  audit: AuditLogPort;
  // How the worker's signing key relates to the chain (F-5), read when the signer
  // resolved. Threaded through so the SAMPLED status matches what the API's
  // dashboard reports: the two run the same collectSystemStatus precisely so they
  // cannot drift, and a check only one of them can see would reintroduce that.
  auditKeyLineage?: AuditKeyLineage | undefined;
  channels: NotificationChannelLookup;
  pollIntervalMs: number;
  batchSize: number;
  // Outer-layer KEK provider for the set_vault_item_tier handler's re-wrap (env-
  // or KMS-backed). Unusable (empty ring / missing KMS key) ⇒ tier-moves fail and
  // retry rather than applying with a wrong key.
  outerLayerKeks?: KekProvider;
  // Blob store for attachment blobs, for the purge_attachment + delete_account
  // handlers. Unset ⇒ those fail and retry rather than orphaning blobs.
  blobStore?: BlobStore;
  // Notification provider registry by channel type. A type with no provider
  // dead-letters its deliveries (no_provider_configured); empty ⇒ nothing sends.
  notificationProviders?: Map<NotificationChannelType, NotificationProvider>;
  // Release-ceremony time windows (CEREMONY_COMPLETION). Config-driven so an E2E
  // can compress them via env — the processor/bridges carry no test-mode branch.
  ceremonyWindows: CeremonyWindows;
  // Bounded-autonomy config (Phase 2). Absent ⇒ autonomy sweep is skipped entirely.
  // Every gate (kill switch, global flag, per-user opt-in/opt-out, breaker) is
  // checked inside the sweep, so a present-but-disabled config is a cheap no-op.
  autonomy?: AutonomyConfig;
  // Guardian config (Phase 3). Absent ⇒ guardian sweep is skipped. The flags are
  // re-checked inside the sweep, so a present-but-disabled config is a no-op.
  guardian?: GuardianSweepConfig;
  // Continuity Verification (docs/26). Both default-absent = default-off:
  // cvCadence drives the multi-channel verification waves (CV_FANOUT_ENABLED);
  // continuityReport is the port the ceremony bridge uses to freeze a report
  // at creation (CV_REPORT_ENABLED). Absent ⇒ behaviour is exactly pre-CV.
  cvCadence?: CvCadenceConfig;
  continuityReport?: ContinuityReportPort;
  // Watchdog for the release worker: a URL pinged after every
  // completed loop iteration (healthchecks.io-style). The monitor alerting on
  // MISSED pings is what notices a silently dead worker — a worker that stops
  // ticking stops releases, which is this product's one unforgivable failure.
  heartbeatUrl?: string;
  // Identity for the DB-backed liveness row (migration 0052). Workers can be
  // scaled horizontally; the API's probe reads the freshest row, since one live
  // worker is enough to drive releases.
  workerId?: string;
  // Reported to the ops dashboard so API/worker version skew is visible — a
  // half-succeeded deploy is otherwise a confusing incident to diagnose.
  workerVersion?: string;
  // How often to verify audit chains. The sweep is bounded per pass and walks
  // users round-robin, so this is a rotation cadence rather than a full scan.
  // Undefined ⇒ disabled (the sweep never runs).
  auditVerifyIntervalMs?: number;
  clock?: () => Date;
  signal: AbortSignal;
}

// Retention cadence for the operational churn tables. Hourly, matching the
// status_samples prune this was modelled on — the rows being removed are already
// well past any window that reads them, so sweeping more often buys nothing.
const RETENTION_PRUNE_EVERY_MS = 60 * 60 * 1000;
// Batches per table per tick. Caps the work one tick can do so a large first-run
// backlog drains over successive hours instead of stalling the release loop
// behind it — the engine ticking on time matters more than a clean table today.
const RETENTION_PRUNE_MAX_BATCHES = 10;

// Main poll loop. Sleeps in cancellable chunks so SIGINT/SIGTERM unblock it
// promptly rather than waiting out the full interval. Errors in a single
// batch are logged and the loop continues — a transient DB error must not
// take the worker down.
export async function runLoop(opts: LoopOptions): Promise<void> {
  const clock = opts.clock ?? (() => new Date());
  log.info('worker.start', {
    pollIntervalMs: opts.pollIntervalMs,
    batchSize: opts.batchSize,
  });

  // The guardian's chokepoint, wired with the EngineReviewPort — the single door
  // through which the guardian may pause a release (dispute_raised → review_required).
  const guardianAuthority = new AiAuthority({
    audit: opts.audit,
    engine: new EngineReviewPort(opts.audit, opts.channels),
  });

  // Bridge 3 consensus→engine callback: map a ceremony engineSignal to the
  // matching engine event, applied in the processor's own transaction (txdb).
  const signalEngine = async (
    txdb: Database,
    userId: UserId,
    sig: CeremonyEngineSignal,
    when: Date,
  ): Promise<void> => {
    const row = await loadRow(txdb, userId);
    if (row === null) return;
    const event =
      sig === 'release_review_verification_passed'
        ? ({ kind: 'release_review_verification_passed' } as const)
        : sig === 'release_review_verification_failed'
          ? ({ kind: 'release_review_verification_failed' } as const)
          : ({ kind: 'dispute_raised' } as const);
    await applyEvent(row, event, { db: txdb, audit: opts.audit, channels: opts.channels, now: when });
  };

  // Audit-verify rotation state. In-memory by design: a restart just restarts
  // the rotation, which is fine for a continuous background check.
  let auditCursor: string | null = null;
  let lastAuditVerifyAt = 0;
  // Starts at 0 so the first tick after a deploy prunes immediately — a worker
  // that restarts often should still make progress on a backlog.
  let lastRetentionPruneAt = 0;
  // Carried onto the heartbeat so the ops dashboard reports chain integrity as
  // STATUS rather than requiring an operator to grep log history for the alert.
  let lastAuditVerify: { at: Date; checked: number; broken: number } | undefined;
  // Last health sample, so the probe runs once per minute bucket rather than
  // once per poll. In-memory: a restart just samples again immediately, and the
  // bucket upsert makes a duplicate write harmless.
  let lastStatusSampleAt: Date | null = null;

  while (!opts.signal.aborted) {
    const tickStart = Date.now();
    const now = clock();
    // Counts batches that threw this tick, so the liveness row can distinguish
    // a worker that is dead from one that is alive-but-failing.
    let tickErrors = 0;
    let engineProcessed = 0;
    try {
      engineProcessed = await tickBatch(
        { db: opts.db, audit: opts.audit, channels: opts.channels, now },
        opts.batchSize,
      );
    } catch (err) {
      log.error('worker.engine_batch_failed', { error: errorMessage(err) });
      tickErrors += 1;
    }
    let actionsResult = { processed: 0, applied: 0, cancelled: 0, failed: 0 };
    try {
      actionsResult = await applyDueActions(
        {
          db: opts.db,
          audit: opts.audit,
          now,
          ...(opts.outerLayerKeks !== undefined ? { outerLayerKeks: opts.outerLayerKeks } : {}),
          ...(opts.blobStore !== undefined ? { blobStore: opts.blobStore } : {}),
          // Surface a per-action apply throw (a poison action retrying every
          // tick) instead of swallowing it into the failed counter (2026-07-18).
          logActionFailure: (info) => log.error('worker.action_apply_failed', info),
        },
        opts.batchSize,
      );
    } catch (err) {
      log.error('worker.actions_batch_failed', { error: errorMessage(err) });
      tickErrors += 1;
    }
    // Continuity Verification cadence (docs/26 CV-1): fan verification waves
    // out to matrix-enabled verified channels while an owner is unresponsive.
    let cvResult = { owners: 0, enqueued: 0 };
    if (opts.cvCadence !== undefined) {
      try {
        cvResult = await runCvCadence(
          { db: opts.db, config: opts.cvCadence, now },
          opts.batchSize,
        );
      } catch (err) {
        log.error('worker.cv_cadence_failed', { error: errorMessage(err) });
        tickErrors += 1;
      }
    }
    // Bridge 1: open a ceremony for any user who has entered release_review.
    try {
      await createReleaseReviewCeremonies(
        {
          db: opts.db,
          audit: opts.audit,
          now,
          windows: opts.ceremonyWindows,
          ...(opts.continuityReport !== undefined
            ? { continuityReport: opts.continuityReport }
            : {}),
        },
        opts.batchSize,
      );
    } catch (err) {
      log.error('worker.ceremony_create_failed', { error: errorMessage(err) });
      tickErrors += 1;
    }
    let ceremonyResult = { affirmationsCommitted: 0, ceremoniesProcessed: 0 };
    try {
      ceremonyResult = await tickCeremonies(
        { db: opts.db, audit: opts.audit, now, signalEngine },
        opts.batchSize,
      );
    } catch (err) {
      log.error('worker.ceremony_batch_failed', { error: errorMessage(err) });
      tickErrors += 1;
    }
    let deliveryResult = { processed: 0, sent: 0, retried: 0, deadLettered: 0 };
    try {
      deliveryResult = await tickDeliveries(
        { db: opts.db, providers: opts.notificationProviders ?? new Map(), now },
        opts.batchSize,
      );
    } catch (err) {
      log.error('worker.delivery_batch_failed', { error: errorMessage(err) });
      tickErrors += 1;
    }
    // Expire stale AI proposals (Phase 1). Safe no-op when the table is empty.
    let proposalsExpired = 0;
    try {
      proposalsExpired = (
        await sweepExpiredProposals({ db: opts.db, audit: opts.audit, now }, opts.batchSize)
      ).expired;
    } catch (err) {
      log.error('worker.ai_proposal_sweep_failed', { error: errorMessage(err) });
      tickErrors += 1;
    }
    // Bounded-autonomy sweep (Phase 2). Every gate is checked inside; skipped
    // entirely when no autonomy config is provided.
    let autonomy = { nudges: 0, tightens: 0 };
    if (opts.autonomy !== undefined) {
      try {
        autonomy = await runAutonomySweep(
          { db: opts.db, audit: opts.audit, config: opts.autonomy, now },
          opts.batchSize,
        );
      } catch (err) {
        log.error('worker.ai_autonomy_sweep_failed', { error: errorMessage(err) });
        tickErrors += 1;
      }
    }
    // Guardian sweep (Phase 3). Flags re-checked inside; skipped with no config.
    let guardianSignals = 0;
    if (opts.guardian !== undefined) {
      try {
        guardianSignals = (
          await runGuardianSweep(
            { db: opts.db, authority: guardianAuthority, config: opts.guardian, now },
            opts.batchSize,
          )
        ).signalsEmitted;
      } catch (err) {
        log.error('worker.guardian_sweep_failed', { error: errorMessage(err) });
        tickErrors += 1;
      }
    }
    const total =
      engineProcessed +
      actionsResult.processed +
      ceremonyResult.ceremoniesProcessed +
      ceremonyResult.affirmationsCommitted +
      deliveryResult.processed +
      cvResult.enqueued +
      proposalsExpired +
      autonomy.nudges +
      autonomy.tightens +
      guardianSignals;
    if (total > 0) {
      log.info('worker.batch', {
        engineProcessed,
        actions: actionsResult,
        ceremonies: ceremonyResult,
        deliveries: deliveryResult,
        cv: cvResult,
        proposalsExpired,
        autonomy,
        guardianSignals,
        elapsedMs: Date.now() - tickStart,
      });
    } else {
      log.debug('worker.idle', { elapsedMs: Date.now() - tickStart });
    }
    // Periodic audit-chain verification. Interval-gated rather than every tick:
    // the chain is append-only at the DB layer, so this is a background integrity
    // check, not a hot path. A broken chain is logged at ERROR and deliberately
    // NOT written to the audit log — appending to a broken chain compounds the
    // damage and buries the evidence (see audit-verify-sweep.ts).
    if (
      opts.auditVerifyIntervalMs !== undefined &&
      Date.now() - lastAuditVerifyAt >= opts.auditVerifyIntervalMs
    ) {
      lastAuditVerifyAt = Date.now();
      try {
        const sweep = await runAuditVerifySweep(
          {
            db: opts.db,
            onBroken: (info) => log.error('worker.audit_chain_broken', info),
          },
          opts.batchSize,
          auditCursor,
        );
        auditCursor = sweep.nextCursor;
        lastAuditVerify = { at: now, checked: sweep.checked, broken: sweep.broken };
        if (sweep.broken > 0) {
          log.error('worker.audit_verify_sweep', { checked: sweep.checked, broken: sweep.broken });
        }
      } catch (err) {
        log.error('worker.audit_verify_sweep_failed', { error: errorMessage(err) });
        tickErrors += 1;
      }
    }

    // Retention for auth_attempts and auth_challenges (2026-08-07 audit, findings
    // 6 and 11). Neither table had any reaper; auth_attempts is read on every
    // login and now also takes a row per AI model call. Drains in bounded batches
    // so a first run against a never-pruned table cannot hold a long transaction,
    // with a per-tick cap so the backlog spreads over hours rather than stalling
    // the release loop behind it.
    if (Date.now() - lastRetentionPruneAt >= RETENTION_PRUNE_EVERY_MS) {
      lastRetentionPruneAt = Date.now();
      try {
        const drain = async (prune: (db: Database, at: Date) => Promise<number>): Promise<number> => {
          let total = 0;
          for (let batch = 0; batch < RETENTION_PRUNE_MAX_BATCHES; batch++) {
            const n = await prune(opts.db, now);
            total += n;
            if (n === 0) break;
          }
          return total;
        };
        const attempts = await drain(pruneAuthAttempts);
        const challenges = await drain(pruneAuthChallenges);
        if (attempts > 0 || challenges > 0) {
          log.info('worker.retention_pruned', { attempts, challenges });
        }
      } catch (err) {
        log.error('worker.retention_prune_failed', { error: errorMessage(err) });
        tickErrors += 1;
      }
    }

    // Record liveness in the DATABASE before the outbound ping. This is the
    // floor beneath HEARTBEAT_URL: it needs no external service, so a deployment
    // that never configured a monitor still cannot end up with no watchdog at
    // all — GET /health/worker reads this row. Best-effort: failing to record
    // liveness must never take down the loop whose liveness it records.
    if (opts.workerId !== undefined) {
      try {
        await recordHeartbeat({
          db: opts.db,
          workerId: opts.workerId,
          now,
          tickMs: Date.now() - tickStart,
          errors: tickErrors,
          version: opts.workerVersion ?? 'unknown',
          ...(lastAuditVerify ? { auditVerify: lastAuditVerify } : {}),
        });
      } catch (err) {
        log.warn('worker.heartbeat_record_failed', { error: errorMessage(err) });
      }
    }

    // Sample health into the series behind the PUBLIC /status page (migration
    // 0055). Deliberately after the heartbeat and before the outbound ping, and
    // deliberately not gated on a flag: an unwritten sample is counted as an
    // unavailable minute by the reader, so a sampler that can be switched off
    // would let a deployment quietly improve its own published uptime.
    //
    // Rate-limited to one per minute bucket — the probe does a wrap/unwrap
    // round-trip against the live KEK, which is a network call on the KMS
    // provider and must not run on every poll. Best-effort, like the heartbeat:
    // failing to record health must never look like health, and must never take
    // down the loop it observes.
    if (opts.outerLayerKeks !== undefined && sampleDue(now, lastStatusSampleAt)) {
      lastStatusSampleAt = now;
      try {
        await recordStatusSampleTick({
          db: opts.db,
          outerLayerKeks: opts.outerLayerKeks,
          // True by CONSTRUCTION, not by assumption: `audit` is non-optional in
          // LoopOptions, so a worker that reached this line has a signer. The
          // API's equivalent is a real check (app.audit can be null when the
          // signer failed to resolve at boot) — here there is no such state to
          // check, and reporting 'unknown' for something structurally
          // guaranteed would be its own kind of dishonesty.
          auditReady: true,
          auditKeyLineage: opts.auditKeyLineage,
          workerVersion: opts.workerVersion ?? 'unknown',
          configuredNotificationTypes: [...(opts.notificationProviders?.keys() ?? [])],
          now,
        });
      } catch (err) {
        log.warn('worker.status_sample_failed', { error: errorMessage(err) });
      }
    }

    // The iteration COMPLETED (even if individual batches logged errors) —
    // tell the external monitor we're alive. Fire-and-forget with a short
    // timeout; a monitoring outage must never stall the loop itself.
    if (opts.heartbeatUrl !== undefined) {
      fetch(opts.heartbeatUrl, { method: 'POST', signal: AbortSignal.timeout(5_000) }).catch(
        (err: unknown) => log.warn('worker.heartbeat_failed', { error: errorMessage(err) }),
      );
    }
    await sleep(opts.pollIntervalMs, opts.signal);
  }

  log.info('worker.shutdown');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
