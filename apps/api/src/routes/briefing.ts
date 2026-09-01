import { createHash } from 'node:crypto';
import { schema, type Database } from '@truecairn/db';
import type { Locale, UserId } from '@truecairn/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BRIEFING_SYSTEM_INSTRUCTION,
  buildBriefingPrompt,
  type BriefingInputs,
} from '../ai/briefing-prompt.js';
import { GeminiClient, logAiError, type BriefingGenerator } from '../ai/gemini.js';
import { AiCallGuard, requestIpHash } from '../ai/guard.js';
import { aiLocale, systemInstructionFor } from '../ai/language.js';
import { gatherBriefingInputs } from '../ai/metadata.js';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { unauthorized } from '../errors.js';

// Reuse a generated briefing while the inputs are unchanged and it's this fresh.
const TTL_MS = 6 * 60 * 60 * 1000;

export interface BriefingResponse {
  briefing: string | null;
  generatedAt: string | null;
  model: string | null;
  stale: boolean;
  reason?: 'disabled' | 'unavailable';
}

// GET /v1/briefing — the AI continuity-readiness briefing (XPRIZE AI-native
// feature). Session-only; advisory and FAIL-SOFT (it never 500s the dashboard and
// nothing in the release path depends on it). The prompt carries METADATA ONLY.
export function briefingRoutes(
  app: FastifyInstance,
  db: Database,
  config: ApiConfig,
  injectedGenerator?: BriefingGenerator,
): void {
  // Master kill switch (AI_ENABLED) wins: false ⇒ null generator ⇒ the disabled
  // fail-soft response, no model call — even with an injected (test) generator.
  const generator: BriefingGenerator | null = !config.ai.enabled
    ? null
    : (injectedGenerator ??
      (config.aiBriefing.enabled ? new GeminiClient(config.aiBriefing) : null));

  app.get(
    '/v1/briefing',
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply): Promise<BriefingResponse> => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      if (generator === null) {
        return { briefing: null, generatedAt: null, model: null, stale: false, reason: 'disabled' };
      }
      // The guard gates only the model call (cache hits below never reach it), so
      // a dashboard reload served from cache costs neither a rate token nor budget.
      const guard = new AiCallGuard(db, config, app.audit);
      return resolveBriefing(db, generator, session.userId, config.aiBriefing.model, new Date(), {
        guard,
        ipHash: requestIpHash(request, config),
        reply,
      });
    },
  );
}

// Guard hooks the route wires in so resolveBriefing stays unit-testable without
// HTTP: optional so existing tests that pass no guard exercise the pure
// generate/cache logic.
export interface BriefingGuardHooks {
  guard: AiCallGuard;
  ipHash: Uint8Array | null;
  reply: { header(name: string, value: string): unknown };
}

// Core logic, separated from HTTP so it is unit-testable with a fake generator:
// gather metadata → cache hit (same inputs + within TTL) → else generate + persist
// → on failure serve a stale row if any, else a null fail-soft response.
export async function resolveBriefing(
  db: Database,
  generator: BriefingGenerator,
  userId: UserId,
  model: string,
  now: Date,
  hooks?: BriefingGuardHooks,
): Promise<BriefingResponse> {
  const inputs = await gatherBriefingInputs(db, userId);
  const locale = await aiLocale(db, userId);
  // THE LOCALE IS PART OF THE CACHE KEY, not just the prompt. A briefing is
  // cached by a hash of its inputs, so without this an owner who switches
  // language keeps being served the previous language's text until the metadata
  // underneath happens to change — which for a settled account could be weeks.
  const inputsHash = hashInputs(inputs, locale);
  const [cached] = await db
    .select()
    .from(schema.aiBriefings)
    .where(eq(schema.aiBriefings.userId, userId))
    .limit(1);

  if (
    cached !== undefined &&
    cached.inputsHash === inputsHash &&
    now.getTime() - cached.generatedAt.getTime() < TTL_MS
  ) {
    return {
      briefing: cached.briefingText,
      generatedAt: cached.generatedAt.toISOString(),
      model: cached.model,
      stale: false,
    };
  }

  // A cache MISS means a model call is imminent — apply the guard here (never on
  // the hit path above). precheck throws 429 on a rate-limit block; opt-out and a
  // tripped breaker fail soft (serve stale if present, else the disabled/unavailable
  // response). Only on proceed do we spend the model call + record usage.
  if (hooks !== undefined) {
    const decision = await hooks.guard.precheck('ai_briefing', userId, hooks.ipHash, hooks.reply, now);
    if (!decision.proceed) {
      if (cached !== undefined) {
        return {
          briefing: cached.briefingText,
          generatedAt: cached.generatedAt.toISOString(),
          model: cached.model,
          stale: true,
        };
      }
      return { briefing: null, generatedAt: null, model: null, stale: false, reason: decision.reason };
    }
  }

  try {
    const { text, usage } = await generator.generate(
      systemInstructionFor(BRIEFING_SYSTEM_INSTRUCTION, locale),
      buildBriefingPrompt(inputs),
    );
    if (hooks !== undefined) await hooks.guard.recordUsage(userId, usage, now);
    await db
      .insert(schema.aiBriefings)
      .values({ userId, inputsHash, briefingText: text, model, generatedAt: now })
      .onConflictDoUpdate({
        target: schema.aiBriefings.userId,
        set: { inputsHash, briefingText: text, model, generatedAt: now },
      });
    return { briefing: text, generatedAt: now.toISOString(), model, stale: false };
  } catch (err) {
    logAiError('briefing', err);
    await hooks?.guard.recordFailure(userId, now);
    // Fail-soft. A live but transiently-unavailable model must not break the
    // dashboard; serve the last briefing (flagged stale) if we have one.
    if (cached !== undefined) {
      return {
        briefing: cached.briefingText,
        generatedAt: cached.generatedAt.toISOString(),
        model: cached.model,
        stale: true,
      };
    }
    return { briefing: null, generatedAt: null, model: null, stale: false, reason: 'unavailable' };
  }
}

function hashInputs(i: BriefingInputs, locale: Locale): string {
  return createHash('sha256').update(JSON.stringify({ ...i, locale })).digest('hex');
}
