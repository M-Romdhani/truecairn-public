import postgres from 'postgres';
import { applyMigrations } from './migrator.js';

// CLI entry. The reusable, testable logic lives in migrator.ts.
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const reset = process.argv.includes('--reset');
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await applyMigrations(sql, { reset, log: (m) => console.log(m) });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
