# Northline: notes for coding agents

Northline is a portfolio app on invented data: a CRM and operations tool for
Northline Exhaust Co., a made-up maker of heavy-duty truck exhaust parts. Owen
owns the architecture, the rules and the decisions; agents write the code.
Owen is new to Svelte and must be able to explain every file, so write plain,
idiomatic code and comment the non-obvious parts.

These notes govern this repository. Instruction files in parent folders
describe other projects and do not apply here.

## Hard rules

- **Stay inside this repository.** Do not read, search or copy files from
  other folders on this machine unless Owen names a specific file for a
  specific purpose.
- **No real names.** Nothing about any real company, its people, customers,
  agencies or vendors goes into code, comments, docs, commit messages, UI text
  or data. Invented names only, `.example` email domains.
- **Name scan before every commit.** `node tools/scan.mjs . <word list>` must
  print `0 hit(s)`, and so must the same scan over your commit messages
  (write `git log --format=%an%n%ae%n%B origin/main..HEAD` to a file in a temp
  folder outside the repo and scan that folder). The word list lives outside
  the repo; ask Owen for its path. Never copy it in.
- **Accounts.** The `gh`, `vercel` and `supabase` command-line tools on this
  machine are signed in to other accounts: never use them for this project.
  Supabase goes through the Supabase MCP connector, project `northline` only.
  GitHub goes through plain `git` over HTTPS with Owen's personal account.
- **Secrets.** Owen fills in `app/.env` himself. Never print, paste or commit
  a key or password. You may generate local-only random values (session
  secret) into `app/.env`.
- **Writing style.** No em dashes anywhere. Plain English. Reports to Owen:
  results first, short.
- **Honesty.** All data is invented; never imply production use or real
  customers.

## Layout

- `app/`: SvelteKit 2 + Svelte 5 (runes) + TypeScript (strict) + Vitest, Vercel adapter.
- `db/migrations/NNNN_name.sql`: the only source of truth for the schema.
  Files named `NNNN_name.supabase.sql` use Supabase-only features (pg_cron) and
  are skipped by PGlite and the tests.
- `db/seed.sql`: the world generator (`nl.reset()`, `nl.build()`).
- `db/fingerprint.sql`: one query that hashes schema and world, to prove two
  databases match.
- `demo/`, `tools/`: older demo tooling. Leave `demo/` alone.

## Database rules

- App tables live in schema `nl`. Nothing is granted to Supabase's `anon` or
  `authenticated` roles; the app never uses the Data API.
- Every request runs in a transaction as role `nl_app` with
  `set_config('nl.user_id', ...)` (see `app/src/lib/server/db/`). Row-level
  security decides the rest. `nl_readonly` is for the assistant's SQL tool and
  has no grant on tables about people.
- Every function: `set search_path = ''` and schema-qualified names. The only
  exceptions are the tiny random helpers in `nl_seed` (see `DECISIONS.md`).
- Every write function: claim the request id, require an active user, check
  field rules, lock optimistically on `updated_at`, write an audit row.
- Status of a commitment is derived in `nl.commitment_progress`, never stored.
- Apply migrations to Supabase with the MCP `apply_migration` tool, in order,
  with the file's exact text. Then run the security and performance advisors,
  and compare `db/fingerprint.sql` on Supabase with `node scripts/fingerprint.ts`.
- Never ship a view without looking at `explain (analyze, buffers)` on the
  full world.

## Commands (run in `app/`)

On Owen's Windows PowerShell, write `npm.cmd`/`npx.cmd`; in Git Bash, plain `npm` works.

- `npm run dev`: dev server on port 5180 (local PGlite unless `DATABASE_URL` is set)
- `npm run check`, `npm test`, `npm run build`: what CI runs
- `node scripts/world.ts [small|demo|full] [YYYY-MM-DD]`: build a world in memory and print it (full takes minutes; build it on Supabase instead)
- `node scripts/fingerprint.ts [YYYY-MM-DD]`: hashes to compare with Supabase
