# What a part is made of, what it costs and how long it takes

Until migration 0031 the item master said three words about how a part is
replenished (`Prod. Order`, `Purchase`, `Assembly`), carried one cost number
and one lead-time formula, and that was the whole manufacturing model. A buyer
could not ask what a part is made of. A quote could not say why a part costs
what it costs. A promise date for something we make was a guess with a formula
on it.

Four migrations and two seed files change that:

| File | What it adds |
|---|---|
| `db/migrations/0031_manufacturing.sql` | units, SKUs, item kinds and material attributes, bills of material, routings, work centres, labour classes and loaded rates, capital assets and derived machine hour rates, overhead pools, sourcing, planning policy, the derived supply shape |
| `db/migrations/0032_cost_rollup.sql` | the two stored roll-ups, the triggers that keep them current, the drift check, the breakdown, where-used, `nl.item_truth` |
| `db/migrations/0033_traceability.sql` | certificate kinds, documents, lots with heat numbers, genealogy both ways, qualifications, calibration, document requirements, the shipment gate |
| `db/migrations/0034_capacity_and_shortages.sql` | work centre load in hours, shortage explosion |
| `db/seed.d/95_manufacturing.sql` | the material master and a parts list and routing for every part the plant makes |
| `db/seed.d/96_traceability.sql` | mill certificates, the genealogy, approved sources, and one shipment that cannot go out |

Screens are at `/manufacturing`, `/manufacturing/parts/<item>` and
`/manufacturing/lots/<lot>`.

---

## The four decisions worth arguing about

### 1. Make, buy and assemble is not a field

A part is not "a make part" or "a buy part". One part can be bought under
twenty-five pieces, made above twenty-five, and plated outside either way. Put
one word on the item card and you have to choose which truth to write down.

So the verb is not stored. Two things replace it:

- **`nl.item_supply_shape`** derives a shape from what the part actually has.
  A parts list and a fabrication step means **manufactured**. A parts list with
  only assembly and packing steps means **assembled**, or **kitted** for a kit.
  A fabrication step and no parts list means **processed**: something was done
  to material we did not buy finished, such as plating a bought elbow. Neither
  means **purchased**. It also writes a sentence a person can read:

  > Manufactured from 1 bought part, 2 packaging items through 4 steps at BEND
  > CELL, CUT CELL, INSPECT, PACK and 1 outside step.

- **`nl.item_sources`** is the list of ways a part can be got, each row with its
  own quantity band, party, cost basis and lead time. Two rows are not a
  contradiction: they are how "buy it in twos, make it in fifties" gets written
  down. About one made elbow and stack in three in the seeded world has both.

Assembly and packing are steps too, so "has a routing" is not the test that
separates making from assembling. What separates them is whether metal is cut,
bent, welded, polished or sent out. A kit that is picked, boxed and labelled has
a routing and is still a kit.

**`nl.items.replenishment` stays exactly as the ERP exports it.** That field is
what we import and what other code reads. Where the derived shape disagrees with
the ERP's word, the part page says so plainly rather than overwriting it. In the
seeded world exactly two kinds of disagreement exist, both deliberate, and a
test asserts there are no others:

| Derived shape | ERP says | Why |
|---|---|---|
| processed | Purchase | chrome parts and mill-length raw stock we buy plain and finish here |
| manufactured | Assembly | custom parts the ERP calls an assembly that the floor welds from tube |

