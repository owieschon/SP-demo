# Code walkthrough

Use this guide after the focused demo when you want to trace a browser request into
TypeScript and Postgres. It maps the server boundary, one read, one write and the
main integration flows to their source; for the click-by-click product path, start
with the [reviewer tour](loom-script.md).

## The shape of the app

```
app/src/
  hooks.server.ts         access gate, session cookie -> user, sign-in gate, theme
  app.html, app.css       the page shell and the design tokens
  params/id.ts            route matcher: /commitments/[id=id] only takes digits
  lib/
    format.ts             money, numbers, dates, places
    components/           Svelte components (board, cards, forms, badges)
    server/               code that only ever runs on the server
      db/                 the one database interface and its two drivers
      session.ts          the signed session cookie
      users.ts            the sign-in picker and "who is this cookie"
      commitments.ts      workflow A: reads and writes
      forms.ts            form actions shared by pages
      errors.ts           database refusals -> HTTP statuses
      rfq/                workflow C
      exports/            workflow D
      accounts/           accounts, contacts, activity
      catalog/            parts, vendors, search
      automation/         the rule builder's compiler and runner
      supply/             the late-order forecast
      pricing/            cost, freight and price rules
      warehouse/          locations, the stock ledger, shipments
      assistant/          Ask Northline: tools, the gate, proposals
  routes/                 one folder per URL
db/
  migrations/             the schema, in order
  seed.sql                the invented world
  seed.d/                 later additions to the world, one file each
  bench/                  the load test
```

SvelteKit treats `lib/server` as server-only and rejects browser imports from it at
build time. Database clients, secrets and privileged workflows live behind that
boundary.

## How a request travels

Take "open the commitment board", `GET /commitments`:

1. **`hooks.server.ts`** runs first. When `SITE_PASSWORD` is configured, it checks
   the signed access-gate cookie before loading the app. It then checks the HMAC
   signature on the `nl_session` cookie (`lib/server/session.ts`), loads that user
   if they are still active, and redirects to `/signin` if nobody is signed in. The
   user goes into `event.locals.user`.
2. **`routes/+layout.server.ts`** hands the user to every page (for the rail
   and the avatar).
3. **`routes/commitments/+page.server.ts`** is the page's `load` function. It
   decides whose board to show (`?who=mine|all`) and calls `listBoard` without
   awaiting it. SvelteKit sends the page straight away and streams the board
   when it is ready.
4. **`lib/server/commitments.ts` `listBoard`** calls `db.asUser(userId, ...)`.
5. **`lib/server/db/postgres.ts`** (or `pglite.ts` locally) opens a
   transaction and first runs `set local role nl_app` and
   `select set_config('nl.user_id', '<id>', true)`. From here on, row-level
   security policies in Postgres decide what this user may read or change.
   `set local` ends with the transaction, which is what makes this safe
   behind Supabase's connection pooler.
6. The query reads **`nl.commitment_progress`**, a view that derives each
   commitment's status from the stored delivered figure, the latest outcome
   and linked quotes (`docs/sql.md`).
7. **`routes/commitments/+page.svelte`** shows `<BoardSkeleton />` inside
   `{#await data.board}`, then `<Board />` once the rows arrive.

And a write, "answer the window-closed question", `POST /commitments/answer`:

1. The form in `OutcomeForm.svelte` posts with `use:enhance`, so the page
   updates without a full reload (and still works without JavaScript).
2. The page's `actions.default` calls `outcomeAction` in `lib/server/forms.ts`,
   which checks the form's shape with zod (`recordOutcomeInput`).
3. `recordOutcome` calls the SQL function **`nl.record_outcome`** as the user.
   The function, not the TypeScript, enforces the rules:
   - claims the request id (a double-submit returns the first result);
   - requires an active user;
   - only the owner or an admin may answer;
   - the window must have closed short;
   - the row version (`updated_at`) must match what the page loaded, or it
     raises a conflict;
   - it writes the outcome and an audit row, in one transaction.
4. A refusal comes back as a SQLSTATE like `NL403`; `errors.ts` turns it into
   an HTTP status and the page shows the message.

## Svelte 5 and SvelteKit features, and where they are

