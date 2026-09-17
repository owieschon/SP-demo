# Handoff for a coding agent on another machine

Read this, then `CLAUDE.md`, `DECISIONS.md`, `db/README.md` and
`docs/walkthrough.md`. This file says what the project is, what is finished,
what is being built right now by someone else, and what is planned, so you
build the right thing and leave the rest alone.

Written 2026-09-17, late afternoon Central. If the date on the last commit is
much later than that, ask before trusting the status table.

## What this is

Northline is a portfolio app: the sales and operations system for Northline
Exhaust Co., an invented maker of heavy-duty truck exhaust parts whose ERP can
only produce file exports. SvelteKit 2, Svelte 5 runes, TypeScript strict,
Postgres 17 on Supabase, no ORM. All data is invented. It exists to show one
engineer's work on Svelte, TypeScript, Postgres, complex SQL, legacy-file
integration, AI with a safety gate, and automation a non-engineer can set up.

Live: https://sp-demo-one.vercel.app  The repository is the one you have
checked out; work from branch `main`.

## Hard rules, no exceptions

1. **No real names.** Nothing about any real company, its people, customers,
   agencies or vendors in code, comments, docs, commit messages, UI text or
   data. Invented names only, `.example` email domains, 555-01xx phone
   numbers. A private word list gates every commit on the owner's machine; two
   ordinary English words already collide with it, so write "expedite" instead
   of one urgency word and "slip" instead of one word for leniency.
2. **No em dashes anywhere**, including generated data. Plain English.
3. **Never run** `gh`, `vercel`, `supabase` or `npx supabase`, and never
   connect to a remote database. The owner's machine has those tools signed in
   to accounts that must not touch this project.
4. **Never call a paid API for real** (Anthropic, mail). Live code paths are
   written and tested with a mocked client. Live runs need the owner's
   explicit approval and a cost estimate first.
5. **Secrets belong to the owner.** Never print, paste or commit a key. Local
   config lives in `app/.env`, which is gitignored.
6. **The owner must be able to explain every file.** He is new to Svelte.
   Write plain, idiomatic code, comment the non-obvious parts, and match the
   density of the file next to yours.
7. **Do not touch** `demo/`, `tools/`, `.claude/`, or another agent's files
   (see the ownership table). Put changes you need in shared files into your
   final report instead, exactly.

## How to run and test

```sh
cd app
npm ci
npm run check                      # svelte-check, must be 0 errors
npx vitest run <your paths>        # your tests; --maxWorkers=1 on a loaded machine
npm test                           # everything (about 300 tests, a few minutes)
npm run dev                        # port 5180; needs no database (PGlite is built from db/)
```

Database tests run on PGlite, which is Postgres 17 compiled to WebAssembly, so
they need nothing installed. `createTestDb()` in
`app/src/lib/server/db/pglite.ts` builds the `small` world with today pinned to
2026-09-17. The `full` world takes minutes and belongs on Supabase, not on a
laptop.

## The rules the database enforces

- App tables live in schema `nl`. Nothing is granted to Supabase's `anon` or
  `authenticated` roles; the app never uses the Data API.
- Every request runs in a transaction as role `nl_app` with
  `set_config('nl.user_id', ...)`, so row-level security decides the rest.
  `db.asReadonly()` runs as `nl_readonly` (SELECT on business tables only, no
  grant at all on tables about people) with a ten second statement timeout.
- Every function: `set search_path = ''` and schema-qualified names. The only
  exceptions are ten tiny random helpers in `nl_seed` (see `DECISIONS.md` 10).
- Every write function: claim the request id (`nl.claim_request` /
  `nl.finish_request`), require an active user (`nl.require_active_user`),
  check the field rules and raise `NL4xx` SQLSTATEs, lock optimistically on the
  row's `updated_at`, and write a row to `nl.audit_log`.
- Status and derived figures come from views. Where a figure is stored for
  speed (delivered value per commitment), triggers keep it exact and a drift
  check proves it: `DECISIONS.md` 12.
- New tables get RLS and explicit grants. Anything naming a person gets no
  `nl_readonly` grant.
