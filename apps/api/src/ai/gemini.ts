import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from '@google/genai';

// ── Turning "thinking" off is MODEL-FAMILY SPECIFIC ──────────────────────────
//
// Every surface here is a short metadata→text/JSON task, and internal "thinking"
// spends the output-token budget without producing any of the answer — the cause
// of the audit's pervasive truncation and the empty AI plan card. Disabling it is
// therefore load-bearing, not a tuning preference.
//
// The two families take DIFFERENT controls and each rejects the other's, so this
// cannot be one constant. Measured live 2026-08-25 against both models:
//
//   gemini-2.5-flash  thinkingBudget: 0    → thoughtsTokenCount absent (off)
//                     thinkingLevel        → HTTP 400, "Thinking level is not
//                                            supported for this model."
//   gemini-3.7-flash  thinkingBudget: 0    → ACCEPTED AND SILENTLY IGNORED:
//                                            547 thought tokens on a 59-token
//                                            prompt
//                     thinkingLevel: LOW   → the 3.x equivalent (MINIMAL is
//                                            rejected: "not supported for this
//                                            model")
//
// The asymmetry is why this is written down. On 2.5 the wrong control is a loud
// 400. On 3.x it is SILENT — the call succeeds, the field is ignored, and the
// truncation this exists to prevent comes back with nothing in the log to say so.
//
// NOTE for 3.x: LOW reduces thinking but does not guarantee zero. The same probe
// in JSON mode still spent 460 thought tokens. Those count toward the cost
// breaker's accounting and can push a long answer into the MAX_TOKENS path, which
// is already handled as a retryable failure below.
export function thinkingControlFor(model: string): ThinkingConfig {
  return /^gemini-(?:[3-9]|\d{2,})[.-]/.test(model)
    ? { thinkingLevel: ThinkingLevel.LOW }
    : { thinkingBudget: 0 };
}

// Typed failure for the briefing path. `retryable` mirrors the notifications
// ProviderError convention (transient vs permanent). The endpoint treats every AI
// failure as fail-soft anyway (the dashboard degrades; nothing in the product or
// release path blocks on it).
export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

