# What compounds

Why this app is shaped the way it is, and what each part accumulates.

The premise worth arguing about: models are rented, code is close to free, and
any competent team can now build a screen that lists purchase orders. So the
interesting question is not what this app does. It is what it accrues that a
competitor with identical code would not have on day one.

## Five things that stay scarce

**Permission.** The right to act in somebody's name with money at stake. It
cannot be downloaded, bought or shipped in a release. It is earned through a
legible record and it accrues to whoever kept the record. This is why the
autonomy ladder and the run trail matter more than any screen here: what they
accumulate is a customer's willingness to let the system act unsupervised. See
[agent-harness.md](agent-harness.md) and [roles.md](roles.md), where an agent's
autonomy level is an authority grant, so raising it is the same audited write
as raising a person's approval limit.

**Decision and outcome pairs, with point in time context.** Every ERP has
transactions. Almost nothing records what was decided, on what information,
with which alternatives, and what happened next. We quoted and lost. We
promised three weeks and took five. We ordered at the reorder point and stocked
out anyway. This has a brutal property: **it cannot be backfilled.** A system
that overwrites state has already destroyed the ability to ask "was that a good
decision given what we knew then?" See [decision-records.md](decision-records.md).

**The policy corpus.** If a person's job is setting policy, then the
accumulated policy set is the company's operating knowledge written down for
the first time. Today it lives in a few heads and leaves when they retire.
Explicit, versioned and testable, it is worth a great deal to the customer
(succession, onboarding, consistency, surviving an acquisition) and it is the
reason nobody rips out the system holding the only written copy of how their
business decides things.

**The override corpus.** Every time a person edits an agent's draft instead of
approving it, that is a labelled correction from a domain expert, produced as a
byproduct of doing the work. Capture the diff rather than only the approval and
it becomes a correction stream that cannot be bought. Most systems throw it
away by recording "approved" and moving on.

**Position as the trust boundary.** Within a decade this business will be
reached by agents: the customer's, the supplier's, the freight broker's.
Whoever owns the surface those agents pass through, with policy and disclosure
enforced at that boundary, owns the relationship. That is the AI-native
position, and it is not "the app with the nicest screens". It is the policy
enforcement point. See [mcp.md](mcp.md) and the disclosure rules in
[desk-agent.md](desk-agent.md).

## What cannot be backfilled, so it gets collected now

Listed in rough order of how much it hurts to have skipped.

- **Every request we did not quote, and why.** Missed demand is invisible in
  every ERP on earth and is usually the largest number in the building.
- **Requirements as structured data.** Certificates, first article, packaging,
  marking, domestic content. The compliance regime gets stricter, never looser,
  and retrofitting a decade of PDFs is not possible.
- **Lot and serial genealogy, end to end**, so a recall is a query rather than a
  six week project, with material provenance beside it for tariffs, sanctions
  and domestic content rules.
- **The clock.** Time to first response, time to quote, time to cash, per kind
  of transaction. Rarely measured, and it tracks win rate harder than price.
- **Labour and machine actuals at the operation.** Without them, true cost is a
  guess with a spreadsheet around it.
- **Who knew what, when, and under whose authority.** When agents act, the
  evidentiary quality of the decision record is what separates a defensible
  business from an uninsurable one. The audit trail becomes a balance sheet
  item.
- **Counterfactuals.** Not only the vendor chosen but the three quoted; not only
  the price sent but the two considered. Without alternatives, causal questions
  are unanswerable later.
- **Confidence on every prediction, and a score on it.** A promised date with a
  stated confidence can be calibrated. One without can never prove it was
  trustworthy.
- **Human time per decision type.** The ROI story of the next decade is "here is
  what people used to spend their hours on", and almost nobody baselines it
  before automating it.
- **Data rights lineage at ingestion.** Whose data is this, under which
  agreement, may it train a model. Tag it on the way in or lose the answer.
- **The relationship graph.** People move between companies within an industry.
  The buyer who left one customer turns up at another, and the relationship
  cannot follow the person if it lives in a departed rep's notes.
- **Tacit rules of engagement per counterparty.** "Always call before a partial
  shipment." "Never quote them on a Friday." Structured, with provenance, which
  is what [context-engine.md](context-engine.md) is for.
- **Physical truth.** Weights, dimensions, photographs. Freight needs it now;
  vision based receiving and carbon reporting will need it next.

