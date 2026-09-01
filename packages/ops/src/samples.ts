import { schema, type Database } from '@truecairn/db';
import { and, asc, count, eq, gte, lte, sql } from 'drizzle-orm';
import { stateSeverity, type CheckState, type SystemStatus } from './system-status.js';

// ── The health time series behind the published availability figure ──────────
//
// Written by the worker after every tick (apps/worker/src/status-sample.ts),
// read by the public status route. See migration 0055 for why a new table was
// needed at all.
//
// THE ARITHMETIC IS THE POINT. Availability is
//
//     buckets observed OK  /  buckets the window SHOULD have contained
//
// and NOT ok/observed. Those two differ exactly when the worker was not running
// — which is the outage that matters most here, because the worker is the sole
// release driver and its death is invisible to every other probe. Dividing by
// observed samples would score a dead worker as 100%: it writes nothing, so
// every sample that does exist is a healthy one. Dividing by expected buckets
// scores the silence as downtime, which is what actually happened.
//
// The same rule as the dashboard's fourth state, applied to time instead of
// components: absence of evidence is never evidence of health.

// One sample per minute. Workers tick far more often than this; the bucket
// coalesces them so the series is a clock, not a function of poll interval.
export const SAMPLE_BUCKET_MS = 60_000;

// How much observation must exist before a percentage is published at all. A
// figure computed from six minutes of evidence is not wrong so much as
// meaningless, and putting it on a public page invites exactly the "invented
// uptime" reading /status exists to avoid. Below this the route reports the
// observed span and no number.
export const MIN_PUBLISHABLE_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RETENTION_DAYS = 90;

// THE INSTRUMENT, NOT THE SERVICE, WAS BROKEN BEFORE THIS INSTANT.
//
// Until 1041bdb (deployed 2026-08-08T21:27:40Z) the `notifications` check
// counted dead-lettered deliveries ALL-TIME rather than in a window. That check
// is release-critical and the composite is a conjunction over the
// release-critical checks, so one dead letter from any point in history made
// every sample the worker wrote record a MEASUREMENT bug as an outage. Nine days
// of rows say the release path was down. It was not.
//
// Those rows are kept. They are real evidence — about the monitor — and the
// admin timeline still shows them; readHealthSeries is deliberately NOT clamped.
// They are simply not evidence about the release path, so the PUBLIC figure
// starts here.
//
// WHY NOT DELETE THEM. The rule this whole module is built on is that a missing
// sample counts as unavailable, not as a gap — because the sampler lives in the
// worker and must not be able to improve the published number by going silent.
// Deleting samples we have judged wrong is that same failure performed
// deliberately, and once it is an available move it is available for a real
// outage too. Clamping publishes no false number AND destroys no evidence;
// anyone auditing the claim later can still read what the monitor said.
//
// A repo constant rather than an env var, for the reason WITHDRAWN_CHANNEL_TYPES
// is one: moving it is a reviewed commit with a comment attached, not a variable
// someone can change at 2am. Goes inert on its own once the 90-day retention
// prunes the pre-epoch rows (~2026-11-06).
export const MEASUREMENT_EPOCH = new Date('2026-08-08T21:30:00.000Z');

export function bucketFor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS);
}

export interface RecordSampleInput {
  db: Database;
  at: Date;
  releasePath: CheckState;
  // The release-critical check that drove a non-ok composite. A check ID from a
  // fixed set — never an error string; this row is read by a public route.
  worstCheck: string | null;
}

// Upsert on the minute bucket, WORSE severity winning a collision.
//
// Two workers sampling the same minute and disagreeing means at least one of
// them observed a problem, and a status page must not let the optimistic
// observer erase it. The setWhere clause is what makes the write order-
// independent: whichever worker lands second, the row ends up at the worse of
// the two — so the series cannot be improved by a retry, a restart, or a second
// replica coming online.
export async function recordStatusSample(input: RecordSampleInput): Promise<void> {
  const { db, at, releasePath, worstCheck } = input;
  const severity = stateSeverity(releasePath);
  await db
    .insert(schema.statusSamples)
    .values({
      bucketAt: bucketFor(at),
      releasePath,
      severity,
      worstCheck,
      sampledAt: at,
    })
    .onConflictDoUpdate({
      target: schema.statusSamples.bucketAt,
      set: { releasePath, severity, worstCheck, sampledAt: at },
      setWhere: sql`${schema.statusSamples.severity} < ${severity}`,
    });
}

