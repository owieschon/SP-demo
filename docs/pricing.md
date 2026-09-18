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

---

# Published sheets, ladders, exceptions and lead times

Everything above is true and none of it is what a buyer is holding. A buyer
holds a **price sheet**: a document with a name, a date, a tier and a price
per part. They remember what they paid last time. When a number moves they
want to know which letter said so, from when, and who signed it. And before
they order anything they want a date they can plan around.

Migration `0031_price_sheets_and_lead_times.sql` is the paperwork behind the
price and the evidence behind the date. `db/seed.d/90_pricing_depth.sql`
builds it. `app/src/lib/server/pricing/sheets.ts` calls it and renames the
columns, exactly as `pricing.ts` does for 0018.

## Price sheets

| Table | What it is |
|---|---|
| `nl.price_sheets` | one generation: code, name, tier, window, the day it was published |
| `nl.price_sheet_lines` | the page price per part on that sheet, and the list it was worked out from |
| `nl.price_sheet_sends` | which sheet went to which account, and when |
| `nl.account_price_sheet` | the sheet an account is holding, how old it is, how many generations behind |

Three generations per tier, in March and November. The generation with
`effective_to` null is the one in force, and a partial unique index allows
only one per tier, for the same reason `nl.customer_prices` allows one open
agreement per account and part.

**The current sheet cannot disagree with `nl.price_for()`.** A line on the
generation in force is seeded as exactly `round(list_price * (1 - discount), 2)`,
which is what 0018 calls the group discount. Putting a sheet in front of the
rule changes the wording of an answer, never the number: "the March 2026
Dealer sheet, page price" instead of "list less 45%". A test holds every line
of every current sheet to that figure.

Older generations sit a few percent under the one that replaced them, because
list has moved since. That is what makes "you are quoting from the March
sheet, they hold the November one, which was 4% lower on this part" a sentence
worth saying, and about a third of the book is holding a replaced generation
on purpose.

## Volume ladders

`nl.price_breaks` supersedes `nl.quantity_breaks` (0021). Two things changed.

- **A rung belongs to a published document**, either a sheet (`sheet_id`) or a
  tier (`price_group`), never both and never neither. A
  `check (num_nonnulls(sheet_id, price_group) = 1)` says so.
- **A rung carries a price, not a discount**, at quantities 1, 6, 12, 25, 50
  and 100. That is what the sheet prints and what the buyer reads back. Rung
  one is the page price, so a ladder explains itself without looking anywhere
  else.

`nl.quantity_breaks` and `nl.desk_price_for()` are left alone so the desk agent
keeps working. Moving it over is one of the call site changes in the report.

### What happens when an agreement and a rung both apply

`nl.customer_prices.break_policy`:

- `better of` (the default): the lower of the two wins, because a buyer
  holding both documents will read the lower one back to us and be right to.
- `agreement only`: the agreed price is firm at every quantity. About one
  agreement in six is written this way.

Under every other rule the rung applies only when it is lower than the base
price. A last paid price under the published ladder stays: the better price
for the customer is the one they already have.

## The quote level rule

`nl.price_quote_for(customer, item, quantity, date)`. `nl.price_for()` is
untouched: this is a second function because a quote knows two things a part
does not, a quantity and which sheet the buyer holds.

| Order | Rule | What it uses |
|---|---|---|
| 1 | `agreement` | an agreed price whose window covers the day |
| 2 | `held sheet` | a live customer exception pinning an older sheet |
| 3 | `last paid` | the last price they paid in the last 12 months, if it clears the floor |
| 4 | `sheet` | the page price on the sheet in force for their tier |
| 5 | `group discount` | list less the tier discount, for a part no sheet covers |
| 6 | `list` | list price, for an account we do not know |

Then the ladder: the sheet's rungs if it prints any for the part, otherwise the
tier's standing ladder, never the two mixed. `next_price` is what they would
actually pay at the next rung up, not the printed rung, so a reply can say
"buy twelve and it is this" and be right even under a firm agreement.

## What they are used to paying

`nl.customer_item_prices` is one row per account and part off their own
invoices: times bought, units, first and last purchase, the last price and
its invoice, the twelve month average weighted by quantity, the highest and
the lowest. Credit memo lines are left out: a return is not a price the buyer
remembers paying.

`nl.customer_item_price_context` puts that next to today's number and sets
`above_last_paid` when the quote is more than `nl.price_jump_pct()` (7%) above
what they last paid. **This is the thing that stops an agent quoting a number
that looks absurd to the buyer.** The flag is strictly greater than the
threshold, so a quote exactly 7% up is not a jump.

