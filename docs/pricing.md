# Cost, freight and price

Three numbers decide whether a line of business is worth having: what a part
costs us, what the freight costs, and what the customer pays. All three move
over time in a real parts business, so all three have a history here, and one
rule each that reads it. Migration `0018_cost_and_pricing.sql` holds the
schema and the rules; `db/seed.d/50_cost_and_pricing.sql` builds the history.

Nothing in this file is worked out in JavaScript. `app/src/lib/server/pricing/`
calls the database and renames the columns, so a page, an import and the
assistant cannot answer the same question three different ways.

## Cost

`nl.items.unit_cost` stays what it always was: the current cost on the item
card. `nl.item_costs` adds the history behind it.

| Column | What it is |
|---|---|
| `item_no`, `effective_from` | the key: one revision per part per day |
| `unit_cost` | what the part cost from that day |
| `vendor_no` | who quoted it, null on a part we make |
| `source` | `vendor quote`, `purchase receipt` or `standard revision` |
| `note` | why it moved, in a sentence |

`nl.item_cost_on(item_no, on_date)` gives the cost that applied on a date: the
newest revision on or before it, else the oldest revision there is (a date
before the history starts), else the item card. `nl.item_cost_timeline` is the
same rows with an end date, a current flag and the size of each step, which is
what a part page shows.

A made part's cost is mostly labor and burden at our own work centers, so it
moves less than a bought part, and raw tube and sheet move most of all. The
seed uses that: one to three revisions a year, most of them rises of 2 to 8%,
about one in five a small fall, bigger jumps through 2021 and 2022 (the supply
squeeze) and steadier since. Bought parts take the full step, made parts about
half of it, raw material a little more than the full step.

The squeeze is only inside a world that reaches back that far, so it was
checked on a small world with "today" pinned to 2023-06-15: 911 rises against
83 falls in 2022, average rise 7.6%, against 405 rises, 70 falls and an average
rise of 3.6% in 2023. The fuel surcharge in the same world climbs to 24.1% in
May 2022 and is back to 8% by March 2023.

The timeline is built **backwards from the current cost**. The draws decide
the steps; the opening cost is then the current cost divided by every step
after it, and the newest row is set to `nl.items.unit_cost` to the cent. The
item card and the timeline therefore cannot disagree, whatever the draws do,
and a test checks every part.

Example, one made part in the small world (`CU-48274`, current cost 67.55):

| From | Cost | Step | Source | Note |
|---|---|---|---|---|
| 2025-01-01 | 59.02 | | standard revision | Opening standard cost, where this history starts |
| 2025-03-03 | 58.38 | -1.1% | standard revision | less material per piece after the fixture change |
| 2025-05-06 | 60.16 | +3.1% | standard revision | labor and burden updated |
| 2025-09-25 | 61.48 | +2.2% | standard revision | labor and burden updated |
| 2026-01-10 | 63.75 | +3.7% | standard revision | work center rate changed |
| 2026-07-06 | 64.72 | +1.5% | standard revision | annual roll up |
| 2026-09-02 | 67.55 | +4.4% | standard revision | labor and burden updated |

### Where the timeline and the ledger disagree

`nl.invoice_lines.unit_cost` already carries a cost per line, and the base seed
(`db/seed.sql`, `build_year`) sets every line's cost to the part's **current**
cost, whatever year the line is from. So the ledger says cost never moved, and
the timeline says it rose about 4% a year.

The margin views read the **line**, never the timeline, so no report changes
its mind about a closed month. But the two are not the same number for history:

| Year (small world) | Cost of goods from the lines | The same units at the timeline's cost |
|---|---|---|
| 2025 | 215,078 | 198,155 |
| 2026 (to 17 September) | 108,145 | 105,301 |

The gap is about 8% in the first year of a two year world and would reach
roughly 35 to 40% in the oldest year of the seven year full world, because
seven years of rises compound. Two ways to close it, both for the lead to
decide, neither done here:

1. Backfill the ledger once, at the end of the build:
   `update nl.invoice_lines il set unit_cost = nl.item_cost_on(il.item_no, il.posted_on);`
   That makes history agree with the timeline and makes old margins look
   better, as they should. It writes 450,000 rows at full scale and fires the
   delivery triggers from 0008, so it belongs inside `build_year` (before the
   triggers matter) rather than in a seed extra.
2. Leave it, and read the difference as what it would be in a real ERP: a
   standard cost that was rolled forward without restating history.

## Freight

The ledger bills freight per invoice, sized off the order subtotal, because
the sales ledger has no weight on it anywhere. The tariff follows the same
shape:

- `nl.freight_periods`: one row per tariff revision, with the "ships free
  over" threshold for that period.
