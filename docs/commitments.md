# The history behind a commitment

A commitment says: this customer will buy these parts between these two dates,
worth this much. [`docs/sql.md`](sql.md) covers how it measures itself off the
invoice ledger. This file covers the other half: what the business already
knows about how that promise came about and how promises like it have gone
before.

The whole claim of this app is that an agent can answer a customer correctly
from what the business already knows. Before migration 0031 a commitment knew
four thin things about its own past:

- a quote was one flat row, so "what changed between revisions and why" was
  not a question the database could answer;
- the conditions a quote carries (a first article, a certificate, who pays
  freight, a price held through a date) lived in nobody's table, so a reply
  could promise something the quote had already ruled out;
- a window got one outcome answer, so a customer with three years of history
  looked exactly like one with none;
- a next step was a title, a due date and an owner, with no kind and no record
  of whether a person wrote it or an agent proposed it.

The sentence this app most wants to be able to say is an agent declining to
promise a date because this customer's last three windows slipped. That needs
history with a shape.

## What migration 0031 adds

| Table | What it holds |
|---|---|
| `nl.quote_revisions` | one row per version of a quote: when it went out, who sent it, its validity window, what changed from the version before and why, and how that version ended |
| `nl.quote_revision_lines` | the lines of one version, with the pricing rule that set each price |
| `nl.requirements` | conditions attached to a quote or to a commitment, as structured rows |
| `nl.commitment_outcomes` (new columns) | what was promised and what had arrived when the window closed, the reason, and the window the business moved to |
| `nl.next_steps` (new columns) | the kind of work, whether a person or an agent proposed it, and a note |

Five views derive the rest. Nothing derived is stored.

| View | One row per | For |
|---|---|---|
| `nl.quote_revision_state` | revision | its total, its line count, whether it is the live version and whether it is still valid today |
| `nl.quote_state` | quote | version count, the latest version's total, and the outcome of the version that decided it |
| `nl.requirement_state` | requirement | the commitment it bears on, satisfied, overdue, and whether a price hold has lapsed |
| `nl.commitment_depth` | commitment | how much history stands behind it, including whether it is bare |
| `nl.account_sales_record` | account | settled windows by how they ended, quotes by whether they won, and the pattern |

## Quotes have versions, and a version can lose

A quote nobody has revised has no revision row at all: `nl.quote_state` falls
back to `nl.quote_lines` for it, which is what the RFQ approval and order desk
paths write. A quote that was revised carries version 1 (the first issue) and
every version after it, each with its own lines.

Two controlled vocabularies keep the counts countable.

```sql
select nl.revision_reasons();
-- first issue, price increase, quantity break, lead time, freight added,
-- scope change, customer request

select nl.loss_reasons();
-- price, lead time, no decision, competitor,
-- requirement we could not meet, customer cancelled the project
```

Each version ends as `open`, `won`, `lost`, `expired`, `superseded` or
`withdrawn`. A version that lost has to say why, from the vocabulary:

```sql
constraint quote_revisions_loss_has_a_reason
  check (outcome <> 'lost' or outcome_reason is not null)
```

A paragraph is not a reason. `outcome_note` is there for the rest of the
story, and a good share of losses carry one, but a note on its own is refused,
because counting losses by reason is the point of having the column at all.
The same vocabulary sits on `nl.commitment_outcomes.reason`, so a loss on a
quote and a broken window count into the same buckets.

Prices come from the app's own pricing precedence
([`docs/pricing.md`](pricing.md)) rather than a second path invented for the
seed. `nl_seed.quote_price` uses `nl.desk_price_for` when the order desk's
quantity breaks are there, `nl.price_for` when only the plain precedence is,
and the group discount when neither has landed. Each line records which rule
set its price, so a reader can see a figure was the tier price rather than a
guess.

What actually changed between two versions is not stored. The server compares
the two line lists and says it in words ("ZT-118 price up 5%, $100 to $105",
"ZT-204 taken off the quote"), which reads better as plain code than as SQL
and cannot fall out of step with the lines.

## Conditions are rows, not prose

An agent can only honour a condition it can read, so a requirement is
structured: a kind, the party who owes it, and the one attribute that makes
that kind actionable. The check constraints insist on the attribute:

| Kind | Must carry |
|---|---|
| `minimum_order` | `quantity` or `amount` |
| `price_hold` | `holds_until` |
| `delivery_terms` | `terms_code` |
| `freight_paid_by` | `party` |
| `first_article_inspection`, `certificate_of_conformance`, `packaging_and_marking` | nothing beyond the kind |

`detail` is for a person's words about the condition, never for the condition
itself. A requirement attaches to exactly one of a quote or a commitment
(`requirements_attached_to_one`): a condition on a quote travels with that
quote, a condition on a commitment outlives any one quote.

Satisfaction is a date and a name, never a flag on its own. A condition on a
quote that was won stays unsatisfied until somebody meets it, which is the
whole reason to keep it.

## The outcome trail

Every answer is a row, and every row carries what it was an answer about:

- `window_starts_on`, `window_ends_on`: the window that closed, because a
  commitment's own dates can move afterwards;
- `committed_value`, `delivered_value`: the figures as they stood;
- `reason`: from `nl.loss_reasons()`, on a pushed or broken answer only;
- `pushed_to_starts_on`, `pushed_to_ends_on`, `next_commitment_id`: where the
  business went.

`nl.record_outcome` fills the first four itself, so nothing has to be typed
twice. The nightly job's "pushed" answer fills them too, but never sets a new
window: it knows a quote went out afterwards, not what the customer agreed to,
so it must not invent one.

