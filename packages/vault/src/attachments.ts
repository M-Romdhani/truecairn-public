// Attachment storage helpers (PHASE3_3 Checkpoint C). Shared by the API (upload
// reserve / download / rollback) and the worker's purge_attachment handler
// (release + file delete), so the budget arithmetic and the on-disk path live in
// one place. The blob itself is an opaque client-encrypted byte stream — the
// server never crypto-processes it; the gate is inherited from the parent item.

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { eq, sql } from 'drizzle-orm';

// Local-disk layout: <baseDir>/<userId>/<attachmentId>.bin (Q5b). userId +
// attachmentId are UUIDs, so there is no path-traversal surface.
export function attachmentFilePath(baseDir: string, userId: string, attachmentId: string): string {
  return join(baseDir, userId, `${attachmentId}.bin`);
}

// Atomically reserve `bytes` of a user's storage budget. SELECT ... FOR UPDATE
// serialises concurrent uploads so two can't both overshoot the cap: the second
// waits for the first to commit, then sees the updated total. Returns false (no
// increment) if the user is missing or the reservation would exceed `capBytes`.
export async function reserveUserStorage(
  db: Database,
  userId: UserId,
  bytes: number,
  capBytes: number,
): Promise<boolean> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    const [row] = await tx
      .select({ used: schema.users.storageBytesUsed })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update');
    if (!row) return false;
    if (row.used + bytes > capBytes) return false;
    await tx
      .update(schema.users)
      .set({ storageBytesUsed: sql`${schema.users.storageBytesUsed} + ${bytes}` })
      .where(eq(schema.users.id, userId));
    return true;
  });
}

// Release a previously-reserved amount (clamped at 0). Used on upload failure
// (rollback) and on purge (the blob is gone).
export async function releaseUserStorage(
  db: Database,
  userId: UserId,
  bytes: number,
): Promise<void> {
  await db
    .update(schema.users)
    .set({ storageBytesUsed: sql`GREATEST(0, ${schema.users.storageBytesUsed} - ${bytes})` })
    .where(eq(schema.users.id, userId));
}

// Best-effort blob removal: a missing file is success (the durable state is the
// DB row; the file is best-effort, per Q5 — manual cleanup / a crash between the
// row delete and the unlink must not wedge a purge). Re-throws other errors.
export async function deleteAttachmentFile(
  baseDir: string,
  userId: string,
  attachmentId: string,
): Promise<void> {
  try {
    await unlink(attachmentFilePath(baseDir, userId, attachmentId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
