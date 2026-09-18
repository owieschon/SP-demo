# The policy engine

A parts business is mostly exceptions. This account collects on its own
carrier account, that family never goes below a third, this buyer works to a
fortnight rather than a month, and the fleet customer whose trucks are off the
road gets the stock before the order that was placed first. Writing each of
those into the code that reads it is how a system fills up with special cases
until nobody can say what it will do.

By migration 0030 the same kind of decision was written six different ways:

| The rule | Where it lived | What it said |
|---|---|---|
| A commitment counts as kept | `nl.kept_ratio()`, migration 0003 | 0.95 |
| Hold a short export | `nl.partial_export_ratio()`, 0010 | 0.40 |
| How far ahead "due soon" looks | `nl.at_risk_days()`, 0010 | 14 |
| How late supply is assumed to land | `nl.overdue_supply_days()`, 0016 | 3 |
| The margin floor | `nl.min_margin()`, 0018 | 0.20 |
| Free freight above | `nl.freight_periods.free_over`, 0018 | per tariff period |
| How long a quote holds | a literal in `nl.approve_rfq_draft()`, 0011 | 30 |
| Who pays the freight | nowhere at all | |
| Who gets stock first | nowhere at all: oldest ship date, per part | |

Every one of them was correct. None could be changed without a deploy, set
differently for one account, or explained to the person looking at the number.

Migration 0034 gives them a home.

## What a policy is, and what it is not

A **policy** is a VALUE that something reads while it works. What is the
margin floor here. Who pays the freight for this account. How long does this
quote hold. It does not make anything happen; something asks it a question and
it answers.

A **rule** (migration 0013, `/automations`) is a TRIGGER that makes something
happen. When a commitment window closes short and the commitment is worth more
than ten thousand dollars, add a next step for its owner.

They are the same spirit and different jobs, and a reviewer will ask, so:

| | Policy | Automation rule |
|---|---|---|
| Shape | a value at a scope, with a window | a trigger, conditions, an action |
| Who reads it | code, in the middle of doing something | the daily runner, or a test run |
| What it does | answers a question | writes a next step or a note |
| When it runs | whenever something asks | when the runner comes round |
| Set by | operations, account managers, admins, per policy | anybody, for their own rules |
| Lives in | `nl.policies` | `nl.automation_rules` |

They compose. A rule's threshold is a number typed into the rule today
(`committed_value >= 10000`). It could be a policy, and then the same rule
would mean something different for a master distributor than for a jobber
without anybody editing the rule. That is the next thing to do here, and it is
listed under "still to move" below.

The **agent harness** (migration 0028) is the third member of the family and
is also not a policy engine: it decides how far an agent may go on its own
(`nl.agent_autonomy`, per agent and per kind of work). A policy says what the
answer is; the harness says who is allowed to act on it without asking.

## The shape of it

```
nl.policy_types     which policies exist: shape, unit, scopes, default,
                    who may change it, and what reads it today
nl.policies         the rows people set: a value at a scope, with a window,
                    a priority and a note saying why

nl.resolve_policy(type, context)     the value AND the explanation
nl.resolve_policies(types, context)  many at once, for a screen or an agent
nl.policy_trace(type, context)       every candidate and why each one lost
nl.set_policy(...) / nl.end_policy(...)   the writes, audited
```

A **context** is a small jsonb object saying what is being decided:

```sql
select nl.resolve_policy('freight.terms', '{"customer_no": "1218"}');
```

```json
{
  "type": "freight.terms",
  "value": "collect",
  "value_words": "collect",
  "source": "policy",
  "scope_kind": "customer",
  "scope_id": "1218",
  "effective_from": "2026-03-01",
  "note": "They collect on their own carrier account, so nothing rides on our bill.",
  "explanation": "collect, because this account has said so since 1 March 2026",
  "beat": [ { "scope_kind": "global", "value": "prepaid and add", "reason": "a less specific scope" } ]
}
```

The explanation is the feature. A quote that says "collect" is a word nobody
can account for. A quote that can say "collect, because this account has said
so since 1 March 2026" is a decision somebody made, with a date on it.

### Scopes

Ten, most specific first. The rank is what decides a tie between two rows that
both apply.

| Scope | Its id | Rank |
|---|---|---|
| `order_line` | `SO-20418:2` | 10 |
| `order` | `SO-20418` | 20 |
| `item` | `EL-4525` | 30 |
| `item_family` | `pipe` | 40 |
| `customer` | `1218` | 50 |
| `customer_segment` | `ELITE` (a price group) | 60 |
| `vendor` | `V-1042` | 70 |
| `mailbox` | `1` | 80 |
| `location` | `WEST` | 90 |
| `global` | empty | 999 |

