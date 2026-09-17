# grcrm-demo

Tooling for demonstrating GRCRM on an invented dataset, in a Supabase
project of its own, so nothing about the real company, its people or its
customers ever appears on screen.

Nothing in this folder is application code. The application lives in its own
repository; this folder holds the world that gets loaded underneath it.

## What is here

| Path | What it does |
|---|---|
| `demo/seed.sql` | The invented world, built inside Postgres. `select demo.reset();` wipes every business table, `select demo.build();` builds 76 customers, about 200 parts, three years of shipments and invoices, 26 deals in every state, a warehouse snapshot for today and yesterday, and the activity a sales team leaves behind. Randomness is seeded, so the same world comes back every run; only the dates move with the calendar. |
| `demo/verify.sql` | The checks to run after a build: the deal board, revenue by year, Today, the warehouse buckets, shortages, reorders, account health, nudges, part search. |
| `demo/seed.mjs` | The first draft of the generator, in JavaScript. Kept as the readable specification of the world; `seed.sql` is the version that runs. |
| `tools/batch-migrations.mjs`, `tools/chunk-sql.mjs` | Turn a folder of migrations into transaction-sized pieces for applying through a management API when there is no direct database connection. |
| `tools/scan.mjs` | Scan a folder for words that must not appear in it (the word list lives outside any repository). Exit code 1 on a hit, so it can gate a commit. |
| `tools/rewrite.mjs` | Apply a mapping of words to replacements across a folder, whole-word and case-preserving. |
| `tools/mint-demo-token.mjs` | Sign the demo user in through Supabase Auth and store the session token for headless checks, the way the application's own test tooling does. |

## Rebuilding the world on the morning of a demo

In the Supabase SQL editor of the demo project, or through any client:

```sql
select demo.reset();
select demo.build();
select public.gr_nightly_refresh();
select public.gr_nightly_nudges();
select public.gr_answer_pushed_windows();
select public.gr_propose_next_steps();
```

The build takes about a minute. Then sign in as the demo admin and open
Today.

## Design notes

The data is shaped exactly the way the ERP exports shape it, because the
application reads it through the same views and functions it uses in
production: item ledger lines carry negative quantities for sales, the
customer ledger holds invoices, credit memos and payments, the warehouse
snapshot goes in through the same import function the upload screen calls,
and accounts and deals are JSON records that the mirror trigger projects
into relational tables. There is no demo-only code in the application.

Two things the world is deliberately not: perfect, and quiet. Revenue runs
behind plan, a quarter of the open orders are past due, some accounts have
gone quiet, and one deal's window closed short with nobody having answered
the question yet. That is what the tooling is for.