Both are grouped on read, not stored. `customer_no` and `item_no` are the
grouping keys, so a filter on either is pushed below the aggregate and one
lookup reads that account's lines for that part and nothing else.
`invoice_lines_customer_item_idx` is `(customer_no, item_no, posted_on desc)
include (quantity, unit_price, amount, invoice_no, line_no)`, which makes it an
index only scan at full scale. It costs about 40 MB there.

## Exceptions

`nl.trade_exceptions`: one table, seven kinds, so an agent looks in one place
instead of seven. Every row carries a reason, the day it was announced, its
window and an owner, because an explanation that cannot say who decided
something is an apology rather than an answer.

| Kind | What it carries |
|---|---|
| `price increase` | a percent and a future date, with the wording of the letter |
| `surcharge` | a percent, material or freight, with a window |
| `customer exception` | an account that keeps an older sheet on a family until a date |
| `lead time` | a longer figure than the card, with the reason: a vendor, a work center, a material |
| `allocation` | a limit per order while stock is short |
| `discontinued` | with the part that replaces it |
| `order minimum` | an order value, or a pack size |

Scope is `item`, `family`, `product_group` or `catalog`; `customer_no` null
means everyone, `price_group` null means every tier. A check constraint holds
the scope column and the scope columns to each other, and another holds each
kind to the fields it uses.

`nl.exceptions_for(customer, item, date)` resolves all of that and returns
live ones, then announced, then anything that ended in the last quarter.
**Announced rows are included on purpose**: a price increase that starts in six
weeks is the single most useful thing to say when a buyer asks how long a
number is good for.

Three decisions:

- **A surcharge and an announced increase do not move today's price.** They
  are reported next to it with the dollars they would add and the day they
  start, because that is how they arrive: a separate line on the invoice, or a
  letter about next quarter.
- **A customer exception does move the price**, because that is what it was
  written to do. It is the one kind that sits in the precedence order, and it
  works by pinning a real older sheet rather than by inventing a discount.
- **An allocation stops a promise.** See below.

## Lead time per vendor and part

A single lead time for a whole vendor is not a lead time. `nl.items.lead_time`
and `nl.vendors.lead_time` are both one text field holding an ERP date
formula, and the old rule coalesced item, then vendor, then a constant, so a
date given to a customer could rest on a guess with no provenance at all.

Buying happens per vendor and per part, so that is where this lives, and a
lead time there is three things that are regularly three different numbers.

| | Where it lives | What it is |
|---|---|---|
| **Quoted** | `nl.vendor_items.quoted_lead_days`, with `quoted_on` and `quote_reference` | what the vendor says. A claim, not a fact |
| **Committed** | `nl.vendor_item_commitments` over the open purchase lines | what they promised on one order, which is often not the quote |
| **Observed** | `nl.vendor_item_lead_times` over `nl.purchase_receipts` | what actually happened |

The observed figures are a count, a median, a ninetieth percentile, the worst
one and the share that arrived late. **There is no average, on purpose.** A
vendor whose median is 18 days and whose ninetieth is 45 is not the same
supplier as one that is 24 days every time, and an average calls them the
same. The tail is the decision.

`nl.vendor_items` also carries what a buyer cannot act without: whether this
vendor is the primary source or an alternate, their part number, the minimum
order quantity, the order multiple, their price at one piece, and whether the
part is on allocation or discontinued at that vendor. `nl.vendor_item_breaks`
is their own ladder, the same shape as the customer one.

### What the system promises with

`nl.promise_lead_days(item)` returns one row: the days, the basis, a sentence
saying why, and whether a date may be given at all.

| Basis | When |
|---|---|
| `observed` | at least `nl.promise_min_receipts()` receipts from the primary source. Uses `nl.promise_percentile()`, the ninetieth, rounded up |
| `quoted` | too little history, so the vendor's own word, with the date they said it |
| `item card` | the part's own ERP date formula |
| `vendor default` | the vendor card figure, **labelled as a default**, because it covers every part they supply |
| `default` | `nl.default_lead_days()` for the replenishment method |
| `exception` | a published slip has moved the date out past all of those |

The ninetieth, not the median, because half of a median is late by definition
and a promise a buyer can plan around has to cover the tail. Both numbers are
policy functions, so they can move without a deploy:
`set_config('nl.promise_percentile', '0.5', true)` and the promise follows.

`can_promise` is false where the source has the part on allocation or has
discontinued it. **An allocated part gets no date at all**, because promising
one we will miss is worse than saying we will come back with one.
`lead_days` is still a number in that case, because the forecast has to plan
with something.