The order across dimensions is a choice, not a law. A policy on a part beats
one on an account, because a part rule is usually physical (this casting is
sold in tens) and an account rule is usually commercial, and the physical one
has to hold. Where that is the wrong way round for one policy, `priority` on
the row settles it, which is what priority is for.

Two of the scopes are worked out rather than given: a context that names a
`customer_no` also matches that account's price group, and one that names an
`item_no` also matches that part's family. A caller may name either directly.

### Resolution order

1. the most specific scope with a row in effect on the date
2. then the higher `priority`
3. then the newest `effective_from`
4. then the row written last
5. and if nothing matches, the type's own `default_value`

The date is `on_date` in the context, or today. An expired row is never
deleted: it is how the trace explains a figure from last spring.

This order is written down once, in `nl.policy_matches()`, and everything else
reads it from there, which is why a trace can never disagree with the value a
quote used. A test asserts exactly that.

### The trace

`nl.policy_trace(type, context)` returns every row of that type, the one that
won, and the reason each of the others did not:

```
won   18%  customer 1312  priority 10   the most specific policy in effect on this date
lost  24%  customer 1312  priority 0    a row at the same scope has a higher priority
lost  20%  everyone                     an account is more specific
lost  32%  part family pipe             set for a part family, not this one
lost  12%  part family raw              set for a part family, not this one
lost  20%  the built-in default         only used when nothing is set
```

`/policies` shows this for whatever is in its context boxes, and the boxes
travel in the query string, so a trace is a link somebody can send.

### Value shapes

Seven, each a word a non-engineer recognizes: `number`, `integer`, `boolean`,
`text`, `enum` (one of a fixed list), `text_list` (several of a fixed list),
`object` (a small set of named numbers, for something like a lead time per
replenishment method). A type may also carry `min_value`, `max_value` and the
list a value has to come from.

Validation is a trigger on `nl.policies`, so it holds for the app, the seed,
an import and anybody at a psql prompt. It returns a sentence, not a code:

```
That is not a value Margin floor can take: 1.5 is above the highest value allowed, 0.9.
```

### Who may change what

Each type names an `edit_role`. An admin may change anything that is editable;
anybody else must hold exactly that role. `nl.set_policy()` checks it and the
page checks it again so the refusal reads like a sentence.

A type that is **not editable** is one whose old hard-coded reader has not
moved yet. `operations.kept_ratio` is in the catalog, says 0.95, and cannot be
changed, because `nl.kept_ratio()` still has 0.95 written in and changing the
policy would move a number on a screen and nothing else. Each type says what
reads it (`read_by`), or says plainly that nothing does yet. That column is
the difference between a policy engine and a page of settings that quietly do
nothing.

### Performance

Resolution happens inside quoting and inside agent replies, so it has to be
quick with a few thousand rows in the table.

`policies_resolve_idx` is `(policy_type, scope_kind, scope_id, effective_from
desc) include (value, effective_to, priority)`, and `nl.policy_candidates()`
declares `rows 10`, which is what makes the planner choose ten index probes
over a hash of every row of that policy type. Without the row estimate the
plan flipped to a scan and one answer went from three milliseconds to sixty,
measured, which is what the timing test now guards.

Measured on PGlite (Postgres 17 in WebAssembly, in the test runner's own
process, on a loaded laptop), 3,564 policy rows, 200 contexts in one
statement:

| | 34 rows | 3,564 rows |
|---|---|---|
| one policy | 2 to 4 ms | 3 to 9 ms |
| eight policies in one call | 4 to 9 ms | 9 to 19 ms |

Those numbers are noisy by a factor of two on that machine, and real Postgres
on real hardware is faster; the shape is what matters. Eight policies in one
call cost about twice one policy rather than eight times, because the context
is worked out once and the table read once, and that is what
`nl.resolve_policies()` exists for. The test asserts the ratio between the
small table and the big one rather than an absolute time, so it fails when the
plan regresses and not when the laptop is busy.

## The five rules that moved

Each one keeps its old function as a thin wrapper that resolves with a global
context, so every existing caller gets the answer it got yesterday. **A
wrapper is a migration step, not the destination.** The point of the wrapper
is that the first release changes nothing: the pipeline does not reprice,
freight does not move, quotes hold for the same month.

### 1. The margin floor

| | Before | After |
|---|---|---|
| The rule | `nl.min_margin()` returns 0.20 | `commercial.min_margin`, default 0.20 |
| Scopes | none | everyone, price group, account, part, family |
| The old function | `select 0.20` | `select nl.policy_number('commercial.min_margin', '{}')` |
| New | | `nl.min_margin_for(customer, item, date)` |

