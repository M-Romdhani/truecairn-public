import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BriefingInputs } from './briefing-prompt.js';

// Gather ONLY the safe metadata fields BriefingInputs declares — counts, enums,
// and timestamps the owner's own dashboard already shows. No ciphertext, labels,
// emails, or secrets are ever read into the AI prompt path (CLAUDE.md invariant
// #1). Shared by every AI feature (briefing, assistant, planner).
export async function gatherBriefingInputs(db: Database, userId: UserId): Promise<BriefingInputs> {
  const [es] = await db
    .select({
      state: schema.engineStates.state,
      previousState: schema.engineStates.previousState,
      nextActionAt: schema.engineStates.nextActionAt,
      inactivityThresholdDays: schema.engineStates.inactivityThresholdDays,
    })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);

  const [vault] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.vaultItems)
    .where(and(eq(schema.vaultItems.userId, userId), isNull(schema.vaultItems.deletedAt)));

  const contactRows = await db
    .select({ status: schema.contacts.status })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.ownerUserId, userId), isNull(schema.contacts.removedAt)));

  const enrolled = contactRows.filter((c) => c.status === 'enrolled' || c.status === 'active').length;
  const pending = contactRows.filter(
    (c) => c.status === 'invited' || c.status === 'pending_keygen',
  ).length;

  return {
    engineState: es?.state ?? null,
    previousState: es?.previousState ?? null,
    nextActionAt: es?.nextActionAt?.toISOString() ?? null,
    inactivityThresholdDays: es?.inactivityThresholdDays ?? null,
    vaultItemCount: vault?.n ?? 0,
    contactCount: contactRows.length,
    enrolledContactCount: enrolled,
    pendingContactCount: pending,
  };
}
