import { schema, type Database } from '@truecairn/db';
import { buildContinuityReport } from '@truecairn/notifications';
import type { UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { GeminiClient, type BriefingGenerator } from '../ai/gemini.js';
import { requestIpHash } from '../ai/guard.js';
import { maybeNarrateReport } from '../ai/narration.js';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { notFound, unauthorized } from '../errors.js';

// Continuity Report routes (docs/26 §3.3, D6). Two views of the same evidence:
//
//   - GET /v1/ceremonies/:id/continuity-report — the FROZEN snapshot attached
//     at ceremony creation, served to the ceremony's recipients (holders and
//     designated beneficiaries) and to the owner. It informs an affirmation
//     decision and contains no secrets — provider-proven facts only. Anyone
//     else: 404, no existence disclosure, same discipline as every ceremony
//     route.
//   - GET /v1/engine/verification-status — the owner's LIVE view, recomputed
//     on demand (flag-gated: it is new behaviour, so CV_REPORT_ENABLED off
//     keeps the surface absent per D8).
//
// Narration (Gap plan G-1): with CV_NARRATION_ENABLED the frozen-report
// response ALSO carries `narration` — plain-language AI prose stored beside
// the sealed payload, generated lazily on first read under every AI guard
// (owner opt-out, rate, breaker, kill switch) and never regenerated. With the
// flag off the key is absent entirely, keeping the response byte-identical to
// pre-narration behaviour. The release driver (worker) makes no AI calls.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function continuityRoutes(
  app: FastifyInstance,
  db: Database,
  config: ApiConfig,
  injectedGenerator?: BriefingGenerator,
): void {
  // Same kill-switch-first construction as every AI surface (routes/ai.ts):
  // AI_ENABLED=false nulls even an injected generator.
  const generator: BriefingGenerator | null = !config.ai.enabled
    ? null
    : (injectedGenerator ??
      (config.aiBriefing.enabled ? new GeminiClient(config.aiBriefing) : null));
  app.get(
    '/v1/ceremonies/:id/continuity-report',
    { preHandler: [requireSession] },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) throw notFound('ceremony not found');

      const [ceremony] = await db
        .select({ id: schema.releaseCeremonies.id, ownerUserId: schema.releaseCeremonies.userId })
        .from(schema.releaseCeremonies)
        .where(eq(schema.releaseCeremonies.id, id));
      if (ceremony === undefined) throw notFound('ceremony not found');

      // Owner, or an enrolled recipient of THIS ceremony (holder or designated
      // beneficiary — both have a ceremony_recipients row). Everyone else 404.
      let authorized = ceremony.ownerUserId === session.userId;
      if (!authorized) {
        const [recipient] = await db
          .select({ id: schema.ceremonyRecipients.id })
          .from(schema.ceremonyRecipients)
          .innerJoin(
            schema.contacts,
            eq(schema.ceremonyRecipients.recipientContactId, schema.contacts.id),
          )
          .where(
            and(
              eq(schema.ceremonyRecipients.ceremonyId, id),
              eq(schema.contacts.contactUserId, session.userId),
            ),
          )
          .limit(1);
        authorized = recipient !== undefined;
      }
      if (!authorized) throw notFound('ceremony not found');

      // The SNAPSHOT, never a live recompute (docs/26 §3.3): the stored TEXT
      // is exactly the bytes whose sha256 the audit chain anchored at
      // creation — parsed here only to serve JSON, never re-derived.
      const [report] = await db
        .select({
          generatedAt: schema.continuityReports.generatedAt,
          payload: schema.continuityReports.payload,
          narrationText: schema.continuityReports.narrationText,
        })
        .from(schema.continuityReports)
        .where(eq(schema.continuityReports.ceremonyId, id));
      if (report === undefined) throw notFound('no continuity report for this ceremony');

      // Flag off ⇒ no narration key at all (byte-identical to pre-G-1).
      if (!config.cvNarrationEnabled) {
        return {
          ceremonyId: id,
          generatedAt: report.generatedAt.toISOString(),
          report: JSON.parse(report.payload) as unknown,
        };
      }

      // Stored narration wins (generate-once); otherwise one lazy, fully
      // guarded attempt. Best-effort by construction: any refusal or failure
      // leaves narration null, and the panel then shows the factual report with
      // no prose block at all — there is no narration template to fall back to,
      // and the report is never blocked on AI.
      let narration = report.narrationText;
      if (narration === null) {
        narration = await maybeNarrateReport(
          {
            db,
            config,
            audit: app.audit,
            generator,
            ipHash: requestIpHash(request, config),
            now: new Date(),
          },
          id,
          ceremony.ownerUserId as UserId,
          report.payload,
        );
      }
      return {
        ceremonyId: id,
        generatedAt: report.generatedAt.toISOString(),
        report: JSON.parse(report.payload) as unknown,
        narration,
      };
    },
  );

  app.get(
    '/v1/engine/verification-status',
    { preHandler: [requireSession] },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      if (!config.cvReportEnabled) throw notFound('continuity verification is not enabled');
      const report = await buildContinuityReport(db, session.userId, new Date());
      return { report };
    },
  );
}