The seed sets the floor at 32% for the pipe family and 12% for raw material
sold to fabrication shops, which is closer to the truth than one number for
both ever was.

`nl.price_for()` still calls `nl.min_margin()`, so a price on a screen is
still checked against the company-wide floor. Moving it to the scoped version
changes what `below_floor` says for the accounts that have one, which is a
decision with a report behind it, not a side effect of this migration. A test
holds that boundary in place so nobody thinks it already happened.

### 2. Freight terms and the free freight threshold

| | Before | After |
|---|---|---|
| Who pays | nowhere | `freight.terms`: prepaid, prepaid and add, collect, third party |
| Free freight above | `nl.freight_periods.free_over` | `freight.free_over`, and the tariff when no policy matches |
| The old function | `nl.freight_for(subtotal, date)` | unchanged, and now a wrapper over `nl.freight_quote(customer, subtotal, date)` |

The tariff still owns the rate bands and the fuel surcharge, because those are
a carrier's numbers and not a policy anybody sets. When no policy matches, the
threshold still comes from the tariff period, so a database with no policy
rows behaves exactly as it did before.

The seed sets `collect` for every account that ships on its own carrier
account, which is the question that started this engine off: it was a boolean
on the customer card with nothing reading it.

### 3. How long a quote holds

| | Before | After |
|---|---|---|
| The rule | `v_today + 30` inside `nl.approve_rfq_draft()` | `commercial.quote_valid_days`, default 30 |
| Scopes | none | everyone, price group, account |
| Recorded | nothing | the audit row carries `valid_days` and the sentence that explains it |

`nl.approve_rfq_draft()` is re-created in 0034, one line changed, because
Postgres replaces a function rather than patching it. Diff it against 0011
before changing anything in it.

Two TypeScript copies of the same 30 are still there
(`desk/compose.ts`, `documents/letterhead.ts`); both belong to other branches
and are listed below.

### 4. Allocation priority

| | Before | After |
|---|---|---|
| The rule | oldest ship date, per part | `fulfilment.allocation_priority`, a rank per account, ship date second |
| Where | `nl.open_line_allocation` | `nl.allocation_plan`, the same columns plus the rank and the reason |
| The proof | | `nl.allocation_priority_effect`, and `/policies/allocation` |

`nl.open_line_allocation` is left exactly as it was. Nine other places read
it, including the allocation each export snapshot stores, and moving them all
is somebody else's migration rather than a side effect of this one.
`/policies/allocation` shows the lines that get a different quantity than
plain ship-date order would have given them, with the reason each one moved,
and says out loud that a priority does not make stock: it decides who waits.

### 5. Which percentile a lead time promise uses

| | Before | After |
|---|---|---|
| The rule | `nl.promise_percentile()` returns 0.90, `nl.promise_min_receipts()` returns 4 | `operations.promise_percentile` and `operations.promise_min_receipts` |
| Scopes | none | everyone, vendor, part, family |
| The old functions | a session setting, then a constant | a session setting, then the policy |

Migration 0032 left this seam open and said so in a comment: both functions
read a session setting first and fall back to a constant, with "a policy
engine, if this database has one, decides it instead" written above them. The
session setting still comes first, because it is a hook somebody wrote on
purpose to pin a figure inside a test.

A test changes the policy from 0.90 to 0.50 and watches a part's promised lead
time fall from its ninetieth percentile to its median, which is the shortest
demonstration in this branch that the app reads the policy rather than a
constant.

`nl.observed_promise_days()` was declared immutable in 0032 while already
reading a session setting. Now that the percentile behind it reads a table,
immutable is a promise it cannot keep, so 0034 relaxes it to stable. Nothing
indexes it.

`nl.promise_lead_days()` still asks the company-wide question.
`nl.promise_percentile_for(vendor, part)` is there for when it carries the
pair into the question, which is the version worth having: a vendor whose
deliveries wander needs a promise that covers more of the tail than one whose
deliveries do not.

## Who may change a policy

Each policy type names an `edit_role`, and `nl.set_policy()` refuses anybody
who does not hold it (an admin holds all of them). The whole rule is one
function, `nl.policy_role_allows(edit_role, actor_role)`, called from exactly
two places.

That is deliberately a seam rather than a mechanism. The roles branch adds
`nl.has_authority()` and an authority called `change_policy`, and when it
lands the right change here is to replace the body of that one function with
a `change_policy` check, keeping `edit_role` as the thing that says which
policies a role may touch. It was not on `origin/main` when this branch was
written, so gating on it would have made this migration fail to apply.