### Everywhere a date appears, so does its basis

`nl.lead_time_for()` gains `basis`, `basis_detail`, `can_promise`, the vendor
and the observed figures. `nl.explain_price()` carries them in `lead_time`.
`nl.answer_for()` extends the `earliest_basis` vocabulary
`available_to_promise` already uses rather than replacing it: `stock` and
`supply` are unchanged, `rolled` is the manufacturing model's own answer, and
where the date rests on a lead time it now says **which** lead time.

### Nothing had to change to get it

`nl.item_lead_days()` (0016) and `nl.item_lead_time_days()` (0029) keep their
signatures and are replaced to read the promise rule. The forecast, the
projection, available to promise, the replenishment maths and the purchase
requests all get the better number without a line of their own changing. A
part with no vendor-part row and no receipts falls all the way through to the
old chain, so a fixture with nothing but an item card answers what it always
did.

The last unnamed number went with it. `nl.sample_open_purchase_lines()` (0022)
dated every line off `coalesce(item formula, vendor formula, 21)`. That 21 had
no name and no provenance and it decided a date. The function is repeated in
0031 with that one coalesce replaced by `nl.item_lead_days()`. It is the only
line that changed, and if 0022 is ever revised this copy has to be revised
with it.

## Landed inbound cost

`nl.items.unit_cost` and the cost timeline both carry what the vendor invoiced
for the goods. Freight in and duty are real money and are not in it, so every
margin in the app is flattering by whatever they add up to.

`nl.purchase_receipts.freight_in` and `.duty` are per receipt, because they
move: a part expedited in to cover a shortage lands at a different cost from
the same part on a full truck. `nl.landed_cost` groups them per vendor and
part into an invoiced unit cost, a landed unit cost and the uplift between
them, over all history and over the last twelve months.

`nl.explain_price()` carries `landed_unit_cost`, `landed_uplift_pct` and
`landed_margin_pct` in its `cost` block, beside the margin the rest of the app
uses, so nobody has to guess how flattering that one is.

## One function that explains a price

`nl.explain_price(customer_no, item_no, quantity, on_date)` returns the price
**and** the reasoning, as one JSON value. A page, the desk agent and the
assistant read the same answer, so they cannot tell a customer two different
things, and an explanation that needed a second query would sooner or later be
assembled two ways.

```
unit_price, extended
quote           rule, detail, base price, the rung that set it, the whole ladder
sheet           the sheet in force for their tier
customer_sheet  the sheet they are holding, their price on it, the difference
agreement       the agreed price and its break policy
history         last paid and when, twelve month average, high, low,
                above_last_paid with the size of the jump
cost            cost, floor, margin, below_floor, and the landed figures
lead_time       days, basis, why, whether it may be promised, the vendor evidence
next_increase   the announced increase that moves this number next, and to what
surcharges      what rides on top, and the dollars on this quantity
exceptions      everything published that reaches this account and this part
talking_points  plain sentences, in the order to say them
```

`nl.answer_for(customer_no, item_no, quantity, needed_by)` adds the other half
of every real question, when can I have it: free stock now, the earliest date
the whole quantity can ship and why, the replacement part if this one is
discontinued, and `reply`, one or two sentences a person can paste into an
email. It feature detects `nl.item_truth()` from the manufacturing model and
uses it when present.

An exception's owner comes back as `owner_id` and never as a name: the
read-only role has no grant on `nl.users`, so a page resolves the name itself
and both functions stay safe to grant to `nl_readonly`.

### A worked explanation

Novak & Sons Truck Parts, `S8-144MC`, 25 pieces, wanted in ten days (small
world, 2026-09-17):

```
unit_price 248.26   extended 6,206.50
rule       last paid, on 2026-09-07
tier price 263.58 on the Performance sheet, March 2026
ladder     1: 263.58  6: 259.28  12: 255.73  25: 249.43  50: 243.27  100: 238.61
```

The ladder rung at 25 is 249.43 and what they last paid is 248.26, so the rung
does not apply: the better price for the customer is the one they already have.
The talking points come back as:

- This holds the price they paid last time.
- At 50 or more it drops to 243.27 each.
- They last paid 248.26, so this is in line.
- They are holding Performance net prices, November 2025, which shows 250.58
  for this part. Quote the current sheet and say the older one has been
  replaced.
- The announced increase of 4.5% starts 2026-11-02, so this number holds until
  then.
- A surcharge of 2.0% is live and is billed as its own line, not inside this
  price.
- Lead time has moved out to 57 days: the bender is the bottleneck and the
  queue in front of this part is four weeks deep.

and `nl.answer_for()` turns the first of those and the date into a reply:

