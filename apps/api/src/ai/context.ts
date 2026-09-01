import { schema, type Database } from '@truecairn/db';
import {
  CEREMONY_STATUSES,
  CONTACT_ROLES,
  VAULT_TIERS,
  isLocale,
  type CeremonyStatus,
  type ContactRole,
  type EngineState,
  type Locale,
  type UserId,
  type VaultTier,
} from '@truecairn/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

// ── The AI context builder (plan docs/25 §3.2 / P2) ───────────────────────────
//
// THE single place any server-side AI prompt gets its data. It is the technical
// anchor of the zero-knowledge promise: the AI sees ONLY what this builder
// assembles, and this builder reads ONLY the fields in AI_CONTEXT_ALLOWLIST —
// counts, closed-enum values, and cadence numbers the owner's own dashboard
// already shows. The allowlist snapshot test (context.test.ts) pins the exact
// field set, so ADDING a field is a deliberate, reviewable change that fails the
// test until the test AND docs/AI.md ("what the AI can see") are updated together.
//
// DELIBERATE DEVIATION FROM THE PLAN'S §3.2 WORDING (recorded in docs/AI.md and
// PROGRESS.md): the plan lists "item titles" and "contact display names" as
// allowlisted. On this codebase those are CIPHERTEXT server-side
// (vault_items.title_ciphertext, contacts.display_label_ciphertext) — the server
// has no plaintext for them, so including them in a server prompt is impossible
// without breaking invariant #1. Vault `category` IS server-plaintext but is
// free-text the owner typed (could be sensitive or an injection vector), so it is
// excluded too. The server-side allowlist is therefore counts + enums + cadence
// ONLY — no free-text values. AI over decrypted titles/notes is Phase 4's
// client-side-only capability, never a server feature.

// The exact, frozen set of leaf field paths any AI prompt may contain. The
// snapshot test asserts this equals the expected list AND that a built context
// exposes no path outside it. NOTHING here is a secret, a free-text value, an
// email, an IP hash, a key field, or session data.
export const AI_CONTEXT_ALLOWLIST = [
  'engine.state',
  'engine.previousState',
  'engine.inactivityThresholdDays',
  'engine.checkInTimeoutDays',
  'engine.nextScheduledCheckInAt',
  'vault.totalItems',
  'vault.itemsByTier.s1',
  'vault.itemsByTier.s2',
  'vault.itemsByTier.s3',
  'contacts.total',
  'contacts.enrolled',
  'contacts.pending',
  'contacts.byRole.personal',
  'contacts.byRole.professional',
  'contacts.byRole.recovery',
  'ceremony.activeStatuses',
  // The owner's stated interface language (migration 0067), added in docs/40
  // Phase 4. It is here because it REACHES A PROMPT — the allowlist's rule is
  // about what a prompt may contain, not about what the model reasons over, and
  // this is a directive about the output rather than an input.
  //
  // Safe for the same reason every other entry is: a CLOSED ENUM from a
  // CHECK-constrained column, never free text. That is the whole basis on which
  // interpolating anything user-derived into a system instruction is acceptable
  // at all — see apps/api/src/ai/language.ts, which takes a `Locale` and not a
  // string precisely so this cannot become an injection vector later.
  'user.locale',
] as const;

export interface AiContext {
  engine: {
    state: EngineState | null;
    previousState: EngineState | null;
    inactivityThresholdDays: number | null;
    checkInTimeoutDays: number | null;
    // ISO timestamp (a cadence datum, not content) or null.
    nextScheduledCheckInAt: string | null;
  };
  vault: {
    totalItems: number;
    itemsByTier: Record<VaultTier, number>;
  };
  contacts: {
    total: number;
    enrolled: number;
    pending: number;
    byRole: Record<ContactRole, number>;
  };
  ceremony: {
    // Closed-enum status NAMES of the user's non-terminal ceremonies. No ids, no
    // affirmation content, no contact identities.
    activeStatuses: CeremonyStatus[];
  };
  user: {
    // NULL means "never chose", which is not the same as choosing the source
    // language (migration 0067). Both produce a source-language answer today.
    locale: Locale | null;
  };
}

