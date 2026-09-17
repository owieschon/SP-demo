# The late-order forecast

One question, answered in SQL: **which customer orders will ship late, by how
many days, because of which incoming supply order, and who do we call?**

Migration 0010 brought in the ERP's open sales lines every morning and handed
on-hand stock to the oldest ship date first. That answers "is there stock for
it today". Migration 0016 adds the other side of the book, the same way, and
turns the pair into a date per line.

```
open_sales_lines        what customers are waiting for   (0010)
open_purchase_lines     what vendors owe us              (0016)
open_production_orders  what the shop floor owes us      (0016)
```

Everything below is derived on read. Nothing about a projection is stored, so
it cannot go stale: a new export, a receipt, a changed due date or simply a
new day changes every answer at once.

## How the data arrives

The ERP can only produce file exports, so all three reports come in the same
way (workflow D, `docs/walkthrough.md`):

1. **One profile per report.** A profile
   (`app/src/lib/server/exports/profile.ts`) is plain data: which headers mean
   which field, which are required, what kind of value each holds, which
   fields are the natural key, how dates and numbers are written. The reader
   (`reader.ts`) knows nothing about any particular report. A fourth report
   later is a fourth profile, not new parser code.
2. **The reader works out which report a file is** (`detectReport`). A profile
   is a candidate when every column it needs is there; a file that is none of
   the three is refused, named against the profile it is closest to, with a
   guess at what it actually is ("this looks like a customer list"). The sales
   and purchase exports share four column names (`Document No.`, `Line No.`,
   `No.`, `Outstanding Quantity`), and the vendor column and the receipt date
   are what tell them apart.
3. **Staging and holds are per report.** `nl.stage_export(..., p_kind)` stores
   the file as a snapshot of its kind and holds it when it looks wrong:
   far fewer rows than the live file **of the same kind** (`partial`), every
   date already past (`stale`), or rows that failed a check (`row_errors`).
   A short purchase file is measured against the last purchase file, never
   against the sales one.
4. **Applying is per report too.** `nl.decide_export` upserts the snapshot's
   rows into the live table of its kind on the ERP's natural key
   (`document_no, line_no` for both line reports, `order_no` for production
   orders), deletes what is no longer in the file, and never moves
   `first_seen_on`. One snapshot per kind is `is_current` at a time.
5. **Day over day** reads the two most recent applied snapshots of a kind:
   `nl.open_line_changes` for sales (new, shipped, newly short) and
   `nl.supply_changes` for both supply reports (`new`, `received`,
   `due_later`, `due_sooner`, with `days_moved`). A due date that moved out is
   the interesting one: it is where a late order usually starts.

A fresh world already has two mornings of all three reports applied
(`db/seed.d/40_supply.sql`), so the forecast has history the moment the app
starts, and today's three files are what the demo uploads. The seed stores the
same fingerprint the reader computes in JavaScript, which is why uploading
yesterday's sample file says "this data was already loaded" instead of loading
it twice. The sample rows come from the database
(`nl.sample_open_sales_lines`, `nl.sample_open_purchase_lines`,
`nl.sample_open_production_orders`), so the seed and the download links can
never disagree.

## The projection

`nl.open_line_projection`: one row per open sales line. Time-phased netting,
per part.

**Demand.** Open sales lines in ship-date order (then document, then line).
`demand_through` is a running sum of quantity: everything this line and the
lines before it ask for.

```sql
sum(l.quantity) over (partition by l.item_no
                      order by l.ship_date, l.document_no, l.line_no
                      rows unbounded preceding) as demand_through
```

**Supply.** On hand at today, then every open purchase line and production
order at its due date. A supply order whose due date has passed is late but
still coming, so it counts `nl.overdue_supply_days()` (three) days from today
and is flagged rather than pretended to have landed. `covers_from` and
`covers_to` are the running sum before and after each event, so the events cut
a part's supply into ranges: (0, 20], (20, 45], (45, 70] ...

```sql
sum(s.quantity) over w - s.quantity as covers_from,
sum(s.quantity) over w              as covers_to
window w as (partition by s.item_no
             order by s.available_on, s.ord, s.document_no nulls first
             rows unbounded preceding)
```

**The join.** A line's availability date is the date of the one supply event
whose range contains its `demand_through`:

