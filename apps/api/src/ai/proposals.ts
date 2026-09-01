import { createHash } from 'node:crypto';
import {
  assertActionKindAllowed,
  validateObject,
  type AiAuthority,
  type AiProposalKind,
  type ObjectSpec,
  type ValidationOutcome,
} from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import { CONTACT_ROLES, VAULT_TIERS, type UserId } from '@truecairn/shared';
import { and, eq } from 'drizzle-orm';
import { gatherReadinessInputs, READINESS_GAP_CODES, scoreReadiness } from './readiness.js';

// ── Proposal generation (plan docs/25 §5 / D2, D4) ────────────────────────────
//
// The AI proposes; a human decides; execution (if any) routes through the EXISTING
// sensitive-actions pipeline. Generation here is DETERMINISTIC-FIRST: proposals are
// derived from the deterministic readiness gaps and bounded rules — the LLM does not
// invent them (it only narrates, elsewhere). This keeps the proposer path free of
// prompt-injection risk by construction: a hostile string can't manufacture a
// proposal, because proposals come from server-side facts, not model text.

export const PROPOSAL_TTL_DAYS = 14;
// Every proposal this module generates carries this template id. The supersede
// sweep below keys off it so it can only ever retire rows THIS generator made —
// a proposal from any other source is none of its business.
export const DETERMINISTIC_TEMPLATE_ID = 'deterministic.readiness.v1';
// A check-in interval above this is "loose" enough to propose tightening; the
// proposal only ever SHORTENS (the closed-direction bound from the chokepoint).
const LOOSE_INACTIVITY_DAYS = 60;
const TIGHTEN_TARGET_DAYS = 30;

// Per-kind payload schemas, validated deny-by-default with ai-authority's
// validator. Closed enums, bounded ints, capped strings, additionalProperties
// false. Adding a field here is a reviewable change (docs/AI.md must track it).
export const PROPOSAL_PAYLOAD_SCHEMAS: Record<AiProposalKind, ObjectSpec> = {
  flag_readiness_gap: {
    fields: {
      gap: { type: 'enum', values: READINESS_GAP_CODES },
      severity: { type: 'enum', values: ['blocker', 'warning'] },
      tier: { type: 'enum', values: VAULT_TIERS },
    },
    optional: ['tier'],
  },
  tighten_checkin_schedule: {
    fields: {
      currentDays: { type: 'int', min: 1, max: 3650 },
      proposedDays: { type: 'int', min: 1, max: 3650 },
    },
  },
  draft_contact_message: {
    fields: {
      role: { type: 'enum', values: [...CONTACT_ROLES] },
      message: { type: 'string', maxLength: 1000, minLength: 1 },
    },
  },
  suggest_metadata_recategorization: {
    fields: {
      fromCategory: { type: 'string', maxLength: 128, minLength: 1 },
      toCategory: { type: 'string', maxLength: 128, minLength: 1 },
      itemCount: { type: 'int', min: 1, max: 100000 },
    },
  },
};

export function validateProposalPayload(
  kind: string,
  payload: unknown,
): ValidationOutcome<Record<string, unknown>> {
  const spec = (PROPOSAL_PAYLOAD_SCHEMAS as Record<string, ObjectSpec | undefined>)[kind];
  if (spec === undefined) return { ok: false, reason: `unknown proposal kind '${kind}'` };
  const out = validateObject(spec, payload);
  if (!out.ok) return out;
  // Cross-field invariant: a schedule change may only ever SHORTEN (the closed
  // safety direction). Enforced here so even a future LLM-emitted tighten proposal
  // cannot loosen protection — validateObject alone can't express cross-field rules.
  if (kind === 'tighten_checkin_schedule') {
    const current = out.value['currentDays'] as number;
    const proposed = out.value['proposedDays'] as number;
    if (proposed >= current) {
      return { ok: false, reason: 'tighten_checkin_schedule may only shorten the interval' };
    }
  }
  return out;
}

interface ProposalCandidate {
  kind: AiProposalKind;
  payload: Record<string, unknown>;
}

// The deterministic candidate set for a user's current state. Same inputs → same
// candidates. Extra bound: tighten only ever SHORTENS the interval.
export async function computeProposalCandidates(
  db: Database,
  userId: UserId,
): Promise<ProposalCandidate[]> {
  const inputs = await gatherReadinessInputs(db, userId);
  const report = scoreReadiness(inputs);
  const candidates: ProposalCandidate[] = [];

  // One flag_readiness_gap per BLOCKER gap (warnings stay in the readiness card,
  // not the proposal inbox, to avoid nagging).
  for (const gap of report.gaps) {
    if (gap.severity !== 'blocker') continue;
    candidates.push({
      kind: 'flag_readiness_gap',
      payload: { gap: gap.code, severity: gap.severity, ...(gap.tier ? { tier: gap.tier } : {}) },
    });
  }

  // tighten_checkin_schedule when the inactivity threshold is loose. Bounded:
  // proposedDays < currentDays (shorten only) — the chokepoint would reject the
  // opposite direction, and validateProposalPayload enforces the shape.
  const [es] = await db
    .select({ days: schema.engineStates.inactivityThresholdDays })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);
  const currentDays = es?.days ?? null;
  if (currentDays !== null && currentDays > LOOSE_INACTIVITY_DAYS) {
    candidates.push({
      kind: 'tighten_checkin_schedule',
      payload: { currentDays, proposedDays: TIGHTEN_TARGET_DAYS },
    });
  }

  return candidates;
}

