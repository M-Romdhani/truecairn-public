import { schema } from '@truecairn/db';
import { desc, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

// How stale the freshest worker tick may be before /health/worker reports down.
// The worker polls on WORKER_POLL_INTERVAL_MS (seconds in production), so minutes
// of silence is already pathological — but the threshold is generous enough that
// a slow tick or a brief restart does not page anyone.
const WORKER_STALE_AFTER_MS = 5 * 60 * 1000;

// DB-backed readiness probe (the 3.0 scaffold deferred this to 3.1). /health
// stays DB-free and always answerable; /ready reports whether the database is
// reachable: 200 {status:'ready'} or 503 {status:'not_ready'}. A load balancer
// routes traffic on /ready while keeping the instance alive on /health.
export function readyRoutes(app: FastifyInstance): void {
  app.get(
    '/ready',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', enum: ['ready'] } },
          },
          503: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', enum: ['not_ready'] } },
          },
        },
      },
    },
    async (_request, reply) => {
      const db = app.db;
      if (db === null) {
        void reply.status(503);
        return { status: 'not_ready' as const };
      }
      try {
        await db.execute(sql`select 1`);
        return { status: 'ready' as const };
      } catch (err) {
        app.log.error({ err }, 'ready.db_unreachable');
        void reply.status(503);
        return { status: 'not_ready' as const };
      }
    },
  );

  // ── Worker liveness (2026-07-25) ──────────────────────────────────────────
  //
  // The worker is the sole release driver (CLAUDE.md invariant 7). If it dies,
  // nothing releases, nothing escalates and no ceremony advances — while /health
  // and /ready both stay green, because the API and database are perfectly fine.
  // That is the most dangerous failure this system has: total, silent, and
  // invisible to every probe that existed before this one.
  //
  // DELIBERATELY SEPARATE FROM /ready. A stale worker must not make the API look
  // unready — the platform would restart or depool a healthy web service and fix
  // nothing. This endpoint is for an uptime monitor to alert a human on.
  //
  // Reads the freshest row across all workers: they scale horizontally and one
  // live worker is enough to drive releases.
  app.get('/health/worker', async (_request, reply) => {
    const db = app.db;
    if (db === null) {
      void reply.status(503);
      return { status: 'unknown' as const, reason: 'no database' };
    }
    try {
      const [row] = await db
        .select()
        .from(schema.workerHeartbeats)
        .orderBy(desc(schema.workerHeartbeats.lastTickAt))
        .limit(1);

      if (row === undefined) {
        // No worker has EVER ticked against this database. Fail closed and loud:
        // silence here is indistinguishable from a worker that never started.
        void reply.status(503);
        return { status: 'down' as const, reason: 'no worker has ever recorded a tick' };
      }

      const ageMs = Date.now() - row.lastTickAt.getTime();
      if (ageMs > WORKER_STALE_AFTER_MS) {
        void reply.status(503);
        return {
          status: 'down' as const,
          reason: 'worker heartbeat is stale',
          lastTickAt: row.lastTickAt.toISOString(),
          ageSeconds: Math.round(ageMs / 1000),
          workerId: row.workerId,
        };
      }
      return {
        status: 'ok' as const,
        lastTickAt: row.lastTickAt.toISOString(),
        ageSeconds: Math.round(ageMs / 1000),
        lastTickMs: row.lastTickMs,
        // Non-zero means the worker is ticking but its batches are throwing —
        // alive-but-broken, which needs a human just as much as dead does.
        consecutiveErrors: row.consecutiveErrors,
        workerId: row.workerId,
      };
    } catch (err) {
      app.log.error({ err }, 'health.worker_probe_failed');
      void reply.status(503);
      return { status: 'unknown' as const, reason: 'probe failed' };
    }
  });
}
