import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { releaseCeremonies } from './ceremonies.js';

// The frozen Continuity Report (docs/26 §3.3): snapshotted into this table in
// the SAME transaction that creates the release ceremony, with the payload's
// hash appended to the audit chain (ceremony.continuity_report_attached).
// Never recomputed after creation — recipients read the snapshot, so the
// evidence they act on is exactly the evidence that was anchored. `payload`
// is the serialized ContinuityReportPayload as TEXT: the anchored hash is
// sha256 over these exact bytes (jsonb would re-order keys and break that).
export const continuityReports = pgTable(
  'continuity_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ceremonyId: uuid('ceremony_id')
      .notNull()
      .references(() => releaseCeremonies.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // AI narration (Gap plan G-1) — BESIDE the sealed payload, never inside it.
    // NULL = no narration, and the panel then renders NO prose block at all —
    // the factual report stands alone. (There is no deterministic narration
    // template; readiness has one, this does not.) Filled at most once
    // (fill-only-NULL update); migration 0051.
    narrationText: text('narration_text'),
    narrationModelId: text('narration_model_id'),
    narrationTemplateId: text('narration_template_id'),
    narrationGeneratedAt: timestamp('narration_generated_at', { withTimezone: true }),
  },
  (t) => ({
    ceremonyUniq: uniqueIndex('continuity_reports_ceremony_uniq').on(t.ceremonyId),
  }),
);

export type ContinuityReport = typeof continuityReports.$inferSelect;
