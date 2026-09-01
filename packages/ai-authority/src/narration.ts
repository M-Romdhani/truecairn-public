import type { ObjectSpec } from './output.js';

// ── Continuity-Report narration (Gap plan G-1, docs/26) ──────────────────────
//
// The one AI purpose that speaks to a ceremony RECIPIENT: a plain-language
// explanation of the frozen Continuity Report. It EXPLAINS, never decides —
// the outcome stays the closed rule-computed enum, the evidence stays the
// sealed payload, and narration is stored beside them (nullable columns), so
// its absence or failure costs nothing but prose. Registered here so the
// output contract lives at the chokepoint with every other AI output spec:
// deny-by-default, additionalProperties:false, length-capped plain text that
// callers render as React text only.
//
// Adding to this file is a SECURITY-REVIEW event like every capability change
// in this package (see capabilities.ts header).

// Versioned template id, recorded on the row + in audit payloads so a stored
// narration is forever attributable to the exact prompt contract that made it.
// v2 (2026-08-07): the payload is now fenced, and the rules gained explicit bans
// on implying incapacity and on urging speed. A stored narration must stay
// attributable to the exact contract that produced it, so a material change to
// the instruction bumps this rather than editing in place — rows written under v1
// keep saying v1.
export const CONTINUITY_NARRATION_TEMPLATE_ID = 'continuity_narration_v2';

// A short reading, not an essay: the deterministic panel already lists every
// line of evidence; narration summarises what it means.
export const NARRATION_MAX_LENGTH = 1200;

export const NARRATION_OUTPUT_SPEC: ObjectSpec = {
  fields: {
    narration: { type: 'string', maxLength: NARRATION_MAX_LENGTH, minLength: 1 },
  },
};
