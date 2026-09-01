import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface ConnectOptions {
  url: string;
  max?: number;
  ssl?: 'require' | 'prefer' | 'disable';
}

export function createClient(opts: ConnectOptions): { db: Database; sql: Sql } {
  const sql = postgres(opts.url, {
    max: opts.max ?? 10,
    ssl: opts.ssl === 'require' ? 'require' : opts.ssl === 'prefer' ? 'prefer' : false,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
