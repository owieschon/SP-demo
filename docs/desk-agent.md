# The desk agent

A customer emails the order desk. The agent works out what the message is,
looks up what is true for that particular account, writes a reply, and puts it
in a queue. A person approves it, and only then does anything go out.

It is not an inbox with one tool bolted to it. It reads the whole database,
and what it may *say* is decided separately from what it may *read*, in code,
after the reply is written.

| Piece | Where |
|---|---|
| Schema, write functions, quantity breaks | `db/migrations/0021_desk_agent.sql` |
| The desks and their inbox | `db/seed.d/70_desk.sql` |
| The agent | `app/src/lib/server/desk/**` |
| Shared types | `app/src/lib/desk/types.ts` |
| Pages | `app/src/routes/desk/**`, `app/src/routes/api/mail/**` |
| Tests | `app/src/lib/server/desk/*.test.ts` |

---

## What wakes it

The agent has no loop and no schedule of its own. It wakes on mail, three ways,
and all three land in `poll.ts`:

| Trigger | How it is let in |
|---|---|
| The **Check mail** button on `/desk` | The signed-in person |
| `GET /api/mail/poll` | `Authorization: Bearer $CRON_SECRET`, the same check as the nightly automation run |
| `POST /api/mail/webhook` | `Authorization: Bearer $MAIL_WEBHOOK_SECRET`, or the `x-mail-webhook-secret` header |

A wrong secret answers **401**. A server with no secret set answers **503**,
which is a different thing: "off" and "wrong password" have to be told apart on
a deployment checklist.

**The webhook does not trust its own body.** It reads the payload, throws it
away and polls the provider instead, so a forged POST cannot put a message in
the inbox; the secret only stops a stranger making the server do work. AgentMail
signs its webhooks with Svix (`svix-id`, `svix-timestamp`, `svix-signature` over
the raw body), which is stronger than a shared secret. Because the body is
discarded here, the shared secret is enough; a deployment that wanted the
stronger guarantee would add the Svix verification on top.

Storing a message is idempotent on a SHA-256 of its normalized content
(`nl.mail_content_key`: mailbox, sender, subject, whitespace-collapsed body,
minute of arrival). The column is unique, so the cron, the webhook and a retry
delivering the same mail write one row, and the same message is never worked
twice.

Each desk is worked **as its own reviewer** (`db.asUser`), so the agent reads
under exactly the row-level security a person would, and the drafts land in the
queue of whoever has to approve them.

Caps: at most 8 lookups per message (`nl.mail_lookup_cap`), 16 KB per lookup
result, and 60 runs per desk per day (`nl.mail_daily_cap`), counted in the
database so a restart does not forget.

---

## What it may read

A read-only tool layer over the database, in `tools.ts`. Every lookup is
batched over all the parts in the message, so a reply about three parts costs
the same budget as a reply about one, and every lookup is recorded on the run
with its name, input, row count and milliseconds.

| Lookup | What it answers |
|---|---|
| `resolveSender` | Contact address, then sender domain, then company name as written |
| `resolveItems` | The part numbers as written against the catalog |
| `priceLines` | `nl.desk_price_for`: their price at that quantity, and the break |
| `agreementsFor` | Their price agreements in force today |
| `pastPricesFor` | What they last paid for these parts |
| `availabilityFor` | `nl.available_to_promise`, else stock less open orders |
| `openOrdersFor` | Their open lines, with the forecast's projected date |
| `openQuotesFor` | Their live quotes and the commitments behind them |
| `vendorLinesFor` | A supplier's own open purchase lines |
| `freightFor` | `nl.freight_for`: the published tariff |

**Sender resolution and the shared domain.** A chain's branches share one email
domain. When the domain fits more than one account, the mail has to name the
city or the branch; if it does not, nothing is matched and a person is asked,
because quoting the wrong branch is a real mistake with real prices on it. An
address that matches no contact, no domain and no name gets a short reply asking
for the account number.

**Degrading gracefully.** `readCapabilities` feature-detects the other teams'
work at run time (`to_regprocedure`, `to_regclass`). Without the supply
forecast, availability falls back to stock less what open orders already claim,
plus a three-week lead time, and every fact it makes is marked *estimated* so
the reply says so. Without the documents work's attachment table, attachments
are kept in `nl.mail_attachments` and `document_attachment_id` stays null.

---

## What it may say, and to whom

`policy.ts` is the whole rule. It is not a paragraph in a prompt, because a
prompt is a request and this is a constraint. The check runs on the **assembled
draft**, after the words are written, so it does not matter whether the words
came from code, from a model, or from a model that had just read an email
telling it to ignore its instructions.

