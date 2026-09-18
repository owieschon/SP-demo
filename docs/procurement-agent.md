# The procurement desk

Four questions, asked every morning in every parts business: what do we need
to buy, how many, who from, and by when. Nobody should have to hold the answer
in their head, because every input is already in the database. Migration
`0029_procurement.sql` works it out, `db/seed.d/80_procurement.sql` shapes the
invented world so the page has something real to show, and `/procurement`
renders it.

Nothing on this page is worked out in JavaScript.
`app/src/lib/server/procurement/` calls the database and renames columns, so a
page, a test and the assistant cannot answer the same question three different
ways. The one exception is the vendor disclosure policy, which is a judgement
about English text and is explained under **What a vendor may hear**.

## The maths

### Usage: how fast a part sells

`nl.part_usage`, one row per part, from the invoice ledger.

| Column | What it is |
|---|---|
| `units_90d`, `units_365d` | units sold in the last 90 and 365 days, credit memos included with their negative quantities |
| `per_day_90`, `per_day_365` | those two divided by 90 and 365 |
| `per_day` | the **higher** of the two, and the rate everything downstream plans on |
| `per_week` | `per_day x 7`, which is how a buyer says it out loud |
| `demand_cv`, `demand_shape` | how erratic the demand is |
| `revenue_90d` | what the part sold in 90 days, in dollars |
| `months_with_demand`, `last_sold_on` | whether the rate means anything |

Two windows, because one window is always wrong for something. Ninety days
catches a part that has just started moving; a year catches a part whose season
is not now. Taking the higher of the two is a deliberate asymmetry: ordering to
the faster of a part's two recent rates costs a month of carrying cost, while
ordering to the slower one costs a line the plant cannot ship.

`demand_shape` is the coefficient of variation of the last twelve monthly
totals, with the empty months counted as zeroes. Leaving them out would make a
part that sells once a quarter look perfectly steady.

| Shape | CV | What it means |
|---|---|---|
| `none` | | nothing sold in a year |
| `steady` | below 0.6 | a rate worth planning on |
| `lumpy` | below 1.2 | plan on it, expect to be wrong sometimes |
| `erratic` | above that | the rate is an average of nothing |

### Lead time

`nl.lead_time_days(text)` reads one ERP date formula and answers in calendar
days, because every date this file works out is a calendar date.

| Unit | Days | Example |
|---|---|---|
| `D` | 1 | `10D` is 10 |
| `W` | 7 | `3W` is 21 |
| `M` | 30 | `2M` is 60 |
| `Y` | 365 | `1Y` is 365 |

Case and spaces do not matter, and a bare number is read as days. Anything
else, including an empty string, a signed formula and null, returns **null**:
"the formula does not say", which is a different answer from "the formula says
zero". One term only. A compound formula like `1W+3D` is not something this
ERP's item card produces, and guessing at half of it would be worse than
saying nothing.

The lead time a part is planned on is its own formula, then its vendor's, then
`nl.default_lead_days(replenishment)`: 28 days for a bought part, 7 for an
assembly, 14 for anything else. `nl.item_lead_time_days(item_no)` is those
three steps for a caller that has only an item number.

**`nl.lead_time_days` and `nl.default_lead_days` belong to migration 0016**,
the supply forecast, which lands first when both are applied. 0022 creates
them only when they are not already there, so it can also be applied to a
database with no supply forecast yet, and the bodies are 0016's to the
character. A lead time that came out differently depending on which migrations
were applied would be worse than no lead time at all, so neither file is the
place to have a new idea about it. The two things 0022 wanted and gave up on
are a leading plus (`+3W`) and a compound formula, and both should go into
0016 if anybody wants them.

### The projection

The horizon is the part's own lead time, and nothing else would mean anything:
an order placed today lands on today + lead time, so what matters is the stock
position on that day.

```
horizon_on              = today + lead_time_days
promised_before_horizon = open sales lines shipping on or before it
incoming_before_horizon = supply due on or before it
projected_available     = on_hand + incoming_before_horizon
                        - promised_before_horizon
```

