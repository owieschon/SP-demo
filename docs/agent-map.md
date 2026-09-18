# The app, mapped for an agent

Written 2026-09-17 on branch `ux-audit`. What each route holds, what can be
done there, which tool covers it, and what is missing. The short version of
this file is served at `/llms.txt`.

Branch state when this was read: `main` at `16fbd58`, `mcp-server` at
`87a0cca` (one commit, substantially finished), `agent-workspace` at
`04a8fdd` (four commits). Both feature branches changed during the audit,
so check the tip before acting on the tool lists.

## How to get in

There are no passwords. `GET /signin` lists the people you may be; a form
post with `userId` sets a signed `nl_session` cookie. Without it every path
redirects to `/signin?next=<path>`. The cookie names one person, and every
database call afterwards runs as that person under row-level security.

Public paths, in `app/src/hooks.server.ts`: `/signin`, `/gate`,
`/robots.txt`, `/api/cron/automations`, `/api/mcp`, `/api/mail/poll`,
`/api/mail/webhook`.

In front of all of it, when `SITE_PASSWORD` is set, is one shared password
(`app/src/lib/server/gate.ts`). The exempt list there is the same set of
secret-carrying endpoints, so a coding agent, the schedulers and the mail
webhook still work while the pages are closed.

## What the pages give an agent, and what they do not

Already true:

- Filters, sorts and page numbers are query parameters on GET forms. There
  is no `goto`, `pushState` or `replaceState` anywhere in the app, so every
  list view is a link.
- Record names are anchors to the record's own URL, roughly twenty of them,
  so the record graph can be walked by following links.
- Every page has exactly one `<main>` and one `<h1>`, and its browser title
  names the record (`C-3014 Chrome stacks for the spring run · Northline`).
- Section headings carry ids that work as anchors: `#answers`, `#scope`,
  `#lines`, `#quotes`, `#buyers`, `#siblings`, `#open`, `#chart`.
- Tables are real tables with a `thead`, and figures are right-aligned with
  tabular numerals.
- No native `confirm()` or `alert()` anywhere, so nothing stalls an agent on
  a dialog it cannot see.
- Every write form carries a hidden `requestId` and the row's
  `expectedUpdatedAt`, so a browser agent gets idempotency and optimistic
  locking for free by submitting the form it was given.
- Every form action is named in the form's own action URL (`?/approve`,
  `?/decide`, `?/adjust`), which is the most reliable handle in the DOM.

Not true yet, in the order that matters:

1. **No `data-*` identifier on any record row, card or action button.** The
   whole app has two: `data-label` (six responsive table captions) and
   `data-theme` on `<html>`. An agent asked to "mark step 4102 done" has to
   match on visible text.
2. **Row action buttons do not carry their record.** Twenty rows give twenty
   buttons whose accessible name is "Done", "Edit", "Use", "Ship it",
   "Correct" or "Remove line". Two controls in the whole app do this right:
   `ConditionRow.svelte:91` and `AccountsTable.svelte:136`.
3. **No public JSON.** One JSON endpoint exists and it is the cron hook.
   SvelteKit serves each page's load data at `<route>/__data.json`, which is
   an internal shape, unversioned and undocumented.
4. **Errors lose their code before the client sees them.** `errors.ts` maps
   `NL401` to `NL429` onto statuses correctly, then every route calls
   `fail(status, { message })` and drops the code and the field name.
5. **No figure carries an as-of date.** `as_of` exists on exactly one table
   in the schema (`nl.stock`) and surfaces in one tool.
6. **Five places hide content behind a click with no URL**: the contact form
   on a vendor page, the reject reason on both proposal cards, the discard
   confirm on an export snapshot, the correction row in the part ledger, and
   the whole rule draft in the automation editor.

## Routes

`R` marks a read a tool covers, `W` a write a tool covers. "no tool" means
no assistant tool and no MCP tool reaches it.

