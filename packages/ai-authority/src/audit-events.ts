// ── AI audit event types (plan docs/25 §3.4) ─────────────────────────────────
//
// New event types the ai-authority chokepoint appends to the existing per-user
// hash chain, always with actor='ai'. Payloads follow D6 — template id + version,
// salted prompt hash, output hash, model id, token counts — NEVER a raw prompt or
// any metadata copy. The asymmetry invariant test asserts an actor='ai' row can
// only ever carry one of these types (in particular, never a forward engine
// event), and the redaction tests cover every field these payloads may contain.

export const AI_AUDIT_EVENT_TYPES = [
  'ai_proposal_created',
  'ai_proposal_decided', // approved | rejected | expired, with the decider
  'ai_autonomous_enqueued',
  'ai_autonomous_vetoed',
  'ai_review_signal_emitted', // the one fail-closed engine signal
  'ai_output_rejected', // deny-by-default validation discarded model output
  'ai_breaker_tripped', // cost circuit breaker opened
  'ai_config_changed',
] as const;

export type AiAuditEventType = (typeof AI_AUDIT_EVENT_TYPES)[number];

const AI_AUDIT_EVENT_SET: ReadonlySet<string> = new Set(AI_AUDIT_EVENT_TYPES);

export function isAiAuditEventType(t: string): t is AiAuditEventType {
  return AI_AUDIT_EVENT_SET.has(t);
}