Open sales lines come from `nl.open_order_lines`, the live table migration 0010
fills from the morning ERP export. Incoming supply comes from
`nl.incoming_supply()`, which is explained under **The two migrations that are
not here yet**. A supply row with no date counts as arriving inside the
horizon: it is already bought, and pretending otherwise would have the desk
order the same part twice.

### The suggestion

```
target_qty  = greatest(policy_level,
                       safety_stock + per_day x (lead_time_days + cover_days))
raw_need    = target_qty - projected_available - on_order_later
suggested   = raw_need, rounded up to the pack
```

`cover_days` is `nl.target_cover_days()` (30). Thirty days is one ordering
cycle for this book: the desk works a weekly list, and a month of cover means a
part that sells steadily comes back round about once a month rather than every
week.

`policy_level` is `coalesce(reorder_point, safety_stock)` from the item card,
and it is a **floor** on the target. A reorder point is the level at which you
reorder, not the level you reorder back up to, and a part that has not sold in
a year still has a reorder point of 20 because somebody decided the plant holds
twenty of them. Without the floor, such a part would show as below its reorder
point with a suggestion of nothing, which reads as a bug.

`on_order_later` is `on_order_total - incoming_before_horizon`. This is the one
place a suggestion could easily double count, so it is worth being explicit:
supply landing **inside** the horizon is already in `projected_available`, and
supply landing **after** it is subtracted here. Every unit on order therefore
comes off the suggestion exactly once, and
`replenishment.test.ts > the suggestion > never counts what is already on order
twice` proves it by comparing two identical parts, one with 30 on order.

`nl.pack_size(family, unit_cost)` gives the pack: 25 for clamps, 10 for
brackets and raw material, 5 for flex, shields and pipe, 2 for elbows, stacks
and mufflers, 1 for everything else, and 1 for anything over $250 a piece,
because nobody buys a case of those to round a number up.

### What puts a part on the list

`needs_buying` is true when the part is not blocked, the suggestion is more than
zero, and either:

| `trigger_reason` | When |
|---|---|
| `below reorder point` | the projection is under the item card's reorder point |
| `below safety stock` | the card has no reorder point, and the projection is under safety stock |
| `promised more than we will have` | the projection is negative, whatever the policy says |

### The dates

`runs_out_on` is when the shelf empties at the current rate.
`order_by_on = runs_out_on - lead_time_days` is the day the order had to be
placed; a date in the past is the desk being told it is already late.
`requested_on` is the delivery date to ask the vendor for: when we need it, but
never sooner than the lead time allows.

### A worked example

`PT-0021` in `replenishment.test.ts`: family `pipe`, 18 on hand, item lead time
`3W`, safety stock 5, reorder point 20, cost $12, and 91 units sold on
2026-08-01 with today pinned to 2026-09-17.

| Step | Working | Result |
|---|---|---|
| 90 day rate | 91 / 90 | 1.0111 a day |
| 365 day rate | 91 / 365 | 0.2493 a day |
| `per_day` | the higher of the two | 1.0111 |
| `per_week` | 1.0111 x 7 | 7.1 a week |
| `lead_time_days` | `3W` | 21 |
| `horizon_on` | 2026-09-17 + 21 | 2026-10-08 |
| `projected_available` | 18 + 0 - 0 | 18 |
| usage target | 5 + ceil(1.0111 x (21 + 30)) = 5 + 52 | 57 |
| `target_qty` | greatest(20, 57) | 57 |
| `raw_need` | 57 - 18 - 0 | 39 |
| `pack` | family `pipe` | 5 |
| `suggested_qty` | 39 rounded up to a multiple of 5 | 40 |
| `suggested_cost` | 40 x $12 | $480.00 |

And the sentence the desk actually reads, from
`nl.replenishment_reason(...)`, for the same part with 9 promised:

```
18 on hand, 2.1 a week, 21 day lead time, 9 already promised, 30 day cover
```

Parts that would say nothing are left out, so a part with nothing promised and
nothing on order gets a shorter sentence rather than two zeroes, and a part
that has not sold says `no sales in a year` instead of `0.0 a week`.

## The signals

`nl.procurement_signals` is the log of what woke the desk, and
`nl.sweep_procurement_signals(request_id, via)` fills it.

