# db

The database: schema, world generator and checks. Postgres 17.

| File | What it is |
|---|---|
| `migrations/NNNN_name.sql` | The schema, applied in order. The only source of truth. A `*.supabase.sql` file uses Supabase-only features and is skipped locally. |
| `seed.sql` | The invented world: helpers in schema `nl_seed`, plus `nl.reset()` and `nl.build()`. Not a migration. |
| `fingerprint.sql` | One query returning hashes of the functions, views, columns, policies and the world. Two databases with the same hashes hold the same thing. |

## Rebuild the world

```sql
select nl.reset();
select nl.build();                    -- full world; 'demo' locally, 'small' for tests
select nl.answer_pushed_windows();    -- what the nightly job does next
```

On a small server, build the full world in steps instead of one call:

```sql
select nl.reset();
select nl_seed.begin_build('full');   -- people, parts, customers, baskets
select nl_seed.build_year(2020);      -- then each later year, in order
select nl_seed.finish_build();        -- commitments, notes, next steps
select nl.answer_pushed_windows();
```

| Size | Customers | Parts | Years | Invoice lines |
|---|---|---|---|---|
| `full` | about 4,500 | about 11,400 | 7 | about 500,000 |
| `demo` | 700 | about 2,700 | 3 | about 28,000 |
| `small` | 90 | about 500 | 2 | about 4,000 |

Everything is dated relative to `nl.today()` (the company's date, America/Chicago),
so a rebuild each morning keeps "today" honest. Randomness is keyed by label,
so the same day always gives the same world, on Supabase and locally.

## Apply to Supabase

Through the Supabase MCP connector, project `northline`:

1. `apply_migration` for each new file in `migrations/`, in order, with its exact text.
2. Run `seed.sql` if it changed, then the rebuild above.
3. Run the security and performance advisors.
4. Run `fingerprint.sql` and compare it with `node scripts/fingerprint.ts` (in `app/`) for the same day.

## Locally

The app builds a PGlite database (the `demo` world) in `app/.pglite` from these
files the first time it runs without `DATABASE_URL`, rebuilds the world when the date changes,
and recreates the database when a migration or the seed changes. Tests use a
throwaway in-memory database with the small world, "today" pinned to 2026-09-17.
