# How a commitment measures itself

A commitment says: this customer will buy these parts between these two dates,
worth this much. Nobody types in how much has arrived. The database works it
out from the invoice ledger, every time a page asks.

Unless a section says otherwise, numbers were measured on the full world on
Supabase (Postgres 17, Micro compute) on 2026-09-17:

| Table | Rows |
|---|---|
| `nl.customers` | 4,490 |
| `nl.items` | 11,422 |
| `nl.invoices` | 114,555 |
| `nl.invoice_lines` | 450,522 |
| `nl.commitments` | 2,644 |
| `nl.commitment_items` | 12,491 |
| `nl.commitment_delivery` | 2,644 |

## The three views

1. **`nl.commitment_family`**: who counts as "the customer". A head office
   buys through its branches, and the branches bill to it, so a commitment made
   with the head office counts every account billed to it, at any depth. The
   walk comes from `nl.customer_family(customer_no)`, a recursive query that
   stops if bad data ever makes a billing loop.
2. **`nl.commitment_lines`**: every invoice line that counts. The line must
   belong to the family, be for a part in the commitment's scope, and be posted
   inside the window. Credit memo lines are negative, so returns take delivery
   back off.
3. **`nl.commitment_progress`**: one row per commitment, in one set-based pass.
   It reads the stored delivered figure (kept current by triggers, below),
   takes the latest answer to "the window closed short: what happened?",
   counts linked quotes, and derives the status:

   | Rule, checked in order | Status |
   |---|---|
   | Someone answered | their answer (`kept`, `pushed`, `broken`) |
   | Delivered is at least 95% of the committed value | `kept` |
   | Anything delivered | `delivering` |
   | A quote is linked | `quoted` |
   | Otherwise | `promised` |

   It also derives `needs_outcome` (the window closed short and nobody has
   answered) and `expected_value` (delivered, plus the owner's confidence
   times what remains).

The status is never stored, so it can never go stale. The detail page lists
the matching lines straight from `nl.commitment_lines`.

## The index behind it (migration 0005)

```sql
create index invoice_lines_delivery_idx
  on nl.invoice_lines (customer_no, item_no, posted_on)
  include (amount);
```

That is exactly the lookup `commitment_lines` makes: this customer, this
part, this date range. Because the index also carries `amount`, the sum
never visits the table (an index-only scan, `Heap Fetches: 0`).

## The slow plan, and the fix (migration 0007)

The first version of `commitment_family` was a recursive view over every
commitment at once. On the full world the board query took **10,963 ms**.

The planner guessed the recursive step would return 1.4 million rows. It
returned 6,488. Trusting its guess, it never used the delivery index: it
looked up invoice lines by part number alone, then threw rows away.

```
Nested Loop  (actual rows=737385)
  Join Filter: ((il.posted_on >= c_1.starts_on) AND (il.posted_on <= c_1.ends_on))
  Rows Removed by Join Filter: 14020184
  ->  Index Scan using invoice_lines_item_idx on invoice_lines il
  ...
  CTE Scan on family  (rows=1367874 estimated, 6488 actual)
Execution Time: 10962.975 ms
```

Two rewrites that kept the recursion inline did not help (15.8 s and 17.6 s):
the bad estimate followed the query wherever it went.

The fix moves the walk into a function that declares its own size:

```sql
create function nl.customer_family(p_customer_no text)
returns table (customer_no text, depth int)
language sql stable rows 3
set search_path = ''
```

`rows 3` tells the planner a family is small. The `set search_path` clause
also stops Postgres from inlining the function, so the planner keeps that
estimate instead of recomputing a bad one. With the right estimate it
visits each commitment's family on its own and reads through the delivery
index:

```
Function Scan on customer_family f  (actual rows=2 loops=2644)
Memoize  (Cache Key: f.customer_no, ci.item_no)
  ->  Index Only Scan using invoice_lines_delivery_idx on invoice_lines il
        Index Cond: ((customer_no = f.customer_no) AND (item_no = ci.item_no))
        Heap Fetches: 0
Execution Time: 336.721 ms
```

| Board query, full world | Time |
|---|---|
| Before 0007 | 10,963 ms |
| After 0007 | 337 ms |

The results are the same. The tests check the family rules:
branches and the accounts billed to them count, unrelated accounts
do not, and a billing loop stops with each account counted once.