| Signal | Subject | Raised when |
|---|---|---|
| `below_reorder_point` | item number | the part `needs_buying` |
| `purchase_order_late` | `source:document:line` | a promised date has passed, or moved out since it was first given |
| `vendor_cost_moved` | `item:effective_from` | a cost revision inside `nl.signal_window_days()` (30), bigger than `nl.cost_move_threshold()` (5%), from a `vendor quote` or a `purchase receipt` |
| `demand_jumped` | item number | the part is short AND an open sales line or a commitment turned up inside the window |
| `no_vendor` | item number | a bought-in part with no vendor on its item card, that sells or has open orders |
| `no_cost` | item number | a part with no cost on the card and none in the history, that sells or has open orders |
| `under_vendor_minimum` | vendor number | that vendor's short parts do not reach its minimum order or its free-freight threshold |

Three of these deserve a sentence of their own.

`vendor_cost_moved` leaves out `standard revision` rows. 0018's cost timeline
also carries our own standard rollups, which are an accounting exercise and not
a price somebody moved on us. Before that filter the sweep raised 75 signals on
the small world; after it, a handful. The threshold moved for the same reason:
at 3% the demo world (2,716 parts) raised 100 of these in thirty days, which
nobody would read. At 5%, which is about what a buyer would re-quote over, it
raises 56.

`demand_jumped` overlaps `below_reorder_point` on purpose. Being under the
reorder point is a standing fact about a part; a new order or a new commitment
arriving and finding it short is an event, and the two want different answers:
buy more, versus go and tell the account manager what is actually possible.
`nl.procurement_new_demand` deliberately answers only "who newly asked for
this", with nothing about whether we can cover it, so the sweep can join it to
the one read it already has instead of making a second one.

`under_vendor_minimum` is one signal per vendor and not one per part, because
the answer is to group that vendor's short parts into one order. That grouping
is what the buying list and the draft both do.

### Once per subject, and why that is a feature

`unique (signal, subject)` on the table. Whoever runs the sweep, however often,
a subject is recorded once and never again. This is the same discipline the
automation rules took in 0013 (`unique (rule_id, subject_key)`), and for the
same reason: a guarantee the runner's memory cannot give you, because it is the
database that holds it.

"Once per subject, ever" makes this a log of the first time somebody was told,
not a queue that nags. What needs buying **today** comes from
`nl.part_replenishment`, which is derived on every read and is always current.
The sweep sets `cleared_at` once a signal's condition has passed, so the log
says what happened as well as what was noticed, and a signal that clears is not
raised again.

The sweep is the one write function in this file with no row version, because
it changes no existing record: it inserts signals that are not there and clears
ones whose condition has passed. The unique key is the concurrency control, and
for "once per subject" it is stronger than a version check: two sweeps racing
each other cannot both insert, whatever each one read first.

## Purchase requests, and the approval path

```
nl.part_replenishment  ->  draft  ->  a person edits  ->  approved
   (derived, always         (nl.purchase_requests)         (nl.procurement_orders
    current)                                                + a vendor email draft)
```

`nl.draft_purchase_requests(vendor_no, request_id, via)` makes one draft per
vendor: the lines, the quantities from the suggestion, the prices from the cost
timeline (0018), a `requested_on` per line worked back from when the stock runs
out, the vendor's payment terms, and a freight note in the vendor's own words
with this order's position against the threshold in them:

```
Prepaid over $1,500 (this order is $930.00 under the free-freight threshold)
```

A vendor that already has an open draft is skipped, which a partial unique
index (`purchase_requests_one_open_idx`) enforces as well as the function's own
`having not exists`. Parts with no vendor or no cost are left out and counted in
the result, because they need a person to fix the item card and a signal has
already said so.

Headers and lines are written by **one** statement, with the view read into a
materialized CTE and the header insert's `RETURNING` feeding the line insert.
`nl.part_replenishment` is the most expensive read in this file, and this way a
draft run evaluates it once.

`nl.set_purchase_request_line(...)` changes a quantity or a date. The lock is
the request's own `updated_at`, so two people editing one draft from stale pages
cannot both win. The line keeps `suggested_qty` (what the maths said) and gains
`edited = true`, so the draft shows what was the machine's idea and what was a
person's.

