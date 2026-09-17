# The agent workspace

> "There should be a workspace for all agents and agent requests where the
> human either approves or corrects the actions. Otherwise agents should be
> fully autonomous throughout the app."

Four features in this app put things in front of a person: quote requests read
out of customer email, the assistant's proposals, the order desk's mail drafts
and the procurement desk's purchase requests. Each has its own page and its own
approval card, so a person had to visit four pages to see what was waiting.

`/workspace` is one queue over all of them. Everything else the agents do stays
autonomous; this page is only the moments where somebody has to say yes or no.

Files: `db/migrations/0023_workspace.sql`,
`app/src/lib/server/workspace/**`, `app/src/lib/workspace/**`,
`app/src/lib/components/workspace/**`, `app/src/routes/workspace/**`.

## The rule that shapes all of it

**The workspace owns no approval logic.** It collects and it routes. Every
guarantee that matters stays with the feature that owns the record:

- the request id, so a retry replays instead of writing twice;
- who is allowed to decide;
- the row version, so a record that moved is not overwritten;
- the audit row;
- and above all, that what gets written comes from the STORED record, not from
  the form that approved it.

So there is no `approve` in this feature's own SQL beyond one history row. A
decision made here calls exactly the same function the feature's own page
calls, as the same person. The test
`writes exactly what approving on the quote request page writes` compares the
rows both paths produce, field by field, and they are equal.

## One row shape

`nl.agent_queue` is a view (security invoker) with one row per waiting request:

| Column | What it is |
|---|---|
| `source` | `rfq`, `assistant`, `mail` or `purchase` |
| `source_id` | the record's own id in that feature's table |
| `summary` | one line: what is proposed |
| `subject_kind` | `account`, `vendor`, or null when it concerns neither |
| `subject_no`, `subject_name` | the account or vendor it is about |
| `value` | what it is worth, where there is a figure |
| `created_by_id`, `created_by` | who or what made the request |
| `created_via` | `person`, `assistant` or `agent` |
| `created_at` | when it was made; the queue is newest first |
| `row_version` | the record's `updated_at`, sent back with a decision |
| `reviewer_id` | whose decision it is, or null for anyone with the right role |
| `status` | `waiting`, `needs_review` (correct it first) or `retry` (an approved write failed) |

Two things are deliberately absent. There is no "value" on an assistant
proposal, because a proposal proposes an action rather than an amount; the
account it concerns is resolved from the commitment its first option names.
And `value` for a quote request is the validator's own subtotal, so the figure
on the row is the figure the approval will write.

Row-level security is unchanged and untouched. The view is
`security_invoker = true`, so each source's own policies decide what is in the
queue at all: an unapproved quote request is its creator's (or an admin's), an
assistant proposal is only ever its own person's. The queue does not widen
anybody's view by a single row, which the test
`shows nobody else what is waiting on them` pins down.

## How each source is routed

`app/src/lib/server/workspace/decide.ts` is the only place a decision goes
through, and it does these six things in order:

1. a decision already recorded under this request id is handed straight back,
   so a double submit writes once;
2. the item is read from `nl.agent_queue` as this person. Somebody else's is
   simply not there, which is a 404;
3. the row version has to match what the page loaded, else 409;
4. the item has to be this person's to decide: its reviewer, or an admin, or
   any active user when it has no reviewer. Else 403;
5. corrections first, through the source's own revise step, then the source's
   own approve or reject;
6. `nl.record_queue_decision` writes the workspace's own history row.

| Source | Approve | Reject | Correct first |
|---|---|---|---|
| `rfq` | `nl.approve_rfq_draft` | `nl.reject_rfq_draft` | `nl.revise_rfq_draft`, one change at a time, each re-validated on the server |
| `assistant` | `decideProposal` in `assistant/proposals.ts`, which records with `nl.decide_assistant_proposal` and then runs the chosen option's own SQL function | the same, with `reject` | not possible, and the UI says why |
| `mail` | `nl.approve_mail_draft` | `nl.reject_mail_draft` | the subject and the body |
| `purchase` | `nl.approve_purchase_request` | `nl.reject_purchase_request` | not here; open it |

The request ids a decision uses are all derived from the one the page sent:

- `<id>` for the source's own approve or reject, which is the id the feature
  would have used on its own page;