| Feature | What it does | Where |
|---|---|---|
| `$props()` | a component's inputs | every component, e.g. `CommitmentCard.svelte` |
| `$state()` | a value that re-renders the page when it changes | `OutcomeForm.svelte` (submitting), `ThemeToggle.svelte` |
| `$derived()` / `$derived.by()` | a value computed from others, kept up to date | `Board.svelte` (columns, totals), `+layout.svelte` (breadcrumbs) |
| `{#await}` | show one thing while a promise is pending, another when it resolves | `routes/commitments/+page.svelte` |
| `load` in `+page.server.ts` | fetch data on the server before the page renders | every route folder |
| Streaming a promise from `load` | send the page first, the slow data later | `routes/commitments/+page.server.ts` |
| Form `actions` | handle a POST from a `<form>` | `commitments/answer`, `commitments/[id=id]`, `signin` |
| `use:enhance` | submit forms with fetch, keep the page, run callbacks | `OutcomeForm.svelte`, `signin/+page.svelte` |
| `hooks.server.ts` `handle` | code that runs on every request | `src/hooks.server.ts` |
| `$lib/server` | server-only modules | `src/lib/server/` |
| `+server.ts` | a plain HTTP endpoint | `routes/signout`, `routes/theme` |
| Param matchers | restrict a route parameter | `params/id.ts` |
| `$app/state` `page`, `navigating` | the current URL and route, and whether a navigation is in flight | `+layout.svelte` |

## Read the database by capability

The ordered files in `db/migrations/` are the schema source of truth. Read them in
these groups instead of relying on a second migration-by-migration registry that can
drift:

| Range | Capability |
| --- | --- |
| `0001` to `0009` | Roles, users, the imported business book, commitments, query plans, trigger-maintained delivery and drift checks |
| `0010` to `0019` | ERP exports, RFQ intake, scheduled maintenance, automation, account and catalog depth, supply forecasting, the assistant, pricing and warehouse state |
| `0020` to `0030` | Document parsing and generation, desk agents, supply coverage, the shared decision queue, MCP access, settings, the agent harness and procurement |
| `0031` to `0043` | Roles and disclosure, price sheets, commitment history, policy resolution, manufacturing cost and traceability, capacity, decision records, run trails and overview reporting |

Files ending in `.supabase.sql` use hosted features such as `pg_cron` and are skipped
by PGlite. The [database guide](../db/README.md) explains the world sizes, local
behavior and hosted migration process.

## Follow a quote request (`/desk`, `/desk/requests/<id>`)

A customer's email becomes a draft quote. There is no upload screen: the
request arrives in the order desk's mailbox and the agent reads it. A mail message
lives at `/desk/<id>`; its validated quote request lives at
`/desk/requests/<id>`. `/rfq` and `/rfq/<id>` are 308 redirects to the desk and the
quote-request detail so older links keep working. A request that came in on the
telephone is typed into the "Add a quote request by hand" panel on `/desk`, which
makes the same quote-request record with its source recorded as a person. It does not
create an outbound reply draft. The path:

1. The desk agent's run (`lib/server/desk/run.ts`), or hand entry
   (`lib/server/agentruns/handentry.ts`), calls `extract` in
   `lib/server/rfq/extract.ts` on what arrived.
2. **The extractor proposes.** `rules.ts` is a deterministic reader (regexes
   and heuristics) and is the default; `claude.ts` calls the model with a
   structured output schema and is used only when a key is configured and the
   passphrase has been entered (`live.ts`). Either way the result is the same
   shape, checked with zod (`schema.ts`).
3. **Code validates.** `validate.ts` checks every field against the catalog
   and the customer master: item numbers exist (or get up to three sibling
   suggestions from the part-number pattern), quantities are positive whole
   numbers after unit conversion, the date parses and is not in the past, the
   customer resolves to exactly one account, and any prices the email states
   add up. Each field ends as `ok`, `corrected` or `needs_review` with a
   reason the page shows.
4. **A person approves.** The quote request is stored (`nl.rfq_drafts`); the
   card says nothing is created until approval. `nl.approve_rfq_draft` takes
   only the request id, its row version and a request id, re-checks the
   stored record, and creates the quote and a commitment in `quoted` in one
   transaction. A person can make that decision on `/desk/requests/<id>` or from the
   shared `/workspace` approval queue. The mail reply queue is a separate workflow;
   approving a hand-entered quote request does not send mail.
5. **Evals.** `evals/rfq/` holds 28 invented emails with the answers they
   should produce. `npm run eval:rfq` scores the extractor field by field and
   writes a dated report. A test fails if any score drops below the recorded
   baseline.

## Workflow D: the daily ERP export (`/operations`)

1. Operations uploads the morning CSV. `lib/server/exports/reader.ts` reads it
   to a **source profile** (`profile.ts`): header aliases, required columns,
   field types, accepted date formats, number format, natural key. A new ERP
   report is a new profile, not new code.
2. Messy input is normalized: byte-order marks, quoted commas, Excel serial
   dates, `1,234.50`, `(12.00)`, stray spaces.