> S8-144MC at 248.26 each, the price they last paid, on 2026-09-07. We can
> ship 0 now and all 25 by 2026-11-13. Lead time on this part is out to 57
> days: the bender is the bottleneck and the queue in front of this part is
> four weeks deep.

## Everything under one customer's roof

`nl.customer_parts(customer_no)`: every part the account has ever bought, with
spend and units over twelve months and lifetime, first and last purchase, what
they last paid, whether they are still buying it (`active`, `slowing`,
`quiet`), and what state the part is in today (`discontinued` with its
replacement, `available`, `on order`, `short`) with the lead time and its
basis. This is what answers a question about a part they bought three years
ago that we may no longer stock.

It is one aggregate over one range of `invoice_lines_customer_item_idx`: the
account's ledger read once, not once per part. It deliberately does not go
through `nl.customer_item_prices`, which would group the same rows again for
every part on the list.

## Query plans

Small, demo and full worlds under PGlite, after `analyze`, best of three.
`node app/scripts/pricing-plans.ts [small|demo|full]` reproduces it.

**Read the buffers, not the milliseconds.** PGlite is Postgres compiled to
WebAssembly and its timings move with whatever else the machine is doing;
pages touched does not. What these have to prove is that a lookup for one
account and one part does not grow with the ledger.

| Query | Small (3.5k lines) | Demo (30k) | Full (450k) |
|---|---|---|---|
| `customer_item_prices`, one account and part | 43 buf | 146 | 356 |
| `customer_item_price_context`, same | 55 | 159 | 368 |
| `price_quote_for` | 46 | 53 | 56 |
| `explain_price` | 168 | 129 | 242 |
| `answer_for` | 201 | 155 | 275 |
| `exceptions_for` | 6 | 7 | 10 |
| `account_price_sheet`, one account | 4 | 5 | 5 |
| `customer_parts`, whole account | 193 | 1,415 | 7,780 |

The agent's hot path, `explain_price` and `answer_for`, is flat from 3,500
invoice lines to 450,000. `customer_parts` grows with the number of parts the
account has bought, not with the ledger: the figures above are 110, 368 and
about 700 parts. The full world column was measured before the vendor and part
section was added; see the report for the figures with it.

Three findings worth keeping.

**A CTE value cannot be pushed into a view's group by.**
`nl.promise_lead_days()` first read `nl.vendor_item_lead_times` and filtered it
by a value from a CTE, which grouped the whole receipts table on every call:
37 buffers a part instead of 4, which showed up at once in
`nl.customer_parts`. It now aggregates the receipts directly, and a test holds
the two copies of that arithmetic to the same answer, the way 0018 holds
`nl.freight_by_month` to `nl.freight_for()`.

**A lateral referenced twice is evaluated twice.** `nl.customer_parts` worked
the open supply out in a lateral and read it in two output columns; the
planner inlined it and ran the two correlated subqueries 1,018 times over 368
parts, 5,600 buffers of the 7,400 it used. Grouping the two small open
document tables once in a CTE took the whole function to 1,400.

**Mark the tiny CTEs `materialized`.** Postgres inlines a CTE used once, so
`nl.today()` and the account's current sheet were being worked out again for
every part on the list.

## What the seed builds

| Table | Small (506 parts) | Demo (2,715) | Full (11,422), estimated |
|---|---|---|---|
| `nl.price_sheets` | 15 | 15 | 15 |
| `nl.price_sheet_lines` | 4,035 | 22,485 | about 94,000 |
| `nl.price_sheet_sends` | 180 | 1,212 | about 7,700 |
| `nl.price_breaks` | 960 | 1,155 | about 7,600 |
| `nl.trade_exceptions` | 23 | 22 | about 77 |
| `nl.vendor_items` | 190 | about 1,000 | about 4,500 |
| `nl.vendor_item_breaks` | 249 | about 1,300 | about 6,000 |
| `nl.purchase_receipts` | 1,124 | about 6,000 | about 27,000 |

## What the desk agent and the assistant should call now

| Instead of | Call |
|---|---|
| `nl.price_for()` for a quote line | `nl.price_quote_for()`, which knows the quantity and the sheet |
| `nl.desk_price_for()` | `nl.price_quote_for()`; `nl.quantity_breaks` is superseded by `nl.price_breaks` |
| assembling an explanation from several lookups | `nl.explain_price()` |
| a price lookup and an availability lookup | `nl.answer_for()`, which is both and returns a reply |
| `nl.item_lead_days()` for a customer facing date | `nl.promise_lead_days()`, and read `can_promise` and `basis` |