// Log an AI failure to stderr. The call sites are fail-soft (they return null/[]),
// so without this the real Gemini/Vertex error — e.g. "Vertex AI API has not been
// used in project … or it is disabled", a billing or permission problem, a bad
// model — is otherwise swallowed and undiagnosable. We log err.message ONLY:
// provider errors carry infra identifiers (project, model, API name), never vault
// content, a passphrase, a share, or any zero-knowledge secret (the AI never sees
// those). Prefixed `[ai]` so it's greppable in the deploy log.
export function logAiError(surface: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ai] ${surface} failed: ${msg}\n`);
}

// Token usage for one model call (plan §0.2 — the breaker's accounting basis).
// Sourced from the SDK's usageMetadata when present, else estimated from text
// length so the cost breaker always has a number to add.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// One generation's result: the text plus its token usage. The usage lets the AI
// guard fold spend into ai_usage_daily without a second SDK call.
export interface GenerateResult {
  text: string;
  usage: TokenUsage;
}

// The seam the briefing route depends on, so tests inject a fake generator and
// never touch the network or the SDK.
export interface BriefingGenerator {
  // `json` requests structured JSON output (responseMimeType) for the planner.
  generate(system: string, user: string, json?: boolean): Promise<GenerateResult>;
}

// A char-based token estimate (~4 chars/token) for when the SDK omits usage
// metadata. Deliberately rough: it only feeds a cost ceiling, never billing.
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface GeminiClientConfig {
  backend: 'vertex' | 'api';
  model: string;
  project?: string | undefined;
  location?: string | undefined;
  apiKey?: string | undefined;
}

const GENERATE_TIMEOUT_MS = 15_000;

// Gemini via the unified @google/genai SDK. backend='api' (default) talks to the
// Gemini API directly with one key; backend='vertex' goes through Google Cloud and
// is kept as the rollback path — see resolveAiBriefing in config.ts for why the
// default moved. It is handed ONLY the metadata prompt (see briefing-prompt.ts)
// and never logs the prompt or the response.
export class GeminiClient implements BriefingGenerator {
  private readonly ai: GoogleGenAI;

  constructor(private readonly cfg: GeminiClientConfig) {
    // Build options omitting undefined keys (exactOptionalPropertyTypes). The
    // route only constructs this when config.aiBriefing.enabled is true, so the
    // backend's required field (vertex→project, api→apiKey) is present here.
    this.ai =
      cfg.backend === 'vertex'
        ? new GoogleGenAI({
            vertexai: true,
            ...(cfg.project !== undefined ? { project: cfg.project } : {}),
            ...(cfg.location !== undefined ? { location: cfg.location } : {}),
          })
        : new GoogleGenAI(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {});
  }

  async generate(system: string, user: string, json = false): Promise<GenerateResult> {
    const call = this.ai.models.generateContent({
      model: this.cfg.model,
      contents: user,
      config: {
        systemInstruction: system,
        // Low temperature: this is a factual help/assistant, not creative writing —
        // the audit caught one passphrase answer contradicting the others, so favour
        // consistency/accuracy over variety.
        temperature: 0.2,
        maxOutputTokens: 4096,
        // Both families are THINKING models; left on, internal "thinking" eats the
        // output-token budget and truncates (or empties) the actual answer. The
        // control differs per family and each rejects the other's — see
        // thinkingControlFor() above, which carries the measurements.
        thinkingConfig: thinkingControlFor(this.cfg.model),
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    });
    // SDK-agnostic timeout: a hung provider must not stall the request.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new AiError('gemini request timed out', true)), GENERATE_TIMEOUT_MS),
    );
    try {
      const res = await Promise.race([call, timeout]);
      // A MAX_TOKENS finish means the model hit the output cap and the answer was
      // cut mid-sentence. Even with thinking disabled a long answer can reach the
      // limit; returning the half-sentence is the audit's residual truncation, so
      // treat it as a (retryable) failure and let the surface fail soft with a
      // clean fallback instead of shipping a truncated answer.
      if (String(res.candidates?.[0]?.finishReason) === 'MAX_TOKENS') {
        throw new AiError('gemini response truncated (max_tokens)', true);
      }
      const text = res.text;
      if (text === undefined || text.trim() === '') {
        throw new AiError('gemini returned no text', true);
      }
      const trimmed = text.trim();
      // Prefer the SDK's real token counts; fall back to a char-based estimate so
      // the cost breaker always has a number. usageMetadata is metadata only —
      // no prompt or content.
      const meta = res.usageMetadata;
      const usage: TokenUsage = {
        inputTokens:
          typeof meta?.promptTokenCount === 'number'
            ? meta.promptTokenCount
            : estimateTokens(system) + estimateTokens(user),
        outputTokens:
          typeof meta?.candidatesTokenCount === 'number'
            ? meta.candidatesTokenCount
            : estimateTokens(trimmed),
      };
      return { text: trimmed, usage };
    } catch (err) {
      if (err instanceof AiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // A missing/retired model is PERMANENT: no amount of waiting brings it back,
      // and the operator needs to read "permanent" in the log rather than assume a
      // transient blip. GEMINI_MODEL unset falls through to a floating alias, so
      // the named family's retirement is a scheduled outage nobody is paged for.
      // Every AI call site is fail-soft, so the surfaces degrade to their template
      // or empty state and NOTHING breaks; the risk is that nobody notices for
      // weeks. (`retryable` is currently informational — no call site retries on
      // it — so this changes the log's honesty, not the number of calls made.)
      throw new AiError(`gemini error: ${msg}`, !isModelNotFound(msg));
    }
  }
}

// Recognise the provider's "that model does not exist here" shapes. Deliberately
// narrow: anything unrecognised stays retryable, because guessing permanence on a
// transient fault is the worse error of the two.
function isModelNotFound(message: string): boolean {
  return /\b404\b|NOT_FOUND|not found|does not exist|is not supported/i.test(message);
}
