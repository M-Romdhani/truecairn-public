import type { EngineEvent } from '@truecairn/engine';

// ── The complete universe of AI capabilities (plan docs/25 §3.1 / D1) ─────────
//
// This file is the type-system layer of the asymmetric-authority guarantee: AI
// may ADD safety, never REMOVE it. Adding to any union or registry here is a
// SECURITY-REVIEW event (plan §11), not a refactor. The runtime guards below are
// defence-in-depth beneath these types; the permanent invariant tests (plan §0.5)
// enumerate every engine event and assert only `review_required` is reachable.

export class AiAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiAuthorityError';
  }
}

// ── Engine authority: exactly ONE signal, in the fail-closed direction ─────────

// The ONLY engine capability the AI has. 'review_required' is a fail-closed
// STATE: reaching it freezes the release ladder (nextActionAt=null) and demands
// human review. The AI can never emit a forward event (a release authorisation,
// a ceremony advance, an attestation). Worst case of a hallucination or a prompt
// injection is therefore a dismissible false alarm — never a wrongful release.
export type AiEngineSignal = 'review_required';

export const AI_ALLOWED_ENGINE_SIGNALS: ReadonlySet<string> = new Set<AiEngineSignal>([
  'review_required',
]);

// Runtime chokepoint: assert a signal is the single allowlisted one BEFORE any
// engine effect. Throws for everything else — including every forward engine
// event kind and every forward transition reason (proven by the invariant test).
export function assertAllowedEngineSignal(signal: string): asserts signal is AiEngineSignal {
  if (!AI_ALLOWED_ENGINE_SIGNALS.has(signal)) {
    throw new AiAuthorityError(
      `engine signal '${signal}' is not in the AI allowlist; AI may emit only 'review_required'`,
    );
  }
}

// Map the abstract AI signal to the concrete engine event. 'review_required' is a
// state, not an event; the event that moves the engine INTO it (from any non-
// terminal state, halting progression) is `dispute_raised`. This function is the
// ONLY place AI intent becomes an engine event, and it can produce only this one.
export function toEngineEvent(signal: AiEngineSignal): EngineEvent {
  assertAllowedEngineSignal(signal);
  return { kind: 'dispute_raised' };
}

// ── Action authority: proposals (Tier 1) and bounded autonomy (Tier 2) ─────────

// Tier 1 — the AI proposes, a human decides (plan §5).
export type AiProposalKind =
  | 'tighten_checkin_schedule'
  | 'draft_contact_message'
  | 'suggest_metadata_recategorization'
  | 'flag_readiness_gap';

// Tier 2 — the AI enqueues into the existing sensitive-actions pipeline; executes
// unless the owner vetoes during the delay window (plan §6).
export type AiAutonomousKind = 'send_reminder_nudge' | 'tighten_checkin_schedule';

export type AiActionKind = AiProposalKind | AiAutonomousKind;
export type AiActionTier = 'proposal' | 'autonomous';

// Which way a kind moves the owner's protection:
//   'closed'  — tightens protection (e.g. SHORTENING a check-in interval).
//   'neutral' — no protection effect (drafting text, flagging a gap, a nudge).
//   'open'    — LOOSENS protection (e.g. lengthening an interval, widening access).
// The rule (§3.1): an 'open' kind may exist ONLY as a Tier-1 proposal a human
// approves — NEVER as Tier-2 autonomy. No 'open' kind is registered today; the
// type + guard exist so that the day one is added, autonomy rejects it by
// construction (proven by the Phase 2 invariant test).
export type SafetyDirection = 'closed' | 'neutral' | 'open';

export interface ActionKindSpec {
  safetyDirection: SafetyDirection;
  // The tiers this kind may be used at. The chokepoint refuses any (kind, tier)
  // pair not listed here, and refuses an 'open' kind at the 'autonomous' tier
  // regardless of this list (belt and braces).
  tiers: ReadonlyArray<AiActionTier>;
}

export const AI_ACTION_KINDS: Readonly<Record<AiActionKind, ActionKindSpec>> = {
  // Shortening the check-in cadence tightens protection ⇒ 'closed'. Allowed as a
  // proposal AND as bounded autonomy (within owner-configured bounds, §6).
  tighten_checkin_schedule: { safetyDirection: 'closed', tiers: ['proposal', 'autonomous'] },
  // Drafts text for the owner to send; sends nothing itself ⇒ 'neutral', proposal.
  draft_contact_message: { safetyDirection: 'neutral', tiers: ['proposal'] },
  // Suggests a metadata recategorisation the owner applies ⇒ 'neutral', proposal.
  suggest_metadata_recategorization: { safetyDirection: 'neutral', tiers: ['proposal'] },
  // Informational readiness gap ⇒ 'neutral', proposal.
  flag_readiness_gap: { safetyDirection: 'neutral', tiers: ['proposal'] },
  // An extra check-in reminder; changes no configuration ⇒ 'neutral', autonomy.
  send_reminder_nudge: { safetyDirection: 'neutral', tiers: ['autonomous'] },
};

// Runtime chokepoint for a proposal/autonomy action. Throws unless the kind is
// registered AND permitted at the requested tier AND — for autonomy — not an
// 'open' (protection-loosening) kind. This is where a future mistake (marking a
// loosening action autonomous) is caught before it can execute unattended.
export function assertActionKindAllowed(kind: string, tier: AiActionTier): void {
  const spec = (AI_ACTION_KINDS as Record<string, ActionKindSpec | undefined>)[kind];
  assertActionSpecAllowed(kind, tier, spec);
}

// The pure spec check, split out so the 'open'-at-autonomous rejection is directly
// testable with a hand-built spec (no such kind exists in the real registry — the
// point is that if one were ever added, autonomy rejects it by construction).
export function assertActionSpecAllowed(
  kind: string,
  tier: AiActionTier,
  spec: ActionKindSpec | undefined,
): void {
  if (spec === undefined) {
    throw new AiAuthorityError(`AI action kind '${kind}' is not registered`);
  }
  if (!spec.tiers.includes(tier)) {
    throw new AiAuthorityError(`AI action kind '${kind}' is not permitted at tier '${tier}'`);
  }
  if (tier === 'autonomous' && spec.safetyDirection === 'open') {
    throw new AiAuthorityError(
      `AI action kind '${kind}' loosens protection and can never be autonomous; propose it instead`,
    );
  }
}
