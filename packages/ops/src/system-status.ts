import { randomBytes } from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import { and, count, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { KekProvider } from '@truecairn/vault';
import { describeAuditKeyLineage, type AuditKeyLineage } from '@truecairn/audit';

// ── The operations centre (2026-07-25) ───────────────────────────────────────
//
// One question this dashboard exists to answer that a normal status page does
// not: **could a release ceremony actually complete right now?**
//
// "API is up" is nearly worthless here. Truecairn's job runs unattended, on
// behalf of someone who cannot complain, and every component it needs can fail
// silently while the web tier stays perfectly green. So the composite below is a
// conjunction over the things a release genuinely depends on, and each one is
// checked by DOING it rather than by asserting configuration exists.
//
// TWO RULES THIS MODULE MUST KEEP.
//
// 1. NEVER report green for something not actually checked. A tile that is
//    decorative is worse than a missing tile, because it converts "we don't
//    know" into "we're fine" — the same failure as a build-provenance page that
//    claims to have verified something it hasn't. Anything uninstrumented
//    reports 'unknown' with a reason, and 'unknown' never counts as healthy.
//    (Backups were the live example for a year: a Railway control-plane concern
//    the application cannot see. What the application CAN see is whether a human
//    ever restored from one and when — see the backups check below, which
//    reports that dated fact and expires it rather than asserting the half it
//    still cannot observe.)
//
// 2. NEVER expose user data. This is a zero-knowledge product and an ops surface
//    is a new attack surface. Counts and enums only — no emails, no user ids, no
//    vault metadata, no contact identities. ops-system.test.ts asserts the
//    response is free of them.
//
// (No Redis tile: there is no Redis in this stack — rate limits and challenges
// are Postgres-backed by design. Drawing one would be inventing a dependency.)

export type CheckState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  // Whether a release ceremony depends on this check. The composite is the
  // conjunction of exactly these.
  releaseCritical: boolean;
  latencyMs?: number;
}

export interface Queues {
  notificationsQueued: number;
  notificationsDeadLettered: number;
  // null when nothing is queued — there is no age to report. Distinct from the
  // whole object being null, which means nothing could be counted at all.
  oldestQueuedAgeSeconds: number | null;
  sensitiveActionsPending: number;
  sensitiveActionsOverdue: number;
  ceremoniesActive: number;
}

export interface SystemStatus {
  // The headline. 'ok' only when every release-critical check is 'ok'.
  continuityEngine: CheckState;
  continuitySummary: string;
  checks: Check[];
  versions: { api: string; worker: string | null; skew: boolean };
  // null when the counts could not be taken, which is exactly the database
  // outage. Every one of the six is a database aggregate, so reporting the
  // zeros they were initialised to would assert "nothing is queued" during the
  // one failure where the depth is unknowable — rule 1 applied to numbers
  // instead of tiles. Same reason accountTotals returns null rather than zeros.
  queues: Queues | null;
  observedAt: string;
}

const WORKER_STALE_AFTER_MS = 5 * 60 * 1000;
// A sweep runs hourly by default; allow generous slack before calling the
// integrity signal stale, so a restart does not read as a problem.
const AUDIT_SWEEP_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
// How recently a delivery must have dead-lettered to count against the live
// notifications state. Long enough that a real delivery outage is still visible
// hours later; short enough that history cannot pin the check (2026-08-08 N-1).
const DEAD_LETTER_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How far back the AI tile looks for EVIDENCE. State still turns on today's row
// alone; this only lets the detail say when the model last answered, on a
// deployment where usage is sparse enough that "today" is usually empty.
const AI_EVIDENCE_WINDOW_DAYS = 7;
// How long a restore attestation stays fresh. The drill cadence is quarterly,
// and this is what makes an operator-supplied date safe to render green: it expires on its own, so the
// tile cannot stay healthy through neglect — which is the failure mode a
// hand-set value invites.
export const RESTORE_ATTESTATION_STALE_AFTER_DAYS = 92;

// What the outer-layer KEK's IDENTITY half managed to establish. Three cases
// rather than a boolean because "there are no stored keys to open" and "we could
// not look" are different claims, and only one of them is true during a database
// outage — reporting either as the other is rule 1 broken in the detail line.
type KekIdentityResult =
  | { kind: 'opened'; kekId: string }
  | { kind: 'none_stored' }
  | { kind: 'unchecked'; why: string };

// What an operator has attested about backups, parsed once from
// BACKUPS_LAST_VERIFIED_RESTORE. Three cases rather than a nullable Date because
// "nobody has recorded a drill" and "somebody recorded something unusable" are
// different operator problems, and a value that failed to parse must never
// silently read as the first — that is how a typo becomes an expired
// attestation nobody notices.
export type BackupAttestation =
  | { kind: 'none' }
  | { kind: 'invalid'; why: string }
  | { kind: 'verified'; at: Date };

