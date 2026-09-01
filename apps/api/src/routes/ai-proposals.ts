import { AiAuthority } from '@truecairn/ai-authority';
import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { generateProposals } from '../ai/proposals.js';
import { requireSession } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { conflict, notFound, unauthorized } from '../errors.js';

// ── The proposal decision surface (plan docs/25 §5, 1.4) ──────────────────────
//
// The AI proposes; a HUMAN decides. Phase 1 is "AI as proposer, ZERO authority":
// a decision records the owner's choice and performs NO server-side mutation. An
// accepted suggestion is applied by the owner through their normal, already-gated
// flows — the proposal never becomes a bespoke mutation path. (AI-INITIATED
// execution through the sensitive-actions pipeline is Phase 2 bounded autonomy.)
//
// Audit actor model: proposal CREATION is AI-authored → actor='ai' via the
// chokepoint (in proposals.ts). A DECISION is the owner's → actor='owner' via the
// normal audit writer here.

interface ProposalDto {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export function aiProposalRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  // GET /v1/ai/proposals — the owner's open proposal inbox. Idempotently refreshes
  // the deterministic proposal set first (no LLM), then lists the 'proposed' ones.
  app.get(
    '/v1/ai/proposals',
    { preHandler: requireSession },
    async (request): Promise<{ proposals: ProposalDto[]; reason?: 'disabled' }> => {
      const session = request.session;
      const audit = app.audit;
      if (session === null) throw unauthorized('no session');
      if (!config.ai.proposerEnabled) return { proposals: [], reason: 'disabled' };
      if (await isOptedOut(db, session.userId)) return { proposals: [], reason: 'disabled' };

      // Refresh the deterministic proposals (best-effort — a failure here must not
      // break the inbox). Needs the audit writer for the ai_proposal_created chain.
      if (audit !== null) {
        try {
          await generateProposals(db, new AiAuthority({ audit }), session.userId, new Date());
        } catch (err) {
          request.log.warn({ err }, 'ai_proposals.generate_failed');
        }
      }

      const rows = await db
        .select()
        .from(schema.aiProposals)
        .where(
          and(
            eq(schema.aiProposals.userId, session.userId),
            eq(schema.aiProposals.status, 'proposed'),
          ),
        )
        .orderBy(desc(schema.aiProposals.createdAt));
      return { proposals: rows.map(toDto) };
    },
  );

  // POST /v1/ai/proposals/:id/decision { decision } — approve (acknowledge) or
  // reject an open proposal. Scoped to the session user (another user's proposal
  // is 404). A proposal that is not 'proposed' is a 409 (already decided/expired).
  app.post(
    '/v1/ai/proposals/:id/decision',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: { decision: { type: 'string', enum: ['approve', 'reject'] } },
        },
      },
    },
    async (request): Promise<{ id: string; status: string }> => {
      const session = request.session;
      const audit = app.audit;
      if (session === null || audit === null) throw unauthorized('auth backend unavailable');
      if (!config.ai.proposerEnabled) throw notFound('proposals are not enabled');
      const { id } = request.params as { id: string };
      const { decision } = request.body as { decision: 'approve' | 'reject' };
      const now = new Date();

      // Load + authorize in one query: a proposal not belonging to this user simply
      // isn't found (no cross-user disclosure).
      const [proposal] = await db
        .select({ id: schema.aiProposals.id, kind: schema.aiProposals.kind, status: schema.aiProposals.status })
        .from(schema.aiProposals)
        .where(and(eq(schema.aiProposals.id, id), eq(schema.aiProposals.userId, session.userId)))
        .limit(1);
      if (proposal === undefined) throw notFound('proposal not found');
      if (proposal.status !== 'proposed') {
        throw conflict(`proposal is already ${proposal.status}`);
      }

      const status = decision === 'approve' ? 'approved' : 'rejected';
      // The status change + its audit ride ONE transaction (CLAUDE.md invariant #5).
      // actor defaults to 'owner' — this is the account-holder's decision.
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .update(schema.aiProposals)
          .set({ status, decidedAt: now })
          .where(eq(schema.aiProposals.id, id));
        await audit.append(tx, session.userId, 'ai_proposal_decided', {
          proposalId: id,
          kind: proposal.kind,
          decision,
        });
      });
      return { id, status };
    },
  );
}

async function isOptedOut(db: Database, userId: UserId): Promise<boolean> {
  const [u] = await db
    .select({ optOut: schema.users.aiOptOut })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u?.optOut === true;
}

function toDto(row: typeof schema.aiProposals.$inferSelect): ProposalDto {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
