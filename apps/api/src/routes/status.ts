import { isCryptoReady } from '@truecairn/crypto';
import type { Database } from '@truecairn/db';
import {
  collectSystemStatus,
  computeAvailabilitySafe,
  toPublicStatus,
  type PublicStatus,
} from '@truecairn/ops';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import { APP_VERSION } from '../config.js';
import { configuredNotificationTypes } from '../ops/notification-config.js';
import { aiSubsystemStatusDeps, backupAttestation } from '../ops/status-deps.js';

// ── The public status page's data source (2026-07-30) ────────────────────────
//
// GET /v1/status — unauthenticated. The reduced projection of the operations
// dashboard: IDs, enums and integers only. See packages/ops/src/public-status.ts
// for what is withheld and why; the short version is that no server-composed
// sentence crosses this boundary, because every internal detail string is
// interpolated from live counts.
//
// UNAUTHENTICATED MEANS CACHED, NOT CHEAP. Producing this answer does real work:
// a wrap/unwrap round-trip against the live outer-layer key (which on the KMS
// provider is a network call to an HSM), plus several aggregate counts. Serving
// that per-request on a public URL would make the status page a free
// amplifier against the very key path it reports on — and the first symptom
// would be the page reporting the outage it caused. So one shared in-process
// result is reused for CACHE_TTL_MS, and concurrent callers await the same
// in-flight promise rather than starting their own probe.
//
// The Cache-Control header lets the edge (Cloudflare, proxied — docs/33) absorb
// the rest. max-age is deliberately shorter than the sample bucket: a visitor
// should never see a status older than the series it is quoting.

const CACHE_TTL_MS = 30_000;

// What the published availability figure covers, when there is enough evidence
// for one. The reader clamps this to the observed span, so early in a
// deployment's life the page reports days rather than the full window.
const AVAILABILITY_WINDOW_DAYS = 90;

export function statusRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  let cached: { at: number; value: PublicStatus } | null = null;
  let inFlight: Promise<PublicStatus> | null = null;

  async function build(): Promise<PublicStatus> {
    const now = new Date();
    const status = await collectSystemStatus({
      db,
      outerLayerKeks: config.outerLayerKeks,
      auditReady: app.audit !== null,
      auditKeyLineage: app.auditKeyLineage ?? undefined,
      apiVersion: APP_VERSION,
      configuredNotificationTypes: configuredNotificationTypes(),
      cryptoReady: isCryptoReady,
      // `backups` is published (it is in the PUBLIC_CHECKS allowlist), so it is
      // resolved through the same helper the admin dashboard uses — a second
      // resolution here is a second opinion waiting to happen. `ai` is not
      // published, and is passed only so both surfaces compute one status object
      // from identical inputs.
      ai: aiSubsystemStatusDeps(config),
      backups: backupAttestation(now),
      now,
    });
    // ...Safe, not the raw compute: a read failure degrades to "no figure"
    // rather than 500ing the page you most want to load during an outage. The
    // rule lives in @truecairn/ops next to the arithmetic it protects — a failed
    // read is not evidence of uptime.
    const availability = await computeAvailabilitySafe(
      { db, now, windowDays: AVAILABILITY_WINDOW_DAYS },
      (err) => app.log.warn({ err }, 'status.availability_unavailable'),
    );
    return toPublicStatus(status, availability);
  }

  async function current(): Promise<PublicStatus> {
    if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    // Collapse a thundering herd onto one probe. Without this, a burst on a cold
    // cache starts one KEK round-trip per connection.
    inFlight ??= build()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  app.get(
    '/v1/status',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['releasePath', 'checks', 'failing', 'availability', 'observedAt'],
            properties: {
              releasePath: { type: 'string', enum: ['ok', 'degraded', 'down', 'unknown'] },
              checks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'label', 'state', 'releaseCritical'],
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    state: { type: 'string', enum: ['ok', 'degraded', 'down', 'unknown'] },
                    releaseCritical: { type: 'boolean' },
                  },
                },
              },
              failing: { type: 'array', items: { type: 'string' } },
              availability: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'measuringSince',
                  'observedDays',
                  'requestedWindowDays',
                  'releasePathOkPercent',
                  'unobservedMinutes',
                ],
                properties: {
                  measuringSince: { type: 'string', nullable: true },
                  observedDays: { type: 'number' },
                  requestedWindowDays: { type: 'number' },
                  // null until there is enough evidence to publish one. The page
                  // renders the honest "measuring since" line instead.
                  releasePathOkPercent: { type: 'number', nullable: true },
                  unobservedMinutes: { type: 'number' },
                },
              },
              observedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const value = await current();
      void reply.header(
        'cache-control',
        `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}, stale-while-revalidate=60`,
      );
      return value;
    },
  );
}