// Drop samples past the retention window. Called on the same cadence as the
// write; the table is one narrow row per minute (~525k/year) so this is cheap
// and mostly about not keeping evidence longer than we publish it.
export async function pruneStatusSamples(
  db: Database,
  now: Date,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(schema.statusSamples)
    .where(lte(schema.statusSamples.bucketAt, cutoff))
    .returning({ bucketAt: schema.statusSamples.bucketAt });
  return deleted.length;
}

export interface Availability {
  // The honest start of the evidence the figure below is computed from: the
  // oldest retained sample, or MEASUREMENT_EPOCH when that is later. null when
  // nothing has ever been sampled. It moves WITH the window start rather than
  // reporting the oldest row, because the page renders the two side by side.
  measuringSince: string | null;
  // The window actually covered, which is min(requested, observed). Never the
  // requested window when we have not been watching that long.
  observedDays: number;
  requestedWindowDays: number;
  // Percent of expected buckets observed OK, to one decimal. null when there is
  // not yet enough evidence to publish one (see MIN_PUBLISHABLE_MS).
  releasePathOkPercent: number | null;
  // Buckets the window should have contained but which hold no sample at all —
  // the worker was not running, or could not write. Counted AGAINST availability
  // above, and reported separately so the page can say so out loud rather than
  // burying it in the percentage.
  unobservedMinutes: number;
}

export interface AvailabilityInput {
  db: Database;
  now: Date;
  windowDays: number;
  // Samples before this instant are not evidence about the release path — see
  // MEASUREMENT_EPOCH. Optional, and it DEFAULTS to the real epoch rather than
  // to "no clamp", so a caller cannot forget to opt in and publish the poisoned
  // prefix. Tests that are about the windowing arithmetic rather than the epoch
  // pass an old date to switch it off.
  measurementEpoch?: Date;
}