- Migrations are `db/migrations/NNNN_name.sql`, applied in order, never edited
  after they are applied (use the next number). `*.supabase.sql` files use
  Supabase-only features and are skipped by PGlite and the tests.
- Additions to the invented world go in `db/seed.d/NN_name.sql` as one function
  `nl_seed.extra_NN_name()`, which `nl_seed.finish_build()` calls in name
  order. Use the keyed randomness helpers at the top of `db/seed.sql` so the
  same world comes back every run, and scale counts with
  `(select scale from nl_seed.settings)` (full 1.0, demo 0.156, small 0.02).

## Look and feel

Match `app/src/routes/operations/**` and `app/src/lib/components/exports/**`
(the newest work): design tokens from `app/src/app.css`, dense tables with
hairlines rather than heavy cards, clear focus and press states, skeletons
while data streams (return an un-awaited promise from `load`, render it with
`{#await}`), `use:enhance` on forms, works at phone width, light and dark.
Empty states say what to do next.

## Status

### Finished and on `main`

`main` is at 4746a4f. Supabase is migrated through 0027 and the world is
built, every drift check zero.

| Feature | Where |
|---|---|
| Commitments that measure themselves, with the board, detail page and the closed-short question | `0003`, `0007`, `0008`, `0009`, `app/src/lib/server/commitments.ts`, [`docs/sql.md`](sql.md) |
| Daily ERP export: profiles, hashing, holds, apply or release, stock allocation into buckets, day over day | `0010`, `app/src/lib/server/exports/**`, `/operations` |
| Quote request intake: extraction, deterministic validation, stored draft, approval that creates a quote and a commitment, 28 scored test emails | `0011`, `app/src/lib/server/rfq/**`, `evals/rfq/` |
| Automation rule builder: catalog, compiler, test run, daily runner, five example rules | `0013`, `app/src/lib/automation/catalog.ts`, `app/src/lib/server/automation/**`, `/automations` |
| Accounts and contacts, with a year of invented activity | `0014`, `db/seed.d/10`, `app/src/lib/server/accounts/**`, `/accounts` |
| Parts, vendors and search | `0015`, `db/seed.d/20`, `app/src/lib/server/catalog/**`, `/parts`, `/vendors`, `/search` |
| Late-order forecast: purchase and production orders, time-phased projection, vendor call sheet, available to promise | `0016`, `0022`, `app/src/lib/server/supply/**`, [`docs/supply-forecast.md`](supply-forecast.md) |
| Assistant: tools with risk classes, a read-only SQL tool, proposals a person approves | `0017`, `app/src/lib/server/assistant/**`, `/ask`, [`docs/assistant-gating.md`](assistant-gating.md) |
| Cost, freight and pricing over time, one pricing function with precedence and a margin floor | `0018`, `db/seed.d/50`, `55`, `app/src/lib/server/pricing/**`, [`docs/pricing.md`](pricing.md) |
| Warehouse state: locations and bins, a stock movement ledger, counts, shipments, transfers | `0019`, `db/seed.d/60`, `app/src/lib/server/warehouse/**`, [`docs/warehouse.md`](warehouse.md) |
| Documents: PDF, spreadsheet and CSV parsing, quote PDFs, source references per extracted line | `0020`, `app/src/lib/server/documents/**`, [`docs/documents.md`](documents.md) |
| Order desk mail agent: mailboxes, inbound mail, intent classification, disclosure policy, drafts into a review queue, sending only behind approval | `0021`, `0026`, `app/src/lib/server/desk/**`, `/desk`, [`docs/desk-agent.md`](desk-agent.md) |
| One workspace queue for every agent request | `0023`, `app/src/lib/server/workspace/**`, `/workspace`, [`docs/workspace.md`](workspace.md) |
| MCP server over streamable HTTP, token scoped and audited | `0024`, `app/src/routes/api/mcp/**`, [`docs/mcp.md`](mcp.md) |
| Settings and admin, with a health page that has two speeds | `0025`, `0027`, `/settings`, [`docs/settings.md`](settings.md) |
| One password in front of the whole site | `app/src/lib/server/gate.ts`, `/gate` |
| UI correctness pass: real totals, labelled headers, distinct action names, a route registry so every agent tool row carries its URL | `app/src/lib/routes.ts`, [`docs/ux-audit.md`](ux-audit.md) |
| Nightly rebuild, "pushed" with evidence, drift repair (pg_cron) | `0012_nightly.supabase.sql` |
| Remote database tooling: status, migrate, seed, rebuild, nightly, fresh | `app/scripts/db-remote.ts`, `db/README.md` |

