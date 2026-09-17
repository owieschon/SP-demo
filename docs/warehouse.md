# The warehouse

Before this, the only warehouse fact in the database was `nl.stock`: one row
per part with an on-hand figure and a shelf and bin label. That answers "how
many" and nothing else. It cannot say where the pieces are, how they got
there, what is on the dock, or why the number changed last Tuesday.

This is the state around that figure, and the rule that keeps it honest.

## What the model holds

| Table | What it is |
|---|---|
| `nl.locations` | The buildings: `MAIN` (the plant), `EAST` (a smaller distribution center) and `WEST` (a forward stocking spot for the coast). The ERP export's `Location Code` column already says MAIN and EAST. |
| `nl.stock_bins` | One row per part per location: zone, aisle, shelf, bin, quantity, when it was last counted. |
| `nl.stock_opening` | What each bin had on the day the ledger starts. Written once, then left alone. A missing row means zero. |
| `nl.stock_moves` | The ledger. Append-only, signed: `receipt`, `shipment`, `adjustment`, `transfer_out`, `transfer_in`, `count`. Carries the paperwork it came from, a reason when a person chose to move it, and who. |
| `nl.count_sessions`, `nl.count_lines` | A cycle count of one zone on one day: expected against counted, with the variance stored as a generated column. |
| `nl.shipments`, `nl.shipment_lines` | Orders picked and packed but not yet collected, with the carrier, the packer and a tracking number. |
| `nl.transfers`, `nl.transfer_lines` | Stock moving between our own buildings, sent and expected dates, some still on the road. |

Three views sit on top: `nl.stock_position` (a part's total, its split by
location, how much open orders have claimed, what is left),
`nl.warehouse_today` (the six figures the page opens with, always all six) and
`nl.stock_moves_recent` (the last month of the ledger with the names filled
in).

## The agreement rule

Three things say how much of a part there is:

1. `nl.stock.on_hand`, the item master
2. the sum of `nl.stock_bins.quantity` for that part
3. the opening balance plus the sum of `nl.stock_moves` for that part

All three have to say the same number. `nl.stock` stays the authoritative
figure, because the parts pages, the ERP allocation view
(`nl.open_line_allocation`, migration 0010) and the supply forecast already
read it, and nothing here changes its meaning or its columns. What the
warehouse adds has to agree with it, not replace it.

Every write function moves all three in the same transaction, per location:

- `nl.post_stock_adjustment` writes one move, sets the bin and moves
  `on_hand` by the same signed quantity.
- `nl.post_count_session` turns every counted line with a variance into one
  `count` move and moves the bin and `on_hand` by exactly that variance.
  Lines that came out right still stamp the bin as counted today.
- `nl.advance_shipment` walks `picking -> packed -> awaiting carrier ->
  shipped`. Only the next step is accepted, so a stale page cannot skip
  packing. Shipping writes one `shipment` move per line and takes the pieces
  out of the bin they were picked from.
- `nl.receive_transfer` writes both halves at once: `transfer_out` at the
  origin and `transfer_in` at the destination. `on_hand` does not change,
  because the stock never left the company, only the building.

Each one follows the house write rules: claim the request id (so a retry
returns the first answer instead of writing twice), require an active user,
check the field rules, take the optimistic lock on `updated_at`, write an
audit row, and refuse anyone who is not operations or an admin
(`nl.can_run_imports()`, migration 0010).

### Stock in transit

In transit stock stays on the origin's books until the transfer is received.
That is a decision, not an oversight. If a transfer took the pieces off the
origin when it was sent, there would be a fourth place for stock to live, and
the sum of the locations would no longer equal the item master for as long as
the truck was on the road. Writing both halves at receipt keeps the identity
true at every moment. The cost is that the origin's bin looks available while
the pieces are actually on a truck, which the page says out loud.

## What the drift check proves

`nl.warehouse_drift()` returns a row for every part where the three figures
disagree, at two levels:

- `scope = 'item'`: `nl.stock.on_hand` against the bin total and the ledger
  total for the whole part.
- `scope = 'location'`: the bin quantity at one location against the ledger at
  that location. `master_on_hand` is null here, because the item master does
  not know about locations.