## Where the money is, for the customer

Each of these is dollarisable inside a quarter, and each is a rule plus a
signal rather than a new product.

- **Price leakage.** For a distributor a point of price is worth roughly eight
  to ten points of profit. Exceptions that outlived their reason, discounts
  nobody re-earned, freight given away, small orders that never covered their
  handling. Put an expiry and a re-justification on every exception and the
  margin arrives on its own.
- **Attach at quote time.** The bill of materials knows what else the customer
  will need. An agent completes every quote at no marginal cost.
- **Substitution instead of a lost order**, which needs the cross reference.
- **Cadence breaks.** The largest revenue problem in distribution is not churn,
  it is silent contraction of the retained base: the account that ordered
  monthly and now orders quarterly, unnoticed for a year.
- **Working capital.** Excess and obsolete with a disposal path, and terms
  arbitrage per order: when the supplier's terms are longer than the
  customer's, the order finances itself.
- **Freight.** Exhaust is heavy and bulky, so freight is a margin line rather
  than a footnote. Consolidation by lane and day, drop ship against stock, and
  billing it to whoever the terms say pays.
- **Supplier lateness as leverage.** Documented slippage is chargeback recovery
  now and negotiating power at renewal. See [pricing.md](pricing.md).
- **Compliance paperwork**, which is hours per order for defense and industrial
  customers and is a template over structured data.

The app answers the first, sixth and seventh of those today, and the
[value ledger](value-ledger.md) is where the money it found is itemised, each
line traceable to the action and evidence that produced it.

## Where the money is, for whoever sells the software

**Onboarding cost decides whether this is software or services.** Every new
customer's data is a mess. If a consultant maps it, gross margin is about 30%
and the company cannot scale. If an agent explores the sources and distils the
context, it is about 80%. The discovery machinery in
[context-engine.md](context-engine.md) is not a feature, it is the unit
economics.

**Outcome pricing needs proof, per action.** When agents do the work there are
no seats to sell. What replaces seats is a share of the margin recovered or the
expedite avoided, and that can only be charged for if it can be itemised and
traced. That is why the value ledger is closer to a billing system than to a
report.

**Cross customer priors, never cross customer data.** Aggregate signal is
legitimate and valuable: how long that class of part really takes from that
class of supplier, what a first article requirement does to cycle time, which
suppliers slipped this month across the network. A new customer starts warm.
A single tenant build, however cheap models make it, cannot have this, and it
is the clearest answer to "why not build it ourselves".

## Deliberately not built

These are company strategy rather than demo features. Written down because they
are the direction, not because anything here implements them.

- **Embedded finance.** A platform this shape sits beside a large flow of
  purchase orders and invoices, and it holds something no bank has: the decision
  quality behind each transaction, a supplier's real reliability, a customer's
  real payment behaviour. Better underwriting data than a credit bureau, with
  the trust record as the moat around it.
- **Inventory liquidity across a network.** One distributor's dead stock is
  another's stockout, for the same supplier part, this week. Anonymous until
  matched, and it clears better the bigger the network gets.
- **The supplier as the second side.** The same supplier receives many quote
  requests from the network. Sell the supplier a desk and both sides of every
  transaction run through the trust boundary, which makes the platform the
  market rather than a tool in it.
- **The data dictionary as the industry's schema.** If everyone maps to your
  shape, integration gets cheaper for you and dearer for everyone else. A moat
  that looks like a public good.
- **Evals as the category scorecard.** Customers cannot evaluate AI vendors.
  Whoever hands them the test defines what good means, and wrote the test.

## Two questions worth asking every customer

"What decision did you make this week that you would want a machine to make
next year, and what would it need to know?" That is the roadmap, the training
set and the trust map in one sentence.

"What would you never let a machine decide?" The boundary is data too, and it
moves. Tracking where it moves, per customer and per year, is the clearest
measure of trust actually earned.

## The short version

Most AI-native platforms will be commoditised, because the model does the work
and the model is rented. What is not rented is the harness around it: the
policies the customer wrote, the evals that prove behaviour, the permission
earned action by action, and the record of what was decided on what information
with what outcome. Data is exportable, code is free, models are
interchangeable. Earned permission is the only asset that does not move, and
offering to export everything else is what earns it.
