import type { EngineState } from '@truecairn/shared';

// ── Zero-knowledge boundary (CLAUDE.md invariant #1) ─────────────────────────
// BriefingInputs is a CLOSED type of safe METADATA ONLY. It deliberately has no
// field for vault content, item titles, contact labels, emails, shares, keys, or
// passphrases — so the AI prompt cannot leak a secret BY CONSTRUCTION, not by
// redaction. Adding a ciphertext/PII field here would be the bug; the type IS the
// guard. Everything below is a count, an enum, or a timestamp the owner's own
// dashboard already shows.
export interface BriefingInputs {
  engineState: EngineState | null;
  previousState: EngineState | null;
  nextActionAt: string | null; // ISO timestamp of the next automatic engine step
  inactivityThresholdDays: number | null;
  vaultItemCount: number;
  contactCount: number; // active relationships (not removed)
  enrolledContactCount: number; // verified key — can hold a release share
  pendingContactCount: number; // invited / mid-enrolment — cannot hold a share yet
}

// Static system instruction. Contains NO user data, so it is safe by definition.
export const BRIEFING_SYSTEM_INSTRUCTION =
  'You are the continuity assistant for Truecairn, a zero-knowledge digital-legacy ' +
  'vault with an inactivity-triggered "engine" that releases access to trusted contacts ' +
  'if the owner goes silent. Describe the product as a digital continuity platform — ' +
  'never as a "dead man\'s switch". You receive ONLY non-sensitive account metadata — never ' +
  "the owner's content, names, or secrets. Write a short, calm readiness briefing " +
  '(2-4 sentences) then 1-3 prioritized, concrete next steps. Domain rules: the ' +
  'engine only protects the owner once its state is "active"; a tier-S2 release needs ' +
  'at least 2 enrolled contacts and S3 needs 3; pending contacts cannot hold a ' +
  'release share until they finish enrolling. Never invent data beyond the metadata, ' +
  'never ask for or reference private content. Use PLAIN TEXT only — no markdown ' +
  'formatting (no **bold**, #, backticks, or bullet characters); short paragraphs, ' +
  'and number any steps like "1." on their own line.';

// Build the user-content prompt from the safe metadata. Pure + deterministic, so
// it is unit-testable and its output is reproducible for caching (inputs_hash).
export function buildBriefingPrompt(i: BriefingInputs): string {
  return [
    'Account continuity metadata:',
    `- engine state: ${i.engineState ?? 'not started (engine not armed)'}`,
    `- previous engine state: ${i.previousState ?? 'none'}`,
    `- next automatic step at: ${i.nextActionAt ?? 'none scheduled'}`,
    `- inactivity threshold (days): ${i.inactivityThresholdDays ?? 'default'}`,
    `- vault items stored: ${i.vaultItemCount}`,
    `- trusted contacts: ${i.contactCount} (enrolled/verified: ${i.enrolledContactCount}, pending: ${i.pendingContactCount})`,
    '',
    'Write the readiness briefing and next steps for the owner based ONLY on the above.',
  ].join('\n');
}