// Strict on purpose: an ISO date (YYYY-MM-DD, optionally a full timestamp), and
// never in the future. `new Date('last tuesday')` is Invalid Date, but
// `new Date('2026')` is a valid January 1st — loose parsing of an operator's
// date field produces a confident wrong answer, which is the one outcome this
// tile must not have.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function resolveBackupAttestation(
  raw: string | undefined,
  now: Date = new Date(),
): BackupAttestation {
  const value = (raw ?? '').trim();
  if (value === '') return { kind: 'none' };
  if (!ISO_DATE_RE.test(value)) {
    return { kind: 'invalid', why: 'is not an ISO date (expected YYYY-MM-DD)' };
  }
  const at = new Date(value.includes('T') || value.includes(' ') ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) {
    return { kind: 'invalid', why: 'is not a real date' };
  }
  // A future date cannot describe a drill that happened, and it would suppress
  // the staleness expiry for as long as it is set — the one way this tile could
  // be pinned green.
  if (at.getTime() > now.getTime()) return { kind: 'invalid', why: 'is dated in the future' };
  return { kind: 'verified', at };
}

// The AI subsystem's configuration as one short phrase for the tile. Model first
// because it is the value with a retirement date attached.
function describeAiConfig(ai: AiSubsystemDeps): string {
  const caps = ai.capabilities.length > 0 ? ai.capabilities.join(', ') : 'assist + briefing only';
  return `${ai.model} (${caps})`;
}

// "3 days ago" between two YYYY-MM-DD day strings. Day granularity is all
// ai_usage_daily has, and stating an age is what makes a stale last-success
// readable as stale rather than as reassurance.
function daysBetween(fromDay: string, toDay: string): string {
  const days = Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS,
  );
  if (!Number.isFinite(days) || days < 0) return 'age unknown';
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

export interface SystemStatusDeps {
  db: Database;
  outerLayerKeks: KekProvider;
  // Non-null when the audit signer resolved at boot. A null signer means audit
  // entries cannot be written, which stops the ceremony path dead — the append
  // rides the same transaction as the state change it records.
  auditReady: boolean;
  // How the resolved signing key relates to the chain already in the database,
  // read once when the signer was resolved (F-5). Absent means "not established"
  // — a caller that has no signer, or an older caller — never "fine".
  auditKeyLineage?: AuditKeyLineage | undefined;
  apiVersion: string;
  // Which notification channel types have a configured provider. Empty means
  // nothing can be delivered, so no owner can be warned and no contact reached.
  configuredNotificationTypes: readonly string[];
  cryptoReady: () => boolean;
  // What the AI subsystem is CONFIGURED to do. Absent (the worker's sampler)
  // means the configuration half is simply not reported — never that it is off.
  ai?: AiSubsystemDeps;
  // What an operator has attested about backups. Required, not optional, so a
  // second surface reading this module cannot silently omit it and publish a
  // different answer from the admin dashboard — the api's /v1/status and
  // /v1/ops/system must never hold two opinions about the same tile.
  backups: BackupAttestation;
  now?: Date;
}

// The AI subsystem's configuration, which — unlike its health — the application
// can observe directly. Passed rather than read from env here so this package
// stays free of process configuration and both API surfaces resolve it once.
export interface AiSubsystemDeps {
  // The master kill switch (AI_ENABLED). Off means no model call is attempted
  // anywhere, which is 'unknown' rather than a fault: reporting a deliberately
  // disabled feature as degraded is how an operator learns to ignore a tile.
  killSwitch: boolean;
  // Whether a model CREDENTIAL resolved at boot. Deliberately separate from the
  // kill switch: "turned off" and "turned on and unable to call anything" are
  // different operator problems, and until 2026-08-11 this tile rendered both as
  // the same sentence ("disabled by configuration").
  credentialResolved: boolean;
  // The resolved model id. On a clock, which is why it is on the tile: an empty
  // GEMINI_MODEL resolves to the auto-updating `gemini-2.5-flash` alias, and the
  // 2.5 family retires 2026-10-16.
  model: string;
  // Capability flags currently ON, by name (proposer / autonomy / guardian).
  capabilities: readonly string[];
}

