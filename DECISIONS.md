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

## 6. Line history covers the whole invoice history

- First version: invoice lines reached back two years, invoices three (like the ERP exports), with a `subtotal` on each invoice so revenue history did not depend on missing lines.
- Revised: the full world loads lines for all seven years, because performance numbers only mean something at production volume (about half a million lines). `subtotal` stays: revenue history reads it instead of summing lines.

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

## 11. Three world sizes, tuned to real shapes

- Options: a small hand-shaped world; a world at production scale.
- Chosen: `nl.build('full')` (about 4,500 customers, 11,400 parts, seven years, half a million invoice lines) on Supabase; `'demo'` (700 customers, three years) for local development; `'small'` (90 customers, two years) for tests.
- Why: comparing this stack with others is only honest at production volume. The generator's distributions (revenue per customer, parts per customer, lines per invoice, seasonality, discounts, margins, freight, credit memos, customer life stages, chains) were tuned against summary statistics of a real business of this kind. No names, records or exact figures were copied; dollars are rescaled.
- The build runs in steps (`nl_seed.begin_build`, one `nl_seed.build_year` per year, `nl_seed.finish_build`) so a small server never runs one very long statement. The board caps its settled columns because the full world holds about 2,500 kept commitments.

## 12. Delivered is stored, and triggers keep it current

- Problem: the board recomputed delivery for every commitment ever made on every load. The cost grew with history (337 ms on the full world, 7.96 s for the same recount at 4x).
- Options: a materialized view refreshed on a schedule; caching in the app; a table kept current by triggers; storing the final figure only once a window closes.
- Chosen: `nl.commitment_delivery`, maintained by statement-level triggers on the four tables that can change a delivered figure (ledger lines, commitment items, commitment window or customer, billing family), re-measuring only the commitments a change can touch, in the same transaction.
- Why: a scheduled refresh shows stale numbers between runs; an app cache can be bypassed by any other writer; closing-time snapshots miss late corrections to the ledger. Triggers are exact at commit time whoever writes. Status stays derived on every read (decision 7); only the sum is stored.
- Guard rails: `nl.delivery_drift()` recounts through the live view and must return nothing (tested after every kind of change and over the whole world); the nightly job repairs and reports any drift; nobody can write the table directly. Details and timings in `docs/sql.md`.

## 13. Load tests run on copies of the world, one copy at a time

- `db/bench/scale.sql` copies the full world with new keys, which keeps its shape (families, windows, outcomes), instead of generating a bigger world with different statistics.
- The first run loaded six copies in parallel, filled the Micro instance's disk and put the database into read-only mode. Recovery: drop the largest index, reset, rebuild, recreate the index (about ten minutes). The measured results stop at 4x. A 10x run needs a larger disk first, and one copy per call.

## 14. The wrong ERP report is refused, not held

- A file missing required columns, or with no data rows, writes nothing at all; the page names the missing columns, lists the columns the file does have, and guesses which report it is.
- Why: a held snapshot exists so a person can release it. There is nothing to release in a file whose rows cannot be read, so holding it would be a dead end.
- Partial, stale and partly broken files are still held, because releasing those is a real decision.

## 15. A file is the same file when its content is the same

- The ERP stamps the export time into every filename and can reorder columns, so identity comes from a SHA-256 of the normalized rows (sorted, canonical values), not the bytes or the name.
- A re-upload of data already loaded is recognized whatever its status, including discarded, and writes nothing. Discard is final by design: a discarded file cannot be loaded later by uploading it again.
- A corrected file differs in content, so it is a new snapshot.

## 16. Import profiles, not import code

- Each ERP report is a data object (header aliases, required columns, field types, date and number formats, natural key) and one reader works to that profile. A test reads an invented second report with European number formatting using only a new profile.
- Why: the legacy systems this pattern targets have dozens of report layouts, and layouts change without notice. A new report should be configuration.

## 17. The AI proposes; deterministic code validates; a person approves

- RFQ extraction returns a draft with a confidence per field. Every field is then checked against the catalog and the customer master in TypeScript and SQL, and ends as ok, corrected or needs review with a reason.
- A draft with anything still needing review cannot be approved. Approval passes only the draft id, its row version and a request id: the quote is built from the stored, re-validated draft, never from the request body, and a price that changed since the draft was checked raises a conflict.
- The assistant's tools carry a risk class. Read and additive tools run; anything that changes or removes data is gated, and the model can only ask for it through a proposal a person approves.

## 18. Rules are data, and their SQL is written by us

- An automation rule names one of a fixed set of reviewed triggers and adds conditions on that trigger's typed fields. The app compiles those into a parameterized WHERE clause over the trigger's query. A rule never contains SQL, so a rule can never say something the catalog does not allow.
- A rule is tested in a transaction Postgres itself marks read only, so "what would this do" cannot write.
- Actions are additive only (a next step, a note). Anything that changes existing data goes through the same proposal and approval path as the assistant.
- A rule fires at most once per subject, enforced by a unique key on (rule, subject), not by the runner's memory.