Every fact a draft cites carries a `kind`, the `ids` it came from, the `subject`
it belongs to (a customer number or a vendor number) and its dollar `amounts`.

Two things are checked:

1. **The kind must be allowed for this recipient**, and a fact *about somebody*
   must be about **this** recipient. "Their own price" is allowed; the same kind
   of fact about another account is not, which is why a fact carries a subject
   and not only a kind.
2. **Every dollar figure in the reply must trace back to one of those facts.** A
   figure nobody verified is the shape a leak takes: the facts list stays clean
   and the number appears in the prose. So the body is read back and each amount
   has to be accounted for.

| A customer may hear | A customer is never told |
|---|---|
| Which account they are, and their tier | What a part costs us |
| Part descriptions | Our margin |
| Their own price, at the quantity asked about | Our price floor |
| A published quantity break | How many are on the shelf |
| Their own agreement, and what they last paid | Any other account's anything |
| Availability dates and lead times | An internal note |
| Their own open orders, quotes and commitments | A colleague's name other than their own rep |
| Their own account manager's name | A supplier's orders or lead times |
| Freight at the published tariff | |

A supplier on the procurement desk hears part descriptions, lead times and
their own open orders, and nothing about any customer. Internally, everything
the agent found can be shown, which is what the message page does.

A draft that cites anything else is **refused**: the queue gets a row with the
reason on it and no sendable text, the message is marked *needs a person*, and
`nl.approve_mail_draft` refuses a held draft outright until somebody rewrites
it.

The agent reads cost and margin freely, because it needs them to know a price is
below the floor. It simply cannot cite them outside.

**Mail is data, never instruction.** The body is stored as it arrived and
nothing in it reaches a write function. Text written as instructions to a
machine is recognised (`looksLikeInstructions`), changes nothing about how the
mail is handled, and is put on the record so a person sees what was attempted.

---

## How it answers, per intent

Six intents: `rfq`, `purchase_order`, `price_question`, `stock_question`,
`order_status`, `other`. The rule-based classifier
(`classify.ts`) is the default everywhere, including for public visitors; the
live one (`claude.ts`) runs when the server has an Anthropic key. Both answer in
the same zod-checked shape with a confidence, so nothing downstream can tell
which ran. Below 0.55, or `other`, the agent asks a short question instead of
guessing.

The live model **classifies only**. It gets no tools, never sees a price and does
not write a word of the reply, so there is no path from anything it says to a
figure that leaves the building. Composition is deterministic (`compose.ts`).

- **rfq**: prices every line at the quantity asked for, names the next quantity
  break, gives availability or a date per line, the subtotal, freight at the
  published tariff, and a validity date 30 days out. The message is also put
  through the existing RFQ pipeline (`createDraft`, migration 0011) in the
  reviewer's name, so approving the quote and approving the reply are one flow.
- **purchase_order**: acknowledges it, lists what was ordered with the price
  used and the ship date we can hold to, says plainly what cannot be met by the
  date asked, and flags any line priced away from the account's agreement.
  It says in as many words that nothing is entered until the customer sees it
  confirmed.
- **price_question**: their price at each quantity asked about (digits and
  number words: "for six, and also for twelve"), the next break, their agreed
  price or what they last paid, and how long the price holds.
- **stock_question**: how many can ship now, when the rest can ship and why (a
  purchase order, a production order, or a lead time). Never a stock level.
- **order_status**: their open lines with the promised date and, where the
  supply forecast is present, the projected one, and a plain sentence about what
  is running late.
- **other**: one short reply saying what the desk handles and asking what they
  need.

---

## The queue and sending

The agent's only write is `nl.queue_mail_draft`. It cannot approve and it cannot
send. Every function in migration 0021 is `security definer` and **no role is
granted INSERT, UPDATE or DELETE on any of these tables**, so there is no way to
change a message, a draft or a run except through a function that checks the
rules first.

Approving:

- `nl.approve_mail_draft`: the mailbox's reviewer or an admin, nobody else
  (403). It takes an optional subject and body; a change is stored and sets
  `edited`. It holds on the row version, so a draft that moved since it was
  loaded raises a conflict.
- `nl.reject_mail_draft`: final, with a reason.
- `nl.mark_mail_sent`: the **only** way a draft reaches `sent`, and only from
  `approved`, and only with the provider's own message id. A table constraint
  says a sent draft has both a provider id and a sent time, and that nothing
  else has a sent time, so "nothing is sent until you approve" is a property of
  the schema and not a habit of the code above it.
