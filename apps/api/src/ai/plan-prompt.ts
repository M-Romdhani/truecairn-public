import type { BriefingInputs } from './briefing-prompt.js';

// Allowed action kinds — a CLOSED enum. The model returns one of these per step
// and the UI maps each to a known deep-link, so an LLM can never smuggle an
// arbitrary action or URL into the dashboard.
export const PLAN_STEP_KINDS = [
  'add_vault_item',
  'add_contact',
  'enrol_contact',
  'assign_shares',
  'arm_engine',
  'review',
] as const;
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];

export interface PlanStep {
  kind: PlanStepKind;
  title: string;
  why: string;
}

export const PLAN_SYSTEM_INSTRUCTION =
  'You are Truecairn’s setup planner. From the owner’s account metadata, choose the ' +
  '1-4 most important next steps to strengthen their digital-continuity setup, most ' +
  'important first. Return ONLY a JSON array (no prose, no markdown fences). Each ' +
  'item is an object {"kind","title","why"} where kind is exactly one of: ' +
  'add_vault_item, add_contact, enrol_contact, assign_shares, arm_engine, review; ' +
  'title is a short imperative (max 6 words); why is one short sentence. Base it ONLY ' +
  'on the metadata. Domain rules: the engine is only useful with at least one vault ' +
  'item and one enrolled contact; S2 needs at least 2 enrolled contacts and S3 needs ' +
  '3; pending contacts must finish enrolling before they can hold a share; arm the ' +
  'engine once there is something to release and someone to release it to. If the ' +
  'setup already looks complete, return a single "review" step.';

export function buildPlanPrompt(i: BriefingInputs): string {
  return [
    'Account metadata:',
    `- engine state: ${i.engineState ?? 'not started'}`,
    `- vault items: ${i.vaultItemCount}`,
    `- contacts: ${i.contactCount} (enrolled: ${i.enrolledContactCount}, pending: ${i.pendingContactCount})`,
    '',
    'Return the JSON array of prioritized steps.',
  ].join('\n');
}

function isPlanStep(v: unknown): v is PlanStep {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['kind'] === 'string' &&
    (PLAN_STEP_KINDS as readonly string[]).includes(o['kind']) &&
    typeof o['title'] === 'string' &&
    typeof o['why'] === 'string'
  );
}

// Parse + validate the model's JSON output. NEVER throws — fail-soft to [] — and
// drops any item whose kind is not in the closed allowlist. Tolerates a stray
// ```json fence in case the model adds one despite the instruction.
export function parsePlanSteps(text: string): PlanStep[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isPlanStep)
    .slice(0, 4)
    .map((s) => ({ kind: s.kind, title: s.title.slice(0, 80), why: s.why.slice(0, 200) }));
}
