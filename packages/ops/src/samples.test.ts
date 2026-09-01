import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import {
  bucketFor,
  computeAvailability,
  computeAvailabilitySafe,
  pruneStatusSamples,
  readHealthSeries,
  readHealthSeriesSafe,
  recordStatusSample,
  worstReleaseCriticalCheck,
  MEASUREMENT_EPOCH,
  MIN_PUBLISHABLE_MS,
  SAMPLE_BUCKET_MS,
} from './samples.js';
import { stateSeverity, type CheckState, type SystemStatus } from './system-status.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

const MINUTE = SAMPLE_BUCKET_MS;
const DAY = 24 * 60 * 60 * 1000;

// These suites are about the WINDOWING arithmetic, not about MEASUREMENT_EPOCH,
// and their fake clocks predate it — so they switch the epoch clamp off. The
// epoch's own behaviour gets its own suite at the bottom of this file, where the
// clock is set after it.
const PRE_EPOCH = new Date(0);

describeIfDb('status samples — the evidence behind a published uptime figure', () => {
  let db: Database;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`TRUNCATE status_samples`;
  });

  // Fill [start, start+count) minute buckets with one state. Bulk-inserted
  // rather than looped through recordStatusSample: a multi-day fixture is
  // thousands of buckets, and one round-trip per row is slow enough to time the
  // suite out. The upsert semantics recordStatusSample owns are covered by the
  // bucket-collision tests below, which call it directly.
  async function fill(start: Date, count: number, state: CheckState): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
      bucketAt: bucketFor(new Date(start.getTime() + i * MINUTE)),
      releasePath: state,
      severity: stateSeverity(state),
      worstCheck: state === 'ok' ? null : 'worker',
      sampledAt: new Date(start.getTime() + i * MINUTE),
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(schema.statusSamples).values(rows.slice(i, i + 1000));
    }
  }

  describe('the missing-sample rule', () => {
    // THE test for this feature. A dead worker writes NOTHING — so a naive
    // ok/observed ratio reports a flawless period for a total outage, because
    // the only samples that exist are the healthy ones from before it died.
    // Availability must divide by the buckets the window SHOULD have had.
    it('counts unwritten samples as unavailable, not as a gap', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      // Two days of window. Healthy for day one, then total silence for day two.
      const start = new Date(now.getTime() - 2 * DAY);
      await fill(start, 24 * 60, 'ok');

      const availability = await computeAvailability({ db, now, windowDays: 2, measurementEpoch: PRE_EPOCH });

      // Observed samples are 100% healthy...
      const [observed] = await db.select().from(schema.statusSamples).limit(1);
      expect(observed).toBeDefined();
      // ...but half the expected buckets are missing, so the figure is ~50%.
      expect(availability.releasePathOkPercent).toBeGreaterThan(45);
      expect(availability.releasePathOkPercent).toBeLessThan(55);
      expect(availability.unobservedMinutes).toBeGreaterThan(1400);
    });

    it('reports 100% only when every expected bucket was observed healthy', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      const start = new Date(now.getTime() - 2 * DAY);
      await fill(start, 2 * 24 * 60, 'ok');

      const availability = await computeAvailability({ db, now, windowDays: 2, measurementEpoch: PRE_EPOCH });
      expect(availability.releasePathOkPercent).toBe(100);
      expect(availability.unobservedMinutes).toBe(0);
    });
  });

  describe('the window never outruns the evidence', () => {
    it('clamps a 90-day request to the observed span', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      const start = new Date(now.getTime() - 3 * DAY);
      await fill(start, 3 * 24 * 60, 'ok');

      const availability = await computeAvailability({ db, now, windowDays: 90, measurementEpoch: PRE_EPOCH });
      expect(availability.requestedWindowDays).toBe(90);
      // Three days of evidence must never be published as a 90-day figure.
      expect(availability.observedDays).toBeCloseTo(3, 0);
      expect(availability.measuringSince).toBe(start.toISOString());
    });

    it('publishes no percentage at all below the minimum evidence threshold', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      const start = new Date(now.getTime() - (MIN_PUBLISHABLE_MS - 60 * MINUTE));
      await fill(start, 60, 'ok');

      const availability = await computeAvailability({ db, now, windowDays: 90, measurementEpoch: PRE_EPOCH });
      // A number computed from a few hours is meaningless on a public page.
      expect(availability.releasePathOkPercent).toBeNull();
      expect(availability.measuringSince).not.toBeNull();
    });

    it('reports nothing measured when the series is empty', async () => {
      const availability = await computeAvailability({
        db,
        now: new Date('2026-07-30T12:00:00.000Z'),
        windowDays: 90,
      });
      expect(availability.measuringSince).toBeNull();
      expect(availability.releasePathOkPercent).toBeNull();
      expect(availability.observedDays).toBe(0);
    });
  });

  // 2026-08-09. Until 1041bdb the notifications check counted dead letters
  // ALL-TIME, so nine days of samples recorded a MEASUREMENT bug as an outage
  // and the public page published 0.1%. The rows are kept — deleting samples we
  // have judged wrong is exactly the failure the missing-sample rule above
  // exists to prevent, performed on purpose — so the public figure is clamped
  // instead.
  // ── The 100.1% bug (QA 2026-08-10 F-03) ────────────────────────────────────
  //
  // `/v1/status` published releasePathOkPercent: 100.1 — arithmetically
  // impossible, on the page whose whole argument is that its numbers are
  // conservative and never flatter.
  //
  // The denominator was floor(spanMs / SAMPLE_BUCKET_MS) while the queries
  // filtered a CLOSED range on minute-aligned bucketAt values. When the two ends
  // of the span are aligned differently, those disagree by exactly one bucket:
  // production had windowStart pinned to MEASUREMENT_EPOCH (aligned, :30:00) and
  // `now` at whatever instant the request arrived, so ~1508.5 minutes floored to
  // 1508 while the range contained 1509 — and 1509/1508 rounds to 100.1%.
  //
  // WHY 1,547 TESTS MISSED IT, and what these fixtures do differently: every
  // other case in this file uses a minute-aligned `now`, where floor() is exact.
  // A ragged `now` alone is not enough either — when the window is clamped by
  // `now - requestedMs` the start goes ragged in the same way and the error
  // cancels. It needs an ALIGNED start (the epoch, or the oldest sample) against
  // a RAGGED now, which is what a 90-day request over two days of evidence
  // produces, and what production does on every single call.
  describe('a window whose ends are aligned differently', () => {
    // Aligned start, 30.5 s past the minute for `now`: the real shape.
    const START = new Date('2026-07-28T12:00:00.000Z');
    const RAGGED_NOW = new Date('2026-07-29T12:00:30.500Z');
    // 90 days requested over ~1 day of evidence, so windowStart is the oldest
    // SAMPLE (aligned) rather than now - requestedMs (ragged).
    const ragged = { windowDays: 90, now: RAGGED_NOW, measurementEpoch: PRE_EPOCH };

    it('never publishes more than 100% (this returned 100.1)', async () => {
      // Every bucket healthy, INCLUDING the in-progress minute the worker has
      // already written — the best case, and where the overflow appeared.
      await fill(START, 24 * 60 + 1, 'ok');

      const availability = await computeAvailability({ db, ...ragged });
      expect(availability.releasePathOkPercent).toBe(100);
    });

    it('reports no negative unobserved minutes — the clamp was hiding the same off-by-one', async () => {
      await fill(START, 24 * 60 + 1, 'ok');

      const availability = await computeAvailability({ db, ...ragged });
      // Math.max(0, …) pinned this to 0 whatever the arithmetic did, which is
      // why only the percentage ever surfaced the fault.
      expect(availability.unobservedMinutes).toBe(0);
    });

    it('still counts a real gap against availability on a ragged window', async () => {
      // Healthy for twelve hours, silent for the rest. The missing-sample rule
      // has to survive the alignment fix, not be traded away for it.
      await fill(START, 12 * 60, 'ok');

      const availability = await computeAvailability({ db, ...ragged });
      expect(availability.releasePathOkPercent).toBeGreaterThan(45);
      expect(availability.releasePathOkPercent).toBeLessThan(55);
      expect(availability.unobservedMinutes).toBeGreaterThan(700);
    });

    // The bucket containing `now` is still in progress: the worker writes it at
    // some point DURING the minute, so charging the window for it would leave a
    // permanent one-minute deficit no healthy system could ever clear.
    it('does not charge the window for the in-progress minute', async () => {
      // Every COMPLETE minute observed; the current one not yet written.
      await fill(START, 24 * 60, 'ok');

      const availability = await computeAvailability({ db, ...ragged });
      expect(availability.releasePathOkPercent).toBe(100);
      expect(availability.unobservedMinutes).toBe(0);
    });
  });

  describe('the measurement epoch', () => {
    const AFTER = new Date(MEASUREMENT_EPOCH.getTime() + 3 * DAY);

    it('excludes pre-epoch samples from the numerator AND the denominator', async () => {
      // Two days of "outage" that never happened, then two days of real health.
      // Counting the prefix at all — even only in the denominator — would publish
      // ~50%, which is the bug wearing a smaller number.
      await fill(new Date(MEASUREMENT_EPOCH.getTime() - 2 * DAY), 2 * 24 * 60, 'degraded');
      await fill(MEASUREMENT_EPOCH, 3 * 24 * 60, 'ok');

      const availability = await computeAvailability({ db, now: AFTER, windowDays: 90 });
      expect(availability.releasePathOkPercent).toBe(100);
      expect(availability.unobservedMinutes).toBe(0);
      expect(availability.observedDays).toBeCloseTo(3, 0);
    });

    it('reports measuringSince as the EPOCH, not the older first sample', async () => {
      // The regression guard. measuringSince is rendered directly beside the
      // percentage — "Measuring since X" next to "N% of the last D days" — so
      // leaving it at the oldest row while the figure covers only the post-epoch
      // span makes the page contradict itself, and the sentence is the false
      // half. That is worse than either publishing the bad number or deleting
      // the rows, which is why this assertion exists rather than being implied
      // by the one above.
      await fill(new Date(MEASUREMENT_EPOCH.getTime() - 2 * DAY), 2 * 24 * 60, 'degraded');
      await fill(MEASUREMENT_EPOCH, 3 * 24 * 60, 'ok');

      const availability = await computeAvailability({ db, now: AFTER, windowDays: 90 });
      expect(availability.measuringSince).toBe(MEASUREMENT_EPOCH.toISOString());
    });

    it('publishes no percentage for the first 24h after the epoch', async () => {
      // The good property of restarting the window: the page goes quiet rather
      // than jumping to a suspicious 100% the moment the fix lands.
      await fill(new Date(MEASUREMENT_EPOCH.getTime() - 5 * DAY), 5 * 24 * 60, 'degraded');
      const soon = new Date(MEASUREMENT_EPOCH.getTime() + 6 * 60 * MINUTE);
      await fill(MEASUREMENT_EPOCH, 6 * 60, 'ok');

      const availability = await computeAvailability({ db, now: soon, windowDays: 90 });
      expect(availability.releasePathOkPercent).toBeNull();
      expect(availability.measuringSince).toBe(MEASUREMENT_EPOCH.toISOString());
    });

    it('leaves the ADMIN timeline unclamped — the rows are kept to be seen', async () => {
      // The whole justification for clamping rather than deleting. If the admin
      // series moved with the public one, the evidence would be invisible in
      // practice and the choice would collapse into a purge with extra steps.
      const oldest = new Date(MEASUREMENT_EPOCH.getTime() - 2 * DAY);
      await fill(oldest, 2 * 24 * 60, 'degraded');
      await fill(MEASUREMENT_EPOCH, 3 * 24 * 60, 'ok');

      const series = await readHealthSeries({ db, now: AFTER });
      expect(series.measuringSince).toBe(bucketFor(oldest).toISOString());
    });

    it('defaults to clamping — a caller cannot forget to opt in', async () => {
      // The parameter exists for the tests above; the DEFAULT is what production
      // gets, and the fail-safe direction is to clamp rather than to publish the
      // poisoned prefix because someone omitted a field.
      await fill(new Date(MEASUREMENT_EPOCH.getTime() - 2 * DAY), 2 * 24 * 60, 'degraded');
      await fill(MEASUREMENT_EPOCH, 3 * 24 * 60, 'ok');

      const defaulted = await computeAvailability({ db, now: AFTER, windowDays: 90 });
      const explicit = await computeAvailability({
        db,
        now: AFTER,
        windowDays: 90,
        measurementEpoch: MEASUREMENT_EPOCH,
      });
      expect(defaulted).toEqual(explicit);
    });
  });

  describe('unknown is never healthy', () => {
    it('excludes unknown samples from the ok count', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      const start = new Date(now.getTime() - 2 * DAY);
      await fill(start, 24 * 60, 'ok');
      await fill(new Date(start.getTime() + 24 * 60 * MINUTE), 24 * 60, 'unknown');

      const availability = await computeAvailability({ db, now, windowDays: 2, measurementEpoch: PRE_EPOCH });
      // Every bucket was observed — none are missing — but half were 'unknown',
      // which must not round up into the healthy total.
      expect(availability.unobservedMinutes).toBe(0);
      expect(availability.releasePathOkPercent).toBeGreaterThan(45);
      expect(availability.releasePathOkPercent).toBeLessThan(55);
    });
  });

  describe('bucket collisions', () => {
    it('lets the worse severity win, whichever worker writes second', async () => {
      const at = new Date('2026-07-30T12:00:30.000Z');
      await recordStatusSample({ db, at, releasePath: 'down', worstCheck: 'worker' });
      // A second worker, same minute, disagreeing optimistically.
      await recordStatusSample({ db, at, releasePath: 'ok', worstCheck: null });

      const [row] = await db.select().from(schema.statusSamples);
      expect(row?.releasePath).toBe('down');
      expect(row?.worstCheck).toBe('worker');
    });

    it('upgrades a healthy bucket when a worker observes a problem', async () => {
      const at = new Date('2026-07-30T12:00:30.000Z');
      await recordStatusSample({ db, at, releasePath: 'ok', worstCheck: null });
      await recordStatusSample({ db, at, releasePath: 'degraded', worstCheck: 'notifications' });

      const [row] = await db.select().from(schema.statusSamples);
      expect(row?.releasePath).toBe('degraded');
    });

    it('coalesces every write in a minute onto one row', async () => {
      const base = new Date('2026-07-30T12:00:00.000Z');
      for (let s = 0; s < 60; s += 5) {
        await recordStatusSample({
          db,
          at: new Date(base.getTime() + s * 1000),
          releasePath: 'ok',
          worstCheck: null,
        });
      }
      const rows = await db.select().from(schema.statusSamples);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.bucketAt.toISOString()).toBe(bucketFor(base).toISOString());
    });
  });

  describe('a failed read is not evidence of uptime', () => {
    it('degrades to no figure instead of throwing', async () => {
      // The status page is worth loading precisely during an outage, and
      // collectSystemStatus already degrades per check rather than throwing. If
      // this read threw instead, a database problem would blank the whole page
      // and discard the component states we DO know.
      const broken = {
        select: () => {
          throw new Error('relation "status_samples" does not exist');
        },
      } as unknown as Database;

      const errors: unknown[] = [];
      const availability = await computeAvailabilitySafe(
        { db: broken, now: new Date('2026-07-30T12:00:00.000Z'), windowDays: 90 },
        (err) => errors.push(err),
      );

      expect(availability.releasePathOkPercent).toBeNull();
      expect(availability.measuringSince).toBeNull();
      // The caller still learns which window was asked for, and the failure is
      // surfaced to the log rather than swallowed silently.
      expect(availability.requestedWindowDays).toBe(90);
      expect(errors).toHaveLength(1);
    });

    it('returns the real figure when the read succeeds', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      await fill(new Date(now.getTime() - 2 * DAY), 2 * 24 * 60, 'ok');
      const availability = await computeAvailabilitySafe({ db, now, windowDays: 2, measurementEpoch: PRE_EPOCH });
      expect(availability.releasePathOkPercent).toBe(100);
    });
  });

  describe('retention', () => {
    it('drops samples past the window and keeps the rest', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      await fill(new Date(now.getTime() - 100 * DAY), 5, 'ok');
      await fill(new Date(now.getTime() - 2 * DAY), 5, 'ok');

      const deleted = await pruneStatusSamples(db, now, 90);
      expect(deleted).toBe(5);
      const rows = await db.select().from(schema.statusSamples);
      expect(rows).toHaveLength(5);
    });
  });

  // The admin timeline strip. Same series, same missing-sample rule as the
  // availability figure above — if these two ever disagree about a minute, one
  // of them is lying to somebody.
  describe('the health series (the admin strip)', () => {
    const HOUR = 60 * MINUTE;

    it('returns one bucket per interval across the whole window', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      const series = await readHealthSeries({ db, now, windowMs: 24 * HOUR, bucketMs: 5 * MINUTE });
      expect(series.buckets).toHaveLength((24 * 60) / 5);
      expect(series.bucketMinutes).toBe(5);
    });

    it('renders an unsampled bucket as null — never as ok, never as absent', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      // One hour of health, then silence to the present. Started one bucket
      // inside the window: the series is bucket-aligned and half-open at the
      // start, so a fixture beginning exactly at now-4h loses its first minutes
      // to the boundary and the arithmetic below stops being obvious.
      await fill(new Date(now.getTime() - 4 * HOUR + 5 * MINUTE), 60, 'ok');

      const series = await readHealthSeries({ db, now, windowMs: 4 * HOUR, bucketMs: 5 * MINUTE });
      const sampled = series.buckets.filter((b) => b.severity !== null);
      const missing = series.buckets.filter((b) => b.severity === null);

      expect(sampled).toHaveLength(12); // 60 minutes / 5
      expect(sampled.every((b) => b.severity === 0)).toBe(true);
      // The silence is REPORTED, not skipped. The worker writes these rows, so
      // the stretch where it wrote nothing is part of the outage — a strip that
      // simply omitted them would draw a dead worker as an uneventful morning.
      expect(missing.length).toBeGreaterThan(0);
      expect(series.unobservedBuckets).toBe(missing.length);
      expect(series.buckets).toHaveLength(sampled.length + missing.length);
    });

    it('takes the WORST minute in a bucket, not the last or the average', async () => {
      const now = new Date('2026-07-30T12:00:00.000Z');
      const start = new Date(now.getTime() - 5 * MINUTE);
      // Four healthy minutes and one down minute inside one 5-minute bucket. A
      // bucket that averaged, or took the newest, would erase the outage.
      await fill(start, 4, 'ok');
      await fill(new Date(start.getTime() + 4 * MINUTE), 1, 'down');

      const series = await readHealthSeries({ db, now, windowMs: HOUR, bucketMs: 5 * MINUTE });
      const worst = series.buckets.filter((b) => b.severity !== null);
      expect(worst.some((b) => b.severity === stateSeverity('down'))).toBe(true);
      // And the cause travels with it, so the strip can name what drove it.
      expect(worst.find((b) => b.severity === stateSeverity('down'))?.worstCheck).toBe('worker');
    });

    it('degrades to null rather than throwing when the series cannot be read', async () => {
      const broken = {
        select: () => {
          throw new Error('connection terminated unexpectedly');
        },
      } as unknown as Database;
      // The timeline must never be the reason the dashboard fails to render the
      // outage it exists to record.
      expect(await readHealthSeriesSafe({ db: broken, now: new Date() })).toBeNull();
    });
  });
});

