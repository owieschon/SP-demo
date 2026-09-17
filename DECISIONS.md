# Decisions

Each real choice, the options considered, and why. Newest at the bottom.

## 1. Plain Postgres roles for row-level security, not Supabase Auth

- Options: Supabase Auth with JWT claims; plain Postgres roles with a per-transaction setting.
- Chosen: every request runs `set local role nl_app` and `set_config('nl.user_id', ...)` inside its transaction. Policies read `nl.current_user_id()`.
- Why: the app is a public demo with a "sign in as" picker, so passwords and an auth service add nothing. The same SQL runs on Supabase and on PGlite, and the tests can prove the policies directly. `set local` ends with the transaction, which keeps it safe behind Supabase's transaction pooler.

## 2. Raw SQL through `postgres`, one small interface, PGlite as the fallback

- Options: an ORM; the `postgres` package everywhere; a thin interface with two backends.
- Chosen: `Db` in `app/src/lib/server/db/types.ts` with `asUser`, `asVisitor`, `asSystem`. `postgres.ts` talks to Supabase (`prepare: false` for the pooler), `pglite.ts` runs Postgres in WebAssembly when `DATABASE_URL` is unset.
- Why: the SQL is the point of the project and should be readable as SQL. Values always travel as parameters (`tx.sql` tagged templates). Both drivers are configured to return the same JavaScript types: dates as `YYYY-MM-DD` strings, numeric and bigint as numbers, timestamps as `Date`.

## 3. PGlite pinned to 0.4.6

- Options: latest PGlite (0.5.x, Postgres 18.3); 0.4.6 (Postgres 17.5).
- Chosen: 0.4.6.
- Why: Supabase runs Postgres 17. Tests must run on the same major version the app is deployed on, or a Postgres 18 feature could pass locally and fail in production.

## 4. Keyed randomness in the world generator

- Options: `setseed()` plus `random()` in a fixed call order; a hash of a label per draw.
- Chosen: `nl_seed.u(key)` = the top 53 bits of `hashtextextended(key, seed)`, scaled to [0, 1).
- Why: sequential randomness depends on the order rows are processed, which depends on the query plan, which can differ between databases and between days. A keyed draw is the same everywhere, so Supabase and PGlite build byte-identical worlds (verified with `db/fingerprint.sql`), and generation can be set-based (a recursive CTE walks every customer's buying rhythm in one statement), which is much faster than row-by-row loops.

## 5. Invoice lines repeat the header's customer and date

- Options: lines only reference the invoice header; lines carry sell-to customer and posting date too.
- Chosen: repeat them, and hold them to the header with a composite foreign key on `(invoice_no, customer_no, posted_on)`.
- Why: the ERP's line export repeats those fields, and delivery measurement filters lines by exactly those columns. The composite key makes disagreement between a line and its header impossible.

## 6. Line history is shorter than invoice history

- Chosen: invoices reach back to January three years ago, invoice lines to January of the year before last (like the ERP exports the world is modeled on). Invoices carry a `subtotal` so revenue history does not depend on lines that are not loaded.

## 7. Commitment status rules

- Status is derived in `nl.commitment_progress`: a person's answer wins; otherwise delivered at or above 95% of the committed value is kept; otherwise any delivery is delivering; otherwise a linked quote is quoted; otherwise promised.
- A window that closed short with no answer keeps its status and gets `needs_outcome`.
- "Pushed" settles the commitment: its window has closed, so late deliveries do not count toward it. Business that is still coming belongs on a follow-on commitment.
- Outcomes are append-only; the latest answer wins and the history stays.
- The nightly job may only answer "pushed", only with evidence, never "broken". A table constraint enforces it, not just the job's code.
- Expected value = delivered + confidence x remaining for open commitments, and delivered for settled ones.

## 8. Optimistic locking on millisecond `updated_at`

- Options: an integer version column; `updated_at` as the brief asks.
- Chosen: `updated_at`, stored at millisecond precision and always moved forward by at least a millisecond (trigger `nl.touch_updated_at`).
- Why: browsers keep milliseconds and Postgres keeps microseconds. A microsecond value sent back from a page would never match.

## 9. "Today" is the company's date, and tests can pin it

- `nl.today()` returns the date in America/Chicago, or the value of the `nl.today` setting when set. Tests pin 2026-09-17 so date-dependent results repeat.

## 10. `search_path` pinned on every function, except the hot random helpers

- The Supabase security advisor flags functions without a pinned `search_path`. All app functions have `set search_path = ''`.
- The ten tiny immutable helpers in `nl_seed` (`u`, `ri`, `chance`, `pick`, `gauss`, `person`, `phone`, `slug`, `agency_for`, `owner_for`) do not: a function with a `SET` clause cannot be inlined, and pinning them made the full build 2.5 to 4.5 times slower (6 s to 17 to 29 s, measured). They are only called from `nl.build()`, which pins its own `search_path`, so their inlined bodies are resolved under it. The advisor still lists those ten; that is expected.
