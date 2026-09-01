import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { applyMigrations, checksumOf, listMigrations } from './migrator.js';

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

describeIfDb('migrator — apply + integrity check', () => {
  let sql: Sql;

  beforeAll(() => {
    sql = postgres(url!, { max: 1, prepare: false });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('applies every migration on a fresh schema and records a checksum per row', async () => {
    const result = await applyMigrations(sql, { reset: true });
    expect(result.applied.length).toBeGreaterThanOrEqual(18);

    const rows = await sql<{ version: string; checksum: string | null }[]>`
      SELECT version, checksum FROM schema_migrations ORDER BY version`;
    expect(rows.length).toBe(result.applied.length);
    // Every row has a 64-hex-char SHA-256 checksum.
    expect(rows.every((r) => typeof r.checksum === 'string' && r.checksum.length === 64)).toBe(true);
  });

  it('is idempotent: a second run verifies all and applies nothing', async () => {
    const result = await applyMigrations(sql, {});
    expect(result.applied).toEqual([]);
    expect(result.verified).toBeGreaterThanOrEqual(18);
  });

  it('refuses to run when an applied migration file no longer matches its recorded checksum', async () => {
    // Simulate the exact bug class: a migration edited after being applied.
    // We corrupt the stored checksum to stand in for a changed file.
    const target = '0001_enums';
    const all = await listMigrations();
    const realChecksum = all.find((m) => m.version === target)!.checksum;

    await sql`UPDATE schema_migrations SET checksum = ${'00'.repeat(32)} WHERE version = ${target}`;
    try {
      await expect(applyMigrations(sql, {})).rejects.toThrow(/modified after being applied/);
    } finally {
      // Restore so later suites run against a consistent tracking table.
      await sql`UPDATE schema_migrations SET checksum = ${realChecksum} WHERE version = ${target}`;
    }

    // After restore, a normal run verifies cleanly again.
    const ok = await applyMigrations(sql, {});
    expect(ok.applied).toEqual([]);
  });

  it('detects a deleted-after-applied migration file (sanity: error message shape)', async () => {
    // Insert a phantom applied version with a checksum but no file on disk.
    await sql`INSERT INTO schema_migrations (version, checksum) VALUES ('9999_phantom', ${checksumOf(
      'x',
    )})`;
    try {
      await expect(applyMigrations(sql, {})).rejects.toThrow(/has no file on disk/);
    } finally {
      await sql`DELETE FROM schema_migrations WHERE version = '9999_phantom'`;
    }
  });
});