- `nl.freight_rates`: the rate for each subtotal band of a period. Bands start
  at 0, 250 and 1000 dollars; the top band runs up to the free freight
  threshold.
- `nl.fuel_surcharge`: a percent per month, added to the rate. Carriers
  publish it monthly and it moves much more than the base rates do.

`nl.freight_for(subtotal, on_date)` returns the freight, the base rate, the
surcharge, the threshold and the band. A date before the history is priced at
the oldest tariff, so an old invoice never gets an empty answer.

The seeded tariff (full world; the shorter worlds start at their own first
year and skip the earlier revisions):

| From | Free over | 0 to 250 | 250 to 1000 | 1000 up |
|---|---|---|---|---|
| first year | 1,200 | 10.50 | 14.50 | 18.00 |
| 2021-07-01 | 1,200 | 11.00 | 15.50 | 19.00 |
| 2022-04-01 | 1,500 | 12.50 | 17.50 | 21.50 |
| 2023-03-01 | 1,500 | 12.75 | 18.00 | 22.00 |
| 2024-04-01 | 1,800 | 13.25 | 18.50 | 23.00 |
| 2025-05-01 | 1,800 | 13.75 | 19.25 | 24.00 |
| 2026-03-01 | 2,000 | 14.25 | 20.00 | 25.00 |

The surcharge wanders between 8 and 28% on two slow waves with a little keyed
noise, and spikes through 2022 (up to ten points on top) when diesel ran away
from everyone. Those rates were chosen to land on the freight the ledger
already bills: `build_year` prices freight around 15 dollars on a 274 dollar
order, rising slowly with order size, and the tariff gives 15.40 on a 120
dollar order in mid 2025 and 29.33 on a 1,400 dollar order in late 2026.

`nl.freight_by_month` puts freight billed next to freight at the tariff of the
day. In the small world the ratio runs about 0.46 to 0.78: the ledger charges
freight on roughly two invoices in three and lets the rest ride, so the
business absorbs a third of its freight. That is the number a freight recovery
screen should lead with.

Two things the tariff does not pretend to know: the ledger sometimes bills
freight on an order above the free freight threshold (a customer who asked for
it to be expedited), and an account that ships on its own carrier account
never pays freight at all (`nl.customers.ships_own_carrier`). Both show up in
`nl.freight_by_month` as a difference, which is honest.

## Price

`nl.customer_prices` holds agreed net prices: one account, one part, a window,
who agreed it and a note. `valid_to` null means open ended, and a partial
unique index allows only one open agreement per account and part, because "the
price" cannot have two answers. A prior agreement stays on file with its own
window, and windows for the same account and part never overlap.

`nl.price_for(customer_no, item_no, on_date)` is the one rule, in this order:

| Order | Rule | What it uses |
|---|---|---|
| 1 | `agreement` | an agreed price whose window covers the day |
| 2 | `last paid` | the last price they paid in the last 12 months, if it still clears the floor |
| 3 | `group discount` | list price less their price group's discount |
| 4 | `list` | list price, for an account we do not know |

It also returns the cost that applied that day, the floor price, the margin at
the price it picked and a `below_floor` flag, so a screen can say why a price
is a bad idea without asking a second question.

Three decisions inside that rule:

- **An agreement wins even when it is below the floor.** It is what was
  agreed. The flag says so and a person decides what to do about it.
- **Last paid has to clear the floor.** Carrying a price forward is a
  convenience, not a commitment, so once cost has risen past it the rule drops
  to the tier price instead of quoting a number that no longer pays.
- **Last paid is the account's own history, not its billing family's.** A
  branch that has never bought the part prices off its group discount, which
  is what the order desk does today.

### The floor

`nl.min_margin()` returns 0.20, and the floor price is
`cost / (1 - 0.20)`, which is cost times 1.25: the price at which gross margin
is exactly 20%. Gross margin here is the usual `(price - cost) / price`, the
same definition `nl.item_margin_history` and `nl.part_summary` use.

Why a fifth: the book's blended gross margin runs in the high forties, and the
thinnest product group (raw tube and sheet sold to fab shops) carries about a
third. Below a fifth a line stops paying for the order desk, the pick, the
pack and the freight it rides on. It is a flag, never a block.

The seed writes agreements for the biggest accounts on the parts they buy most,
two to eight points under their tier price, and now and then ten to sixteen
points under, which is how an agreement ends up below the floor. Example rows
from the small world:

| Account | Part | Tier price today | Agreed | From | To |
|---|---|---|---|---|---|
| 1214 | K-3572 | 674.50 | 622.54 | 2026-07-16 | open |
| 1218 | M-6565 | 92.55 | 85.53 | 2025-07-06 | open |
| 1218 | M-6565 | 92.55 | 77.41 | 2024-08-13 | 2025-06-28 |
| 1218 | RBRC10B3 | 43.83 | 42.01 | 2026-01-24 | 2026-08-03 |

