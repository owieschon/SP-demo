# How a commitment measures itself

A commitment says: this customer will buy these parts between these two dates,
worth this much. Nobody types in how much has arrived. The database works it
out from the invoice ledger, every time a page asks.

All numbers below were measured on the full world on Supabase (Postgres 17,
Micro compute) on 2026-09-17:

| Table | Rows |
|---|---|
| `nl.customers` | 4,490 |
| `nl.items` | 11,422 |
| `nl.invoices` | 114,555 |
| `nl.invoice_lines` | 450,522 |
| `nl.commitments` | 2,644 |
| `nl.commitment_items` | 12,491 |

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
   It sums the lines, takes the latest answer to "the window closed short: what
   happened?", counts linked quotes, and derives the status:

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

The status is never stored, so it can never go stale.

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

## What is still left on the table

- The date range is checked after the index lookup (`Rows Removed by Join
  Filter: 263878`), because Memoize caches per customer and part, not per
  window. Putting the window into the lookup would cut that further.
- The board computes progress for all 2,644 commitments, then keeps the
  129 it shows. Most are kept commitments from past years. A settled
  commitment could store its final numbers once its window closes, but that
  would break "never stored"; at 337 ms it is not worth it yet.

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
