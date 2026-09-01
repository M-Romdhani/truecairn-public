import type { ReviewRequiredPort } from '@truecairn/ai-authority';
import type { Database } from '@truecairn/db';
import {
  applyEvent,
  loadRow,
  type AuditLogPort,
  type NotificationChannelLookup,
} from '@truecairn/engine';
import type { UserId } from '@truecairn/shared';

// ── The AI→engine bridge (plan docs/25 §3.1 / §7) ─────────────────────────────
//
// The ONE place AI intent becomes an engine effect. It implements the chokepoint's
// ReviewRequiredPort by applying the EXISTING fail-closed engine event
// `dispute_raised` (→ review_required state) — NO engine modification. It lives
// OUTSIDE the fenced guardian directory precisely because it imports @truecairn/
// engine: the guardian itself must reach the engine only through the chokepoint,
// which is handed this port. dispute_raised can only PAUSE the ladder (it is a
// no-op at full_release / review_required), never advance it.
export class EngineReviewPort implements ReviewRequiredPort {
  constructor(
    private readonly audit: AuditLogPort,
    private readonly channels: NotificationChannelLookup,
  ) {}

  async raiseReviewRequired(
    db: Database,
    userId: UserId,
    now: Date,
  ): Promise<{ changed: boolean; toState: string | null }> {
    const row = await loadRow(db, userId);
    if (row === null) return { changed: false, toState: null };
    const result = await applyEvent(
      row,
      { kind: 'dispute_raised' },
      { db, audit: this.audit, channels: this.channels, now },
    );
    return result.kind === 'transition'
      ? { changed: true, toState: result.toState }
      : { changed: false, toState: row.state };
  }
}
