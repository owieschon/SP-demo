# db

The database: schema, world generator and checks. Postgres 17.

| File | What it is |
|---|---|
| `migrations/NNNN_name.sql` | The schema, applied in order. The only source of truth. A `*.supabase.sql` file uses Supabase-only features and is skipped locally. |
| `seed.sql` | The invented world: helpers in schema `nl_seed`, plus `nl.reset()` and `nl.build()`. Not a migration. |
| `seed.d/NN_name.sql` | Later additions to the world, one file each, defining `nl_seed.extra_NN_name()`. `nl_seed.finish_build()` calls them in name order. |
| `bench/scale.sql` | The load test: copies the world to measure it at several times its size. |
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

From `app/`, with `DATABASE_URL` set in `app/.env` (the same connection the app
uses). The script records every migration in Supabase's own migration history,
so the dashboard stays true, and it never prints the connection string:

```sh
node --env-file=.env scripts/db-remote.ts status     # applied, pending, or changed since it was applied
node --env-file=.env scripts/db-remote.ts migrate    # apply what is pending, in order
node --env-file=.env scripts/db-remote.ts seed       # load seed.sql and seed.d (functions only)
node --env-file=.env scripts/db-remote.ts rebuild    # reset and build the full world, step by step
node --env-file=.env scripts/db-remote.ts nightly    # run the nightly job once, as pg_cron does
node --env-file=.env scripts/db-remote.ts fresh      # start over: drop, apply everything, seed, build
```

`fresh` is for development: a migration file that was edited after it was
applied cannot be applied again, so the schema is dropped and rebuilt from
0001. Small changes can also go through the Supabase MCP connector's
`apply_migration` with the file's exact text.

Afterwards, run the security and performance advisors, and compare
`fingerprint.sql` on Supabase with `node scripts/fingerprint.ts` (in `app/`)
for the same day.

## Locally

The app builds a PGlite database (the `demo` world) in `app/.pglite` from these
files the first time it runs without `DATABASE_URL`, rebuilds the world when the date changes,
and recreates the database when a migration or the seed changes. Tests use a
throwaway in-memory database with the small world, "today" pinned to 2026-09-17.