```sql
left join events e
  on e.item_no = d.item_no
 and d.demand_through >  e.covers_from
 and d.demand_through <= e.covers_to
```

The ranges partition (0, total], so at most one event can match, and a line
asking for more than the part's whole supply matches none. That is what
`no_supply` means: somebody has to buy or make it.

Then:

```
projected ship date = greatest(promised ship date, availability date)
days late           = projected ship date - promised ship date
```

A line does not ship early, and a line whose parts are there before the
promise is simply on time.

### Status, exactly one per line

Checked in this order:

| Rule | Status | What it means |
|---|---|---|
| The promised date has already passed | `past_due` | `covered_now` says whether the stock is on the shelf right now |
| Nothing on hand or on order reaches the line | `no_supply` | the earliest date is today plus the part's lead time |
| The parts are there by the promised date | `on_time` | nothing to do |
| The covering supply order is itself past due | `late_supply_overdue` | chase the vendor or the work center |
| The covering supply order lands after the date | `late_waiting_supply` | tell the customer the new date |

The view also names the supply order that decides the line: `supply_source`
(`stock`, `purchase`, `production`), `supply_document`, `supply_vendor_no`,
`supply_work_center`, `supply_due_date`, `supply_overdue`. That is what turns
a number into a sentence on the page: "waiting on PO-104471 from Beacon
Plating, due Oct 3", "made on WC-120, order MO-200231 due Sep 30", "nothing on
order; earliest if ordered today is Oct 8".

A test proves the partition (every line has exactly one status, no negative
delay, no projected date before its promise) over the whole world, and
another checks the arithmetic against a hand-computed example with one part,
two purchase orders and four lines, including the line that partial coverage
leaves out (`app/src/lib/server/supply/projection.test.ts`).

### Lead times

The item and vendor cards carry the ERP's date formulas verbatim: `3W`,
`10D`, `2M`. `nl.lead_time_days(text)` reads them and returns null for
anything else, so the caller can fall back. `nl.item_lead_days(item)` is the
fallback chain: the item card, then its vendor's card, then
`nl.default_lead_days(replenishment)` (28 days bought, 14 made, 7 assembled).
A `no_supply` line is projected on today plus that figure, which is the honest
answer to "when could we ship it if we ordered it now".

## Who to call

Four aggregates over the projection, each one a group by:

| View | One row per | For |
|---|---|---|
| `nl.forecast_by_vendor` | vendor | a buyer's call sheet: late purchase orders, how many are past due, and the customer dollars waiting on each vendor |
| `nl.forecast_by_work_center` | work center | the production backlog |
| `nl.forecast_by_customer` | customer | who to call, and who owns the account |
| `nl.promise_moves` | open sales line whose ship date changed | measured across applied snapshots, not logged |

A row counts as late when `days_late > 0`, so a past-due line whose stock is
already on the shelf (it ships today) does not put a vendor on the call sheet.

`nl.promise_moves` is the one that reads history rather than the live tables:
it walks `nl.export_snapshot_lines` for the applied sales snapshots with
`lag(ship_date) over (partition by document_no, line_no order by snapshot_id)`
and counts the changes. The vendor call sheet joins `nl.vendor_contacts` when
that table exists (the app asks `to_regclass` first) and leaves the column out
when it does not.

## Can we ship it?

`nl.available_to_promise(item_no, quantity, needed_by)` is the same netting
asked forwards, for the order desk: what is on hand, how much of it earlier
open lines have already been promised (the lines due on or before that date),
what is coming in when, whether the quantity can be there by the date, the
earliest date it can, and which supply order decides it. It returns JSON, so
the page shows one answer and the whole incoming list.

```sql
select nl.available_to_promise('L3515-630SC', 25, '2026-10-15');
```

## Indexes

| Index | Why |
|---|---|
| `open_order_lines_allocation_idx (item_no, ship_date, document_no, line_no) include (quantity)` | 0010's index is exactly the demand window's order, and carries what it sums |
| `open_purchase_lines_supply_idx (item_no, due_date, document_no, line_no) include (quantity)` | the same for the purchase side of the supply walk, and the lookup `nl.available_to_promise` makes for one part |
| `open_production_orders_supply_idx (item_no, due_date, order_no) include (quantity)` | the same for production orders |
| `open_purchase_lines_vendor_idx`, `open_production_orders_wc_idx` | the vendor filter on the table itself (the call sheet groups the projection, which reads every line anyway) |
| `export_snapshot_purchase_lines_item_idx`, `..._vendor_idx`, `export_snapshot_production_orders_item_idx` | the review panel and the day-over-day views |

