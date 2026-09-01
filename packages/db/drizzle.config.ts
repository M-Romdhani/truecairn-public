import type { Config } from 'drizzle-kit';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for drizzle-kit operations');
}

export default {
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
} satisfies Config;