describe('worstReleaseCriticalCheck', () => {
  function status(checks: SystemStatus['checks']): SystemStatus {
    return {
      continuityEngine: 'ok',
      continuitySummary: '',
      checks,
      versions: { api: 'v', worker: null, skew: false },
      queues: {
        notificationsQueued: 0,
        notificationsDeadLettered: 0,
        oldestQueuedAgeSeconds: null,
        sensitiveActionsPending: 0,
        sensitiveActionsOverdue: 0,
        ceremoniesActive: 0,
      },
      observedAt: '2026-07-30T12:00:00.000Z',
    };
  }

  it('names the worst release-critical check', () => {
    const s = status([
      { id: 'database', label: 'Database', state: 'degraded', detail: '', releaseCritical: true },
      { id: 'worker', label: 'Worker', state: 'down', detail: '', releaseCritical: true },
    ]);
    expect(worstReleaseCriticalCheck(s)).toBe('worker');
  });

  it('ignores supporting checks entirely', () => {
    // The composite is a conjunction over release-critical checks only, so a
    // failing supporting check must never be recorded as the cause of a red
    // release path.
    const s = status([
      { id: 'database', label: 'Database', state: 'ok', detail: '', releaseCritical: true },
      { id: 'backups', label: 'Backups', state: 'unknown', detail: '', releaseCritical: false },
    ]);
    expect(worstReleaseCriticalCheck(s)).toBeNull();
  });
});