- `<id>-edit-1`, `-edit-2` ... for each correction;
- `<id>-queue` for the workspace's own history row.

So retrying a whole decision replays every part of it rather than doing any of
it twice. The history row stores the SOURCE write's request id, which is what
ties it to the audit row the feature wrote.

## "Correct, then approve"

Where the source supports an edit, the queue offers it inline and records the
decision as `edited_approved` rather than `approved`:

- **Quote request:** a quantity per line and the needed-by date. Each goes
  through `nl.revise_rfq_draft`, exactly as the quote request page does it, so
  the draft is validated again on the server after each change and the approval
  that follows uses the row version the last change returned. Anything bigger
  (a different part, a different customer, accepting a price) is corrected on
  the quote request page, which has the whole draft and every check beside it.
  A draft with a field that still needs a person shows as `needs_review` and
  its Approve button is disabled, because `nl.approve_rfq_draft` would refuse
  it anyway.
- **Mail draft:** the subject and the body. A field the person did not touch is
  filled from the stored record, not sent empty.
- **Assistant proposal:** cannot be edited, and the row says so in as many
  words. A proposal is a fixed option with a fixed input whose row version was
  captured when it was made; that fixedness is what makes approving it safe.
  Reject it and ask for a different one.
- **Purchase request:** not edited here either.

## How it degrades when a source is missing

Migrations 0021 (mail drafts) and 0022 (purchase requests) are being built on
other branches. **On this branch they do not exist**, and a view cannot name a
table that is not there, not even inside `where exists`: Postgres resolves the
names when the view is created. So the view text is assembled by a function.

- `nl.agent_queue_fragment(source)` returns one SELECT in the queue's shape for
  that source, or null when it is not in this database.
- `nl.rebuild_agent_queue()` unions the fragments that are not null and does
  `create or replace view nl.agent_queue ...`. It is DDL, so it is **not**
  granted to `nl_app`; the schema's owner runs it.
- `nl.agent_queue_sources()` says which sources are in the view as it stands,
  as `{"rfq": true, "assistant": true, "mail": false, "purchase": false}`. The
  page reads it and tells a person that this database does not have mail drafts
  yet, rather than leaving them wondering.

With a source missing, the queue simply has no rows from it, a filter for it
returns nothing, and a decision on one is a 404 because there is no such row.
Nothing is faked and nothing half-works.

**After applying 0021 or 0022, run `select nl.rebuild_agent_queue();` once** as
the owner of the schema (a one-line migration is the tidiest place for it).
Until that is run, the new table is not in the view.

### What those two tables need for the queue to carry them

The queue looks for a table called `nl.mail_drafts`, or `nl.purchase_requests`
(`nl.purchase_request_drafts` is also accepted). It needs four columns and
takes the rest if they are there:

- required: `id`, `status`, `created_at`, `updated_at`. Without all four the
  source stays out and `nl.agent_queue_sources()` reports it absent.
- a row counts as waiting when its `status` is one of `draft`, `waiting`,
  `pending` or `proposed`.
- optional, used when present: `summary` or `subject` for the one-line summary,
  `customer_no` (mail) or `vendor_no` (purchase) for the account or vendor,
  `value` / `total` / `total_value` for the figure, `created_by`, `reviewer_id`,
  and `body`, `to_address` or `reason` for the detail behind the row.

For routing, the write functions are called with **named arguments**, so their
argument order does not matter, and each parameter is filled from:

| Parameter | Filled with |
|---|---|
| `p_request_id` | the decision's request id |
| `p_expected_updated_at` | the row version the page loaded |
| `p_reason` or `p_note` | what the person typed |
| `p_subject`, `p_body` | what the person corrected, or the stored value |
| anything ending in `_id` | the record's own id |
| any other `p_<name>` | the stored record's column of the same name |

A parameter the workspace cannot fill is refused BY NAME, with a message that
sends the person to that feature's own page. That is the whole extent of the
guessing: no write is ever attempted with a value the workspace invented.

`app/src/lib/server/workspace/queue-sources.test.ts` proves the mechanism with
a stand-in `nl.mail_drafts` and its two write functions, built inside the test:
the table appears, the queue is rebuilt, the row shows up, a correction reaches
`nl.approve_mail_draft`, and the stored subject is used when nobody corrected
it. The stand-in is not migration 0021; it is the shape above.

