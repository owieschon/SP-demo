# Roles: scope, authority and disclosure

Every screen used to show every row to everybody. Twelve rail entries, every
list unfiltered, and one column deciding one thing. A person signing in as an
account manager saw the same warehouse counts as the warehouse.

A role is not one fact. It is three, and they answer different questions.

| | Question | Where it lives | What it does |
|---|---|---|---|
| **Scope** | Which slice of the world is mine? | `nl.user_scope` | The default filter on every list, and what a person may ACT on |
| **Authority** | What may I decide, and up to what amount? | `nl.authority_grants` | Whether a decision lands on my home page at all |
| **Disclosure** | What may I be shown at all? | `nl.disclosure_grants` | Which facts go into a payload, by fact kind |

Migration `0031_roles.sql`, seeded in `db/seed.d/90_roles.sql`.

## Three things worth knowing

**Scope narrows actions, not reads.** A salesperson may read another rep's
account. That is how cover works, how a question gets answered when somebody is
out, and how search stays useful. So scope is not a row-level read wall on the
business tables: it narrows what a person may change (`nl.may_act_on`), it is
the default filter a list starts from, and it is what `nl.work_waiting_for`
searches. The only thing that hides a value from a reader is disclosure, and
that is enforced on the payload a page or a tool assembles.

**An agent is a principal in the same tables.** `nl.users` grew a `kind`
column, and the two desk agents are rows in it. An agent's mailbox is a scope
row, its autonomy level is an authority grant, its disclosure level is a
disclosure row. So one sentence is literally true: raising an agent's autonomy
is the same write as raising a person's approval limit. Both call
`nl.grant_authority`, both are audited, both are effective-dated. An agent has
no password and no session, so anything listing people says `kind = 'person'`.

**"Everything" is a granted row, not a default.** The ops manager, the sales
director and the chief executive hold every scope dimension because somebody
granted it, not because nobody said otherwise. A missing row means "nobody has
told us yet", and those two must never be the same thing.

## The home page is derived, not configured

There is no per-role page picker and no column chooser. `nl.work_waiting_for`
returns everything inside a person's scope that is waiting on an authority they
hold, and that is the home page. An entry with nothing behind it is hidden
rather than greyed, because a greyed control is a question and a missing one is
an answer. Hiding a rail entry hides the entry: every page stays reachable by
its URL and through the command palette.

## Who is in the seeded world

Six to sign in as, each with a home that fits on one screen:

| Person | Reads as | Their home holds |
|---|---|---|
| Ines Carver | Inside sales | Drafts to send, quotes running out |
| Lena Ortmann | Buyer | Coverage gaps, costs going up |
| Wes Tanner | Planner | Shortages on parts made here |
| Rae Sandoval | Warehouse | Picks, receipts, counts |
| Priya Raman | Ops manager | Policies, agent trust, what escaped |
| Hollis Vance | Chief executive | The whole business, drillable to a row |

The chief executive has the widest scope and nothing withheld, and
**deliberately almost no operational authority**: change a policy, review an
exception, override the margin floor. No approve-quote, no
release-purchase-order, no confirm-pick. Reading the business is not the same
as running somebody's queue, and none of that should pile onto a page meant for
seeing the whole place at once. Stepping into somebody's job is one deliberate
edit, because that person holds `change_policy`.

## What is not done, and it matters

**Eight write functions still read `nl.users.role` directly.** They were written
before this model existed and they check `role not in ('operations', 'admin')`:
`nl.stage_export` and `nl.decide_export` (0010, redefined in 0016),
`nl.add_vendor_contact` (0015), and `nl.post_stock_adjustment`,
`nl.post_count_session`, `nl.advance_shipment` and `nl.receive_transfer` (0019).

So the seed does **not** rewrite the role column. Everybody keeps the coarse
value they had, every write that worked before works now, and the finer preset
names exist in `nl.role_presets()` without being assigned to the original
fourteen people. Rae Sandoval is seeded as `operations` rather than `warehouse`
for exactly this reason, and it is the one place the two models rub against
each other in a way a reader can see.

The grants that will replace those eight checks are already seeded, for exactly
the people who pass them today, so converting the guards is a migration that
changes behaviour for nobody. It has not been written. Doing it means
recreating those eight functions with `nl.has_authority(...)` in place of the
role test, and it was not worth doing in the hours before a demo when the
alternative was leaving 73 tests red.

One consequence to know about: `/people` can move somebody between presets,
which writes that legacy column, and moving an operations person to a finer
preset would take those eight writes away from them until the conversion lands.

## What a real deployment would add

An identity provider's groups mapped onto presets, so joining a team grants the
scope rather than somebody remembering to. Per-tenant defaults, because a
distributor and a manufacturer disagree about what a planner decides. An
approval chain, so a quote over somebody's ceiling routes to whoever holds a
bigger one instead of simply not appearing.

What would not change: the three axes, scope narrowing actions rather than
reads, agents as principals in the same tables, and a home page derived from
what is waiting on you.