## Backtesting a policy

Before anybody changes a number, they ask what it would have done. For the
margin floor the answer is already in the ledger, because every invoice line
carries the cost that applied on the day it was posted (migration 0018), so
the margin on every line ever sold is a fact rather than a model.

`nl.margin_floor_backtest(floor, from, to)` runs a proposed floor over a
window and returns, per account: what was sold, what it made, how much of it
was priced under that floor, what those lines would have billed at the floor,
and what that would have added. `/policies/backtest` runs it twice over the
same window, once at the floor in force and once at the floor being tried, so
the only difference between the two is the policy.

It reports **two bounds and no prediction**:

- every under-floor line repriced and every customer still buys: margin goes
  up by `margin_gained`
- every under-floor line refused and every one of them walks: `revenue_below`
  and the margin that came with it go away

The truth is between them and nothing in this database knows where. Saying so
on the page is the point; a single number there would be a forecast dressed up
as arithmetic.

Left out on purpose: credit memos and price corrections (a return is not a
pricing decision), freight (it sits on the invoice header and never on a
line), and whether the customer would have paid the higher price, which is the
whole of the risk.

## The screens

- **`/policies`** lists every policy grouped by part of the business, with its
  company-wide value, its value for whatever is in the context boxes, and what
  reads it. Opening one shows the sentence, the trace, every row that is set,
  and the form. Changing anything writes an audit row.
- **`/policies/backtest`** is what the margin floor would have done to last
  quarter.
- **`/policies/allocation`** is the fourth rule, shown rather than described.
- **`/dictionary`** is the data dictionary (see `docs/data-dictionary.md`).

## Still to move

The engine is in and four rules use it. These are the call sites that still
have the number written in, in the order worth doing them:

1. `nl.price_for()` calls `nl.min_margin()`: give it the account and the part
   so `below_floor` means what the account agreed. (`0018`)
2. `nl.kept_ratio()` in `nl.commitment_progress`: `operations.kept_ratio`
   exists and is not editable until this happens. (`0003`, `0008`, `0009`)
3. `nl.at_risk_days()` in `nl.open_line_allocation` and the operations board:
   `operations.at_risk_days`, which a location could then set for itself.
   (`0010`)
4. `nl.overdue_supply_days()` in the projection: `operations.overdue_supply_days`,
   which a vendor could then set for itself. (`0016`)
5. `nl.partial_export_ratio()` in the import: `operations.partial_export_hold_ratio`. (`0010`)
6. `nl.default_lead_days()`: `operations.default_lead_days`, the object policy. (`0016`)
7. `QUOTE_VALID_DAYS = 30` in `app/src/lib/server/desk/compose.ts` and
   `app/src/lib/server/documents/letterhead.ts`: call `nl.quote_valid_days()`
   so an emailed quote and an approved one agree.
8. The automation rule builder: let a condition's threshold be a policy key
   rather than a number, so one rule can mean different things for different
   tiers.
9. The agent harness (`nl.agent_autonomy`, migration 0028):
   `agents.approval_threshold` and `agents.daily_cap` are declared here and
   decided there.
10. The desk's disclosure policy (`app/src/lib/server/desk/policy.ts` and
    `nl.mailboxes.disclosure`): `agents.disclosure_level` is declared here and
    decided there.

11. `nl.promise_lead_days()` asks the company-wide percentile: give it the
    vendor and the part so `nl.promise_percentile_for()` can answer.
12. `nl.policy_role_allows()`: replace its body with a `change_policy`
    authority check once the roles branch lands (see above).

Each of those is a small change plus a test that the answer did not move.

## Decisions worth knowing

- **The catalog lives in the migration, not the seed.** `nl.reset()` truncates
  every table in schema `nl` and the nightly job calls it, so reference data
  written once would be gone by morning. `nl.load_policy_catalog()` is called
  by the migration and again by `db/seed.d/90_policies.sql`, and is
  idempotent.
- **Nothing is deleted.** Ending a policy sets its last day. The row stays so
  the trace can still explain a figure from before today.
- **A policy value travels as jsonb.** One column holds a number, a word, a
  yes or no, a list or a small object, and the type says which. The
  alternative was a column per shape and a union view over them.
- **`set_by` is not granted to `nl_readonly`.** The read-only role the
  assistant and the MCP server use can read the policies and the dictionary,
  and cannot see who set a policy, because that names a person. A test proves
  it by trying.
- **A priority tie is settled by priority, then by date, then by id.** Never
  by "whichever was typed second", which is not a rule anybody can hold in
  their head.
