# The data dictionary

Every field a person or an agent reads, in one sentence each: what it means,
what it is measured in, whether it came from the ERP or was worked out here,
and whether it may go outside the company.

It exists because of a question that kept coming back in different clothes.
Why is line revenue short of invoiced revenue (freight sits on the header, not
the lines). What does `replenishment` mean (the ERP words, verbatim: Purchase,
Prod. Order, Assembly). Is `delivered` on a commitment stored or worked out
(worked out, and then stored by a trigger, and a drift check proves the two
agree). An agent asking the same questions has nowhere to look at all: the
`run_sql` tool description lists table names in prose and nothing more, which
the UX audit called out.

## What is in it

```
nl.data_dictionary          one row per field
nl.describe_data(entity)    the same, as rows, for the assistant and MCP
nl.data_dictionary_gaps     where the dictionary and the schema disagree
/dictionary                 the page
```

A row carries:

| Column | What it is |
|---|---|
| `entity`, `field` | the table or view, and the column |
| `label` | what it is called on screen |
| `meaning` | one sentence, not a restatement of the name |
| `unit` | USD, days, pieces, ratio, percent, or empty |
| `source` | `erp export`, `app`, `derived` or `policy engine` |
| `derivation` | how it is worked out, in words, for a derived field |
| `example` | a value of the right shape |
| `shareable` | may an agent put this in something that leaves the building |

## Coverage

18 tables and views, 231 fields: the ones a person or an agent actually reads.

| | |
|---|---|
| Parts and accounts | `nl.items`, `nl.customers` |
| The ledger | `nl.invoices`, `nl.invoice_lines` |
| Commitments | `nl.commitments`, `nl.commitment_progress` |
| Open orders | `nl.open_order_lines`, `nl.open_line_allocation`, `nl.open_line_projection` |
| Stock | `nl.stock`, `nl.stock_moves` |
| Quotes and prices | `nl.quotes`, `nl.quote_lines`, `nl.customer_prices`, `nl.item_costs` |
| The policy engine | `nl.policies`, `nl.policy_types`, `nl.data_dictionary` |

Three of those views carry most of their columns through from the table
underneath. Those rows are copied from the table's own wording rather than
typed twice, filtered by what the view really has, so the two cannot drift
apart and a column the view drops does not leave a row pointing at nothing.

## The honest part

A dictionary nobody checks is worse than no dictionary, because it is believed
and wrong.

`nl.data_dictionary_gaps` returns three kinds of disagreement:

- `entity missing`: the dictionary describes a table that is gone
- `column not documented`: a column exists and nobody wrote it down
- `field is not a column`: a field was renamed or removed

The tests require it to be empty. That test fails the day somebody adds a
column to one of these tables, which is exactly when a dictionary starts to
rot. It cannot be quieted by deleting the row either: a second test holds the
list of tables the dictionary promises to cover. `/dictionary` shows the gaps
at the top of the page as well, because a reviewer should not have to run the
tests to find out.

Two more tests keep the writing honest rather than merely present: every field
has a meaning of more than twenty characters that is not just its own name
with the underscores taken out, and every derived field says how it is worked
out.

## Whether it may leave the building

`shareable` is the same question the order desk asks before it sends an email
(`app/src/lib/server/desk/policy.ts`), asked one level down, about the field
itself.

Inside only: cost, margin, the floor price, what is on the shelf, another
account's anything, internal notes, and the ids and names of colleagues.
A customer may hear their own commercial position: the part description, their
price, their agreement, their open order, their quote, the date it can ship.

The desk's own policy is still the thing that decides what goes in a draft.
This column is a second, cruder statement of the same rule, one level down,
where a tool that hands rows to a model can read it. Where they disagree, the
desk's policy wins, because it is the one with a test that reads the assembled
draft back.

## Asking it

```sql
select * from nl.describe_data('nl.items');   -- one table
select * from nl.describe_data(null);         -- everything
```

Fields come back in the order the columns are in, which is the order somebody
looking at the table would see them. The short name works too
(`nl.describe_data('items')`), because that is what an agent will try first.

`nl_readonly` may call it, so the assistant's SQL tool and the MCP server can
answer "what does this column mean" without a round trip through a person. The
tool itself is not wired up yet: that is a one-line addition to the assistant's
tool registry and the MCP server's read tools, both of which belong to other
branches. See the report for the exact call sites.

## The page

`/dictionary` is searchable, grouped by table, and filters to what may leave
the building. The search runs in the browser: the whole dictionary is a couple
of hundred short rows, so sending it once and filtering there is quicker than
a round trip per keystroke and keeps working on a slow connection.