## The workspace's own history

`nl.queue_decisions` is a small append-only table: source, source id, the
decision (`approved`, `edited_approved`, `rejected`), who decided, when, the
note, and the request id the source's write ran under.

It exists because the nightly job rebuilds the invented world, so a source row
can be replaced while what a person decided about it should not be. It does not
replace `nl.audit_log`; it sits beside it, and a decision writes to both.

`nl.record_queue_decision` follows the repository's write rules: it claims the
request id, requires an active user, checks its fields with `NL4xx` codes and
writes an audit row. There is no optimistic lock, because it is an insert and
the row the decision is ABOUT was locked by the source's own write function a
moment earlier. Recording the same decision twice (same source, same record,
same source request id) writes once and says `recorded: false`.

Access, as the handoff describes: RLS on, everyone with `nl_app` reads it (it
is the team's history, like the audit log), everyone may only ever insert a row
in their own name, nobody updates or deletes one, and `nl_readonly` gets no
grant at all, because a decision names the person who made it.

## The page

`/workspace` is one list, newest first, in two sections: **Needs you** (you are
the reviewer, or the record is yours) and **Needs someone**. Counts at the top,
filters by source and by account, and a tab for recent decisions. Each row
expands to the facts behind the proposal, its lines or its options, the
corrections that source allows, and the two buttons. The empty state says
"Nothing is waiting on you", which is the good case.

## Tests

`app/src/lib/server/workspace/workspace.test.ts` (17) and
`queue-sources.test.ts` (8), both on PGlite with today pinned to 2026-09-17:

- the queue shows a quote request and an assistant proposal created in the
  test, in one shape, newest first;
- **approving through the queue writes exactly what approving on the feature's
  own page writes**: the quote, its lines, the commitment, its scope, the total
  and the audit rows are compared and equal;
- an assistant proposal approved here lands through the assistant's own path:
  one outcome, by that person, `via = 'assistant'` in the trail;
- correcting then approving goes through the revise step, ends up in the quote,
  and is recorded as `edited_approved`;
- a stale row version is a 409 and leaves the record untouched;
- somebody else's item is a 404 (row-level security gets there first, which is
  why the 403 case needs a source the whole team can see);
- a non-reviewer is refused with 403 on the stand-in mail source, and an admin
  is not; a row with no reviewer is anyone's;
- the same decision twice writes once: one quote, one decision row;
- a rejected item leaves the queue and nothing was written;
- the view works with 0021 and 0022 absent, and `pg_get_viewdef` shows it does
  not name `mail_drafts` or `purchase_request` at all;
- decisions are recorded with who, when, the note and the request id, and the
  whole team can read them.

## Not done

- The queue is read with `limit 100`. A person working through hundreds would
  want paging.
- `explain (analyze, buffers)` was run on the small world only, not on the full
  one, which the repository's rule asks for before shipping a view. On the
  small world the plan is an Append of two branches, a sort and a limit, 3.5 ms
  and 5 shared buffers. Two things to watch when it is measured on the full
  world: the assistant branch uses
  `assistant_proposals_created_by_idx`, but the quote request branch is a
  sequential scan, because the RLS predicate is
  `created_by = me OR is_admin()` and an OR like that cannot use the index on
  `created_by`. Unapproved drafts are few and short-lived, so this is cheap
  today; if it stops being cheap, the fix is a partial index on
  `nl.rfq_drafts (created_by, created_at desc) where status = 'draft'`.
- The mail and purchase routing is proven against a stand-in, not against the
  real 0021 and 0022. Whoever lands those should read
  "What those two tables need" above, run `nl.rebuild_agent_queue()`, and
  check the detail columns they expose.

## Follow-up: the mail source is real now

`queue-sources.test.ts` proved the mail path against a stand-in table built
inside the test, because migration 0021 did not exist when the queue was
written. It does now, with its own shape and its own write functions, so a
stand-in of the same name cannot be created and those tests are parked
(`describe.skip`). The rewrite points them at the real `nl.mail_drafts`,
builds its fixture through `nl.queue_mail_draft`, takes the reviewer from the
mailbox rather than from the draft, and proves that approving through the
queue equals approving on the desk page.

A database where 0023 was applied before 0021 needs `select
nl.rebuild_agent_queue();` once, or the mail source is missing from the view.