### Being built right now, on other machines: do not touch

Eleven branches are open. Take the next free migration number after checking
`db/migrations/`, and the next free `db/seed.d` number, and say in your report
which you used. Merge `origin/main` into your branch at least once mid-way:
several of these branches touch components and layout.

| Branch | What it owns |
|---|---|
| `policy-engine` | Typed, scoped, effective-dated policy values with an explaining resolver; the data dictionary and `nl.describe_data`; `/policies` and `/dictionary` |
| `context-engine` | Sources, claims, entity resolution, promotion to fact with citations, staleness, versioned context bundles served to agents and over MCP; `/context` |
| `agent-harness` | The autonomy ladder (shadow, suggest, auto with review, auto), undo window, pause switch, evals with baselines; `/agents` |
| `procurement-desk` | Replenishment maths, internal wake signals, purchase requests, vendor drafts; `/procurement` |
| `manufacturing-model` | The parts taxonomy, bills of material, routings, work centres, labour and machine time, the loaded cost model |
| `pricing-depth` | Landed inbound cost, outbound carriers and modes, customer price sheets and exceptions, and lead time per vendor-part (quoted, committed, observed) |
| `design-system` | Tokens and components, the rail reorganised into four groups by intent, "Today" as an exception queue, the command palette, chart doctrine |
| `roles` | Scope, authority and disclosure as three axes; `nl.work_waiting_for`; agents as principals in the same tables; `/people` |
| `commitment-depth` | Quote revisions with reasons, requirement-carrying quotes, the outcome trail, next steps that behave like real ones |
| `desk-depth` | Retires `/rfq` into the order desk as evidence; agent run trails with refusals; replay and diff |
| `agent-surface` | Output schemas and structured content on the MCP tools, visible page headings, placeholder text a screen reader can hear, column names in write errors |

### Planned, not started: safe to pick up

1. **Supply-side commitments.** A commitment gets a side: demand (a customer
   promises to buy) or supply (a vendor promises to deliver). The measurement
   code is the same, pointed at receipts instead of invoices.
2. **More wake signals for the desks**: a late-order notice, a quote about to
   expire, a commitment window closing short, a shipment confirmation, back in
   stock, an account gone quiet, a price agreement expiring. Each belongs in
   the rule builder so a threshold can change without a deploy.
3. **Receiving dock queue**, **returns with reason codes**, **freight invoices
   against what was billed**, **payment terms and aging**.
4. **A supplier quote round trip**: send a request to three vendors, put the
   replies side by side, and record why one was chosen.
5. **Cross-reference and interchange**: a customer's own part number, and a
   competitor's, mapped to ours.
6. **A data quality screen**: which records contradict each other, which are
   missing what an agent needs, sorted by the money behind them.

### A local note on the test suite

Running `npm test` while many agents work on this machine crashes vitest
workers with "Worker exited unexpectedly". That is memory pressure, not a
failing test. Re-run with `npx vitest run --maxWorkers=2`, or serially, before
reporting a failure.

## Deadlines and priorities

The owner demonstrates this on Friday 2026-09-18 in the evening, Central time.
Until then: nothing half-built on `main`, and the documentation stays true.
Correctness, tests and a clear write-up matter more than one more feature.

## How to hand work back

- Work on a branch named after the feature. Commit in small steps, plain
  English messages, no em dashes, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Do not push to `main`, do not open a pull request, do not rebase onto
  anything, and do not force push.
- Final report, short, results first: files added, migration and seed summary,
  test count and what they prove, the exact changes needed in shared files
  (nav entry, breadcrumbs, public paths, env vars), decisions worth a line in
  `DECISIONS.md`, and anything unfinished or unverified. Say plainly what you
  did not test.