3. The file is identified by a SHA-256 of its normalized rows, so a re-export
   of the same data is recognized however it is named.
4. `nl.stage_export` stores the good rows and the failed rows and decides
   whether a person must look first: far fewer lines than the live data,
   every ship date already past, or rows that failed a check. Nothing touches
   the live table yet.
5. `nl.decide_export` applies, releases (with a note) or discards. Applying
   upserts open lines on (document, line), keeps `first_seen_on`, removes
   lines that are gone, and stores that day's allocation.
6. `nl.open_line_allocation` hands stock to lines oldest ship date first with
   a running sum, and puts every line in exactly one bucket.
   `nl.open_line_changes` compares today with yesterday.

## Automations (`/automations`)

- `lib/automation/catalog.ts` is shared with the browser: the triggers, their
  typed fields, which comparisons each type allows, the action shapes, and
  `ruleSchema`, which checks a rule against all of that.
- `lib/server/automation/sources.ts` holds the reviewed SQL behind each
  trigger; `compile.ts` turns a rule's conditions into a parameterized WHERE
  clause over it. Field names can only come from the catalog, and every value
  is a bound parameter.
- `rules.ts` tests a rule (in a read-only transaction), runs it as its owner,
  and fires `nl.fire_automation` per match. The action's kind comes from the
  stored rule, and a unique key on (rule, subject) makes a second firing
  impossible.
- `routes/api/cron/automations/+server.ts` runs enabled rules daily, called by
  Vercel with a shared secret.

## Accounts, parts, vendors and search

- `/accounts` and `/accounts/<customer_no>`: the account's people, revenue by
  month, how often it usually orders, its commitments, open orders, invoices,
  timeline and next steps. The writes behind the page (add or edit a contact,
  name a commitment's buyer, log a call, add or complete a next step) are SQL
  functions with the same rules as everything else.
- `/parts/<item_no>`: stock, 24 months of sales, margin, top buyers, open
  demand and siblings. `/vendors/<vendor_no>`: terms, contacts, parts
  supplied.
- `/search?q=`: accounts, parts and vendors in one page, on prefix indexes so
  it stays fast without an extension (PGlite runs the same SQL).

## Questions a reviewer is likely to ask

**Why raw SQL and no ORM?**
The interesting logic is set-based: recursive families, window functions,
triggers, row-level security. An ORM would hide exactly the part worth
showing. `lib/server/db/types.ts` keeps it safe: every value is a bound
parameter from a tagged template.

**How do you stop one user changing another user's data?**
Twice. Each transaction runs as `nl_app` with the user's id, and policies in
`0001` to `0003` restrict what that role can see and write. Write functions
check the same rules again and raise `NL403`. The tests in
`commitments.test.ts` try it as the wrong user.

**What happens if someone double-clicks Submit?**
Each form carries a request id generated when the page loaded.
`nl.claim_request` records it; the second call gets the first result back
(`claim_request` in `0001`, tested in `commitments.test.ts`).

**What if two people edit the same commitment?**
The page sends back the `updated_at` it loaded. The write only happens if it
still matches; otherwise the user gets a conflict and reloads. The column is
kept at millisecond precision because browsers drop microseconds (decision 8).

**Status is derived, but delivered is stored. Isn't that a contradiction?**
Delivered is a sum that only changes when four specific tables change, so
triggers on those tables keep it exact at commit time, and a drift check
compares it with a fresh count. Status, which depends on today's date and on
people's answers, is still computed on every read. `DECISIONS.md` 12.

**How did you find the 11-second query?**
`explain (analyze, buffers)` on the full world: the planner estimated
1.4 million rows from the recursive step and got 6,488, so it never used the
delivery index. `docs/sql.md` has both plans.

**What breaks first at ten times the size?**
The board still reads one row per commitment ever made, and a day's import
walks the billing chain per account. `docs/sql.md` lists the next steps and
what the 4x run measured.

**How do the tests run against Postgres without Docker?**
PGlite is Postgres 17 compiled to WebAssembly. The tests build a small world
in memory from the same portable migrations and seed files, with today pinned.
Supabase-only migrations are skipped.

**How is the AI kept from doing damage?**
Reads and two narrowly additive tools, adding a note or next step, run immediately
under the signed-in person's database permissions and audit trail. Changes to
existing records are gated: the model can only create a proposal, a person approves
the stored option, and the same checked SQL function used by the UI performs the
write. RFQ extraction follows a separate boundary described above: code validates
the proposed fields, then approval writes from the stored draft rather than request
values.
