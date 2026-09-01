import {
  AiAuthority,
  CONTINUITY_NARRATION_TEMPLATE_ID,
  NARRATION_OUTPUT_SPEC,
  validateAiObjectOutput,
} from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { ApiConfig } from '../config.js';
import { logAiError, type BriefingGenerator } from './gemini.js';
import { AiCallGuard } from './guard.js';
import { aiLocale, systemInstructionFor } from './language.js';
import { buildNarrationPrompt, NARRATION_SYSTEM_INSTRUCTION } from './narration-prompt.js';

// ── Lazy narration of a frozen Continuity Report (Gap plan G-1) ───────────────
//
// Called from the recipient-gated report READ path, never from the worker: the
// release driver stays free of external AI network calls entirely — the
// strongest form of "the release path can never be blocked by AI" (the plan's
// D3 attach-time attempt was deliberately traded for this; generation happens
// on first read instead, which is also the first moment anyone needs it).
//
// Every guard applies, in order: the CV_NARRATION_ENABLED flag and the master
// AI kill switch (a null generator), then the OWNER's ai_opt_out (it is their
// account's evidence being narrated), the ai_narration rate ceilings, and the
// cost breaker — any refusal returns null, and the panel then renders the
// factual report with no prose block at all (there is no narration template to
// fall back to). Output is deny-by-default validated (NARRATION_OUTPUT_SPEC); a
// rejection writes ai_output_rejected (actor='ai') and stores nothing.
// Persistence is a fill-only-NULL update, so narration is generated at most
// once per report no matter how many readers race.

// The audit port in the same structural shape the guard takes (AuditLogWriter
// satisfies it; null in audit-less contexts skips the forensic record only).
type NarrationAuditPort = ConstructorParameters<typeof AiAuthority>[0]['audit'];

export interface NarrationDeps {
  db: Database;
  config: ApiConfig;
  audit: NarrationAuditPort | null;
  generator: BriefingGenerator | null;
  ipHash: Uint8Array | null;
  now: Date;
}

export async function maybeNarrateReport(
  deps: NarrationDeps,
  ceremonyId: string,
  ownerUserId: UserId,
  frozenPayloadJson: string,
): Promise<string | null> {
  const { db, config, generator, now } = deps;
  if (!config.cvNarrationEnabled || generator === null) return null;

  const guard = new AiCallGuard(db, config, deps.audit);
  const decision = await guard.evaluate('ai_narration', ownerUserId, deps.ipHash, now);
  if (!decision.proceed) return null;

  let text: string;
  try {
    const result = await generator.generate(
      // The OWNER's language, not the reading contact's — the same rule the
      // contact-facing emails follow. This narrates the owner's continuity
      // report to people the owner chose, and the owner is the only party who
      // has expressed a language preference about this ceremony.
      systemInstructionFor(NARRATION_SYSTEM_INSTRUCTION, await aiLocale(db, ownerUserId)),
      buildNarrationPrompt(frozenPayloadJson),
      true,
    );
    await guard.recordUsage(ownerUserId, result.usage, now);
    text = result.text;
  } catch (err) {
    logAiError('continuity-narration', err);
    await guard.recordFailure(ownerUserId, now);
    return null;
  }

  const validated = validateAiObjectOutput(NARRATION_OUTPUT_SPEC, text);
  if (!validated.ok) {
    // Deny-by-default: discard + forensic record, exactly like the assist path.
    if (deps.audit !== null) {
      try {
        const authority = new AiAuthority({ audit: deps.audit });
        await authority.appendAiAudit(db, ownerUserId, 'ai_output_rejected', {
          purpose: 'continuity_narration',
          templateId: CONTINUITY_NARRATION_TEMPLATE_ID,
          reason: validated.reason,
        });
      } catch (err) {
        logAiError('continuity-narration-audit', err);
      }
    }
    return null;
  }
  const narration = validated.value['narration'] as string;

  // Fill-only-NULL: the first writer wins; a racing reader re-reads the row.
  const updated = await db
    .update(schema.continuityReports)
    .set({
      narrationText: narration,
      narrationModelId: config.aiBriefing.enabled ? config.aiBriefing.model : 'injected',
      narrationTemplateId: CONTINUITY_NARRATION_TEMPLATE_ID,
      narrationGeneratedAt: now,
    })
    .where(
      and(
        eq(schema.continuityReports.ceremonyId, ceremonyId),
        isNull(schema.continuityReports.narrationText),
      ),
    )
    .returning({ id: schema.continuityReports.id });
  if (updated.length === 0) {
    // Another request narrated first — serve THEIRS (the stored one is the
    // generate-once truth).
    const [row] = await db
      .select({ narrationText: schema.continuityReports.narrationText })
      .from(schema.continuityReports)
      .where(eq(schema.continuityReports.ceremonyId, ceremonyId));
    return row?.narrationText ?? null;
  }
  return narration;
}
