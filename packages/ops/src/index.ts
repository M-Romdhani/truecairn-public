// The operations surface, shared by the API (which serves it) and the worker
// (which samples it). Lives in a package rather than in apps/api so there is one
// definition of "could a release ceremony complete right now?" — the worker
// writes the health time series and the API publishes figures computed from it,
// and those two must not be allowed to drift into separate opinions.
export {
  accountTotals,
  collectSystemStatus,
  recentAlerts,
  recentAlertsSafe,
  resolveBackupAttestation,
  stateSeverity,
  RESTORE_ATTESTATION_STALE_AFTER_DAYS,
  type AccountTotals,
  type AiSubsystemDeps,
  type BackupAttestation,
  type Check,
  type CheckState,
  type Queues,
  type RecentAlert,
  type SystemStatus,
  type SystemStatusDeps,
} from './system-status.js';
export {
  bucketFor,
  computeAvailability,
  computeAvailabilitySafe,
  pruneStatusSamples,
  readHealthSeries,
  readHealthSeriesSafe,
  recordStatusSample,
  worstReleaseCriticalCheck,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SERIES_BUCKET_MS,
  DEFAULT_SERIES_WINDOW_MS,
  NO_AVAILABILITY,
  MEASUREMENT_EPOCH,
  MIN_PUBLISHABLE_MS,
  SAMPLE_BUCKET_MS,
  type Availability,
  type HealthBucket,
  type HealthSeries,
} from './samples.js';
export { toPublicStatus, type PublicCheck, type PublicStatus } from './public-status.js';