The orthogonal flags stay separate, because each answers a different question:
`made_to_order` (the ERP's own), `configured_to_order`, `phantom`,
`consignment`, `customer_supplied`, `drop_shipped`, `non_stock`, `service_only`.
Lot-sizing and planning rules live in `nl.item_planning`, not in the label.

### 2. The roll-ups are kept current, not recomputed

True cost and true lead time have to be knowable at an instant, because the desk
agent and the assistant call them in the middle of writing a reply to a
customer. A roll-up is a recursive walk down a tree, and a recursive walk is the
one shape the planner is worst at estimating: `docs/sql.md` records a recursive
view over the customer family taking 10,963 ms because the planner guessed 1.4
million rows where 6,488 came back. At 11,400 parts that is not a tuning
problem, it is the wrong design.

So the answer is stored and kept current:

- `nl.item_cost_rolled`: one row per part, nine cost elements twice (what this
  level costs and what it costs with everything below it), the depth, and the
  item card's cost for comparison.
- `nl.item_lead_rolled`: one row per part, its own days, the critical path
  through everything below it, and that path in words.

Statement-level triggers on the ten things that can change either figure
re-measure exactly the parts affected **and every part above them in the tree**,
found through `nl.item_parents()`. The ten: a bill-of-material line, a routing
operation, an item card's cost or lead time or vendor, a cost revision, a work
centre, a labour rate, a machine, the capital behind a machine, an overhead
pool, a vendor's lead time.

**This is the house style, not a new idea.** `nl.commitment_delivery`
(migration 0008) keeps delivered value current exactly this way, for exactly
this reason, and `nl.delivery_drift()` proves it. `nl.warehouse_drift()` (0019)
proves the same thing for stock. A stored figure is only trustworthy if
something independently recomputes it and complains.

Where this differs from 0008: delivered value has a cheap independent
formulation (a plain sum over an index), so its drift check compares two
genuinely different code paths. A rolled cost has no cheap second formulation,
because bottom-up is the only way to compute it. So `nl.rollup_drift()`
recomputes every part from scratch through the same arithmetic and reports what
moved. That catches the real risk, a trigger that did not fire. It does not
catch a mistake in the arithmetic, which is what the hand-computed tests are
for.

The measuring itself is set-based. The working set is sorted into passes, where
pass 0 is the parts with nothing left to wait for and each later pass is the
parts whose children are all done, and each pass is one statement. Measuring the
whole catalogue is four or five statements rather than 11,400 function calls.

### 3. Cost is a breakdown, not a number

Nine elements, each its own column and its own line on the page:

| Element | What it is |
|---|---|
| material | a purchased raw or consumable part's own purchase cost |
| component | a purchased component or finished part's own purchase cost |
| labor | operation time at the **loaded** rate, times the crew |
| machine | operation time at a machine hour rate derived from capital |
| overhead | each pool that reaches the operation, through its own driver |
| outside | an outside step's price per piece |
| scrap | what a yield below 100% throws away, costed where it is lost |
| packaging | a purchased packaging part's own purchase cost |
| expedite | a premium paid to move a lot up the queue |

Nothing is folded into a single "burden" figure, because the whole point is
being able to say which part of the cost is which.

**Labour is loaded.** `nl.labor_rates` is effective-dated per class with a base
wage, a fringe percentage, a payroll tax percentage and a paid-time-off factor:

    loaded = base_wage x (1 + fringe + payroll_tax) x pto_factor

A fabricator on 26.40 an hour costs 38.46 loaded. The part page shows both, and
the gap is the point.

**Machine hour rates are derived from capital, not typed in.**
`nl.capital_assets` holds what a machine cost, its in-service date, its useful
life, its salvage value and the hours the plant expects to run it. Straight line
only, because that is what a standard cost roll-up uses and a reader can check
it in their head. `nl.machine_hour_rate` adds five numbers:

    depreciation (cost - salvage) / life / expected hours
    + maintenance per hour
    + energy (kilowatts x rate)
    + tooling per hour
    + floor space (square feet x rate per year / expected hours)

The robotic weld cell costs about 14.12 an hour in depreciation alone; a hand
booth costs under two. That is why a part routed through the robot costs more
per minute, and the breakdown says so in words on the screen.

**Overhead absorbs through the driver each pool names.** `nl.overhead_pools` has
a period amount and the quantity of its driver the plant used, and the rate is
one over the other. Four drivers are modelled and all four are used:

| Driver | How the roll-up absorbs it |
|---|---|
| labor hours | rate x the operation's labour hours |
| machine hours | rate x the operation's machine hours, when it names a machine |
| floor space | the machine's square feet x rate x the share of its year the operation uses |
| material value | a percentage of what a piece costs to buy, charged on the part that was bought |

This is standard costing with absorption. A real plant argues about which driver
is right, which is exactly why the driver is data on the pool and not a rule in
the code. Material-value pools are charged on the part that was **bought**, not
on the parent it ends up in, which is what stops them being absorbed twice on
the way up a tree.

**The scrap allowance is costed where the piece is lost.** Walking a part's
operations in sequence, the value in the piece at operation k is what came in
plus the conversion cost through k. To get one good piece out of an operation
that yields y, you have to start 1/y pieces, so (1 - y) / y pieces are lost,
each worth that much. Which is why a scrap at the polish cell costs several
times what the same scrap costs at the saw. A test builds two parts with
identical operations in identical order and moves the yield from the first step
to the last, and asserts the late one costs more than three times as much.

Bill-of-material scrap and routing yield are different things and both are
modelled: `bom_lines.scrap_pct` is material lost in cutting and handling and
raises the material need; `routing_operations.yield_pct` is pieces lost at a
step and is valued at what has been spent on them by then.

### 4. Paperwork hangs off a lot, not off a part

A mill certificate is about a particular pour of steel on a particular day, not
about the part number it later became. Two lots of the same part number can come
from different mills in different countries, one acceptable to a customer and
one not. Put the certificate on the part and that distinction is gone, and with
it the ability to answer the only question that matters in a recall: which
customers got metal from this heat.

So certificates attach to lots through `nl.lot_documents`, and the few that
really are about the part rather than the material (a first article report, a
weld procedure qualification, a restricted substance declaration) attach to the
part through `nl.item_documents`, which is a different table on purpose.

The consequence that makes it work: **a requirement for a mill certificate is
satisfied by a certificate on the lot shipped or on any lot underneath it in the
genealogy.** A finished elbow does not have a mill certificate of its own and
never will. The gate walks the tree to find it.

---

## A worked example

`MF-TOP` from `app/src/lib/server/manufacturing/manufacturing.test.ts`, whose
figures the test computes by hand and asserts:

```
MF-RAW   bought tube, 10.00 a foot
MF-MID   2 feet of MF-RAW with 10% scrap, one hour of setup over a lot of
         ten plus six minutes a piece, at a cell with efficiency 1.0
MF-TOP   3 of MF-MID, twelve minutes a piece, no setup
```

Labour class MFTEST: 30.00 an hour, 20% fringe, 9.15% payroll tax, no
paid-time-off factor, so **39.00 an hour loaded**.

**MF-RAW.** Bought, so its own material is its purchase cost, 10.00. Materials
handling absorbs on material value, so it carries 10.00 x the current
material-value rate. Rolled cost = 10.00 + 10.00 x rate. Levels 0.

**MF-MID.** An hour of setup over a lot of ten is six minutes a piece, plus six
minutes of run: twelve minutes, a fifth of an hour.

    labour    0.2 h x 1 crew x 39.00        = 7.80
    machine   no machine on this operation  = 0
    overhead  0.2 h x the labour-hour pools that reach this cell
    scrap     yield 100%                    = 0
    material  2 feet + 10% scrap = 2.2 feet x MF-RAW's rolled cost

Rolled cost = 2.2 x MF-RAW + 7.80 + 0.2 x labour-hour pool rates. Levels 1.

**MF-TOP.** Twelve minutes at the same cell:

    rolled = 3 x MF-MID + 0.2 h x 39.00 + 0.2 h x labour-hour pool rates

Levels 2. `nl.item_cost_rollup('MF-TOP')` returns one row per cost line in the
whole tree with the level it came from, and the test asserts the sum equals the
stored rolled cost.

**The lead time.** MF-RAW is bought and names no lead time, so it takes the
house default for a purchase, 28 days. MF-MID's own work is two hours, which is
one day. MF-TOP's is twelve minutes, also one day. The critical path is the
longest chain, not the sum of the tree:

```
{ "MF-TOP: make 1 day", "MF-MID: make 1 day", "MF-RAW: buy 28 days" }  = 30 days
```

Shorten any other branch and the promise date does not move. That is the whole
reason the path is stored rather than just the number.

---

## The plans

Measured on PGlite (Postgres 17 compiled to WebAssembly) on the small world,
2026-09-17, warm, five runs each. **Not measured on Supabase: the handoff
forbids connecting to a remote database, so the full-world figures below are not
in this document and should be taken before the demo if anyone wants them.**

Read these against PGlite's floor: a single-row primary key lookup costs about
5 ms in this environment, almost all of it the WebAssembly bridge rather than
the query. On real Postgres the same lookup is microseconds.

| Query | Time | Floor-adjusted |
|---|---|---|
| `nl.item_cost_rolled` by primary key | 5.0 ms | the floor |
| `nl.item_lead_rolled` by primary key | 4.8 ms | the floor |
| `nl.item_supply_shape` for one part | 14.8 ms | about 10 ms |
| `nl.stock_position` for one part | 8.6 ms | about 4 ms |
| `nl.available_to_promise` | 9.6 ms | about 5 ms |
| **`nl.item_truth`** | **26.8 ms** | about 22 ms |
| `nl.item_cost_rollup` (the breakdown) | 54.8 ms | about 50 ms |
| `nl.item_lead_time_rollup` | 16.4 ms | about 11 ms |
| `nl.item_where_used` | 11.2 ms | about 6 ms |
| `nl.shipment_trace` | 5 to 20 ms | |
| `nl.lot_recall_customers` | 12 to 72 ms | |

What matters more than the numbers is the plan shape, and every access path is
an index lookup with no sequential scan over a large table:

```
nl.item_supply_shape where item_no = 'K-2408'
Nested Loop Left Join  (actual rows=1)
  ->  Index Scan using items_pkey on items i  (actual rows=1)
  ->  GroupAggregate  (actual rows=1)
        ->  Bitmap Index Scan on bom_lines_parent_idx  (actual rows=7)
        SubPlan: Index Only Scan using bom_lines_parent_idx  (rows=1, loops=7)
        SubPlan: Index Only Scan using routing_operations_item_idx  (rows=0, loops=3)
  ->  Bitmap Index Scan on routing_operations_item_idx  (actual rows=2)
Planning Time: 9.1 ms   Execution Time: 5.7 ms
```

The filter pushes into the grouped subqueries, so asking about one part reads
that one part's rows and nothing else. Planning time is larger than execution
time for the wider views, which is PGlite; it is the reason `nl.item_truth`
reads stored rows rather than computing anything.

The lesson from `docs/sql.md` is applied to every recursive walk here. Each one
is a function, not a view, with a declared row estimate and a pinned search
path:

```sql
create function nl.item_parents(p_item_no text)
returns table (item_no text, depth int)
language sql stable rows 8
set search_path = ''
```

`rows 8` tells the planner a part's family is small. `set search_path` stops
Postgres inlining the function, which would throw that estimate away and
recompute a bad one. Every walk also carries the parts it has already seen and
stops at 32 levels, so a loop in the data costs one wrong number instead of a
hung transaction.

---

## What is seeded, and what it costs to build

`db/seed.d/95_manufacturing.sql` reads the geometry back out of the
descriptions the catalogue already generated. `4" X 48" PIPE ALUMINIZED PLAIN`
takes four feet of 4 inch 16 gauge aluminized tube, because that is what it is.
Where a description carries no dimensions (a custom part made from a drawing)
the part falls back to a nominal body, and a catch-all fabrication step keeps it
from looking like an assembly.

Small world (scale 0.02), which is what the tests run on:

| | Rows |
|---|---|
| Parts | 682, of which 189 are material, components, consumables and packaging this file adds |
| SKUs | 514 |
| Bill-of-material lines | 2,052, of which 11 are substitutes |
| Routing operations | 1,609, of which 54 are outside |
| Sourcing rows | 731, with 46 parts genuinely multi-sourced |
| Lots | 407 |
| Documents | 640 |
| Consumption rows (the genealogy) | 144 |
| Deepest tree | 3 levels (kit, muffler, phantom shell, sheet) |

At full scale the same rules give tens of thousands of bill-of-material lines
and routing operations, in proportion to the catalogue's 11,400 parts.

**Build time.** The small world went from about 20 seconds to about 35 to 50
seconds with both files, on a loaded laptop. Most of that is the three full
measurements of the catalogue, not the inserts. The triggers return early while
`nl.item_cost_rolled` is empty (the same guard `nl.remeasure_after_ledger_change`
uses in 0008 while there are no commitments), so the build measures once at the
end instead of on every statement.

**Why three measurements and not one.** The item cards already carry a cost, and
that cost is what the rest of the app reads. If the metal price were invented at
face value the rolled cost would land nowhere near it and the variance report
would be noise rather than a finding. So the wages, machine rates and overhead
pools are set at plausible figures, the world is measured, and the price per
pound is then moved so that the middle of the catalogue sits on the middle of
the item cards. Two rounds, because moving the metal price moves the scrap
allowance with it. `db/seed.d/50_cost_and_pricing.sql` builds its cost history
backwards from the item card for the same reason.

The result, on the families whose geometry is real:

| Family | Median rolled cost / item card cost |
|---|---|
| pipe | 1.10 |
| shield | 1.00 |
| stack | 0.80 |
| elbow | 1.44 |

Custom parts come out around 0.4, which is the finding rather than the bug: a
custom part's card cost is a price somebody quoted off a drawing.

---

## The traceability layer

- **`nl.lots`**: heat number, mill, country of melt, vendor and vendor lot
  number, the receipt or production order it came in on, quantity received and
  remaining, and a status. A lot of tube with no mill certificate is a real
  state, and about one lot in eight in the seeded world is in it. Half of those
  sit in quarantine.
- **`nl.lot_consumption`**: which child lots went into which parent lot, and how
  much. Both traces walk this table and nothing else, so a lot that went into
  two parents is counted once in each and never twice in either.
- **`nl.lot_trace_back(lot)`**: every lot underneath one, at any depth, with the
  certificates each carries.
- **`nl.lot_trace_forward(lot)`** and **`nl.lot_recall_customers(lot)`**: every
  lot made from one, and every account that received something made from it.
  This is the recall question and it is the impressive one.
- **`nl.shipment_trace(shipment)`**: the paperwork for an order that shipped
  last year.

**The gate.** `nl.document_requirements` says what a customer, an order or a
part requires: a certificate type, an inspection level, domestic melt,
packaging and marking notes, and what the package adds to the price and to the
promise. `nl.shipment_document_gaps(shipment)` returns one row per line and
certificate that is required and unsatisfied, with the reason in plain English.
A trigger on `nl.shipments` refuses the move to shipped while any gap remains:

> Shipment TR-SHIP-1 cannot ship until its document package is complete.
> Missing: Material test report on line 1 (TR-PART): no unexpired Material test
> report on the lot shipped or on anything under it.

It is a trigger rather than a change to `nl.advance_shipment()` so the warehouse
writes keep their one owner, and so a write that goes around the function is
stopped too.

**Qualification is about permission, not paperwork.**
`nl.part_qualifications` records that a customer has approved a part from a
source, with a first-article status and an expiry.
`nl.supplier_qualifications` is the approved source list with an audit date and
a rating. `nl.part_qualification_flags(customer, item)` returns both plus the
requirements and what they cost, as a short list of sentences a quote can print.
Nothing blocks anything: quoting an unqualified source is a commercial decision,
sometimes the right one, and a system that refuses it just gets worked around.
What it must not be is silent.

**People and equipment.** `nl.operator_qualifications` (a welder qualified to a
procedure, with an expiry) and `nl.calibrations` on gauges and machines.
`nl.operation_readiness` says whether each routing step could actually run
today. In the seeded world the digital protractor is a fortnight out of
calibration, so the large bender's operations are not satisfied even though the
cell is standing free.

---

## Capacity and shortages

`nl.work_center_load` puts hours of work in front of each cell, by the week it
is due, against the hours that cell can sell. The hours come from the open
production orders and the routing of the part each is for: setup once per order,
run time times the quantity, both stretched by the cell's efficiency, because a
cell that yields 51 minutes an hour needs 70 minutes of clock to do an hour of
work.

Two things the screen says out loud, because both would otherwise be read wrong:

- An order whose routing names four cells is counted in all four, so the total
  across cells is larger than the order book. That is four answers to four
  questions, not a total.
- Only the ordered part's own routing counts. Making a parent usually means
  making its children, and those hours are real, but they belong to production
  orders that do not exist yet. Counting them would be a plan, not a load.

`nl.item_shortage_explosion(item, quantity)` explodes a quantity into everything
it needs and says for each whether it is there, with the purchase or production
order that would clear it. `nl.shortage_watch` runs it for the open lines the
ERP allocation says are short and names the deepest part that is actually
missing, which is the one holding everything up.

---

## What is missing

Listed plainly, because the owner has to be able to say what this does not do.

- **Movement types for production.** The stock ledger (0019) still has six
  kinds. Issue to production, work-in-progress moves, backflush, scrap, rework
  and return to vendor are not added, so material is not actually issued against
  a production order: the genealogy records what went into what, and the ledger
  records the warehouse's own movements, and the two are not joined. The reason
  codes table and non-conformance records are not built either.
- **Quality records.** Inspection plans per item or operation, first-article
  requirements as a workflow, and non-conformance records with scrap and rework
  reasons are not modelled. The scrap allowance in the roll-up is standard cost,
  not actual scrap measured against it.
- **Transfer and subcontract orders as documents.** Purchase and production
  orders exist (0016). `nl.item_sources` can say a part comes by transfer or
  goes out for processing, but there is no order document for either, so one
  part cannot yet show all four in its history.
- **Serial numbers.** Lots only. Warranty would need serials and nothing here
  needs warranty yet.
- **Landed material cost.** `nl.material_cost_basis` is the single seam where it
  plugs in: the pricing branch owns inbound freight, duty and broker fees, and
  when that lands the view is replaced and the roll-ups re-measured, and every
  rolled cost in the database picks it up. Until then the basis is the cost
  timeline from 0018 falling back to the item card.
- **Full-world timings.** Everything above was measured on PGlite on the small
  world. The rules forbid connecting to Supabase, so the full-world figures the
  brief asked for were not taken.
- **A departmental material-value overhead pool.** Only plant-wide ones absorb,
  because material is received at the dock before it belongs to a department.
  A pool declared with a department and a material value driver is stored and
  ignored, which is a gap rather than a decision.
- **The load board counts only released production orders.** A part that needs
  making but has no order yet contributes nothing, so the board understates the
  next month's real load.

## Checking it

```sql
select * from nl.rollup_gaps();      -- parts with no rolled figure at all
select * from nl.rollup_drift();     -- recompute everything and report what moved
select * from nl.lot_balance_drift();-- lots whose remaining does not tie out
select nl.repair_rollups();          -- for the nightly job, next to nl.repair_delivery()
```

All four are expected to be empty, and the tests require it after every kind of
change. `nl.repair_rollups()` is not yet called by the nightly job in
`0012_nightly.supabase.sql`; adding it is a one-line change in a file this work
does not own.