| Route | What it shows | What a person can do | Tool cover |
|---|---|---|---|
| `/` | redirect to `/commitments` | nothing | n/a |
| `/commitments?who=mine\|all` | six lanes: promised, quoted, delivering, kept, pushed, broken; four headline totals | open a card, answer a closed window | `run_sql` only. `list_windows_closed_short` covers the closed-short lane. No tool returns the board |
| `/commitments/<id>` | scope as item numbers, delivered against committed, matched invoice lines, quotes, notes, next steps, buyer | set confidence `W`, answer the outcome `W`, name the buyer, add a note `W`, add a next step `W` | `get_commitment` `R`. Buyer choices come from `nl.contacts` and are unreachable: `nl_readonly` has no grant on it |
| `/commitments/answer?who=` | the oldest window that closed short | record kept, pushed or broken `W` | `list_windows_closed_short` `R`, `record_outcome` `W` (gated) |
| `/accounts` | the book, 50 a page, with revenue, cadence, committed value | filter by q, state, group, quiet, open; sort; page | `search_accounts` `R` covers q only. No state, group, quiet, sort or paging |
| `/accounts/<customer_no>` | five figures, 24 months of revenue, people, activity, next steps, commitments, orders, invoices, branches | add and edit a contact, log a call `W`, add and complete a next step | `get_account` `R` for the business half. **Contacts and the activity timeline are not covered and not reachable** |
| `/parts` | 100 parts by 12-month revenue | filter by q, family, short, reorder; sort | `run_sql`. `get_part` is one item at a time |
| `/parts/<item_no>` | stock, price, cost, margin, 24 months of units, buyers, open demand, siblings | nothing | `get_part` `R` for the summary. Demand, the sales series and siblings: `run_sql` only |
| `/vendors` | 100 vendors by revenue | filter by q, all | `run_sql` |
| `/vendors/<vendor_no>` | terms, contacts, every part supplied (no cap) | add a contact | `run_sql` for the first two. Vendor contacts not covered |
| `/search?q=` | accounts, parts and vendors, ten each | nothing | `search_accounts` covers accounts only |
| `/operations?snapshot=` | today's export: buckets, past due and at risk, day over day, recent snapshots | upload a CSV, apply, release with a note, discard | `decide_export` `W` (gated). **`nl.export_snapshots` is not readable by any tool**, so an agent can decide on a snapshot it cannot inspect |
| `/operations/forecast` | when each open line will really ship, a vendor call sheet, a production backlog, customers to call | ask "can we ship N of X by D" | `run_sql` partly. `nl.available_to_promise` is not in the read-only function allowlist, so the answer an agent most wants is uncallable |
| `/warehouse?part=` | bins, the stock ledger, the pick queue, count sheets, transfers | advance a shipment, post a count, post an adjustment | **nothing.** No tool, and the 0019 tables are not in the read-only grant |
| `/automations` | every rule as one plain-English sentence, and what it has done | nothing | **nothing lists saved rules** |
| `/automations/new`, `/automations/<id>` | the rule builder: trigger, conditions, action, a test run | test, save `W` | `test_automation_rule` `R` tests an unsaved rule; `save_automation_rule` `W` (gated) |
| `/desk`, `/desk/<id>` | what arrived, what the agent did step by step, what it refused and under which rule, the document beside its reading | check mail, enter a request by hand | **nothing reads a run trail** |
| `/desk/requests/<id>` | what was read, what code checked, what approval will create | revise a field, approve, reject | **nothing** |
| `/ask`, `/ask/<id>` | the assistant, its lookups and its proposals | ask, approve or reject a proposal | private by design: RLS keeps a conversation to its owner |
| `/signin` | the people you may be | sign in | n/a |
| `/workspace` (branch) | one queue for every agent proposal, from four features | approve, edit and approve, reject | `list_pending_approvals` on the other branch covers the assistant slice only |

## The tools

### Assistant, `app/src/lib/server/assistant/tools.ts`

Fourteen. Risk class is a field on the tool and is branched on in
`gate.ts:145` before the input is even parsed, so it is enforced rather than
advisory.

| Tool | Read or write | Risk |
|---|---|---|
| `search_accounts` | read | read |
| `get_account` | read | read |
| `get_commitment` | read | read |
| `list_windows_closed_short` | read | read |
| `get_part` | read | read |
| `run_sql` | read | read |
| `test_automation_rule` | read | read |
| `add_note` | write | additive |
| `add_next_step` | write | additive |
| `record_outcome` | write | gated |
| `set_confidence` | write | gated |
| `decide_export` | write | gated |
| `save_automation_rule` | write | gated |
| `propose_action` | neither | propose |

`run_sql` runs as `nl_readonly` in a read-only transaction with a ten second
timeout, no grant on any table naming a person, a forbidden-keyword list, a
six-function allowlist and a 1000-row wrapper.

### MCP, branch `mcp-server`

Tools built from the assistant registry rather than rewritten:
`...TOOLS.filter(t => t.risk === 'read').map(readTool)`, plus
`list_pending_approvals`, plus the gated and additive tools in whichever shape
the token's level allows. Streamable HTTP, JSON-RPC 2.0, stateless,
`POST /api/mcp`. Bearer token `nlmcp_...`, SHA-256 stored only, 200 calls per
token per day, every call logged to `nl.mcp_calls`. A token acts as one named
person, so RLS still decides what it sees.

