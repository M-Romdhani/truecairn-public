import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

export interface MigrationFile {
  version: string;
  path: string;
  body: string;
  checksum: string;
}

export function checksumOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export async function listMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const path = resolve(MIGRATIONS_DIR, f);
    const body = await readFile(path, 'utf8');
    out.push({ version: f.replace(/\.sql$/, ''), path, body, checksum: checksumOf(body) });
  }
  return out;
}

interface AppliedRow {
  version: string;
  checksum: string | null;
}

export interface ApplyResult {
  applied: string[];
  verified: number;
}

// Applies pending migrations and — critically — verifies that no
// already-applied migration's file has changed since it was applied. Editing
// an applied migration creates divergent schemas across environments that the
// version tracking table cannot detect; this check refuses to proceed when it
// happens. See docs/19 §"Migration discipline".
export async function applyMigrations(
  sql: Sql,
  opts: { reset?: boolean; log?: (msg: string) => void } = {},
): Promise<ApplyResult> {
  const log = opts.log ?? ((): void => {});

  if (opts.reset) {
    log('[migrate] --reset: dropping public schema');
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      checksum    text,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Bring a pre-checksum tracking table up to the current shape.
  await sql.unsafe('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;');

  const appliedRows = await sql<AppliedRow[]>`SELECT version, checksum FROM schema_migrations`;
  const appliedByVersion = new Map(appliedRows.map((r) => [r.version, r.checksum]));
  const all = await listMigrations();
  const byVersion = new Map(all.map((m) => [m.version, m]));

  // Integrity pass — runs every invocation, including "nothing to apply".
  let verified = 0;
  for (const [version, storedChecksum] of appliedByVersion) {
    const file = byVersion.get(version);
    if (!file) {
      throw new Error(
        `[migrate] integrity check failed: applied migration "${version}" has no file on disk. ` +
          `Applied migrations are immutable history; a missing file means the history diverged. ` +
          `Restore the file, or reset a dev database.`,
      );
    }
    if (storedChecksum === null) {
      // Row applied before checksums were tracked. Backfill once from the
      // current file. A pre-tracking edit cannot be detected retroactively;
      // future edits to this file WILL be caught.
      await sql`UPDATE schema_migrations SET checksum = ${file.checksum} WHERE version = ${version}`;
      continue;
    }
    if (storedChecksum !== file.checksum) {
      throw new Error(
        `[migrate] integrity check failed: migration "${version}" was modified after being applied ` +
          `(recorded ${storedChecksum.slice(0, 12)}…, file now ${file.checksum.slice(0, 12)}…). ` +
          `Applied migrations are immutable — add a NEW numbered migration instead of editing this one. ` +
          `For a dev database, reset it: pnpm --filter @truecairn/db reset.`,
      );
    }
    verified += 1;
  }

  const pending = all.filter((m) => !appliedByVersion.has(m.version));
  for (const m of pending) {
    log(`[migrate] applying ${m.version}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(m.body);
      await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${m.version}, ${m.checksum})`;
    });
  }
  log(pending.length === 0 ? '[migrate] nothing to apply' : `[migrate] applied ${pending.length} migration(s)`);

  return { applied: pending.map((m) => m.version), verified };
}