## Margin

Two views, both grouped once over the ledger, both taking cost from the line:

- `nl.item_margin_history`: per part and month, with units, revenue, cost of
  goods, gross margin and margin percent.
- `nl.customer_margin`: per account and year, with the same figures plus how
  many distinct parts it bought.

Credit memo lines are included. A return takes its units, revenue and cost
back off; a price correction (quantity 0, amount negative) takes revenue off
and leaves cost alone, which is exactly what it did to the margin. Freight is
not in either view: it sits on the invoice header, not on the lines, and it has
`nl.freight_by_month` to itself.

## Stored or derived

| Stored | Derived on read |
|---|---|
| `nl.item_costs` (a revision is a fact) | `nl.item_cost_on`, `nl.item_cost_timeline` |
| `nl.freight_periods`, `nl.freight_rates`, `nl.fuel_surcharge` | `nl.freight_for`, `nl.freight_by_month` |
| `nl.customer_prices` | `nl.price_for`, the floor, the margin, `below_floor` |
| `nl.invoice_lines.unit_cost` (what the cost was that day) | `nl.item_margin_history`, `nl.customer_margin` |

No figure here is cached anywhere. `nl.commitment_delivery` is stored because
recounting it grew with history (see `DECISIONS.md` 12); these views group the
ledger once per question and do not need the same treatment yet.

## Query plans

Measured on the **small world under PGlite** (505 parts, 3,480 invoice lines,
845 invoices), after `analyze`. The rules for this repository say never to
ship a view without an `explain (analyze, buffers)` on the full world; that run
belongs on Supabase and has not happened yet, so read these as plan shapes,
not as timings. Buffer counts are the number to watch: they are what grows with
the full world.

| Query | Plan | Buffers | Time |
|---|---|---|---|
| `item_margin_history` for one part | Bitmap Index Scan on `invoice_lines_item_posted_idx`, then HashAggregate | 38 | 1.1 ms |
| `customer_margin` for one account | Seq Scan, then GroupAggregate | 42 | 40 ms |
| `customer_margin`, whole book | Seq Scan, then HashAggregate, 81 rows out | 42 | 48 ms |
| `item_cost_on` | Index Scan on `item_costs_lookup_idx` | 5 | 2 ms |
| `item_cost_timeline` for one part | Index Scan on `item_costs_lookup_idx`, then WindowAgg | 3 | 0.7 ms |
| `price_for` | Function Scan: index scans on `customer_prices` and `invoice_lines_delivery_idx` | 458 | 20 ms |
| `freight_for` | Function Scan, three index lookups on tables of a few dozen rows | 21 | 6 ms |
| `freight_by_month` | one Seq Scan of invoices, joined to the tariff ranges | 15 | 107 ms |

Notes on three of those.

**The filter reaches the group by.** `item_no` and `customer_no` are grouping
keys of the two margin views, so `where item_no = ...` is pushed below the
aggregate and the view reads one part's lines, not the whole ledger. That is
why these are plain views and not materialized ones.

**The per-account index.** `invoice_lines_customer_cost_idx` is
`(customer_no, posted_on) include (item_no, quantity, amount, unit_cost)`: the
columns `customer_margin` needs, which the delivery index from 0005 does not
carry. On the small world the planner ignores it and scans the table, and it is
right to: one account is half of that ledger. It is there for the full world,
where an account is a fraction of 450,000 lines. It costs about 35 MB there and
can be dropped if disk ever matters more than the account page.

**`freight_by_month` repeats the rule as a join.** The first version called
`nl.freight_for()` once per invoice. Every function in this schema pins its
`search_path` (see `DECISIONS.md` 10), and a function with a `SET` clause
cannot be inlined, so a call per row stays a call per row: 662 ms and 6,551
buffers for 845 invoices, growing straight with the ledger. Turning the three
tiny tariff tables into date and subtotal ranges and joining once costs 107 ms
and 15 buffers, and the buffer count does not grow with the ledger. The rule
is duplicated, so a test prices every month both ways and fails if they ever
differ.

## What the seed builds

| Table | Small (505 parts, 2 years) | Full (11,422 parts, 7 years), estimated |
|---|---|---|
| `nl.item_costs` | 2,250 (4.5 per part) | about 150,000 (13 per part) |
| `nl.freight_periods` | 3 | 7 |
| `nl.freight_rates` | 9 | 21 |
| `nl.fuel_surcharge` | 21 months | 81 months |
| `nl.customer_prices` | 17, over 6 accounts | about 340, over 120 accounts |