- `nl.mark_mail_failed`: a provider that could not be reached leaves the draft
  **approved** with the error on it, so it can be tried again; a provider that
  refused the request sets `failed`, because sending it again would fail again.

Sending (`send.ts`), in order: the draft must be approved; every recipient must
be on `MAIL_ALLOWLIST`, checked on the server against the draft's stored
recipients and not against anything the browser sent (an entry starting with `@`
allows a whole domain); the send is idempotent on a request id derived from the
draft id and its row version at approval, so two clicks, a double submit and a
retry after a timeout send once. Everything sent comes from the stored row.

With **no `AGENTMAIL_API_KEY`**, the provider is the scripted mailbox
(`mock.ts`): invented messages built around real rows from whatever world is
loaded, and a "send" that records a simulated send and says so in the interface.
Everything else is the real path. With an empty `MAIL_ALLOWLIST`, a real
provider is refused outright.

### Environment

| Variable | What it does |
|---|---|
| `AGENTMAIL_API_KEY` | Live mail. Without it, the scripted mailbox. |
| `MAIL_INBOX_ORDERS`, `MAIL_INBOX_PROCUREMENT` | The two desk addresses, for the deployment's own reference; the addresses the app uses are the ones in `nl.mailboxes`. |
| `MAIL_ALLOWLIST` | Comma-separated. `buyer@shop.example` is one address, `@shop.example` is a whole domain. Empty means no real mail can be sent. |
| `MAIL_WEBHOOK_SECRET` | The webhook's shared secret. Unset means the webhook answers 503. |
| `CRON_SECRET` | The scheduled poll's secret (shared with the automation cron). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | The live classifier. Default model `claude-opus-5`. |

Live mail also needs the SDK: `"agentmail": "0.5.26"` in `app/package.json`.
`agentmail.ts` loads it through a dynamic import of a specifier held in a
variable, so the app builds, type-checks and runs on a machine where the
package is not installed; without it, live mail reports that it is off instead
of failing the build.

---

## Quantity breaks

`nl.price_for` (migration 0018) answers "what does this account pay for this
part". The order desk also has to answer "what does it pay for twelve of them",
which is a different question with a published answer, so `nl.quantity_breaks`
and `nl.desk_price_for(customer, item, quantity, date)` sit on top of it rather
than arithmetic in the app.

A break stacks on the price group discount and applies to the tier price, to
last paid and to list. It **never** cuts under an agreed price: the agreement is
the thing both sides signed. `desk_price_for` also returns the next break up, so
a reply can say "25 or more is $21.61 each" without a second question.
`below_floor` stays a flag and not a veto, exactly as in 0018.

---

## The tests, and what each one proves

`npx vitest run src/lib/server/desk --maxWorkers=1` gives 75 tests in two files.

`policy.test.ts` needs no database:

| Proves | Tests |
|---|---|
| A customer may hear their own price | 1 |
| Cost, margin and the price floor are refused | 3 |
| Raw stock is refused while an availability date is allowed | 1 |
| Another account's order and another account's data are refused | 2 |
| An amount in the body that no fact accounts for is refused | 2 |
| A vendor and a customer cannot hear each other's kinds | 1 |
| Internally everything is allowed | 1 |
| Money is read, part numbers and dates are not | 1 |
| Instruction-shaped mail is recognised and changes nothing | 3 |
| Each intent shape classifies, with a confidence and a reason | 6 |
| Quoted history is dropped before deciding | 1 |
| Quantities are read as digits and as words, and a size is not a quantity | 1 |
| The allowlist: one address, a whole domain, an empty list, junk entries | 4 |
| Cron and webhook: 401 wrong, 503 unset, 200 right, 401 missing | 4 |
| The scripted mailbox needs no key and says a send was simulated | 3 |
| A provider address splits into a name and an address | 1 |

`desk.test.ts` runs against the small world, today 2026-09-17:

| Proves | Tests |
|---|---|
| A poll works both desks and starts a run per message | 1 |
| Every message gets an intent, a run and a draft, and every draft waits | 2 |
| The same message is never worked twice, whatever the provider calls it | 2 |
| Waiting counts and the daily cap per desk | 1 |
| A buyer on file is matched; a shared domain is resolved or asked about; an unknown sender is asked | 3 |
| Each intent produces a draft with the right facts | 6 |
| An emailed request is linked to an RFQ draft in the reviewer's name | 1 |
| The lookup budget is respected and every lookup is recorded | 1 |
| Every price in every reply matches `nl.desk_price_for` for that account and quantity | 1 |
| Quantity breaks are applied and the next one is named correctly | 2 |
| Availability answers line up with the supply data | 1 |
| Cost, margin, the floor, other accounts and stock never reach a draft | 2 |
| A mail demanding cost gets its parts question answered and the demand flagged | 1 |
| A held draft cannot be approved | 1 |
| A draft nobody approved cannot be sent, in the code and in the database | 1 |
| Approval is the reviewer's or an admin's; anyone else gets 403 | 1 |
| A stale row version is refused | 1 |
| An edit is stored and marks the draft edited | 1 |
| A rejection is recorded and the draft can never be sent | 1 |
| A recipient off the allowlist is refused and nothing is sent | 1 |
| A simulated send is recorded and says so | 1 |
| Approving and sending twice sends once | 1 |
| A failed send leaves the draft approved and retryable | 1 |
| A refused send marks the draft failed | 1 |
| An empty allowlist refuses a real provider | 1 |
| A draft that does not exist is refused | 1 |
| The audit trail records the agent as `assistant` and a person as `ui` | 1 |

No test touches the real mail API or the Anthropic API: the mail client is
always passed in, and the live classifier is only reachable through an injected
API object.

---

## A worked example

This is a real run from the small world, with the scripted mailbox on.

**In**, to `order-desk@agentmail.to` from
`casey.esposito@kennebectruckparts.example`, subject "Second truck, same build":

```
Hi,

We are building a second truck to the same spec. Can you quote:

  L760-128B  qty 12
  S5-48KS  qty 2

Needed by October 5 if you can. Freight to Mobile please.

Casey Esposito
Service Manager
Kennebec Truck Parts
Mobile, AL
```

**What it did.** Classified `rfq`, 0.95 sure: "It asks for a quote, asks us to
quote." Matched the sender: "casey.esposito@kennebectruckparts.example is Casey
Esposito at Kennebec Truck Parts (1214)." Five lookups:
`resolve_items`, `price_lines`, `agreements_for`, `available_to_promise`,
`freight_for`.

**Out**, drafted, subject "Re: Second truck, same build":

```
Hello Casey,

Thanks for the request. Here is our quote for Kennebec Truck Parts:

  L760-128B  7" 60 DEG ELBOW 12" X 8" BLACK
    12 at $57.79 each, $693.48
    8 can ship now, the rest by Thursday, November 12 (56-day lead time)

  S5-48KS  5" X 48" CURVED STACK STAINLESS
    2 at $106.82 each, $213.64
    All 2 can ship from stock

Subtotal $907.12, before freight and tax.
Freight would be $23.46 at our published rate, and it ships free over $2,000.00.
This quote holds until Saturday, October 17.
One thing to flag about your Monday, October 5 date: L760-128B is not all there
until Thursday, November 12. I would rather say so now than let it slip.

Order desk
Northline Exhaust Co.
order-desk@agentmail.to
```

**The facts it cited**, which is what the disclosure check read:

| Kind | Fact | From |
|---|---|---|
| `account_identity` | Kennebec Truck Parts (1214), Elite pricing | `customer_no 1214` |
| `part_description` | L760-128B: 7" 60 DEG ELBOW 12" X 8" BLACK | `item_no L760-128B` |
| `own_price` | L760-128B at 12: $57.79 each, $693.48 the line. Agreed price in force since 2025-04-28, open ended | `1214`, `L760-128B`, qty 12 |
| `availability` | L760-128B: 8 of 12 can ship now, all 12 by Thursday, November 12 on a 56-day lead time | `item_no L760-128B` |
| `part_description` | S5-48KS: 5" X 48" CURVED STACK STAINLESS | `item_no S5-48KS` |
| `own_price` | S5-48KS at 2: $106.82 each, $213.64 the line. The price they last paid, on 2026-08-17 | `1214`, `S5-48KS`, qty 2 |
| `availability` | S5-48KS: all 2 can ship now | `item_no S5-48KS` |
| `own_price` | Subtotal for this quote: $907.12 | `1214`, 2 lines |
| `freight` | Freight on $907.12 is $23.46; free over $2,000.00 | subtotal 907.12 |

Note what is in the facts and not in the letter: the price rule for each line
(one is an agreement, the other is what they last paid). Note what is in neither:
the cost of either part, the margin on them, the floor price, and how many are
actually on the shelf. The agent looked all four up. It cannot cite them to a
customer, so it did not.

Nothing was sent. The draft sat in the queue at `/desk` until Jordan Pike
approved it.