export async function computeAvailability(input: AvailabilityInput): Promise<Availability> {
  const { db, now, windowDays } = input;
  const requestedMs = windowDays * 24 * 60 * 60 * 1000;

  const [first] = await db
    .select({ bucketAt: schema.statusSamples.bucketAt })
    .from(schema.statusSamples)
    .orderBy(asc(schema.statusSamples.bucketAt))
    .limit(1);

  if (first === undefined) {
    return {
      measuringSince: null,
      observedDays: 0,
      requestedWindowDays: windowDays,
      releasePathOkPercent: null,
      unobservedMinutes: 0,
    };
  }

  // Clamp the window to when we actually started watching. Reporting a 90-day
  // figure after three days of sampling would be the invented number this whole
  // mechanism exists to avoid — the window shrinks to the evidence, never the
  // other way round. The epoch is the third floor: samples the broken check
  // wrote are not evidence about the release path.
  const epoch = input.measurementEpoch ?? MEASUREMENT_EPOCH;
  const windowStart = new Date(
    Math.max(now.getTime() - requestedMs, first.bucketAt.getTime(), epoch.getTime()),
  );
  const spanMs = now.getTime() - windowStart.getTime();

  // measuringSince must move WITH windowStart, not report the oldest row. It is
  // rendered directly beside the percentage ("Measuring since X" next to "N% of
  // the last D days"), so leaving it at first.bucketAt while the figure covers
  // only the post-epoch span makes the page contradict itself — and the sentence
  // would be the false half, on the page whose whole argument is that it does not
  // claim more measurement than it has.
  const measuringSince = new Date(
    Math.max(first.bucketAt.getTime(), Math.min(epoch.getTime(), now.getTime())),
  ).toISOString();

  // THE DENOMINATOR MUST BE THE SAME SET THE QUERIES COUNT.
  //
  // `expectedBuckets = floor(spanMs / SAMPLE_BUCKET_MS)` was not, and the page
  // published 100.1% on 2026-08-10. bucketAt values are minute-aligned and the
  // range below is closed, so a span of ~1508.5 minutes floors to 1508 while the
  // range [windowStart, now] actually contains 1509 aligned instants — one more
  // bucket than the divisor admits exists. Every test used a minute-aligned
  // `now`, where floor() is exact and the two agree; production never does.
  //
  // So both ends are aligned here and the endpoints are reused verbatim in the
  // WHERE clauses. Counting the instants instead of dividing the span makes
  // okBuckets <= expectedBuckets structural rather than something to clamp
  // afterwards — a clamp would have produced a plausible number over arithmetic
  // that was still wrong, on the one page whose entire argument is that its
  // figures never flatter.
  //
  // The window ends at the last COMPLETE minute: the bucket containing `now` is
  // still in progress and the worker may not have written it yet, so counting it
  // as expected would charge us for a minute that has not finished.
  const firstBucket = Math.ceil(windowStart.getTime() / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS;
  const lastBucket =
    Math.floor(now.getTime() / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS - SAMPLE_BUCKET_MS;
  const expectedBuckets =
    lastBucket < firstBucket ? 0 : (lastBucket - firstBucket) / SAMPLE_BUCKET_MS + 1;
  const rangeStart = new Date(firstBucket);
  const rangeEnd = new Date(lastBucket);

  if (spanMs < MIN_PUBLISHABLE_MS || expectedBuckets <= 0) {
    return {
      measuringSince,
      observedDays: round1(spanMs / (24 * 60 * 60 * 1000)),
      requestedWindowDays: windowDays,
      releasePathOkPercent: null,
      unobservedMinutes: 0,
    };
  }

  const [observed] = await db
    .select({ n: count() })
    .from(schema.statusSamples)
    .where(
      and(
        gte(schema.statusSamples.bucketAt, rangeStart),
        lte(schema.statusSamples.bucketAt, rangeEnd),
      ),
    );
  const [healthy] = await db
    .select({ n: count() })
    .from(schema.statusSamples)
    .where(
      and(
        gte(schema.statusSamples.bucketAt, rangeStart),
        lte(schema.statusSamples.bucketAt, rangeEnd),
        // severity 0 is 'ok' and nothing else. Written as the severity rather
        // than the text so a future state name cannot accidentally count as
        // healthy by sorting into the wrong branch.
        eq(schema.statusSamples.severity, 0),
      ),
    );

  const okBuckets = healthy?.n ?? 0;
  const observedBuckets = observed?.n ?? 0;

  return {
    measuringSince,
    observedDays: round1(spanMs / (24 * 60 * 60 * 1000)),
    requestedWindowDays: windowDays,
    // Denominator is EXPECTED, not observed — see the header comment.
    releasePathOkPercent: round1((okBuckets / expectedBuckets) * 100),
    // No clamp. The count and the range are now the same set of buckets, and
    // bucketAt is unique, so this cannot go negative. The Math.max(0, …) that
    // used to be here was hiding the identical off-by-one that reached the page
    // as 100.1% — it made one symptom of a broken denominator look correct
    // while leaving the other on a public page.
    unobservedMinutes: expectedBuckets - observedBuckets,
  };
}

// What we publish when the series cannot be read at all: no figure, no window,
// no claim. Exported so the route cannot invent its own softer fallback.
export const NO_AVAILABILITY: Availability = {
  measuringSince: null,
  observedDays: 0,
  requestedWindowDays: 0,
  releasePathOkPercent: null,
  unobservedMinutes: 0,
};

// computeAvailability, but a read failure degrades instead of throwing.
//
// This lives here rather than in the route because it is the same rule as the
// arithmetic above: a failed read is NOT evidence of uptime. The status page is
// worth loading precisely during an outage, and collectSystemStatus already
// degrades per check (an unreachable database reports 'down' rather than
// throwing) — so the availability read has to degrade the same way, or a
// database outage turns the whole page into a blank error and discards the
// component states we do know.
export async function computeAvailabilitySafe(
  input: AvailabilityInput,
  onError?: (err: unknown) => void,
): Promise<Availability> {
  try {
    return await computeAvailability(input);
  } catch (err) {
    onError?.(err);
    return { ...NO_AVAILABILITY, requestedWindowDays: input.windowDays };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── The health series, bucketed for display (2026-08-06) ─────────────────────
//
// The admin timeline strip. Same table, same rule as computeAvailability — this
// is the ARITHMETIC rendered instead of summarised, so it has to agree with the
// percentage on the public page or one of them is lying.
//
// 1440 one-minute samples cannot be a legible strip at any width, so minutes
// coalesce into display buckets with WORST SEVERITY WINNING, exactly as two
// workers colliding on one minute do. A bucket that should contain minutes but
// holds no sample at all is `null`, and null is NOT a gap in the evidence: the
// worker writes these rows, so the outage that erases its own record is the one
// that matters most. The renderer draws null as unavailable, never as blank and
// never as its neighbours' colour.
export interface HealthBucket {
  at: string;
  // 0 ok / 1 unknown / 2 degraded / 3 down, or null when the window contained
  // no sample at all.
  severity: number | null;
  // The release-critical check that drove the worst minute in the bucket.
  worstCheck: string | null;
}

export interface HealthSeries {
  buckets: HealthBucket[];
  bucketMinutes: number;
  from: string;
  to: string;
  // Buckets with no sample, counted out so the page can say so in words rather
  // than leaving it to be read off the hatching.
  unobservedBuckets: number;
  // Oldest sample retained, so a young deployment can say how long it has been
  // watching instead of implying the whole window is evidence.
  measuringSince: string | null;
}

export const DEFAULT_SERIES_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SERIES_BUCKET_MS = 5 * 60 * 1000;

export interface HealthSeriesInput {
  db: Database;
  now: Date;
  windowMs?: number;
  bucketMs?: number;
}

export async function readHealthSeries(input: HealthSeriesInput): Promise<HealthSeries> {
  const { db, now } = input;
  const windowMs = input.windowMs ?? DEFAULT_SERIES_WINDOW_MS;
  const bucketMs = input.bucketMs ?? DEFAULT_SERIES_BUCKET_MS;

  // Align the window to bucket boundaries so the strip is a clock: the same
  // minute always lands in the same cell, and a refresh does not reshuffle it.
  const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
  const start = end - windowMs;
  const bucketCount = Math.floor(windowMs / bucketMs);

  const rows = await db
    .select({
      bucketAt: schema.statusSamples.bucketAt,
      severity: schema.statusSamples.severity,
      worstCheck: schema.statusSamples.worstCheck,
    })
    .from(schema.statusSamples)
    .where(
      and(
        gte(schema.statusSamples.bucketAt, new Date(start)),
        lte(schema.statusSamples.bucketAt, new Date(end)),
      ),
    )
    .orderBy(asc(schema.statusSamples.bucketAt));

  const [first] = await db
    .select({ bucketAt: schema.statusSamples.bucketAt })
    .from(schema.statusSamples)
    .orderBy(asc(schema.statusSamples.bucketAt))
    .limit(1);

  const buckets: HealthBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    at: new Date(start + i * bucketMs).toISOString(),
    severity: null,
    worstCheck: null,
  }));

  for (const row of rows) {
    const idx = Math.floor((row.bucketAt.getTime() - start) / bucketMs);
    const bucket = buckets[idx];
    if (bucket === undefined) continue;
    // Worst wins, and the worst minute's cause is the bucket's cause.
    if (bucket.severity === null || row.severity > bucket.severity) {
      bucket.severity = row.severity;
      bucket.worstCheck = row.worstCheck;
    }
  }

  return {
    buckets,
    bucketMinutes: Math.round(bucketMs / 60_000),
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    unobservedBuckets: buckets.filter((b) => b.severity === null).length,
    measuringSince: first?.bucketAt.toISOString() ?? null,
  };
}

// readHealthSeries, degrading to an empty series rather than throwing — the
// timeline must never be the reason the dashboard fails to render during the
// database outage it exists to record.
export async function readHealthSeriesSafe(
  input: HealthSeriesInput,
  onError?: (err: unknown) => void,
): Promise<HealthSeries | null> {
  try {
    return await readHealthSeries(input);
  } catch (err) {
    onError?.(err);
    return null;
  }
}

// The check that drove a non-ok composite, for the stored sample. Release-
// critical only: the composite is a conjunction over exactly those, so a
// degraded supporting check must never be recorded as the cause of a red
// release path.
export function worstReleaseCriticalCheck(status: SystemStatus): string | null {
  let worst: { id: string; severity: number } | null = null;
  for (const check of status.checks) {
    if (!check.releaseCritical) continue;
    const severity = stateSeverity(check.state);
    if (severity === 0) continue;
    if (worst === null || severity > worst.severity) worst = { id: check.id, severity };
  }
  return worst?.id ?? null;
}
