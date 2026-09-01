# @truecairn/db

Postgres schema, migrations, and typed query helpers.

## Layout

- `src/schema/` — Drizzle ORM table definitions. Used for type-safe queries from app code. **Not** the source of truth for migrations.
- `migrations/` — Hand-written numbered SQL migrations. **This is the source of truth.** Drizzle's auto-generated SQL is not used because the schema relies on Postgres features (generated columns, partial unique indexes, triggers, ENUM types, role-based grants) that drizzle-kit does not reliably emit. The hand-written SQL is reviewed and applied as-is.
- `src/migrate.ts` — Minimal migration runner. Reads `migrations/*.sql` in lexical order, tracks applied versions in `schema_migrations`, applies each in a transaction.
- `src/client.ts` — `postgres.js` connection + Drizzle client wired to `src/schema`.

## Running migrations

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://truecairn:truecairn@localhost:5432/truecairn_dev
pnpm --filter @truecairn/db migrate
```

To wipe and reapply (dev only):

```bash
pnpm --filter @truecairn/db reset
```

## Editing the schema

When you add or change a table:

1. Write the SQL in a new numbered migration file (`migrations/NNNN_<short_name>.sql`). Never edit a migration that has been applied to any environment.
2. Mirror the change in the corresponding `src/schema/*.ts` Drizzle file so queries stay type-safe.
3. If the change touches an ENUM, also update `packages/shared/src/enums.ts`.
4. Run `pnpm --filter @truecairn/db migrate` against a fresh local DB to verify the migration applies cleanly.