`nl.approve_purchase_request(...)` is the only thing on the page that commits
money, and it is the strictest write in the file:

1. operations or an admin, nobody else (`NL403`);
2. the draft's own row version has to match the page's (`NL409`);
3. the request id is claimed first, so a double submit returns the first result;
4. a line with no cost is refused (`NL422`) rather than ordered at nothing;
5. one purchase order in `nl.procurement_orders` and its lines, with
   `original_promised_on` kept so a later slip is visible without a history
   table;
6. the order is mirrored into the supply forecast's own table when that exists;
7. an audit row naming the order it created.

The vendor email is **not** queued by that function. It is built and checked in
TypeScript (`app/src/lib/server/procurement/requests.ts`), inside the same
transaction, and `nl.queue_purchase_request_draft(...)` stores it afterwards. So
a disclosure refusal rolls the approval back with it, and there is no state in
which an order exists and its email was quietly dropped.
`requests.test.ts > approving > takes the order back down with it when the email
would say too much` proves that: no order, no draft, and the request still a
draft.

## What a vendor may hear

A vendor **may** hear the parts, the quantities, the dates, the price **we pay
them**, our payment and freight terms with them, and our own name, purchase
order number and contact details.

A vendor may **never** hear:

- the name of any customer of ours,
- what we sell the part for, or any customer's price,
- our margin on anything,
- another vendor's prices, or another vendor's name.

The reasoning is commercial rather than legal. A vendor who knows which customer
the parts are for can go round us. A vendor who knows our selling price knows
our margin and will ask for a share of it. A vendor who sees a competitor's
quote learns exactly what it has to beat, which is worth more to it than it is
to us.

### Where it is enforced

Two places, and both matter.

**First, the email is built from a structure that has nothing to leak.**
`app/src/lib/server/procurement/email.ts` takes a `VendorEmailInput` whose only
money field is `unitCost`, the price we pay. There is no field on it for a
customer, a selling price or a margin, so no amount of editing the template can
let one out.

**Second, the finished text is scanned.**
`app/src/lib/server/procurement/disclosure.ts` `assertVendorSafe(text, context)`
runs in `outbox.ts` before anything is written. The context is gathered from the
database for **these** parts in `requests.ts`: the accounts with open orders or
open commitments for them, what those accounts pay (`nl.price_for`, 0018), our
margin at that price, and what any other vendor charges us for the same part.
That is the set a leak would come from, and it is small enough to scan the text
against on every approval. Subject and body are both scanned, because a subject
line is the easiest place to put a customer's name without thinking.

The scan has to tell a leak from an ordinary number, because the email is
supposed to contain quantities and the prices we pay. So:

- a **dollar amount** counts when it has a dollar sign in front of it, or when
  it is written with two decimal places, which is how money is written and how
  a quantity never is. A plain `40` is a quantity, not a price;
- a **margin** counts next to a per cent sign or the word "percent", or as a
  decimal ratio like `0.64`;
- a **name** is matched on whole words after folding case, curly quotes,
  punctuation and thousands separators, and again with the company ending
  (`Inc`, `LLC`, `Co`) taken off, so leaving off the suffix is not a way past
  it;
- some **phrases** are refused whatever number is next to them: `margin`,
  `markup`, `gross profit`, `selling price`, `sell price`, `resale`,
  `list price`, `customer price`, `quoted us`.

A refusal is an `NL422` naming every problem it found, so the page can show all
of them at once rather than one per attempt.

## The migrations that were being written at the same time

This desk was written alongside the supply forecast (0016) and the order desk's
mail agent (0021), on separate branches, so nothing in it depends on either
existing. Both are detected at RUN time, never at creation time, and
`nl.procurement_sources()` reports what was found so a page can say which
numbers it is working from:

```
{ "open_purchase_lines": …, "production_orders": …,
  "available_to_promise": …, "mail_drafts": … }
```

0016 landed on `main` while this branch was being written, so the two
detections it covers were checked against the real migration, and the
`nl.lead_time_days` collision it caused was found the same way (see above).
0021 had not landed, so the mail-queue mirror in `outbox.ts` is still working
from a guess at that migration's shape, and it is written to cost nothing when
the guess is wrong.

