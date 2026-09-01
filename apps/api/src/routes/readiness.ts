import { createHash } from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import type { Locale, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { GeminiClient, type BriefingGenerator } from '../ai/gemini.js';
import { logAiError } from '../ai/gemini.js';
import { AiCallGuard, requestIpHash } from '../ai/guard.js';
import { aiLocale, systemInstructionFor } from '../ai/language.js';
import {
  gatherReadinessInputs,
  scoreReadiness,
  type ReadinessGap,
  type ReadinessReport,
} from '../ai/readiness.js';
import {
  READINESS_SYSTEM_INSTRUCTION,
  buildReadinessPrompt,
  deterministicReadinessExplanation,
} from '../ai/readiness-prompt.js';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { unauthorized } from '../errors.js';

// Reuse a generated explanation while the readiness inputs are unchanged + fresh.
const TTL_MS = 6 * 60 * 60 * 1000;

export interface ReadinessResponse {
  score: number;
  gaps: ReadinessGap[];
  explanation: string;
  llmWritten: boolean;
  model: string | null;
  generatedAt: string;
  reason?: 'disabled';
}

// GET /v1/ai/readiness — the deterministic continuity-readiness report (score +
// typed gaps), with an LLM-written explanation (template fallback). Gated by the
// Phase-1 proposer flag. The SCORE + GAPS are deterministic and always present; the
// LLM only rewrites the prose, and its unavailability (off / opted-out / breaker /
// rate-limited) never removes the gaps — it just falls back to the template.
export function readinessRoutes(
  app: FastifyInstance,
  db: Database,
  config: ApiConfig,
  injectedGenerator?: BriefingGenerator,
): void {
  const generator: BriefingGenerator | null = !config.ai.enabled
    ? null
    : (injectedGenerator ??
      (config.aiBriefing.enabled ? new GeminiClient(config.aiBriefing) : null));

  app.get('/v1/ai/readiness', { preHandler: requireSession }, async (request): Promise<ReadinessResponse> => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    // Phase-1 flag: the readiness surface stays off until AI_PROPOSER_ENABLED.
    if (!config.ai.proposerEnabled) {
      return {
        score: 0,
        gaps: [],
        explanation: 'AI proposals are not enabled.',
        llmWritten: false,
        model: null,
        generatedAt: new Date().toISOString(),
        reason: 'disabled',
      };
    }
    const guard = new AiCallGuard(db, config, app.audit);
    return resolveReadiness(db, generator, guard, session.userId, {
      ipHash: requestIpHash(request, config),
      model: config.aiBriefing.model,
      now: new Date(),
    });
  });
}

// Core logic, unit-testable with a fake generator. Deterministic gaps first; then a
// cache hit; else generate the explanation (LLM if the guard allows, else template)
// and persist.
export async function resolveReadiness(
  db: Database,
  generator: BriefingGenerator | null,
  guard: AiCallGuard,
  userId: UserId,
  opts: { ipHash: Uint8Array | null; model: string; now: Date },
): Promise<ReadinessResponse> {
  const inputs = await gatherReadinessInputs(db, userId);
  const report = scoreReadiness(inputs);
  const locale = await aiLocale(db, userId);
  // The locale is part of the cache key. The explanation is cached by a hash of
  // the deterministic report, so without this an owner who switches language
  // keeps the previous language's paragraph until their setup happens to change
  // — which for a finished account is the point at which it never does.
  const inputsHash = hashReport(report, locale);

  const [cached] = await db
    .select()
    .from(schema.aiReadiness)
    .where(eq(schema.aiReadiness.userId, userId))
    .limit(1);
  if (
    cached !== undefined &&
    cached.inputsHash === inputsHash &&
    opts.now.getTime() - cached.generatedAt.getTime() < TTL_MS
  ) {
    return {
      score: cached.score,
      gaps: cached.gaps as ReadinessGap[],
      explanation: cached.explanation,
      llmWritten: cached.llmWritten,
      model: cached.model,
      generatedAt: cached.generatedAt.toISOString(),
    };
  }

  const explained = await explain(generator, guard, userId, report, { ...opts, locale });
  await db
    .insert(schema.aiReadiness)
    .values({
      userId,
      inputsHash,
      score: report.score,
      gaps: report.gaps,
      explanation: explained.explanation,
      llmWritten: explained.llmWritten,
      model: explained.model,
      generatedAt: opts.now,
    })
    .onConflictDoUpdate({
      target: schema.aiReadiness.userId,
      set: {
        inputsHash,
        score: report.score,
        gaps: report.gaps,
        explanation: explained.explanation,
        llmWritten: explained.llmWritten,
        model: explained.model,
        generatedAt: opts.now,
      },
    });

  return {
    score: report.score,
    gaps: report.gaps,
    explanation: explained.explanation,
    llmWritten: explained.llmWritten,
    model: explained.model,
    generatedAt: opts.now.toISOString(),
  };
}

// Produce the explanation: the LLM rewrite when the guard permits a call, else the
// deterministic template. Any LLM failure fails soft to the template — the gaps are
// never lost.
async function explain(
  generator: BriefingGenerator | null,
  guard: AiCallGuard,
  userId: UserId,
  report: ReadinessReport,
  opts: { ipHash: Uint8Array | null; model: string; now: Date; locale: Locale },
): Promise<{ explanation: string; llmWritten: boolean; model: string | null }> {
  const fallback = {
    explanation: deterministicReadinessExplanation(report, opts.locale),
    llmWritten: false,
    model: null,
  };
  if (generator === null) return fallback;
  const decision = await guard.evaluate('ai_briefing', userId, opts.ipHash, opts.now);
  if (!decision.proceed) return fallback; // opted-out / breaker / rate-limited → template
  try {
    const { text, usage } = await generator.generate(
      systemInstructionFor(READINESS_SYSTEM_INSTRUCTION, opts.locale),
      // The prompt carries the SOURCE-language templates as material to rephrase.
      // The model is told to answer in the owner's language; giving it the
      // translated sentences instead would make a rephrase a translation of a
      // translation, and the consequence clause is exactly what that loses.
      buildReadinessPrompt(report),
    );
    await guard.recordUsage(userId, usage, opts.now);
    return { explanation: text, llmWritten: true, model: opts.model };
  } catch (err) {
    logAiError('readiness', err);
    await guard.recordFailure(userId, opts.now);
    return fallback;
  }
}

// Hash the deterministic report (score + gaps) so a changed setup regenerates the
// explanation. The gaps already encode the salient inputs.
function hashReport(report: ReadinessReport, locale: Locale): string {
  return createHash('sha256').update(JSON.stringify({ ...report, locale })).digest('hex');
}