**A pushed window creates the next one.** When an answer names a new window,
the trigger `commitment_outcomes_open_pushed_window` opens the follow-on
commitment: same customer, same buyer, same owner, same parts, worth what the
first window did not deliver, and a note saying where it came from. It is
`security definer` for the reason `nl.measure_commitments` is (the insert
happens inside somebody else's write, and the policies on `nl.commitments` are
written for a person creating their own), and it writes an audit row naming
the answer that caused it, so nothing appears from nowhere.

## Next steps that behave like real ones

`kind` is one of call, send a quote, chase a purchase order, confirm a
condition, check stock, or other. `source` is `person` or `agent`, and
`next_steps_agent_is_named` insists the two agree: an agent proposal names the
agent, a person's does not. That is a column and not a habit in the title
because the point of letting an agent propose work is being able to see
afterwards how much of it was worth doing.

Overdue is measured against `nl.today()`, never the server clock. The world is
dated relative to a company date that a test can pin, and a step that is
overdue to the business is the only kind worth showing.

## What the seeded world contains

`db/seed.d/90_commitment_depth.sql` fills all of this in seven steps. Every
count is a per-row keyed draw rather than a quota, so the shapes hold at all
three sizes without a size-specific number anywhere in the file.

1. **More settled history.** The base world gave an account one to three
   settled commitments, which is not enough to read a pattern off. This adds
   nought to three more per account, on windows the account really bought in,
   over the last three years. About one account in seven is a difficult one
   whose windows mostly did not hold, and those get two to four.
2. **Snapshots** on the answers the base world already wrote.
3. **Second answers.** A window pushed long enough ago got another look: some
   were finally called broken, some named the new window and opened it.
4. **Quotes and revisions.** Nought to three quotes per commitment, one to
   four versions each. Nought is the standing arrangement. A commitment still
   at "promised" is left alone on purpose, because a quote on the record is
   what makes it "quoted".
5. **Conditions**, on about two quotes in five and about one commitment in
   four, some met, some owed, some owed past their date.
6. **Next steps**, nought to three per commitment, spread across overdue, due
   today, not urgent, done, done late and never done at all, with about a
   third proposed by an agent.
7. **Calls, emails and visits** in bursts around each revision, and a note
   against each answer. Quiet accounts stay quiet, and there is nothing after
   a loss on purpose: silence is the signal.

### Counts

Built with today pinned to 2026-09-17.

| | small | demo | full |
|---|---|---|---|
| Commitments | 18 | 288 | 3,425 |
| Quotes | 16 | 263 | 3,131 |
| Quote revisions | 21 | 501 | 5,929 |
| Revision lines | 84 | 2,032 | 24,111 |
| Requirements | 19 | 268 | 3,143 |
| Next steps on commitments | 20 | 259 | 3,097 |
| Outcome answers | 5 | 50 | 636 |
| Follow-on windows opened | 0 | 7 | 96 |
| Activity on commitments | 26 | 775 | 9,216 |

The small world is small enough that some of these are single figures; the
test asserts bands and a spread rather than any of these numbers, so the
generator can be tuned without breaking it.

### The spread

An even spread is the tell of generated data, so
`app/src/lib/server/commitments/depth.test.ts` asserts that the histograms are
lumpy: three or more distinct sizes of quotes per commitment and of next steps
per commitment, no single size holding more than three quarters of the world,
both ends present (commitments with nothing behind them at all, and
commitments carrying several quotes and a checklist), at least one account
with a poor record, and losses that carry a reason.

It runs against `small` and `demo` every time. `full` takes about half an hour
to build in PGlite, so it is opt in:

```sh
NL_WORLD_SIZES=small,demo,full npx vitest run --maxWorkers=2 src/lib/server/commitments
```

## What the screens show

**A commitment** (`/commitments/[id]`) gains four sections, streamed in behind
the figures: the quotes with every version and what moved between them, the
conditions as a checklist with what is still owed at the top, the outcome
trail oldest first, and the next steps with the overdue ones first. The page
keeps its one chart, the delivered bar, which already carries the 95% line and
the pace tick. Everything added is a list, a table or a figure with its
comparison in words.

**An account** (`/accounts/[customer]`) gains "Their record": kept, pushed and
broken counts, quotes won and lost, the loss reasons with their counts, and
the pattern as a small inline mark, oldest on the left. The page already has
its one chart (24 months of revenue), so the pattern is a row of ticks beside
a sentence that says the same thing in words, and the mark carries the whole
sentence as its accessible label. The record is measured over the billing
family, the same way the commitments section above it is.

## Reading it from SQL

```sql
-- This account's record, and why its quotes were lost.
select kept, pushed, broken, kept_rate, pattern, quotes_won, quotes_lost,
       top_loss_reason, loss_reasons
from nl.account_sales_record
where customer_no = '2599';

-- Everything behind one commitment, in one row.
select * from nl.commitment_depth where commitment_id = 3013;

-- Commitments with nothing behind them: the shape an agent can say least about.
select count(*) from nl.commitment_depth where is_bare;

-- Conditions still owed, soonest first.
select commitment_id, kind, required_by, overdue
from nl.requirement_state
where not satisfied
order by required_by nulls last;
```

`nl.commitment_depth` counts calls, emails and visits, and `nl.activities` is
a table about people that the assistant's read-only role has no grant on
anywhere, so that one view is granted to `nl_app` only. The other four are
about money and dates and are readable by both.