It should always be empty, and the tests require it: once after a build, and
again after every write in the suite has run. That is the same idea as
`nl.delivery_drift()` in migration 0008. A stored figure is only trustworthy
if something independently recomputes it and complains, and the check is
cheap enough to run whenever anybody wants to be sure.

What it proves is narrow and worth stating plainly: the three figures agree
with each other. It does not prove any of them matches the physical shelf.
That is what the cycle counts are for, and a posted count is exactly the
moment the database admits the shelf was right and it was wrong.

## The ledger is built backwards

The seed (`db/seed.d/60_warehouse.sql`) cannot invent a plausible history and
hope it lands on today's figure. So it does not try. It builds the current
state first, then the history that is already known, then solves for what is
left:

1. Split each part's `on_hand` across one or two locations and bins, keeping
   the part's existing shelf and bin at its home location. Exact by
   construction: the home bin takes `on_hand` minus whatever went elsewhere.
2. Write the history that is already known. Every invoice line of the last 90
   days becomes a `shipment` move off one of the part's own bins, weighted by
   how much each holds. Every credit memo line with pieces on it becomes a
   `returned to stock` adjustment. Shipments marked gone today, the transfer
   that has been received and every posted count variance all write their
   moves too.
3. Add a few adjustments with reasons, because a real warehouse has damage,
   scrap and boxes found in the wrong aisle.
4. Solve for the start. `opening + everything above = today's quantity`, so
   whatever is left over is split between an opening balance and one to four
   receipts (purchase orders for bought parts, production orders for made
   ones) spread across the window.

A bin whose moves add up to more than it holds today would have to have
started below zero. Rather than fudge it, the seed books the difference as one
`scrap` adjustment at the start of the window and says so in the note, which
is what actually happens in a warehouse where something was written off and
never keyed.

So the ledger is not an approximation that happens to be close. It is the
current figure minus its own history, which is why it ties out to the piece,
and why the "explain this number" panel on `/warehouse?part=<item>` can show
the arithmetic and have it come out right.

## Access

Row-level security is on every table. Everyone signed in can read all of it:
an account manager needs to answer "is it on the shelf" without being able to
change anything. Only operations and admins write, and the write functions
check the same rule first so the message is in plain English rather than a
policy violation.

The read-only role the assistant's SQL tool uses gets `nl.locations`,
`nl.stock_bins`, `nl.stock_opening` and `nl.stock_position`: where parts are
and how many. It does not get the ledger, the counts, the shipments or the
transfers, because every one of those names a person. `nl.warehouse_today`
and `nl.warehouse_drift()` read those tables as the caller, so they are not
granted to it either.

`nl.stock_moves` has an insert policy and no other, and no update or delete
grant. A posted move cannot be edited away; a mistake is corrected by another
move, which is what "append-only ledger" has to mean if it means anything.

## Plan shapes checked

- **The pick queue.** `nl.shipments` ordered by `(status, promised_on,
  shipment_no)` reads `shipments_queue_idx` directly, and the lines for the
  twenty shipments that came back are fetched in one second query rather than
  one per shipment.
- **"The last N moves for this part."** `stock_moves_item_idx` is
  `(item_no, moved_at desc, id desc)`, so the part ledger's newest forty moves
  are one index range, no sort.
- **"Moves at this location today."** `stock_moves_location_idx` is the same
  shape by building.
- **The drift check.** Three group-bys over the bins, the openings and the
  ledger, joined per part. It is a whole-table check by design, which is why
  it is a function to call and not something a page runs on every load.
- **`nl.warehouse_today`.** Six aggregates with `nl.today()` pulled into a
  materialized CTE, the same trick migration 0009 used, so the clock is asked
  once per query rather than once per row.

## What is not built yet

- A receiving screen. `nl.receive_transfer` exists, is tested and is wrapped
  in `receiveTransfer`, but the warehouse page only lists what is on the road.
  Booking a transfer in belongs next to the paperwork on the receiving dock.
- Entering counts. The count sheet shows what has been counted and posts it;
  the counting itself happens on a phone in an aisle and wants its own screen.
- Putting a location on a line. A shipment is booked to one location, so an
  order that would ship from two buildings is not modelled. The seed only
  builds shipments that one location covers completely.