### Incoming supply

`nl.incoming_supply()` returns `(source, document_no, line_no, item_no,
quantity, due_on)` from whichever sources exist:

| `source` | Where from |
|---|---|
| `desk` | an order this desk raised and the vendor has not shipped yet |
| `purchase` | `nl.open_purchase_lines`, once 0016 has landed |
| `production` | `nl.open_production_orders`, likewise |
| `stock` | `nl.stock.on_purchase_order` and `on_production_order`, for whichever of those two the ERP's own tables could not answer |

It is a set-returning function and not a view, because a view's body has to
name tables that exist when the view is created. It reads 0016's two tables by
whichever of several candidate column names they turn out to have
(`nl.first_column`, and `nl.date_expression` for the date term), rather than
betting on one spelling, and falls through to the item master for either one
it cannot read. `nl.part_replenishment` materializes the whole result once and
joins to it, rather than calling it per part, because the planner cannot push
a single-part filter into a function.

The candidate lists put 0016's real column names first, checked against the
migration itself:

| Field | 0016's name |
|---|---|
| purchase quantity | `quantity` |
| purchase date | `coalesce(promised_date, due_date)`: the vendor's own promise, then the order's due date, because 0016 lets the promise be null |
| purchase key | `document_no`, `line_no` |
| production quantity | `quantity` |
| production date | `due_date` |
| production key | `order_no`, and no line number |

An order mirrored into 0016's table is skipped by the `desk` branch, so a
mirrored order is counted once and not twice.

### The mail queue

`app/src/lib/server/procurement/outbox.ts` is the adapter, and it is the only
place that has to change when 0021 lands.