**There are no scopes.** Migration 0044 dropped the column. What a token may
do is what its person may do; how far it goes without asking is one dial, its
rung on the harness autonomy ladder, held as an `agent_autonomy` grant on the
token's own principal in `nl.users`. At `suggest` a change is offered as
`propose_<name>` and a person approves it; from `auto_review` the four gated
tools and the two additive ones are offered under their own names and happen
for real, bounded by the person's `approve_agent_proposal` ceiling, the
`agents.approval_threshold` policy, the undo window and the pause switch.
`tools/list` answers with that rung's list only, so it tells an agent the
truth about what it can do right now. See [`mcp.md`](mcp.md).

It carries `annotations: { title, readOnlyHint, destructiveHint,
idempotentHint }`. `openWorldHint` is missing. There is no `outputSchema`
and no `structuredContent`: results are `JSON.stringify` in a text block.

## Writes, and who can reach them

Twenty-three business writes a person can perform. Six are covered by a
tool. Seventeen are not.

Covered: `log_activity`, `add_next_step`, `record_outcome`, `set_confidence`,
`decide_export`, `save_automation_rule`. The MCP branch adds no new write
coverage, only a better approval path for the same four gated ones.

Not covered: `add_contact`, `update_contact`, `complete_next_step`,
`set_commitment_buyer`, `add_vendor_contact`, `stage_export`,
`advance_shipment`, `post_count_session`, `post_stock_adjustment`,
`save_rfq_draft`, `revise_rfq_draft`, `approve_rfq_draft`,
`reject_rfq_draft`, `start_automation_run`, `fire_automation`,
`finish_automation_run`, `receive_transfer`.

`nl.receive_transfer` is implemented, exported and tested, and no route and
no tool calls it. It is reachable by nobody.

Whole features that are invisible to an agent: RFQ intake (four writes), the
warehouse (four writes), contacts (three writes).

## The rules an agent's writes must obey

The same rules a person's writes obey, because they go through the same SQL
functions. Every write function claims a request id (`nl.claim_request`, so
a repeat returns the first result), requires an active user, checks the field
rules and raises an `NL4xx` SQLSTATE, locks optimistically on the row's
`updated_at`, and writes a row to `nl.audit_log`. None of that lives in
TypeScript, and none of it lives in a prompt.

The gate above it, `docs/assistant-gating.md`: a gated tool is refused
before its input is parsed and can only be proposed. A proposal carries the
tool name and input it was shown; on approval the server compares them with
the stored proposal, refuses on a mismatch, and writes from the stored copy,
never from the request.

## What an agent cannot find out

- What happened to a proposal it made. On `agent-workspace` the decision is
  stored with who and when, in `nl.queue_decisions`, and the only way to
  read it is the `/workspace` page. There is no endpoint, no tool, and
  `nl_readonly` has no grant on the table. The assistant's own conversation
  gets one prose line with no actor and no timestamp.
- What the difference was between what it proposed and what was approved.
  `edited_approved` records that a correction happened, not what it was.
- What its earlier lookups in the same conversation returned.
  `historyFrom` in `conversation.ts:209` replays message text only and drops
  tool calls and tool results, so the model must redo its own work on a
  follow-up question.

## The gaps, as requirements

Ordered by what they unblock.

1. `data-<thing>-id` on every record row, card and action target, and the
   record's name in every row action's accessible name.
2. A route registry, one module, that every URL in the app and every tool
   result is built from. Then every result row can carry its own URL.
3. A structured output schema per tool, and `structuredContent` alongside the
   text, on both the assistant and the MCP server.
4. Machine-readable errors: the `NL4xx` code and the field name in the
   `fail()` payload and in the tool's error, not just a sentence.
5. A "describe the data" tool: every view, its columns and what each column
   means, so `run_sql` stops being a guessing game.
6. An as-of stamp on every figure a tool returns, and on every panel of
   figures a page shows.
7. Tool cover for the three invisible features: RFQ intake, the warehouse,
   contacts. Reads first, then proposals for the writes.
8. A read path for a proposal's fate, exposed to whoever made it, with the
   diff when it was edited.
9. `openWorldHint` on the MCP tools, and the assistant's `risk` exposed
   under the MCP annotation names so a generic client can read it.
10. The five hidden view states into the URL, the rule draft first.
11. An activity view of what the assistant and the desks did, with undo,
    which is the queue on `agent-workspace` plus a history tab.
12. The saved automation rules published as reusable prompts, since a rule
    is already a named, parameterised routine.