const OUTPUT_HASH_SALT = 'tc-ai-proposal-v1';
function outputHash(kind: string, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(OUTPUT_HASH_SALT)
    .update(kind)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Generate + persist deterministic proposals for a user, idempotently. Each
// candidate is (a) guarded by the chokepoint kind/tier registry, (b) validated
// deny-by-default, (c) deduped against an existing 'proposed' row with the same
// output hash, then (d) inserted + audited (ai_proposal_created, actor='ai') in
// ONE transaction. Returns the number of NEW proposals created.
export async function generateProposals(
  db: Database,
  authority: AiAuthority,
  userId: UserId,
  now: Date,
): Promise<number> {
  const candidates = await computeProposalCandidates(db, userId);
  let created = 0;
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000);
  // The hashes that are STILL justified by the owner's current state. Built from
  // the same candidate list the create loop consumes, so generation and supersede
  // can never disagree about what is live.
  const liveHashes = new Set<string>();

  for (const c of candidates) {
    // Defence in depth: the kind must be a registered proposal kind, and the
    // payload must validate. A candidate failing either is a bug — skip it.
    try {
      assertActionKindAllowed(c.kind, 'proposal');
    } catch {
      continue;
    }
    const valid = validateProposalPayload(c.kind, c.payload);
    if (!valid.ok) continue;
    const hash = outputHash(c.kind, valid.value);
    liveHashes.add(hash);

    const existing = await db
      .select({ id: schema.aiProposals.id })
      .from(schema.aiProposals)
      .where(
        and(
          eq(schema.aiProposals.userId, userId),
          eq(schema.aiProposals.status, 'proposed'),
          eq(schema.aiProposals.outputHash, hash),
        ),
      )
      .limit(1);
    if (existing[0] !== undefined) continue; // already have this open proposal

    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const [row] = await tx
        .insert(schema.aiProposals)
        .values({
          userId,
          kind: c.kind,
          payload: valid.value,
          status: 'proposed',
          source: 'assist',
          promptTemplateId: DETERMINISTIC_TEMPLATE_ID,
          outputHash: hash,
          expiresAt,
        })
        .returning({ id: schema.aiProposals.id });
      await authority.appendAiAudit(tx, userId, 'ai_proposal_created', {
        proposalId: row!.id,
        kind: c.kind,
        outputHash: hash,
      });
    });
    created += 1;
  }

  await supersedeResolved(db, authority, userId, liveHashes, now);
  return created;
}

// Retire open proposals whose gap the owner has already fixed (QA 2026-08-11 §4).
//
// Scoped twice over, because this is the only path that closes a proposal without
// the owner deciding it: to rows THIS generator created (`promptTemplateId`), and
// to rows still `proposed`. An approved/rejected row is the owner's record and is
// never touched; a proposal from another source is not ours to judge.
//
// `superseded` is deliberately not `expired` — see migration 0064. The owner
// fixing something and the owner ignoring it are different facts, and this one
// rides the tamper-evident chain.
//
// Reads the rows and filters in JS rather than a NOT IN: the set is at most a
// handful per user, and an empty `liveHashes` (every gap resolved — the good case)
// is exactly where a `notInArray` would need special-casing anyway.
async function supersedeResolved(
  db: Database,
  authority: AiAuthority,
  userId: UserId,
  liveHashes: ReadonlySet<string>,
  now: Date,
): Promise<void> {
  const open = await db
    .select({ id: schema.aiProposals.id, kind: schema.aiProposals.kind, outputHash: schema.aiProposals.outputHash })
    .from(schema.aiProposals)
    .where(
      and(
        eq(schema.aiProposals.userId, userId),
        eq(schema.aiProposals.status, 'proposed'),
        eq(schema.aiProposals.promptTemplateId, DETERMINISTIC_TEMPLATE_ID),
      ),
    );

  for (const row of open) {
    if (row.outputHash !== null && liveHashes.has(row.outputHash)) continue;
    // Status change + its audit in ONE transaction (CLAUDE.md invariant #5).
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await tx
        .update(schema.aiProposals)
        .set({ status: 'superseded', decidedAt: now })
        .where(and(eq(schema.aiProposals.id, row.id), eq(schema.aiProposals.status, 'proposed')));
      await authority.appendAiAudit(tx, userId, 'ai_proposal_decided', {
        proposalId: row.id,
        kind: row.kind,
        status: 'superseded',
      });
    });
  }
}
