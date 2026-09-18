# Ten-minute reviewer tour

Use this tour when you want to evaluate Northline's legacy integration, SQL design,
AI boundary and full-stack execution without reading the whole repository first. Run
it locally so every action stays inside an invented PGlite world; after the tour, you
will know which source files contain each enforcement point.

The hosted demo at <https://sp-demo-one.vercel.app> is private. Its access password is
provided by the owner, and the role picker appears after that gate. Read-only checks
verified the Today, Commitments, Morning exports and Order desk pages. The hosted
order desk is connected to external mail, so **do not poll mail, approve, reject or
submit a write during a review**. Approved replies can leave the application. Use the
local path below for every mutating step.

Start the local app with no `.env`:

```bash
cd app
npm ci
npm run dev
```

Open <http://localhost:5180> and choose an active admin or operations role. Say once
at the start: "The business data and samples are invented. This is a demonstration
system, and the local run simulates external mail."

## 1. Stage a legacy ERP file

Open **Morning exports**. The page turns a file-only ERP workflow into a reviewable import:
the parser identifies one of three report profiles, normalizes its values, hashes its
content and stages a diff before live open lines change.

1. Download **Today's sales lines** from the sample list.
2. Upload the file and inspect its added, changed and removed rows.
3. Apply it if you want to demonstrate the human decision.
4. Upload **Wrong report** to see missing required columns refused before staging.
5. Upload **Partial export** to see a suspicious but readable snapshot held for a
   person.

Yesterday's exports are already applied in the seeded world, so uploading one of them
demonstrates duplicate detection rather than the normal apply path.

Read the implementation in
[`app/src/lib/server/exports/`](../app/src/lib/server/exports) and
[`db/migrations/0010_erp_exports.sql`](../db/migrations/0010_erp_exports.sql).

## 2. Validate an invented quote request

Open **Order desk**, expand **Add a quote request by hand**, and select an invented sample.
Choose **Read and check**. With no model key, the deterministic rules extractor reads
the request and the same validation pipeline used by live extraction checks its
result.

This hand-entry flow creates a quote request under `/desk/requests/<id>`. It does not
create an outbound reply draft. A mail message, when one exists, has its own
`/desk/<id>` detail and separate reply-review actions.

Point out three distinctions:

- Extraction proposes values. It does not create a quote.
- Validation resolves the sender, customer, parts, quantities, dates and stated
  prices against stored business data. Each field ends as accepted, corrected or
  needing review with a reason.
- Approval uses the stored draft's id and row version. The database function reloads
  and revalidates it before writing a quote and commitment. Approval is available on
  the quote-request detail and in **Approval queue**; it does not send mail.

The separate mail-agent workflow labels instruction-shaped fixture text as data,
shows each fact's source and checks outbound recipients against a server-side
allowlist. The local no-key path simulates mail; hosted mail approval may send.

The rules-only regression set currently gets 26 of 28 invented cases fully right. The
set and extractor share an author, so this is a regression floor rather than evidence
of generalization to unseen mail.

Read the pipeline in [`app/src/lib/server/rfq/`](../app/src/lib/server/rfq) and the
evaluation contract in [`evals/rfq/README.md`](../evals/rfq/README.md).

## 3. Follow a commitment into SQL

Open **Commitments**, then open one record. A commitment names a customer family,
parts, a date window and a value. Its delivered amount comes from matching invoice
lines, including branches that bill through the committed account. Returns subtract
from delivery.

The database derives the visible status. A person records only the outcome of a
window that closed short. Checked write functions enforce ownership, idempotency,
optimistic concurrency and auditing.

The historical full-world benchmark reduced the board query from 10,963 ms to 6 to
10 ms through a planner-aware family function, an index, trigger-maintained delivery
totals and a once-per-query date read. Those figures were measured on 2026-09-17 on
Supabase Postgres 17 Micro compute. They are not rerun by this local tour.

Read the plans and scale limits in [`docs/sql.md`](sql.md), then inspect migrations
[`0003`](../db/migrations/0003_commitments.sql) through
[`0009`](../db/migrations/0009_progress_today_once.sql).

## 4. Test a typed automation

Open **Automations**, choose a seeded rule and select **Test this rule**. The browser
edits a typed rule object, not SQL. The server compiles its conditions over one of a
fixed set of reviewed query sources, and every value becomes a bound parameter.

Testing runs inside a transaction Postgres marks read-only. Saving a rule and firing
it are separate operations, and a unique key keeps one rule from firing twice for the
same subject.

Read the shared catalog in
[`app/src/lib/automation/catalog.ts`](../app/src/lib/automation/catalog.ts) and the
server path in [`app/src/lib/server/automation/`](../app/src/lib/server/automation).

## 5. Ask for a gated change

Open the command palette and choose the assistant, or go directly to `/ask`. The
assistant is intentionally not a left-rail item. The local app uses a scripted model,
so this step consumes no model API. Ask which commitments closed short, then ask to
mark one as pushed.

The read tool can run. The change tool cannot. The runtime records the gated attempt
and can show a proposal card, but only a person's approval can execute the stored
option. Approval runs the same database function as the ordinary UI under the
person's identity and with the captured row version.

Read the complete threat boundary in
[`docs/assistant-gating.md`](assistant-gating.md) and its implementation in
[`app/src/lib/server/assistant/gate.ts`](../app/src/lib/server/assistant/gate.ts).

## Close on the evidence

The through-line is not the number of screens. It is that TypeScript adapts inputs and
Postgres owns the invariants: explicit roles, row-level security, checked write
functions, idempotency keys, row versions and audit records. Gated model actions and
staged file imports stop at reviewable proposals before important writes; read tools
and the two narrowly additive assistant tools run inside the signed-in user's limits.

Close by showing the offline verification commands:

```bash
npm run check
npm test
npm run build
npm run eval:rfq
```

CI runs the first three after a clean install on Node 24. The rules-only eval is an
additional reproducible check. Neither path verifies hosted networking,
the connection pooler, scheduled `pg_cron` jobs, live model behavior or delivery by
the external mail provider.
