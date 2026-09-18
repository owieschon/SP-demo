# Northline

Northline is a full-stack sales and operations system for an invented truck-parts
manufacturer whose legacy ERP exchanges files instead of serving an API. It uses
SvelteKit 2, Svelte 5, strict TypeScript and Postgres 17. The database owns the
business rules, while AI features can propose work but cannot approve their own
changes. All business records are invented.

I designed and built Northline in 48 hours to learn and demonstrate Svelte through a
backend-heavy system. Coding agents wrote much of the implementation under the
architecture, data model, rules and validation strategy I set; I reviewed, tested and
measured the result.

## Three engineering highlights

- **SQL that explains its speed.** A commitment measures itself against invoice
  history across a recursive customer family. On a full synthetic world, the board
  moved from 10,963 ms to 6 to 10 ms through planner-aware SQL, a covering index,
  trigger-maintained delivery totals and a once-per-query date read. These are dated
  hosted measurements, not local or production claims. See the
  [plans, data size and 4x limit](docs/sql.md).
- **A safe edge around a file-only ERP.** Morning CSVs are matched to typed report
  profiles, normalized, content-hashed and staged as a diff. Wrong reports are
  refused; suspicious but readable files wait for a person; applying a snapshot
  allocates stock oldest ship date first. Start at
  [the export pipeline](app/src/lib/server/exports).
- **AI as a bounded parser and proposer.** An extractor may propose RFQ fields, but
  deterministic code resolves customers, parts, quantities, dates and prices. Tool
  risk classes live in code; gated writes stop before input parsing and run only
  after a person approves a stored, versioned proposal. The UI shows validation
  reasons, source citations and refusals. See the
  [assistant boundary](docs/assistant-gating.md).

## Run it locally

Use Node 24. You do not need Docker, a database, app credentials or a model API. The
first start builds a persistent demo world in PGlite from the portable migrations and
the same seed files used by hosted Postgres, so it can take a minute or two:

```bash
cd app
npm ci
npm run dev
```

Open <http://localhost:5180> and choose an active role. Leave `app/.env` absent so
the app stays on local PGlite, uses deterministic extraction and simulates mail.

Run the offline verification from `app/`:

```bash
npm run check      # Svelte and TypeScript checks
npm test           # Vitest against in-memory PGlite
npm run build      # production build with the Vercel adapter
npm run eval:rfq   # rules-only RFQ regression evaluation
```

CI runs the clean install, check, test and build sequence on Node 24.

## Review three flows

These three beats take about five minutes and keep writes inside the local invented
world:

1. Open **Morning exports**. Download **Today's sales lines**, upload it and inspect
   the staged diff. **Wrong report** demonstrates refusal; **Partial export**
   demonstrates a hold. Yesterday's file is already applied, so uploading it
   demonstrates duplicate detection.
2. Open **Order desk**, expand **Add a quote request by hand**, load an invented
   sample and choose **Read and check**. This creates a quote request, not an outbound
   reply. Open the request to inspect field-level evidence; approval can happen there
   or in **Approval queue** and creates the quote and commitment without sending mail.
3. Open **Commitments** and inspect a record. Delivery comes from matching invoice
   lines across the billing family, returns subtract from it, and status is derived.
   Checked write functions enforce identity, idempotency, row versions and auditing.

Continue with the [ten-minute reviewer tour](docs/loom-script.md) for automations and
the assistant, or the [code walkthrough](docs/walkthrough.md) to trace a request
through SvelteKit, TypeScript and Postgres.

## Know the trust boundaries

| Boundary | What enforces it |
| --- | --- |
| Browser to database | Tagged templates bind values; every user transaction runs as `nl_app` with `nl.user_id`; row-level security and explicit grants decide access. |
| Write path | Checked functions require an active user, claim an idempotency key, validate authorization and fields, and append an audit row. Mutations of existing records also compare `updated_at`. |
| Assistant SQL | `nl_readonly` has no grant on people or conversation tables; Postgres marks the transaction read-only and applies a timeout. |
| Model actions | Code assigns each tool a risk class. Gated tools can only become stored proposals, and approval reloads stored input instead of trusting the browser or model. |
| Outbound mail | A person must approve, and the server checks a recipient allowlist at send time. The local no-key path records a simulated send. |
| Hosted access | A shared password protects the private demo before its passwordless role picker. This is a review curtain, not production identity. |

The private hosted demo is at <https://sp-demo-one.vercel.app>. Ask the owner for
access and use it read-only unless asked to act: **Order desk** is connected to an
external mail service, so polling or approving a reply can have a real external
effect.

## Read the evidence honestly

- **Offline tests:** PGlite runs the portable Postgres schema and integration tests
  without external services. It does not reproduce the hosted network, connection
  pooler or Supabase-only `pg_cron` migrations.
- **RFQ evaluation:** the rules extractor currently gets 26 of 28 invented cases
  fully right and holds field scores to a checked-in baseline. The cases and
  extractor share an author, so this is a regression floor, not a held-out
  generalization result. See the [evaluation contract](evals/rfq/README.md).
- **SQL benchmark:** the 2026-09-17 figures in [`docs/sql.md`](docs/sql.md) were
  measured on Supabase Postgres 17 Micro compute over invented data. The offline
  suite does not rerun them, and they are not an independent or production workload.
- **Demo scope:** Northline does not serve real customers. Hosted integrations can
  still have real side effects, which is why the reproducible tour runs locally.

## Find the source

| Path | What it owns |
| --- | --- |
| [`app/src/routes/`](app/src/routes) | SvelteKit loads, form actions, pages and HTTP endpoints |
| [`app/src/lib/server/`](app/src/lib/server) | Server-only validation, integrations, agents and database access |
| [`db/migrations/`](db/migrations) | Ordered schema, roles, policies, functions, views and triggers |
| [`db/seed.sql`](db/seed.sql), [`db/seed.d/`](db/seed.d) | Deterministic invented worlds |
| [`evals/`](evals) | Invented cases, expected results, baselines and reports |
| [`DECISIONS.md`](DECISIONS.md) | Architecture choices, alternatives and tradeoffs |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Clean-install verification |

The [database guide](db/README.md) covers world sizes and migration behavior.