- `nl.purchase_request_drafts` (this desk's own table) **always** gets the
  draft. It is the record, and `/procurement` reads it.
- When `nl.mail_drafts` exists and has the columns named in
  `MAIL_DRAFT_COLUMNS`, the same draft is mirrored into it and the id it came
  back with is stored on our row as `mail_draft_id`.

The table's shape is checked with `nl.first_column` **before** anything is
attempted, not after, because a failed statement would abort the transaction. A
mirror that does not fit costs a missing convenience, never a lost order.

**To join the two up:** make `MAIL_DRAFT_COLUMNS` in `outbox.ts` match 0021's
real column names. Nothing else in the desk, and no data already written, has to
move.

## The page

`/procurement`, four panels, in the order the work happens.

1. **What needs buying**, grouped by vendor, worst first (open lines that
   cannot ship, then money). Each group says what it adds up to, what it puts
   at risk, and whether it clears that vendor's minimum order and free-freight
   threshold. Each row says why it is there, in words.

   Parts with no vendor get their own groups, last, because nothing on this
   page can act on them until somebody else has acted. There are **two** kinds
   and they are not the same problem, which is why they are two groups:

   - *Made here, no vendor needed*: we make these, so they are short of a
     production order and were never going to have a vendor. A part we make
     can still have a vendor for an outside operation like plating, and those
     sit in that vendor's group like anything else.
   - *Bought in, but no vendor on the item card*: these are bought and there is
     nobody to buy them from, or no cost to buy them at. The item card needs
     fixing, and a signal has already said so.

   The first version put both in one group headed "No vendor on the item card",
   which told an operations lead that 37 parts they make in the next bay were a
   data-quality problem. Keeping them apart is the difference between a
   scheduling job and a job for whoever keeps the item master.
2. **Suggested orders**: the drafts, with every quantity and date editable, and
   one button that approves.
3. **Vendor emails**: what is waiting for a person. Nothing here has been sent
   and this app cannot send it.
4. **Signals**: the log, with a filter for what is still open and a button to
   look for anything new.

Buttons only for operations and admins. An account manager sees exactly the same
figures and no controls, which
`requests.test.ts > the desk the page reads > reads the same for an account
manager` checks.

The page streams: `load` returns `getProcurementDesk(...)` **without** awaiting
it, and `+page.svelte` shows `<DeskSkeleton />` inside `{#await}`. The buying
list reads the whole catalog, so the skeleton is on screen for a moment on every
load and not only on a slow connection.

## The seed

`db/seed.d/80_procurement.sql`, which runs after the base world and after
`50_cost_and_pricing`. Migration 0022 derives everything from the catalog, the
ledger and the item card, so a world where every part happened to be well
stocked would render an empty page and prove nothing. The seed therefore shapes
the world so all seven signals have a real subject:

| Step | What it does |
|---|---|
| 1 | a reorder policy where 0015 left one out (it only sets a policy for parts selling at least a dozen a year) |
| 2 | a handful of parts pushed under their policy, by taking stock off the shelf rather than raising the reorder point, which is how it happens in life |
| 3 | one vendor with three cheap parts emptied and a minimum order twice what they add up to, plus $500 |
| 4 | one bought-in part with its vendor cleared |
| 5 | one part with its cost and its cost history cleared |
| 6 | a few cost revisions dated inside the signal window, from a `vendor quote`, with the item card moved to match (0018's own rule: the newest revision is the current cost) |
| 7 | a commitment written this month for a part that cannot cover it |
| 8 | one desk purchase order whose promised date has passed and which the vendor already moved once |

Counts scale with `nl_seed.settings.scale` and never drop below two, so the
small world used by the tests still has a list. Every draw is keyed
(`nl_seed.u`, `nl_seed.ri`), so Supabase and PGlite build the same world.

### Steps 1 to 4 stand aside when the supply forecast is here

`db/seed.d/40_supply.sql` runs before this file, and its own comment says what
it does: it plans the supply in its sample export files **against demand**,
which reads the reorder policy and nets against stock on hand, and then stores
each file's fingerprint so that re-uploading it says "already loaded" instead
of loading it twice.

So anything that fills in a reorder policy, or takes stock off a shelf, after
40_supply has stamped those fingerprints changes what the same generator would
now produce, and the stamps stop matching. Measured on a small world: filling
in the reorder policy alone took the sample production orders from 42 lines to
68 and failed two of 0016's own tests.

The four steps that shape the world therefore run only when
`nl.open_production_orders` is not there. On a world with the forecast, its
own reorder-point-aware planning already leaves the desk plenty to look at,
and this file keeps its hands off the item master and the stock. Steps 5 to 8
(the part with no cost, the cost revisions, the commitment, the late purchase
order) run either way, because none of them touches an input those generators
read.

That is a workaround, not the right answer. The policy fill belongs **before**
anything that plans against it, which means a `seed.d` file numbered below 40
or a few more lines in `20_catalog_depth.sql`. The alternative is for
40_supply to stamp its fingerprints at the end of `nl_seed.finish_build()`,
after every extra has run, which would make it immune to this and to the next
file that shapes the world. Either is a better home for it than a guard here.

Step 8 needs a word. Before 0016 lands, the ERP's own purchase orders are only a
quantity on the item card with no date on it, so a late purchase order can only
come from an order this desk raised. One is seeded for that reason. Once 0016 is
here, `nl.procurement_late_supply` reads its dated lines too and the seeded one
stops being the only case.

## The tests

`npx vitest run src/lib/server/procurement --maxWorkers=2`, 76 tests in four
files, on PGlite with today pinned to 2026-09-17.

| Guarantee | Where |
|---|---|
| The maths, against hand-computed examples | `replenishment.test.ts > the suggestion > covers the lead time plus the target cover...` |
| `nl.lead_time_days` on every formula shape, and on rubbish | `replenishment.test.ts > nl.lead_time_days reads an ERP date formula` (4 tests, including 11 kinds of rubbish) |
| Lead time falls back item, then vendor, then house default | `... > falls back from the item to the vendor to the house default` |
| Two usage windows, and the higher rate wins | `replenishment.test.ts > usage is measured over two windows` |
| Demand shape, with empty months counted | `... > calls demand steady, lumpy or erratic` |
| A suggestion never double-counts what is on order | `replenishment.test.ts > the suggestion > never counts what is already on order twice`, and `... does not count supply arriving after the horizon` |
| The reason sentence | `... > writes the reason out in words` |
| Pack sizes and rounding up | `replenishment.test.ts > pack sizes` |
| Each signal fires, on a fresh world | `signals.test.ts > the seed leaves something for every signal` |
| Each signal fires once per subject | `signals.test.ts > a signal fires at most once per subject` (3 tests, one of them writing straight to the table as the owner) |
| Approval creates the purchase order and the email draft | `requests.test.ts > approving > raises the purchase order, its lines, and queues the vendor email` |
| And clears the part off the buying list | `... > clears the part off the buying list` |
| The vendor policy refuses margins, selling prices and another vendor's prices | `disclosure.test.ts > a vendor never hears` (9 tests) |
| And is not tripped up by a quantity that looks like a price | `disclosure.test.ts > ... is not tripped up by a quantity that happens to look like a price` |
| A disclosure refusal rolls the approval back | `requests.test.ts > approving > takes the order back down with it when the email would say too much` |
| An account manager cannot sweep, draft, edit or approve (403) | one test in each of those four describes |
| A stale row version is refused (409) | `requests.test.ts > editing a line > refuses an edit made from a stale page`, and `... > approving > refuses an approval made from a stale page` |
| A repeated request id writes once | `requests.test.ts > approving > approves once when the same form arrives twice` (one order, one draft, one audit row), and `signals.test.ts > a repeated request` |
| Every write leaves an audit row | `signals.test.ts > every sweep leaves an audit row`, and `requests.test.ts > approving > leaves an audit row naming the order it created` |

## What it costs to read

`nl.part_replenishment` is the expensive thing here: it touches the whole
catalog, a year of the invoice ledger, the open order lines, the cost timeline
and every incoming supply row. Measured on the demo world (700 customers,
2,716 parts, three years, about 28,000 invoice lines) in PGlite:

| | First version | Now |
|---|---|---|
| one read of `nl.part_replenishment` | 1,343 ms | 515 ms |
| the whole `/procurement` page's data | 4,320 ms | 757 ms |
| `nl.sweep_procurement_signals` | 8,785 ms | 1,320 ms |

Three changes got that, and each is worth knowing about because the same
mistake is easy to make again.

**`nl.part_usage` is set-based, not per part.** The first version ran two
lateral subqueries for every part, one of them a `generate_series` of twelve
months to supply the months that sold nothing: 5,432 small queries. It now
makes one grouped pass over the year's lines for the whole catalog. The empty
months need no rows at all, because with twelve as a fixed divisor the
population standard deviation comes straight out of two sums, and a month that
sold nothing adds nothing to either.

The trade-off: a query for ONE part now reads the year's lines for every part.
Nothing here asks it that. A single-part caller should read `nl.part_summary`
(0015), which is built the other way round.

**The page reads the view once.** The list is capped at 200 rows but the
figures are for the whole list, which used to mean two reads. Now one
materialized CTE feeds both, and the totals ride along on every row.

**The sweep reads the view once.** Five of the seven signals want something
from it. It goes into a temp table (`pg_temp.swept`) and every signal works
from that, including the step that clears signals whose condition has passed.

On the full world (about 11,400 parts and 500,000 invoice lines, of which a
year is roughly 70,000) the grouped scan grows with the year of lines rather
than with the history, so expect two to three times these figures, not
eighteen. That has not been measured: `explain (analyze, buffers)` on the full
world is a job for whoever applies this to Supabase, and it is the one check
`db/README.md` asks for that this branch could not do.

## Things left for later

- **Receiving.** `nl.procurement_order_lines.received_qty` exists and
  `nl.incoming_supply()` reads it, but nothing writes it yet. Warehouse receipts
  live in 0019.
- **A nightly sweep.** `nl.sweep_procurement_signals` is built to be called by a
  job (it accepts `via = 'automation'`), but it is only wired to the button.
  `routes/api/cron/automations/+server.ts` is the pattern to copy.
- **Dismissing a draft.** `nl.purchase_requests.status` allows `dismissed` and
  nothing sets it, so a draft the desk does not want has to be approved or left.
- **Late supply from the ERP.** `nl.procurement_late_supply` reads whatever
  `nl.incoming_supply()` found, so it picks up 0016's dated purchase lines for
  free, but only the desk's own orders carry `original_promised_on`, so only
  those can show a slip as well as a delay.