export async function collectSystemStatus(deps: SystemStatusDeps): Promise<SystemStatus> {
  const now = deps.now ?? new Date();
  const checks: Check[] = [];

  // ── Database ───────────────────────────────────────────────────────────────
  let dbOk = false;
  try {
    const { ms } = await timed(() => deps.db.execute(sql`select 1`));
    dbOk = true;
    checks.push({
      id: 'database',
      label: 'Database',
      state: 'ok',
      detail: 'reachable',
      releaseCritical: true,
      latencyMs: ms,
    });
  } catch (err) {
    checks.push({
      id: 'database',
      label: 'Database',
      state: 'down',
      detail: `unreachable: ${errText(err)}`,
      releaseCritical: true,
    });
  }

  // ── Worker (the sole release driver) ───────────────────────────────────────
  let workerRow: typeof schema.workerHeartbeats.$inferSelect | undefined;
  if (dbOk) {
    const rows = await deps.db
      .select()
      .from(schema.workerHeartbeats)
      .orderBy(desc(schema.workerHeartbeats.lastTickAt))
      .limit(1);
    workerRow = rows[0];
  }
  if (workerRow === undefined) {
    checks.push({
      id: 'worker',
      label: 'Release worker',
      state: dbOk ? 'down' : 'unknown',
      detail: dbOk ? 'no worker has ever recorded a tick' : 'database unreachable',
      releaseCritical: true,
    });
  } else {
    const ageMs = now.getTime() - workerRow.lastTickAt.getTime();
    const stale = ageMs > WORKER_STALE_AFTER_MS;
    // Alive-but-failing is its own state: the process ticks, so a liveness ping
    // would look fine, but its batches are throwing and nothing is progressing.
    const erroring = workerRow.consecutiveErrors > 0;
    checks.push({
      id: 'worker',
      label: 'Release worker',
      state: stale ? 'down' : erroring ? 'degraded' : 'ok',
      detail: stale
        ? `last tick ${Math.round(ageMs / 1000)}s ago — releases are not being driven`
        : erroring
          ? `ticking, but ${workerRow.consecutiveErrors} batch error(s) since the last clean tick`
          : `last tick ${Math.round(ageMs / 1000)}s ago`,
      releaseCritical: true,
    });
  }

  // ── Cryptographic services ─────────────────────────────────────────────────
  const cryptoOk = deps.cryptoReady();
  checks.push({
    id: 'crypto',
    label: 'Crypto (libsodium)',
    state: cryptoOk ? 'ok' : 'down',
    detail: cryptoOk ? 'initialised' : 'NOT initialised — every crypto operation will throw',
    releaseCritical: true,
  });

  // ── The outer-layer KEK: the single cryptographic power the server holds ───
  //
  // Two things are checked, and it took a restore drill (2026-08-10, F-1) to
  // learn that only one of them used to be.
  //
  // A wrap→unwrap round-trip on a FRESHLY GENERATED probe proves the key is
  // USABLE — the KMS answers, the ring resolves, AEAD works. It cannot prove it
  // is THE key: any well-formed 32-byte value round-trips green against itself.
  // So if OUTER_LAYER_KEK were ever replaced with a wrong-but-valid value — a
  // bad transcription, a rotation mistake, an environment seeded from the wrong
  // copy — this check stayed green while every existing vault item was
  // permanently unopenable, and the first symptom would have been a real
  // ceremony failing at its last step. That is the worst possible place to
  // discover it: the temporal gate opens only once, and the person waiting on it
  // is a beneficiary, not an operator.
  //
  // So the authoritative half is unwrapping a STORED outer_layer_keys row —
  // ciphertext this deployment actually has to be able to open, under the kek_id
  // and AAD that row was sealed with — the check that has to pass against real
  // restored ciphertext for a drill to count as one.
  //
  // A deployment with no stored keys yet has nothing to open, and says so rather
  // than implying otherwise (rule 1: never report green for something not
  // actually checked — the wording is the check's honesty, not decoration).
  try {
    const { value: identity, ms } = await timed<KekIdentityResult>(async () => {
      const probe = randomBytes(32);
      const aad = Buffer.from('ops-probe', 'utf8');
      const wrapped = await deps.outerLayerKeks.wrap(probe, aad);
      const back = await deps.outerLayerKeks.unwrap(
        deps.outerLayerKeks.currentKekId,
        wrapped,
        aad,
      );
      if (Buffer.compare(Buffer.from(back), probe) !== 0) {
        throw new Error('round-trip mismatch');
      }

      // The identity half. Oldest LIVE key: the one most likely to predate a
      // rotation, so a half-applied rotation fails here rather than hiding
      // behind keys the new KEK happened to seal. No user id, no row id, no
      // plaintext leaves this block (rule 2).
      // "there are no stored keys" and "we could not look" are different claims,
      // and only one of them is true on a database outage.
      if (!dbOk) return { kind: 'unchecked', why: 'database unreachable' };
      const [row] = await deps.db
        .select({
          kekId: schema.outerLayerKeys.kekId,
          ciphertext: schema.outerLayerKeys.outerKeyEncrypted,
          nonce: schema.outerLayerKeys.outerKeyNonce,
          aad: schema.outerLayerKeys.outerKeyEncryptionAad,
        })
        .from(schema.outerLayerKeys)
        .where(
          and(
            isNull(schema.outerLayerKeys.releasedAt),
            isNull(schema.outerLayerKeys.rotatedAt),
          ),
        )
        .orderBy(schema.outerLayerKeys.createdAt)
        .limit(1);
      if (row === undefined) return { kind: 'none_stored' };

      const opened = await deps.outerLayerKeks.unwrap(
        row.kekId,
        { ciphertext: row.ciphertext, nonce: row.nonce },
        row.aad,
      );
      // Unwrap is AEAD: a wrong key fails to authenticate rather than returning
      // garbage, so reaching here IS the proof. The length check catches the
      // separate case of a structurally wrong key having been provisioned.
      if (opened.length !== 32) throw new Error(`stored key opened to ${opened.length} bytes`);
      return { kind: 'opened', kekId: row.kekId };
    });
    const current = deps.outerLayerKeks.currentKekId;
    checks.push({
      id: 'outer_layer_kek',
      label: 'Outer-layer key (release gate)',
      state: 'ok',
      detail:
        identity.kind === 'opened'
          ? `opened a stored outer-layer key (sealed under ${identity.kekId}; current ${current})`
          : identity.kind === 'none_stored'
            ? `wrap/unwrap round-trip verified (${current}) — no outer-layer keys stored yet, so the key's IDENTITY is not yet provable`
            : `wrap/unwrap round-trip verified (${current}) — stored-key identity NOT checked (${identity.why})`,
      releaseCritical: true,
      latencyMs: ms,
    });
  } catch (err) {
    checks.push({
      id: 'outer_layer_kek',
      label: 'Outer-layer key (release gate)',
      state: 'down',
      detail: `FAILED: ${errText(err)} — no release can be completed`,
      releaseCritical: true,
    });
  }

  // ── Audit signing ──────────────────────────────────────────────────────────
  // The audit append rides the same transaction as the state change it records,
  // so an unavailable signer does not merely lose the record — it rolls the
  // transition back. Release-critical for that reason.
  //
  // The lineage half (F-5, 2026-08-10 drill): "a signer resolved" is the same
  // shape of claim the outer-layer KEK check used to make before F-1 — it proves
  // a key is present and usable, not that it is THE key. A mis-transcribed
  // SERVER_AUDIT_SIGNING_KEY derives a different key id, registers as a new row
  // and boots clean, while new entries are signed under a lineage nobody holds a
  // paper copy of. `lineage` is read once at boot (see audit/lineage.ts — the
  // query is a scan, and this is a public request path), which is sound because
  // a signing key cannot change under a running process.
  //
  // A split is DEGRADED, not down: it is the expected state immediately after a
  // legitimate rotation, and retired keys keep verifying. It must be visible
  // without being an outage.
  const lineage = deps.auditKeyLineage;
  checks.push({
    id: 'audit_signing',
    label: 'Audit signing',
    state: !deps.auditReady ? 'down' : lineage?.kind === 'split' ? 'degraded' : 'ok',
    detail: !deps.auditReady
      ? 'no signer — audited state changes cannot commit'
      : lineage === undefined
        ? 'signer resolved (lineage not established)'
        : describeAuditKeyLineage(lineage),
    releaseCritical: true,
  });

  // ── Audit chain integrity (from the worker's rotating sweep) ───────────────
  if (workerRow?.lastAuditVerifyAt == null) {
    checks.push({
      id: 'audit_chain',
      label: 'Audit chain',
      state: 'unknown',
      detail: 'no sweep has completed yet',
      // Not release-critical: a broken chain is a forensic emergency, but it does
      // not stop a legitimate release, and we must not let 'unknown' here take
      // the whole engine red on every worker restart.
      releaseCritical: false,
    });
  } else {
    const broken = workerRow.lastAuditVerifyBroken ?? 0;
    const sweepAge = now.getTime() - workerRow.lastAuditVerifyAt.getTime();
    checks.push({
      id: 'audit_chain',
      label: 'Audit chain',
      state: broken > 0 ? 'down' : sweepAge > AUDIT_SWEEP_STALE_AFTER_MS ? 'degraded' : 'ok',
      detail:
        broken > 0
          ? `${broken} chain(s) FAILED verification — investigate immediately`
          : `${workerRow.lastAuditVerifyChecked ?? 0} chain(s) verified ${Math.round(sweepAge / 60000)}m ago`,
      releaseCritical: false,
    });
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  // Configuration first (can anything be sent at all?), then evidence from the
  // delivery table (is anything actually getting through?).
  const types = deps.configuredNotificationTypes;
  let deadLettered = 0;
  let deadLetteredAllTime = 0;
  let queued = 0;
  let oldestQueuedAgeSeconds: number | null = null;
  if (dbOk) {
    const [q] = await deps.db
      .select({
        n: count(),
        oldest: sql<Date | null>`min(${schema.notificationDeliveries.nextAttemptAt})`,
      })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.status, 'queued'));
    queued = q?.n ?? 0;
    if (q?.oldest != null) {
      oldestQueuedAgeSeconds = Math.max(
        0,
        Math.round((now.getTime() - new Date(q.oldest).getTime()) / 1000),
      );
    }
    // "Dead-lettered" is the terminal 'failed' status the processor sets after
    // exhausting retries (processor.ts) — there is no separate enum member.
    //
    // WINDOWED, and that is the whole point (2026-08-08 re-audit, N-1). This was
    // an ALL-TIME count feeding a release-critical check, so a single dead letter
    // — ever — made `notifications` degraded forever, made the composite
    // never-ok forever, and pinned the published availability figure at 0%
    // permanently. The metric was saturated: a real outage could not move it
    // because it was already at the floor. The page whose argument is "computed
    // from health samples on a clock" was publishing 0% uptime.
    //
    // updated_at is the exact dead-letter moment: processor.ts sets
    // `{ status: 'failed', lastError, updatedAt: now }` in the same statement.
    // Every other check in this module is windowed or state-based (audit_chain
    // on sweep age, worker on heartbeat recency); this one reasoning over an
    // unbounded historical total was the outlier.
    const [d] = await deps.db
      .select({ n: count() })
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.status, 'failed'),
          gte(schema.notificationDeliveries.updatedAt, new Date(now.getTime() - DEAD_LETTER_WINDOW_MS)),
        ),
      );
    deadLettered = d?.n ?? 0;
    // The all-time total stays available for the admin QUEUES panel: history is
    // useful to an operator looking at a dashboard, and useless as a live health
    // state. Separating the two is the fix.
    const [dAll] = await deps.db
      .select({ n: count() })
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.status, 'failed'));
    deadLetteredAllTime = dAll?.n ?? 0;
  }
  checks.push({
    id: 'notifications',
    label: 'Notifications',
    // State is deliberately unchanged when the database is unreachable: the
    // CONFIGURATION half of this check is still genuinely checked, and the
    // composite is already down via the database tile. Only the detail admits
    // that the delivery evidence could not be read — moving the state here
    // would silently rewrite the public /status page and the availability
    // series, which read this same check.
    state:
      types.length === 0
        ? 'down'
        : deadLettered > 0
          ? 'degraded'
          : 'ok',
    detail:
      types.length === 0
        ? 'NO provider configured — the owner cannot be warned and no contact can be reached'
        : !dbOk
          ? `${types.join(', ')} configured; delivery records not readable`
          : deadLettered > 0
            ? `${types.join(', ')} configured; ${deadLettered} delivery(s) dead-lettered in the last 24h`
            : deadLetteredAllTime > 0
              // Says the backlog out loud rather than hiding it behind a green
              // tile: the state is ok because nothing failed RECENTLY, and an
              // operator should still know history exists (the queues panel has
              // the number). Windowing must not become forgetting.
              ? `${types.join(', ')} configured; none in the last 24h (${deadLetteredAllTime} older)`
              : `${types.join(', ')} configured`,
    releaseCritical: true,
  });

  // ── AI subsystem (fix plan Part A) ─────────────────────────────────────────
  //
  // NOT release-critical, and that is load-bearing: no release has ever depended
  // on a model call (the worker is AI-free by import-fence test), so a degraded
  // AI tile must never drag the release composite or the published availability
  // figure. worstReleaseCriticalCheck filters on exactly this flag.
  //
  // Why this check needs to exist at all: every AI call site is fail-soft, so a
  // dead model degrades four surfaces to their templates and NOTHING alerts. That
  // is the correct resilience and the wrong observability — and it is on a clock,
  // because an empty GEMINI_MODEL resolves to the auto-updating
  // `gemini-2.5-flash` alias and the 2.5 family retires 2026-10-16.
  //
  // TWO HALVES, AND ONLY ONE OF THEM IS OBSERVABLE (2026-08-11).
  //
  // Health cannot be checked from here — the only honest proof that a credential
  // works is a model call, and this module must not make one: it runs on a
  // 15s admin refresh and on an unauthenticated public route, and the worker
  // samples it once a minute while being pinned AI-FREE by import fence
  // (ai-free-release-path.test.ts). So health is INFERRED from recorded usage,
  // and an idle day infers nothing. `scripts/ai-live-eval.ts` is the thing that
  // proves the credential end to end; the tile points at it rather than
  // pretending to be it.
  //
  // Configuration IS observable, and reporting it is the fix for what the
  // operator actually hit: with the three capability flags ON in production, the
  // tile still said "no model calls attempted today — nothing to infer" and
  // nothing else. That sentence is true and useless — it looks identical whether
  // the subsystem is fully wired or has no credential at all, which is the exact
  // ambiguity this check exists to remove. So the detail now always names the
  // model and the enabled capabilities, and the two configuration faults that
  // used to be invisible have their own states.
  //
  // The EVIDENCE window is 7 days rather than today, for the same reason. Usage
  // on this deployment is sparse, so "today" is empty most days and the last
  // observation gets thrown away daily. State still turns on TODAY's row only —
  // a success three days ago is not evidence of health now, and rule 1 holds —
  // but the detail can say when the model was last known to answer.
  if (dbOk) {
    const windowStartDay = new Date(now.getTime() - (AI_EVIDENCE_WINDOW_DAYS - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const usage = await deps.db
      .select({
        day: schema.aiUsageDaily.day,
        calls: schema.aiUsageDaily.calls,
        failures: schema.aiUsageDaily.failures,
      })
      .from(schema.aiUsageDaily)
      .where(
        and(gte(schema.aiUsageDaily.day, windowStartDay), isNull(schema.aiUsageDaily.userId)),
      )
      .orderBy(desc(schema.aiUsageDaily.day));

    const today = now.toISOString().slice(0, 10);
    const todayRow = usage.find((r) => r.day === today);
    const calls = Number(todayRow?.calls ?? 0);
    const failures = Number(todayRow?.failures ?? 0);
    // Rows are newest-first, so the first row with a success is the most recent
    // day the model is known to have answered.
    const lastSuccess = usage.find((r) => Number(r.calls) > 0);
    const windowFailures = usage.reduce((n, r) => n + Number(r.failures), 0);
    const windowCalls = usage.reduce((n, r) => n + Number(r.calls), 0);

    const ai = deps.ai;
    const config = ai === undefined ? '' : `${describeAiConfig(ai)}; `;
    // A capability flag switched on with no credential behind it is a real
    // fault: every AI surface silently serves its template and nothing alerts.
    // With no capability enabled it is just an unconfigured install, which must
    // stay quiet — AI_ENABLED defaults to true, so crying wolf here would degrade
    // the tile for every deployment that never wanted AI at all.
    const missingCredential = ai !== undefined && ai.killSwitch && !ai.credentialResolved;

    // Starts 'unknown' because that is the answer whenever nothing was observed,
    // and every branch below either proves otherwise or leaves it alone.
    const check: Check = {
      id: 'ai',
      label: 'AI subsystem',
      state: 'unknown',
      detail: '',
      releaseCritical: false,
    };
    if (ai?.killSwitch === false) {
      check.detail = `AI_ENABLED=false — no model call is attempted (${ai.model} configured${ai.capabilities.length > 0 ? `, ${ai.capabilities.join(', ')} would be live` : ''})`;
    } else if (missingCredential) {
      const armed = ai.capabilities.length > 0;
      check.state = armed ? 'degraded' : 'unknown';
      check.detail = armed
        ? `${ai.capabilities.join(', ')} enabled but NO model credential resolved — every AI surface is serving its deterministic template`
        : 'no model credential configured — the AI subsystem is inert';
    } else if (calls > 0) {
      check.state = 'ok';
      check.detail = `${config}${calls} model call(s) succeeded today${failures > 0 ? `, ${failures} failed` : ''}`;
    } else if (failures > 0) {
      check.state = 'degraded';
      check.detail = `${config}every model call today failed (${failures}) — check the model id and credential`;
    } else if (windowCalls === 0 && windowFailures > 0) {
      // No success anywhere in the window and attempts were made: a dead
      // credential or a retired model looks exactly like this.
      check.state = 'degraded';
      check.detail = `${config}nothing succeeded in the last ${AI_EVIDENCE_WINDOW_DAYS} days (${windowFailures} failed) — check the model id and credential`;
    } else if (lastSuccess !== undefined) {
      check.detail = `${config}no model call today — last success ${lastSuccess.day} (${daysBetween(lastSuccess.day, today)})`;
    } else {
      // The eval pointer only where it is actionable: a caller that reported no
      // configuration at all (the worker's sampler) has nobody to point.
      check.detail = `${config}no model call in the last ${AI_EVIDENCE_WINDOW_DAYS} days — nothing to infer${ai === undefined ? '' : '; run scripts/ai-live-eval.ts to prove the credential'}`;
    }
    checks.push(check);
  }

  // ── Backups: the restore attestation ──────────────────────────────────────
  //
  // WHAT THIS TILE DOES NOT CLAIM. It is not a probe of the platform's control
  // plane. Railway holds the schedules and the snapshots, the application cannot
  // see either, and nothing here has changed that. Green does NOT mean "a backup
  // ran last night".
  //
  // WHAT IT DOES CLAIM: that a human restored from a backup, decrypted the
  // result, and recorded the date — the only property anyone actually wants from
  // a backup, and the one a snapshot count never proves. That fact lives in
  // BACKUPS_LAST_VERIFIED_RESTORE, set by the operator from a completed backup
  // restore-drill record — NOT the ceremony recovery drill, which is a separate
  // exercise proving a different property.
  //
  // WHY AN ATTESTATION MAY GO GREEN AT ALL, given rule 1. Because it expires. A
  // hand-set value that stays green forever is exactly the decorative tile rule 1
  // forbids, so this one turns amber by itself after the drill cadence and stays
  // amber until someone drills again and re-dates it. Neglect makes it worse, not
  // better, and the date is on the tile so a reader can judge the claim rather
  // than trusting the colour. Unset is still 'unknown' — the honest answer for a
  // deployment that has never proven a restore, and the state this tile sat in
  // for months while there were no backups AT ALL to verify (docs/38, backlog 0).
  //
  // The alternative considered and rejected: query Railway's API for real backup
  // state. It needs a Railway API token in production, and Railway tokens are
  // workspace-scoped with write access — a credential that can delete the
  // infrastructure, added to a zero-knowledge product's public status path, to
  // colour one non-release-critical tile. The trade is not close.
  // The field is required, so the fallback is for callers that reach this
  // through a cast (the deps builders in the test files do) — and "nothing
  // attested" is the right answer for a caller that supplied nothing.
  const attestation = deps.backups ?? { kind: 'none' };
  if (attestation.kind === 'verified') {
    const ageMs = Math.max(0, now.getTime() - attestation.at.getTime());
    const ageDays = Math.floor(ageMs / DAY_MS);
    const stale = ageDays > RESTORE_ATTESTATION_STALE_AFTER_DAYS;
    const on = attestation.at.toISOString().slice(0, 10);
    checks.push({
      id: 'backups',
      label: 'Database backups',
      state: stale ? 'degraded' : 'ok',
      detail: stale
        ? `restore last verified ${on} (${ageDays} days ago) — OVERDUE, the drill cadence is every ${RESTORE_ATTESTATION_STALE_AFTER_DAYS} days (docs/23)`
        : `restore last verified ${on} (${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`}) — operator-attested from a completed drill; snapshots themselves are platform-managed and not observable from here`,
      releaseCritical: false,
    });
  } else {
    checks.push({
      id: 'backups',
      label: 'Database backups',
      state: 'unknown',
      detail:
        attestation.kind === 'invalid'
          ? `BACKUPS_LAST_VERIFIED_RESTORE ${attestation.why} — treated as no attestation at all`
          : 'no verified restore recorded — snapshots are platform-managed; set BACKUPS_LAST_VERIFIED_RESTORE after a drill (docs/23)',
      releaseCritical: false,
    });
  }

  // ── Queues ─────────────────────────────────────────────────────────────────
  let sensitivePending = 0;
  let sensitiveOverdue = 0;
  let ceremoniesActive = 0;
  if (dbOk) {
    const [p] = await deps.db
      .select({ n: count() })
      .from(schema.sensitiveActions)
      .where(eq(schema.sensitiveActions.status, 'pending'));
    sensitivePending = p?.n ?? 0;
    // Past their effective time and still pending = the worker is not applying.
    const [o] = await deps.db
      .select({ n: count() })
      .from(schema.sensitiveActions)
      .where(
        and(
          eq(schema.sensitiveActions.status, 'pending'),
          lt(schema.sensitiveActions.effectiveAt, now),
        ),
      );
    sensitiveOverdue = o?.n ?? 0;
    const [c] = await deps.db
      .select({ n: count() })
      .from(schema.releaseCeremonies)
      .where(
        sql`${schema.releaseCeremonies.status} in ('initiated','collecting_affirmations','awaiting_outer_key','reconstructing')`,
      );
    ceremoniesActive = c?.n ?? 0;
  }
  if (sensitiveOverdue > 0) {
    checks.push({
      id: 'queue',
      label: 'Action queue',
      state: 'degraded',
      detail: `${sensitiveOverdue} sensitive action(s) past due and still pending — the worker is not applying them`,
      releaseCritical: false,
    });
  } else {
    checks.push({
      id: 'queue',
      label: 'Action queue',
      state: dbOk ? 'ok' : 'unknown',
      detail: dbOk ? `${sensitivePending} pending, none overdue` : 'database unreachable',
      releaseCritical: false,
    });
  }

  // ── The composite ──────────────────────────────────────────────────────────
  // Conjunction over release-critical checks, worst state wins. 'unknown' is
  // deliberately NOT treated as healthy: not knowing whether a release could
  // complete is itself a problem worth a human's attention.
  const critical = checks.filter((c) => c.releaseCritical);
  const worst = critical.reduce<CheckState>((acc, c) => worseOf(acc, c.state), 'ok');
  const failing = critical.filter((c) => c.state !== 'ok');

  return {
    continuityEngine: worst,
    continuitySummary:
      worst === 'ok'
        ? 'Continuity Engine Operational — a release ceremony could complete right now'
        : `Release path ${worst.toUpperCase()} — ${failing.map((c) => c.label).join(', ')}`,
    checks,
    versions: {
      api: deps.apiVersion,
      worker: workerRow?.workerVersion ?? null,
      skew:
        workerRow?.workerVersion != null && workerRow.workerVersion !== deps.apiVersion,
    },
    // null, never the initialised zeros, when nothing could be counted.
    queues: dbOk
      ? {
          notificationsQueued: queued,
          notificationsDeadLettered: deadLetteredAllTime,
          oldestQueuedAgeSeconds,
          sensitiveActionsPending: sensitivePending,
          sensitiveActionsOverdue: sensitiveOverdue,
          ceremoniesActive,
        }
      : null,
    observedAt: now.toISOString(),
  };
}

// The ranking, exported because status_samples persists it as a smallint and the
// availability reader compares against it. One definition: a change here must
// move the migration's comment and nothing else.
//
// 'unknown' outranking 'ok' is the load-bearing part — it is what stops an
// uninstrumented component from counting as healthy, in the composite and in
// every published availability figure alike.
const ORDER: Record<CheckState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

export function stateSeverity(state: CheckState): number {
  return ORDER[state];
}

function worseOf(a: CheckState, b: CheckState): CheckState {
  return ORDER[b] > ORDER[a] ? b : a;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Recent operational events, newest first. Read from the audit log's SYSTEM-level
// events only — never a user's own activity. Kept to event types and timestamps
// so the ops surface stays free of user data even when the underlying rows are
// per-user.
export interface RecentAlert {
  at: string;
  kind: string;
  detail: string;
}

export async function recentAlerts(db: Database, limit = 20): Promise<RecentAlert[]> {
  // Engine-state history is the closest thing to an operational event stream that
  // contains no user-authored content. We surface the TYPE and time only.
  const rows = await db
    .select({
      at: schema.engineStateHistory.occurredAt,
      reason: schema.engineStateHistory.reason,
      toState: schema.engineStateHistory.toState,
    })
    .from(schema.engineStateHistory)
    .where(
      sql`${schema.engineStateHistory.reason} in (
        'all_channels_failing',
        'notification_stall_exhausted',
        'release_review_verification_failed',
        'dispute_raised'
      )`,
    )
    .orderBy(desc(schema.engineStateHistory.occurredAt))
    .limit(limit);

  return rows.map((r) => ({
    at: r.at.toISOString(),
    kind: r.reason,
    detail: `→ ${r.toState}`,
  }));
}

// recentAlerts, but a read failure degrades to null instead of throwing.
//
// This is the same rule as computeAvailabilitySafe, and it was a real defect
// until 2026-08-06: the route awaited the throwing version, so an unreachable
// database took the WHOLE dashboard to a 500 — during the one outage where
// collectSystemStatus had carefully degraded every individual check so the page
// could still be read. The careful per-check degradation was unreachable in
// practice because this one query threw first.
//
// null, not []: "the log could not be read" and "the log is empty" are different
// facts and must not render the same. An empty array is a claim that nothing has
// happened, which during a database outage is precisely what we cannot know.
export async function recentAlertsSafe(
  db: Database,
  limit = 20,
  onError?: (err: unknown) => void,
): Promise<RecentAlert[] | null> {
  try {
    return await recentAlerts(db, limit);
  } catch (err) {
    onError?.(err);
    return null;
  }
}

// ── Account totals ───────────────────────────────────────────────────────────
//
// How many accounts exist, how many are usable, and how many have actually armed
// the engine. Rule 2 above still binds, and this obeys it the only way that is
// testable: integers, computed by aggregate. No per-account row, no email, no id,
// no ordering by anything — there is no query here that could be narrowed to a
// person, and the route serving it still has no user lookup beyond checking the
// caller's own allowlist membership.
//
// Composed by the ROUTE rather than folded into SystemStatus, deliberately, and
// for the same reason recentAlerts is: SystemStatus is what the worker samples
// every tick and what toPublicStatus reduces for the unauthenticated /status
// page. Keeping these counts out of that type means they cannot reach either
// surface by someone forgetting — the public projection has nothing to omit, and
// the sampler pays for no scan it never reads.
export interface AccountTotals {
  total: number;
  // Registered since the start of the current UTC day. UTC rather than the
  // viewer's midnight on purpose: the server owns this number, two admins in
  // two timezones must not be shown different "today"s for the same database,
  // and the page labels it as UTC rather than leaving it to be misread. Still
  // an aggregate — an integer with no row, no ordering, nothing narrowable to a
  // person — so rule 2 holds exactly as it does for the other three.
  registeredToday: number;
  // account_status = 'active'. Everything else is pending / locked / recovery /
  // closed — signed up but not finished, or shut off.
  active: number;
  // Accounts that have armed the engine. Arming is one-way (the state machine has
  // no path back to pre_active and nothing clears users.armed_at), so this is a
  // live count rather than a historical one — and it is the number this dashboard
  // actually cares about: how many people the continuity engine is responsible
  // for right now.
  armed: number;
}

// null when the count could not be taken. NOT zeros: "0 accounts" is a claim, and
// during the database outage that is the only way this fails it would be a false
// one. Same rule as the dashboard's fourth state — absence of evidence never
// renders as a figure. It degrades rather than throwing for the same reason
// collectSystemStatus does: this page is worth loading precisely when something
// is broken, and one failed count must not take the component states with it.
export async function accountTotals(db: Database): Promise<AccountTotals | null> {
  try {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        // `at time zone 'utc'` twice on purpose: the inner one takes now() to a
        // naive UTC wall clock so date_trunc cuts at UTC midnight, the outer one
        // puts that boundary back on the timeline as a timestamptz. Without the
        // outer conversion Postgres would reinterpret the boundary in the
        // SESSION's timezone, and the number would quietly mean "since local
        // midnight on whatever the database happens to be set to".
        registeredToday: sql<number>`cast(count(*) filter (where ${schema.users.createdAt} >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')) as int)`,
        active: sql<number>`cast(count(*) filter (where ${schema.users.accountStatus} = 'active') as int)`,
        armed: sql<number>`cast(count(*) filter (where ${schema.users.armedAt} is not null) as int)`,
      })
      .from(schema.users);
    return row ?? null;
  } catch {
    return null;
  }
}