The primary keys of `nl.stock`, `nl.items`, `nl.vendors` and `nl.customers`
carry the rest of the joins.

## Numbers

The other measurements in `docs/sql.md` were taken on Supabase. These were
taken on PGlite (Postgres 17 in WebAssembly, the local and test database),
because that is what this machine can run: the small world, then synthetic
rows up to the shapes of the full world. PGlite is several times slower than
the Supabase instance, especially at sequential scans, so read these as an
upper bound.

Volumes: 11,505 items, 11,505 stock rows, 1,528 open sales lines, 714 open
purchase lines, 410 open production orders, 90 customers.

| Query | Best of three (wall) |
|---|---|
| `select * from nl.open_line_projection` (every line) | 144 ms |
| The page's own table: late lines, worst first, 150 at most | 58 ms |
| `nl.forecast_by_vendor` | 24 ms |
| `nl.forecast_by_work_center` | 18 ms |
| `nl.forecast_by_customer` | 66 ms |
| `nl.promise_moves` | 2 ms |
| `nl.supply_changes` | 2 ms |
| `nl.available_to_promise` for one part | 4 ms |

On the small world the tests run against (128 open lines, 64 purchase lines,
80 production orders) the whole projection is about 8 ms.

What the plan shows at the bigger size, and what it says about the design:

- The demand side is a sort of 1,528 rows and one window (about 8 ms). The
  running sum reads the allocation index's order.
- The supply side is three branches appended, then one window (about 45 ms of
  the total, most of it the sequential scan over 11,505 stock rows). Only the
  parts somebody is waiting for are read: a `wanted` CTE of the distinct item
  numbers on open lines drives every branch. On Supabase, where an index scan
  is cheap relative to a sequential scan, the planner uses the stock primary
  key for those 1,456 lookups instead.
- The range join comes out as a merge join on `item_no` with the two
  cumulative-sum conditions as a filter (681 rows removed), which is the
  shape to want: per part it compares a handful of lines with a handful of
  supply events, not lines with lines.
- The join to `nl.items` and `nl.vendors` for the lead time is a hash of the
  item master (about 25 ms here, a few ms on Supabase). Computing it only for
  the lines that need it (a scalar subquery per uncovered line) was measured
  and was slower on PGlite, so the plain join stayed.

What would come next, in this order:

1. The page runs one query per panel, each one recomputing the projection.
   Six queries of 20 to 65 ms is comfortable, but a single query with the
   projection in a CTE and the panels as grouping sets would do the netting
   once.
2. At ten times the open order book, store the projection the way
   `nl.commitment_delivery` stores delivered figures (`DECISIONS.md` 12):
   triggers on the three live tables and on `nl.stock` re-measure only the
   parts a change can touch. The rule stays "status is derived", because
   status depends on today's date; only the availability date would be stored.
3. `nl.promise_moves` walks every applied snapshot's lines. After a year of
   daily exports that is a few hundred thousand rows; it would want an index
   on `(document_no, line_no, snapshot_id)` or a small table of moves written
   at apply time.

## Reproducing

On Supabase, as the app's role:

```sql
begin;
set local role nl_app;
select set_config('nl.user_id', '1', true);
explain (analyze, buffers)
select * from nl.open_line_projection;
rollback;
```

The page's queries are in `app/src/lib/server/supply/forecast.ts`
(`getForecast`). The bench above is the small world plus synthetic rows; the
script is not committed, because the load test that belongs in the repository
is `db/bench/scale.sql`.

Checks worth running after a change:

```sql
-- every line has exactly one status, no negative delay
select status, count(*) from nl.open_line_projection group by 1;
select count(*) from nl.open_line_projection where days_late < 0;

-- the supply the seed generates matches the item master, part by part
select count(*)
from nl.stock s
left join (select item_no, sum(quantity) as q
           from nl.sample_open_purchase_lines(nl.today()) group by 1) p on p.item_no = s.item_no
where s.on_purchase_order > 0 and coalesce(p.q, 0) <> s.on_purchase_order;
```
