import { isCryptoReady } from '@truecairn/crypto';
import type { Database } from '@truecairn/db';
import {
  collectSystemStatus,
  pruneStatusSamples,
  recordStatusSample,
  resolveBackupAttestation,
  worstReleaseCriticalCheck,
  SAMPLE_BUCKET_MS,
} from '@truecairn/ops';
import type { KekProvider } from '@truecairn/vault';
import type { AuditKeyLineage } from '@truecairn/audit';

// ── The health sampler (2026-07-30) ──────────────────────────────────────────
//
// Writes one row per minute into status_samples, from which the public /status
// page computes a real availability figure. See migration 0055 for why the
// series has to exist and packages/ops/src/samples.ts for why a MISSING sample
// counts against availability rather than being skipped.
//
// WHY THE WORKER OWNS THIS. Two reasons, and the second is the important one.
//
//   * It already ticks on a clock. A sampler driven by the API would be driven
//     by TRAFFIC, and a page nobody visits would record no evidence — the
//     sampling rate would silently correlate with everything except health.
//
//   * The worker is the sole release driver, so a worker that cannot write a
//     sample is very likely a worker that is not releasing either. The absence
//     is itself the signal, and the reader is built to read it that way. An API-
//     side sampler would happily keep writing "ok" through a total worker
//     outage, which is precisely the false green this page must never show.
//
// The composite is computed with the SAME collectSystemStatus the dashboard
// uses — not a worker-local approximation — so the series and the live tiles can
// never drift into two opinions about what "ok" meant.
//
// BEST-EFFORT, ALWAYS. This is observability: a failure here must never take
// down the loop it observes. The caller swallows errors, and the consequence of
// a failed write is an unobserved minute, which the reader already treats as
// unavailable. Failing to record health is never allowed to look like health.

export interface StatusSampleDeps {
  db: Database;
  outerLayerKeks: KekProvider;
  auditReady: boolean;
  auditKeyLineage?: AuditKeyLineage | undefined;
  workerVersion: string;
  configuredNotificationTypes: readonly string[];
  now: Date;
  retentionDays?: number;
}

// Prune far less often than we sample: retention is a housekeeping concern and a
// DELETE on every tick would be pure write amplification for a table whose whole
// job is to be cheap.
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

export async function recordStatusSampleTick(deps: StatusSampleDeps): Promise<void> {
  const status = await collectSystemStatus({
    db: deps.db,
    outerLayerKeks: deps.outerLayerKeks,
    auditReady: deps.auditReady,
    auditKeyLineage: deps.auditKeyLineage,
    // The sampler runs in the worker, so the "api" version it reports is this
    // process's. Only used for the skew field, which the public projection drops.
    apiVersion: deps.workerVersion,
    configuredNotificationTypes: deps.configuredNotificationTypes,
    cryptoReady: isCryptoReady,
    // Read here rather than defaulted, even though the sample records only the
    // release-path composite and `backups` is not release-critical: a deps field
    // silently filled with "nothing attested" in one caller is how the two
    // surfaces drift, and this one is cheap to keep true. No `ai` — the worker
    // holds no model configuration and is pinned AI-free by import fence.
    backups: resolveBackupAttestation(process.env['BACKUPS_LAST_VERIFIED_RESTORE'], deps.now),
    now: deps.now,
  });

  await recordStatusSample({
    db: deps.db,
    at: deps.now,
    releasePath: status.continuityEngine,
    worstCheck: worstReleaseCriticalCheck(status),
  });

  if (deps.now.getTime() - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = deps.now.getTime();
    await pruneStatusSamples(deps.db, deps.now, deps.retentionDays);
  }
}

// Whether a new sample is due. Workers tick far more often than the bucket, and
// re-running the probe every few seconds would mean a wrap/unwrap round-trip
// against the KEK (a network call on the KMS provider) many times a minute for
// a row that would only overwrite itself.
export function sampleDue(now: Date, lastSampleAt: Date | null): boolean {
  if (lastSampleAt === null) return true;
  return (
    Math.floor(now.getTime() / SAMPLE_BUCKET_MS) >
    Math.floor(lastSampleAt.getTime() / SAMPLE_BUCKET_MS)
  );
}
