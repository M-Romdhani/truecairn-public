import { type Database } from '@truecairn/db';
import { CONTACT_ROLES, type ContactRole } from '@truecairn/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ASSIST_SYSTEM_INSTRUCTION, buildAssistPrompt } from '../ai/assist-prompt.js';
import { aiLocale, systemInstructionFor } from '../ai/language.js';
import { GeminiClient, logAiError, type BriefingGenerator } from '../ai/gemini.js';
import { AiCallGuard, requestIpHash } from '../ai/guard.js';
import { INVITE_SYSTEM_INSTRUCTION, buildInvitePrompt } from '../ai/invite-prompt.js';
import { gatherBriefingInputs } from '../ai/metadata.js';
import {
  PLAN_SYSTEM_INSTRUCTION,
  buildPlanPrompt,
  parsePlanSteps,
  type PlanStep,
} from '../ai/plan-prompt.js';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { unauthorized } from '../errors.js';

type Reason = 'disabled' | 'unavailable';

// The owner-facing AI surfaces beyond the dashboard briefing (Build with Gemini
// XPRIZE AI-native operations). All session-gated, all FAIL-SOFT (the model is
// advisory; nothing in the product or release path blocks on it), all routed
// through the same Gemini client + config the briefing uses, and all gated by the
// Phase 0 AI guard (opt-out → rate-limit → cost breaker). The interactive owner
// calls share the ai_assist rate scope.
export function aiRoutes(
  app: FastifyInstance,
  db: Database,
  config: ApiConfig,
  injectedGenerator?: BriefingGenerator,
): void {
  // Gated by the master kill switch (AI_ENABLED) FIRST: flipping AI_ENABLED=false
  // makes `generator` null — even an injected (test) generator — so every surface
  // returns the defined disabled response with no model call (plan §4 task 0.3).
  // Otherwise use the injected generator (tests) or the real Gemini client when a
  // credential resolved.
  const generator: BriefingGenerator | null = !config.ai.enabled
    ? null
    : (injectedGenerator ??
      (config.aiBriefing.enabled ? new GeminiClient(config.aiBriefing) : null));

  const guard = (): AiCallGuard => new AiCallGuard(db, config, app.audit);

  // POST /v1/ai/assist — in-app help assistant. The free-text question is the
  // user's OWN words (owner-consented input → Gemini); the system instruction
  // guardrails against the model requesting or echoing any secret.
  app.post(
    '/v1/ai/assist',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['question'],
          properties: { question: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply): Promise<{ answer: string | null; reason?: Reason }> => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { question } = request.body as { question: string };
      if (generator === null) return { answer: null, reason: 'disabled' };
      const now = new Date();
      const decision = await guard().precheck(
        'ai_assist',
        session.userId,
        requestIpHash(request, config),
        reply,
        now,
      );
      if (!decision.proceed) return { answer: null, reason: decision.reason };
      try {
        const metadata = await gatherBriefingInputs(db, session.userId);
        const { text, usage } = await generator.generate(
          systemInstructionFor(ASSIST_SYSTEM_INSTRUCTION, await aiLocale(db, session.userId)),
          buildAssistPrompt(question, metadata),
        );
        await guard().recordUsage(session.userId, usage, now);
        return { answer: text };
      } catch (err) {
        logAiError('assist', err);
        await guard().recordFailure(session.userId, now);
        return { answer: null, reason: 'unavailable' };
      }
    },
  );

  // POST /v1/ai/draft-invite — draft an invitation message for a contact role.
  // Metadata-only (role enum); the owner edits before sending.
  app.post(
    '/v1/ai/draft-invite',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['role'],
          properties: { role: { type: 'string', enum: [...CONTACT_ROLES] } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply): Promise<{ message: string | null; reason?: Reason }> => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const { role } = request.body as { role: ContactRole };
      if (generator === null) return { message: null, reason: 'disabled' };
      const now = new Date();
      const decision = await guard().precheck(
        'ai_assist',
        session.userId,
        requestIpHash(request, config),
        reply,
        now,
      );
      if (!decision.proceed) return { message: null, reason: decision.reason };
      try {
        const { text, usage } = await generator.generate(
          systemInstructionFor(INVITE_SYSTEM_INSTRUCTION, await aiLocale(db, session.userId)),
          buildInvitePrompt(role),
        );
        await guard().recordUsage(session.userId, usage, now);
        return { message: text };
      } catch (err) {
        logAiError('draft-invite', err);
        await guard().recordFailure(session.userId, now);
        return { message: null, reason: 'unavailable' };
      }
    },
  );

  // GET /v1/ai/plan — AI-prioritized, actionable next steps (structured JSON,
  // validated against the closed PLAN_STEP_KINDS allowlist; fail-soft to []).
  app.get(
    '/v1/ai/plan',
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply): Promise<{ steps: PlanStep[]; reason?: Reason }> => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      if (generator === null) return { steps: [], reason: 'disabled' };
      const now = new Date();
      const decision = await guard().precheck(
        'ai_assist',
        session.userId,
        requestIpHash(request, config),
        reply,
        now,
      );
      if (!decision.proceed) return { steps: [], reason: decision.reason };
      try {
        const metadata = await gatherBriefingInputs(db, session.userId);
        const { text, usage } = await generator.generate(
          systemInstructionFor(PLAN_SYSTEM_INSTRUCTION, await aiLocale(db, session.userId)),
          buildPlanPrompt(metadata),
          true,
        );
        await guard().recordUsage(session.userId, usage, now);
        const steps = parsePlanSteps(text);
        // A successful call that yields no usable steps means empty/unparseable
        // model output — surface it as unavailable so the dashboard shows a
        // fail-soft message instead of silently hiding the card (audit Blocker 2).
        return steps.length > 0 ? { steps } : { steps: [], reason: 'unavailable' as const };
      } catch (err) {
        logAiError('plan', err);
        await guard().recordFailure(session.userId, now);
        return { steps: [], reason: 'unavailable' };
      }
    },
  );
}
