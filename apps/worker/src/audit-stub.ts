import type { AppendedAuditEntry, AuditLogPort } from '@truecairn/engine';
import type { Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { randomUUID } from 'node:crypto';
import { log } from './log.js';

// Logging-only audit port retained for dev environments that don't want to
// generate signing keys. Production deployments wire AuditLogWriter from
// @truecairn/audit instead.
export class LoggingAuditPort implements AuditLogPort {
  private nextSeq = 1n;
  async append(
    _db: Database,
    userId: UserId,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<AppendedAuditEntry> {
    log.info('audit.deferred', { userId, eventType, payload });
    const seq = this.nextSeq++;
    return { id: randomUUID(), seq, entryHash: new Uint8Array(32) };
  }
}