// Assemble the AI context for a user by EXPLICIT field selection (schema-pick,
// never object spread). Every read below corresponds to one allowlisted path.
export async function buildAiContext(db: Database, userId: UserId): Promise<AiContext> {
  const [es] = await db
    .select({
      state: schema.engineStates.state,
      previousState: schema.engineStates.previousState,
      inactivityThresholdDays: schema.engineStates.inactivityThresholdDays,
      checkInTimeoutDays: schema.engineStates.checkInTimeoutDays,
      nextScheduledCheckInAt: schema.engineStates.nextScheduledCheckInAt,
    })
    .from(schema.engineStates)
    .where(eq(schema.engineStates.userId, userId))
    .limit(1);

  const vaultByTier = await db
    .select({ tier: schema.vaultItems.tier, n: sql<number>`count(*)::int` })
    .from(schema.vaultItems)
    .where(and(eq(schema.vaultItems.userId, userId), isNull(schema.vaultItems.deletedAt)))
    .groupBy(schema.vaultItems.tier);

  const contactRows = await db
    .select({ role: schema.contacts.role, status: schema.contacts.status })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.ownerUserId, userId), isNull(schema.contacts.removedAt)));

  const ceremonyRows = await db
    .select({ status: schema.releaseCeremonies.status })
    .from(schema.releaseCeremonies)
    .where(eq(schema.releaseCeremonies.userId, userId));

  const [userRow] = await db
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const itemsByTier = emptyTierCounts();
  let totalItems = 0;
  for (const row of vaultByTier) {
    itemsByTier[row.tier as VaultTier] = row.n;
    totalItems += row.n;
  }

  const byRole = emptyRoleCounts();
  let enrolled = 0;
  let pending = 0;
  for (const c of contactRows) {
    byRole[c.role as ContactRole] += 1;
    if (c.status === 'enrolled' || c.status === 'active') enrolled += 1;
    else if (c.status === 'invited' || c.status === 'pending_keygen') pending += 1;
  }

  const TERMINAL: ReadonlySet<CeremonyStatus> = new Set(['released', 'cancelled', 'failed']);
  const activeStatuses = ceremonyRows
    .map((r) => r.status as CeremonyStatus)
    .filter((s) => !TERMINAL.has(s));

  return {
    engine: {
      state: es?.state ?? null,
      previousState: es?.previousState ?? null,
      inactivityThresholdDays: es?.inactivityThresholdDays ?? null,
      checkInTimeoutDays: es?.checkInTimeoutDays ?? null,
      nextScheduledCheckInAt: es?.nextScheduledCheckInAt?.toISOString() ?? null,
    },
    vault: { totalItems, itemsByTier },
    contacts: { total: contactRows.length, enrolled, pending, byRole },
    ceremony: { activeStatuses },
    // Narrowed through isLocale rather than passed through: the column is
    // CHECK-constrained, but a value retired from LOCALES after a row was
    // written is exactly how a "cannot happen" value happens, and this one ends
    // up in a system instruction.
    user: { locale: isLocale(userRow?.locale) ? userRow.locale : null },
  };
}

function emptyTierCounts(): Record<VaultTier, number> {
  return Object.fromEntries(VAULT_TIERS.map((t) => [t, 0])) as Record<VaultTier, number>;
}

function emptyRoleCounts(): Record<ContactRole, number> {
  return Object.fromEntries(CONTACT_ROLES.map((r) => [r, 0])) as Record<ContactRole, number>;
}

// Enumerate every leaf field path a context object actually contains. Used by the
// allowlist snapshot test to prove the built object never exposes a path outside
// AI_CONTEXT_ALLOWLIST — the runtime companion to the type. Arrays are treated as
// leaves (their element VALUES are closed-enum status names, asserted separately).
export function contextLeafPaths(context: AiContext): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, prefix === '' ? k : `${prefix}.${k}`);
    } else {
      paths.push(prefix);
    }
  };
  walk(context, '');
  return paths.sort();
}

// Guard used by the snapshot test AND available to any prompt builder: assert a
// context exposes no field outside the allowlist. Also asserts ceremony status
// values are closed-enum names (never free text).
export function assertContextWithinAllowlist(context: AiContext): void {
  const allowed = new Set<string>(AI_CONTEXT_ALLOWLIST);
  for (const path of contextLeafPaths(context)) {
    if (!allowed.has(path)) {
      throw new Error(`AI context exposes non-allowlisted field '${path}'`);
    }
  }
  for (const status of context.ceremony.activeStatuses) {
    if (!(CEREMONY_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`AI context ceremony status '${status}' is not a closed-enum value`);
    }
  }
}
