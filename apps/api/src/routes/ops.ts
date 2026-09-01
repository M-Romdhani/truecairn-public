import { isCryptoReady } from '@truecairn/crypto';
import { schema, type Database } from '@truecairn/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { APP_VERSION } from '../config.js';
import { notFound, unauthorized } from '../errors.js';
import { configuredNotificationTypes } from '../ops/notification-config.js';
import {
  accountTotals,
  collectSystemStatus,
  readHealthSeriesSafe,
  recentAlertsSafe,
} from '@truecairn/ops';
import { aiSubsystemStatusDeps, backupAttestation } from '../ops/status-deps.js';

// ── The operations centre route (2026-07-25) ─────────────────────────────────
//
// GET /v1/ops/system — the single "could a release complete right now?" answer,
// plus the component checks behind it. See @truecairn/ops for the two rules that
// surface must keep (never green what isn't checked; never expose user data).
//
// This is the ADMIN view and says everything. The public /status page reads the
// reduced projection in the same package (routes/status.ts) — IDs and enums
// only, no counts, no versions, no free text. Keep the two apart: a field added
// here does not become public, by construction.
//
// GATING. An ops surface on a zero-knowledge product is a new attack surface, so
// this fails closed twice:
//
//   * OPS_ADMIN_EMAILS unset ⇒ the routes are NEVER REGISTERED. Not 403, not
//     401 — absent. A deployment that does not use the dashboard has no
//     dashboard to attack, and nothing to leak operational intelligence to.
//   * Otherwise: a valid session whose account email is on the allowlist.
//
// Deliberately reusing the session rather than inventing an admin role or a
// shared bearer token. A role would mean a schema change and a new privileged
// state to reason about; a static token is a long-lived secret that ends up
// pasted into browsers and chat logs. The allowlist is config, revocable by
// redeploy, and grants no capability beyond reading aggregate health and account
// totals — there is no write, no user lookup, and no impersonation anywhere on
// this surface. The one query keyed by a user id is the caller's own email, read
// to check it against the allowlist.

export function opsRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const allowlist = (process.env['OPS_ADMIN_EMAILS'] ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  // Unconfigured ⇒ no surface at all.
  if (allowlist.length === 0) return;

  async function assertOpsAdmin(userId: string): Promise<void> {
    const [u] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    // 404 rather than 403: an authenticated non-admin should not be able to
    // confirm the dashboard exists.
    if (u?.email == null || !allowlist.includes(u.email.toLowerCase())) {
      throw notFound('not found');
    }
  }

  app.get('/v1/ops/system', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    await assertOpsAdmin(session.userId);

    const status = await collectSystemStatus({
      db,
      outerLayerKeks: config.outerLayerKeks,
      // app.audit is null only when the signer failed to resolve at boot.
      auditReady: app.audit !== null,
      auditKeyLineage: app.auditKeyLineage ?? undefined,
      apiVersion: APP_VERSION,
      configuredNotificationTypes: configuredNotificationTypes(),
      cryptoReady: isCryptoReady,
      // Both of these are shared with the PUBLIC /v1/status route through one
      // helper, so the admin dashboard and the public page cannot report
      // different states for the same tile.
      ai: aiSubsystemStatusDeps(config),
      backups: backupAttestation(),
    });
    // Both of these degrade to null rather than throwing. This page is worth
    // loading precisely when something is broken, and collectSystemStatus has
    // already gone to the trouble of reporting each check's own failure — one
    // unguarded aggregate throwing here would discard all of that and serve a
    // 500 instead, which is what happened until 2026-08-06.
    const alerts = await recentAlertsSafe(db, 20, (err) =>
      request.log.warn({ err }, 'ops: recent alerts unreadable'),
    );
    // Aggregate counts, composed here rather than inside collectSystemStatus so
    // they exist on this admin response only — the worker's sampler and the
    // public projection both take a SystemStatus, and neither can carry a field
    // that type does not have. null (never 0) when the count could not be taken.
    const accounts = await accountTotals(db);
    return { ...status, alerts, accounts };
  });

  // The composite health strip. Separate from /system deliberately: the live
  // tiles re-check every 15s and this is 24 hours of history that changes once
  // every five minutes, so folding it in would re-send the whole series 240
  // times an hour to redraw the same picture.
  //
  // Composite ONLY. status_samples records the release-path severity and the
  // check that drove it, not per-check states, so there is no honest per-check
  // strip to serve and this route does not invent one.
  app.get('/v1/ops/health-series', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    await assertOpsAdmin(session.userId);

    const series = await readHealthSeriesSafe({ db, now: new Date() }, (err) =>
      request.log.warn({ err }, 'ops: health series unreadable'),
    );
    return { series };
  });
}