## Keeping delivered current (migration 0008)

After 0007 the board still measured all 2,644 commitments on every load,
including 2,557 kept ones from past years whose figure could only change if
the ledger changed. That cost grows with history, not with what the page
shows.

Delivered changes only when one of four things changes: invoice lines, a
commitment's items, a commitment's customer or window, or which account
bills to which. Statement-level triggers on those four tables work out which
commitments the change can touch and re-measure only those, in the same
transaction, into `nl.commitment_delivery`. The board reads the stored
figure. The status is still derived on every read.

| Trigger on | Re-measures |
|---|---|
| `invoice_lines` (insert, update, delete) | commitments on the line's account or any account above it, with the line's item in scope and its date in the window |
| `commitment_items` | that commitment |
| `commitments` (customer or window changed) | that commitment |
| `customers` (`bill_to_no` changed) | every commitment above the account, on the old chain and the new |

The triggers read the changed rows from transition tables, so an import of
a thousand lines re-measures each affected commitment once. The measuring
query fixes the commitment inside a lateral subquery, which puts the window
into the index lookup (`posted_on` becomes an index condition, not a filter).

Two things keep the stored figure honest:

- `nl.delivery_drift()` recounts every commitment through the live view
  (`nl.commitment_lines`, the code path from 0007) and returns any that
  differ. The tests require it to be empty after every kind of change,
  including over the whole seeded world. On Supabase it was empty after the
  full build.
- The nightly job calls `nl.repair_delivery()`, which re-measures anything
  that drifted and reports it. Nothing is expected; it is there so a bug
  would show up in the job log instead of on a card.

Nobody can write the table directly: `nl_app` has SELECT only, and the
measuring function is `security definer` with no EXECUTE grant (a test
checks both).

Migration 0009 then made the view ask for `nl.today()` once per query (a
scalar subquery becomes an InitPlan) instead of once per row. That was 15 of
the remaining 22 ms.

| Board query, full world | Time |
|---|---|
| Recursive view (0003) | 10,963 ms |
| Family function (0007) | 337 ms |
| Stored delivered (0008) | 22 ms |
| Today once per query (0009) | 6 to 10 ms |

## At four times the size

`db/bench/scale.sql` copies every customer, invoice, line, quote and
commitment with new keys, so the copies keep the shape of the business. On
the same Micro instance, at four times the full world:

| | Full world | 4x |
|---|---|---|
| Invoice lines | 450,522 | 1,802,088 |
| Commitments | 2,644 | 10,576 |
| Recount every commitment the 0007 way | 304 ms | 7,963 ms |
| Board, reading stored figures | 22 ms | 117 ms |
| Detail page lines for one commitment | not measured | 1.9 ms |
| One day of new invoice lines, with triggers | 169 lines, 38 ms | 676 lines, 324 ms |

The recount grew 26 times for 4 times the data. The cause was not traced
before the reset (index size against the instance's 1 GB of memory is the
first suspect). The board grew about 5 times, in line with the
number of commitments, and the 4x board figure was measured before 0009.

The run stopped at 4x: copying the ledger six more times in parallel filled
the instance's disk and Supabase switched the database to read-only. Freeing
space and rebuilding the full world took ten minutes. At ten times, the
disk needs to be sized first, and the copies loaded one at a time.

What would come next at larger sizes:

- The board still reads one row per commitment ever made. Kept commitments
  from past years could move to a settled table that the board counts but
  does not scan.
- A day's import re-walks the billing chain for each account on it. With
  thousands of accounts a day, a closure table of ancestors (maintained by
  the same family trigger) would replace the walk with an index lookup.
- `invoice_lines` could be partitioned by year; the delivery index would
  then be per partition, and old partitions would stay cold.

## Reproducing the numbers

On Supabase, as the app's role:

```sql
begin;
set local role nl_app;
select set_config('nl.user_id', '1', true);
explain (analyze, buffers)
select * from nl.commitment_progress;
rollback;
```

The exact board query is `listBoard` in `app/src/lib/server/commitments.ts`.

Check the stored figures against a fresh count (empty means they agree), and
repair any drift:

```sql
select * from nl.delivery_drift();
select nl.repair_delivery();
```

The 4x run is in `db/bench/scale.sql`. Run it only on a database nobody is
using, with enough disk, one copy per call.
