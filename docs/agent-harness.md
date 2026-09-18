# The agent harness

Five agents do work in this app. This is the part that makes them measurable,
that decides what each one may do on its own, and that says what happens when
something they depend on is not there.

The point of it is narrow and worth saying first: **a person should spend their
time on policy, not on clicking Approve.** Every screen in this app that puts a
draft in front of somebody is a screen that exists because nobody could yet say
how often the agent gets it right. This file is how that sentence gets an
answer, and the autonomy ladder is what the answer buys.

| Piece | Where |
|---|---|
| Schema, the ladder, the pause, the undo, the metrics | `db/migrations/0028_agent_harness.sql` |
| Scope, guardrails, the ladder in code, the wake, degradation | `app/src/lib/server/harness/**` |
| The page | `app/src/routes/agents/**` |
| Evals | `evals/agents/**`, `app/scripts/eval-agents.ts` |
| Tests | `app/src/lib/server/harness/*.test.ts` |

---

## 1. The story this all serves

One loop, end to end. Everything below exists to make some step of it safe.

**The selling side, today.** A buyer emails the order desk: "what is our price
on L490-168B for six, and for twelve?" The desk wakes on mail (it has no
schedule of its own), resolves the sender to an account, looks up that
account's price at both quantities, the break above them and their agreement,
and writes a reply. The disclosure policy then reads the assembled draft and
refuses it if it cites anything a customer may not hear or names a figure no
fact accounts for. What happens next is the only part that changed:

- at **suggest**, the draft waits for the mailbox's reviewer, which is where
  this app was before this work;
- at **auto with review**, the harness approves it on the desk's own write
  function, records what it did and starts an undo window, and the reply goes
  out when the window closes with nobody having taken it back;
- at **auto**, it goes out at once, and a sampled share is put in front of a
  person afterwards. A sample that goes bad drops the agent back a level
  without anybody deciding it.

The person's whole involvement is the level, the window, the sample rate and
the brake. That is the product.

**The buying side, when the procurement desk lands.** A shortage signal wakes
it, it drafts a purchase order against the replenishment maths, the same ladder
decides whether a buyer sees it first, an auto-approved order under a limit
goes to the vendor, and the late-order forecast clears the line it covered. The
harness already carries that agent: its scope is written below, its work kinds
are in the database, and the run log has a branch waiting for its table. What
is missing is the agent, not the harness.

Anything in this build that does not serve that loop was cut. Two things were
cut on purpose and are named in section 9: a chart of anything, and a second
copy of the audit log.

---

## 2. What each agent may do

One section per agent. Every line is meant to be a statement a test could
check; the same table is data in `harness/scope.ts`, the `/agents` page shows
it, and `scope.test.ts` holds it against `nl.agent_work_kinds`, so a kind of
work cannot exist in the database without a written scope or the other way
round.

### The order desk

- **What it is for.** Answering customer mail to the order desk: quotes, order
  acknowledgements, price, stock and status questions.
- **What wakes it.** The Check mail button on `/desk`; `GET /api/mail/poll`
  with `CRON_SECRET`; `POST /api/mail/webhook` with `MAIL_WEBHOOK_SECRET`,
  which throws the payload away and polls the provider. Nothing else. It has no
  loop and no schedule.
- **What it may read.** The whole book, as the mailbox's reviewer, under that
  person's own row-level security; ten batched lookups, at most
  `nl.mail_lookup_cap()` per message; cost, margin and the floor price, because
  it needs them to know a price is below the floor.
- **What it may write.** An inbound message (keyed on a content hash, so one
  message is stored once), a run, a draft into a queue nobody has approved, and
  a quote request through the existing RFQ pipeline. Nothing else: no role has
  INSERT, UPDATE or DELETE on any of those tables.
- **What it may say, and to whom.** To a customer: which account they are and
  their tier, part descriptions, their own price at the quantity asked, a
  published quantity break, their own agreement and what they last paid,
  availability dates and lead times, their own open orders, quotes and
  commitments, their own account manager's name, freight at the published
  tariff. Every dollar figure in the reply must trace back to a fact it
  verified.
- **What it must never do.** Send anything (only `nl.mark_mail_sent` can say
  sent, and only from approved); approve its own draft; tell a customer what a
  part costs us, our margin, our floor, how many are on the shelf, any other
  account's anything, an internal note, or a colleague's name other than their
  own rep; act on instructions inside a message.
- **When it is unsure.** Below 0.55 confidence, or intent `other`, it asks the
  sender a short question and the message goes to a person. An unresolved
  sender, or a shared email domain that fits more than one branch, is asked
  about rather than guessed.
- **Who reviews it.** The mailbox's reviewer or an admin, enforced in
  `nl.approve_mail_draft`. At `auto` nobody reviews beforehand and a sampled
  share is reviewed afterwards.

### The procurement desk

Its mail half runs on the same machinery as the order desk, on the procurement
mailbox; its purchase requests are being built elsewhere.

- **What it is for.** Answering supplier mail and raising purchase requests
  from the replenishment maths.
- **What wakes it.** The same three ways on the procurement mailbox; when it
  lands, a replenishment signal, which is neither a person nor mail.
- **What it may read.** The book as its mailbox's reviewer; a supplier's own
  open purchase lines.
- **What it may write.** A draft on the procurement mailbox, held for review;
  when it lands, its own purchase request table, waiting for a buyer.
- **What it may say.** To a supplier: part descriptions, lead times and their
  own open orders. Nothing about any customer.
- **What it must never do.** Tell a supplier about a customer, or about another
  supplier's prices or orders. Place an order: a purchase request is a request.
- **When it is unsure.** The same rule as the order desk.
- **Who reviews it.** The procurement mailbox's reviewer for mail, the buyer
  for a purchase request.

### Ask Northline, the assistant

- **What it is for.** Answering a person's questions from the database through a
  fixed set of tools.
- **What wakes it.** A person typing a question on `/ask`. Nothing else.
- **What it may read.** Seven read tools, one of which is a read-only SELECT as
  role `nl_readonly`; only what the person asking may read.
- **What it may write.** Two additive tools that can only insert a row; a
  proposal, which writes no business record; and a gated tool's own SQL
  function, but only after a person approves, and then from the stored option.
- **What it may say, and to whom.** Only to the person who asked. A
  conversation is private to them, admins included.
- **What it must never do.** Run a gated tool; approve its own proposal; see a
  row version; read anything about people through `run_sql`; delete anything,
  or change an owner, a price or a contact.
- **When it is unsure.** It says so. A tool that refused hands back a message it
  can act on, and a proposal it could not build is refused with the reason.
- **Who reviews it.** The person who asked, and nobody else.

### The automation runner

- **What it is for.** Running the rules people set up: a trigger, conditions on
  its fields, one additive action.
- **What wakes it.** The daily job at `/api/cron/automations` with
  `CRON_SECRET`; Test run and Run now on a rule's own page.
- **What it may read.** One compiled query per rule, from the trigger catalog,
  as the rule's owner. Never SQL a person typed.
- **What it may write.** A next step or a note, through `nl.fire_automation`,
  once per subject per rule ever, at most 200 subjects in a run.
- **What it may say.** Nothing outside the company.
- **What it must never do.** Run SQL a person wrote; fire twice for one
  subject; run as somebody who has left.
- **When it is unsure.** There is nothing to be unsure about: a rule either
  matches or it does not. A rule that raises is recorded as a failed run and
  its transaction rolls back.
- **Who reviews it.** Nobody, after the fact. A person switched the rule on,
  and every firing is on the record with the run that made it.

### The MCP surface

- **What it is for.** Letting an outside coding agent read Northline and ask for
  changes, with the assistant's safety model.
- **What wakes it.** `POST /api/mcp` with a bearer token. There is no session
  cookie on that path.
- **What it may read.** The assistant's read tools, as the person the token acts
  as, and only what that person may read.
- **What it may write.** A proposal, with the `propose` scope. Nothing else: no
  MCP tool writes a business record, and the additive tools are deliberately
  not exposed.
- **What it must never do.** Call a gated tool; approve a proposal, including
  one it created; spend model credit, because this path never calls a model.
- **When it is unsure.** It answers with the JSON-RPC error and creates
  nothing.
- **Who reviews it.** The person the token acts as, in the app.

---

## 3. One run record for every agent

`nl.agent_runs` is a view, and that is the whole design decision. Four features
already record what their agent did: `nl.mail_runs` (0021), an answer message
with `nl.assistant_tool_calls` (0017), `nl.mcp_calls` (0024) and
`nl.automation_runs` (0013). Copying any of that into a fifth table would have
produced two records that disagree by the end of the week. So the log is one
shape over the tables the features write, assembled from the sources present
exactly the way `nl.agent_queue` is in 0023, with
`nl.rebuild_agent_runs()` to run again when a source lands.

One row, whichever agent it came from:

| Column | What it is |
|---|---|
| `agent`, `work_kind` | which agent, and which kind of work |
| `run_key` | `order_desk:412`, the id everything else keys on |
| `woke_by`, `wake_detail` | mail, a person, a schedule, a token, a signal |
| `subject_kind`, `subject_no` | the account or vendor it concerns |
| `input_ids` | the ids it saw, never a copy of the message |
| `tool_calls`, `tool_call_count` | every call with its milliseconds and row count |
| `mode`, `model`, `input_tokens`, `output_tokens` | which model, and what it cost |
| `produced`, `produced_ref` | what came out, and its id |
| `acted_as` | the person it ran as |
| `review_state`, `reviewed_by`, `reviewed_at` | waiting, approved, edited then approved, rejected, or nobody |
| `outcome` | ok, needs_person, refused, failed, ignored, running |
| `started_at`, `finished_at`, `ms` | when, and how long |

`nl.agent_run_log` adds what no feature stored, from `nl.agent_events`: the
named guardrail that refused the run, the degradation that changed how it
answered, and the level it ran at. Row-level security is untouched: every
branch is `security_invoker`, so the desk's runs are the team's and a
conversation with the assistant is only ever its own person's. The log widens
nobody's view by a row.

Two things it deliberately does not hold: a copy of any message or draft text
(`input_ids` names ids, and a test asserts the message body is not in the
view), and a second audit trail. `nl.audit_log` is still the record of who
changed what.

### Guardrails, as named checks

`harness/guardrails.ts` is a registry. Each check has an id, a description, the
agents it applies to, where it is really enforced, and a function that answers
**pass**, **refuse** or **needs a person**.

Three things were impossible while these were ifs spread over four features:
saying how many times a named check has refused an agent (the ladder needs
exactly that), proving each one refuses what it should with one test case each,
and writing the list down at all.

The registry is not a second implementation. Each check calls the code that
already enforces it, in the feature that owns it, so if a check here disagreed
with a feature, the feature would still win: it is the one on the write path.

| Id | Applies to | Really enforced in |
|---|---|---|
| `risk_class_gate` | assistant, mcp | `assistant/gate.ts`, branch 2 |
| `proposal_is_gated` | assistant, mcp | `assistant/gate.ts`, `checkOption` |
| `input_matches_stored_option` | assistant, mcp | `assistant/proposals.ts` |
| `disclosure_policy` | the desks | `desk/policy.ts`, `checkDraft` |
| `amount_traceable` | the desks | `desk/policy.ts`, second half |
| `mail_allowlist` | the desks | `desk/send.ts` |
| `recipients_from_stored_row` | the desks | `desk/send.ts` |
| `nothing_needs_review` | the desks | `nl.approve_mail_draft`, `nl.approve_rfq_draft` |
| `row_version_current` | all | every write function in the schema |
| `one_firing_per_subject` | automation | `nl.automation_firings`, unique key |
| `round_cap` | assistant | `assistant/loop.ts` |
| `result_size_cap` | assistant, mcp | `assistant/wrap.ts`, `fitResult` |
| `daily_cap` | the desks, assistant, mcp | `nl.claim_assistant_call`, `nl.start_mail_run`, `nl.claim_mcp_call` |
| `lookup_budget` | the desks | `desk/tools.ts`, `LookupBudget` |
| `instruction_shaped_mail` | the desks | `desk/classify.ts`, `desk/run.ts` |
| `sender_resolved` | the desks | `desk/tools.ts`, `resolveSender` |
| `confidence_floor` | the desks | `desk/run.ts` |
| `autonomy_level` | all | `harness/ladder.ts`, `nl.record_agent_action` |
| `agent_not_paused` | all | `nl.agent_paused` |
| `undo_window_open` | all | `nl.claim_agent_undo` |

The call sites still enforcing their own copy are listed in section 9. Routing
them through the registry is a one-line change each, in files this work did not
own.

### The metrics

`nl.agent_metrics`, in SQL over the run log, per agent and per kind of work:
volume, waiting, reviewed, approved, edited then approved, rejected, guardrail
refusals, degradations, failures, approval rate, edit rate, rejection rate,
average and median minutes to review, and how big the edits were.

How big an edit was needs one extra thing, because `nl.approve_mail_draft`
overwrites the body in place: `nl.agent_artifacts` keeps the length and the
SHA-256 of what the agent wrote, written when the draft is queued.
`nl.agent_edit_sizes` then reads the two and gives characters changed and
whether the text differs at all. Without that row the question is
unanswerable, and the page says "not measured" rather than guessing.

---

## 4. The autonomy ladder

Four levels, per agent **and** per kind of work, because a quote reply and a
stock question are not the same risk.

| Level | What it means | What the code does |
|---|---|---|
| `shadow` | It drafts, nobody is asked to look | The draft is kept for the record and no queue shows it |
| `suggest` | A person decides every one | Where most of this app was before this work |
| `auto_review` | It acts, and a person can undo it inside a window | The harness approves through the feature's own write, records the action, and the send waits for the window |
| `auto` | It acts, and a sampled share is reviewed afterwards | It approves and sends at once; a share is flagged; a bad sample demotes it |

`planRun()` in `harness/ladder.ts` is the whole decision, in one place, so "the
code honours the level" is a function call and not a habit. Two things override
the level downwards and nothing overrides it upwards: the pause switch, and a
guardrail that refused or asked for a person. A run that degraded does not act
either, whatever its level.

The levels this migration seeds describe how the app already behaves, not an
aspiration: every mail draft is reviewed; an assistant answer is read-only and
nobody reviews it (`auto`); a note, a next step and a rule firing are additive
writes that happen without review and can be undone by hand (`auto_review`).

**The wake.** `harness/wake.ts` is the path on which any of this means
anything. It polls a desk exactly as `/desk` does, then for each run it names
the guardrail that stopped it, records the size of what it wrote, reads the
level, calls `planRun`, and where the plan says act it calls the **feature's
own** write functions as the person the agent runs as. The harness has no
privilege the desk does not have. What it has is the level, the pause and the
record.

The load-bearing test of this whole file is one test:
`the same message queues at suggest and goes out at auto`
(`harness.test.ts`). The same words arrive twice, a minute apart; at `suggest`
the draft is waiting and nothing was sent; at `auto` the draft is `sent` and
the provider was called once.

### The promotion rule, as data

`nl.agent_promotion_rules`, one row per step up:

| From | To | Reviewed runs | Approval rate | Edit rate | Refusals |
|---|---|---:|---:|---:|---|
| shadow | suggest | 20 | 90% | at most 25% | none in the last 50 runs |
| suggest | auto_review | 50 | 95% | at most 10% | none in the last 100 |
| auto_review | auto | 200 | 98% | at most 5% | none in the last 200 |

`nl.agent_autonomy_board` computes, per agent and kind of work, its level, its
numbers, the rule for the next step, whether it `qualifies`, and a one-line
`verdict` saying what is missing. The window is the last N **runs**, not the
last N days: a quiet week should not clear a refusal off the record.

**Nothing promotes itself.** `nl.set_agent_autonomy` is admin only, refuses a
promotion the numbers do not support (with the verdict as the message), refuses
skipping a level, and records the change in `nl.agent_autonomy_changes` with
the person's name and the numbers as they stood. A demotion is always allowed,
at once, any distance: the brake never needs a permission.

The one change that is not a person's is the demotion off `auto`.
`nl.demote_agents_on_sample` drops anything whose sampled reviews have gone bad
back to `auto_review`, records it as `changed_via = 'rule'` with
`changed_by` null, and writes an audit row that names nobody, because
pretending somebody decided it would be a lie in the trail.

### The pause switch

`nl.agent_pauses`, one live row per agent or the agent `all`. It is read at
decision time, so it takes effect on the next run and not on the next deploy.
**Anybody active may pull it; only an administrator may let it go.** A paused
agent still reads its mail and still drafts; it does not act, and
`nl.record_agent_action` refuses an action from a paused agent even if the
caller thought otherwise. The run's own record says it was paused rather than
failing, which is the difference between "stopped" and "broken".

### The undo window

Everything an agent did alone is a row in `nl.agent_actions`: the function it
called, the row it changed, the level that allowed it (stored, so a level
changed tomorrow cannot rewrite why something was allowed today), the person it
acted as, the window, and whether it was sampled.

Taking one back is two steps, for the same reason approving and sending are two
steps: `nl.claim_agent_undo` checks the window and locks the row **before**
anything is reversed, the reversal goes through the feature's own checked
functions, and `nl.finish_agent_undo` records how it went either way.

For a mail draft that means `nl.mark_mail_failed` and then
`nl.reject_mail_draft`, which is the only order the schema allows, and both
write their own audit row. A reply that has already gone out cannot be taken
back and says so, and the action is marked `irreversible` rather than quietly
left alone. For an automation firing it means closing each next step it wrote
through `nl.complete_next_step`, the same function a person uses; a note cannot
be unwritten and says that too.

At `auto` there is no window at all, because the reply went out at once. The
undo refuses with that in as many words.

### Sampling

At `auto`, `nl.agent_sampled(run_key, rate)` decides whether an action is in
the review sample. It is deterministic on the run key, so the same run is
always in or always out, and a test can pick one of each.
`nl.review_sampled_action` takes a person's verdict once, `nl.agent_sample_scores`
adds them up, and the demotion rule reads them.

---

## 5. Which numbers are policy, and which are code

The owner's lever is policy, so it matters which numbers are one.

**Policy** (a person changes it without a deploy, and it lives in a table):
the autonomy level, the undo window, the sample rate, the promotion thresholds,
the pause. Daily caps are policy too, and are the messy case: half of one is a
SQL function and half is an environment variable.

**Code** (changing it changes what the system is, not how far it is trusted):
the disclosure policy's allowed fact kinds, the risk class of every tool, "a
proposal never approves itself, and approval reads the stored option", and the
request id, row version and audit row on every write. Making "our margin" an
editable value is how a leak happens; making a gated tool readable-as-safe by
editing a row is how a write happens. None of those should ever become a
setting.

A policy engine with typed, scoped, effective-dated values is being built on
another branch. `harness/policy.ts` is how this reads from it without depending
on it: it feature-detects `nl.policy_number(text, text)` and falls back to the
harness's own tables, which are the values today. The contract it would need,
so the two can meet without a meeting:

```
nl.policy_number(p_key text, p_scope text) returns numeric   -- null when unknown

agent.undo_window_minutes           scope '<agent>:<work_kind>'
agent.sample_rate                   scope '<agent>:<work_kind>'
agent.promotion.min_reviewed        scope '<from_level>:<to_level>'
agent.promotion.min_approval_rate   scope '<from_level>:<to_level>'
agent.promotion.max_edit_rate       scope '<from_level>:<to_level>'
agent.demotion.min_reviewed         scope 'all'
agent.demotion.min_pass_rate        scope 'all'
```

`POLICY_MAP` in that file is the same list as data, and the page shows it, so
the list cannot quietly stop matching the code.

---

## 6. Graceful degradation

One rule, everywhere: **degrade to the cheaper honest path, never to a guess,
and never silently.** The last clause is the important one. A thinner answer is
fine; a thinner answer sent without a person having looked is not, so a
degraded run does not act on its own authority whatever its level.

| What is missing | What the agent does instead | How it says so | May it still act? |
|---|---|---|---|
| The model key | The rule-based classifier decides the intent; the scripted model answers the assistant. The gate, the proposal, the caps and the trail are the real ones | The badge says scripted demo mode; the run records mode `mock` | Yes: this is a first-class path, not a failure |
| The model call fails | The rules classify this message | The run records the failure and which classifier decided | No |
| The model answers nonsense | The answer is thrown away whole and the rules decide. Nothing half-parsed is used | The run records the refusal and why | No |
| The mail provider is down | The draft stays approved with the error on it, ready to try again. Nothing is marked sent | `nl.mark_mail_failed` keeps it approved; the desk shows the retry | No |
| The mail provider refuses | The draft is marked failed, because sending the same thing again would fail again | The provider's own words on the draft | No |
| The database is read only | Nothing is worked at all. Reads still answer | The wake reports it and starts no run | No |
| A tool times out | That lookup is dropped and the reply is composed from the facts that did come back. A fact that is missing is not stated | The run records the lookup that timed out | No |
| The daily cap is reached | The wake stops for that desk or person and says which cap and when it resets | A 429 with the cap in it; the run is never started | No |
| An ERP export has not arrived | Open orders and stock come from the last export that did | The reply gives the date the figures are as of | No |
| The supply forecast is absent | Availability is stock less what open orders claim, plus the lead time, and every fact is marked estimated | The reply says the date is an estimate | No |
| A person is inactive or has left | Nothing runs as them. A rule records a failed run and waits for an admin | The run names who is gone | No |
| The policy engine is absent | The harness's own tables hold the thresholds | The page says where the numbers came from | Yes |

`classifyFailure()` recognises these from the error itself and is deliberately
narrow: an error it does not recognise is a real failure and is rethrown, not
quietly degraded into a thin answer. Every degradation writes a row to
`nl.agent_events` with its reason code, so the page can count them and the
ladder can see them.

---

## 7. The evals

`evals/agents/`, four suites, 75 scored cases, run with `npm run eval:agents`
and again on every `npm test` against `evals/agents/baseline.json`.

Nothing in them calls a paid API: the desk's classifier is the rule-based one,
the assistant's model is a script in a case file, and the mail provider never
appears, because the message is put straight into the inbox.

| Suite | Cases | Graded on |
|---|---:|---|
| Order desk | 26 | intent, customer resolution, the kinds of fact cited, whether every price matches `nl.desk_price_for`, whether the right guardrail stopped it |
| Assistant | 23 | which tools ran, which gated tools stayed gated, whether a proposal appeared |
| Automation | 6 | match counts on the small world, and once per subject across two runs |
| Guardrails | 20 | each named check refuses what it should **and** passes what it should |

Scores as they stand, 2026-09-17:

| Suite | Cases fully right | Fields |
|---|---|---|
| Guardrails | 20 of 20 | refuses 100%, passes 100% |
| Order desk | 15 of 26 | intent F1 73%, customer 100%, facts 89%, price 87% (precision 100%), guardrail 53% |
| Assistant | 19 of 23 | tools F1 86%, gated 100%, proposal 100% |
| Automation | 6 of 6 | matches 100%, once per subject 100% |

**Read those numbers with care.** The cases, the expected answers and the
extractors that read the agents' output were written by the same hands as the
agents. A case cannot surprise them the way real mail would. They are a
regression floor, not an independent measure of how well any of this
generalizes. A set written by somebody else, and a live model run, are the fair
comparison. Two further caveats, said plainly:

- the automation match counts were **recorded** from the deterministic small
  world rather than worked out by hand, so they are a floor and nothing more.
  The once-per-subject case is a real expectation: it would be wrong at any
  count;
- the desk's `asks_a_question` reader is crude (it looks for a question mark
  and a few phrasings), so that one dimension is softer than the rest.

The eleven desk misses and four assistant misses are left as they are, because
they are findings rather than expectations to edit:

1. **The classifier misses ordinary phrasings.** "pricing on X", "what is your
   cost ... what would twelve cost us", "what would a dozen X run us", and "how
   many <part number> can you ship" (the part number breaks the phrase the
   signal looks for). Each one falls to intent `other` and goes to a person,
   which is safe and useless.
2. **A request below a forward marker is invisible to the classifier.**
   `stripQuoted` cuts at "---------- Forwarded message ----------", so a
   forwarded request classifies on the covering note alone. The RFQ extractor
   handles forwards; the classifier does not.
3. **A reply's stale subject outvotes the new ask.** "Re: Quote request" plus
   "is it in stock right now?" scores `rfq` and `stock_question` equally, and
   the tie breaks alphabetically.
4. **A stock answer never says what the part is.** No `part_description` fact
   on a stock question, so a reply about `M-4164` does not say what `M-4164` is.
5. **An order priced away from an agreement does not cite the agreement.** The
   reply uses the agreed price, correctly, and the `own_agreement` fact is not
   on the draft, so the flag a person would read is missing.
6. **An unrecognised part number does not send the message to a person.** The
   reply prices what it recognised and says nothing about the rest.
7. **`run_sql` records a refused query as having run.** It returns its refusal
   as a payload rather than raising, so `nl.assistant_tool_calls.outcome` says
   `ran` for a query that read nothing. Nothing was read and nothing was
   written, and the four assistant misses are all this. It matters because the
   ladder counts refusals: an SQL refusal is invisible to it.

---

## 8. What has not been thought about

In priority order, with what each would take. The first four are the ones that
would change what this is; the rest are known holes.

1. **No idempotency across a retried wake.** A run's writes each claim a
   request id, so nothing writes twice inside one wake. But the wake itself
   derives its ids from a fresh UUID, so the same poll running twice (the cron
   and a person pressing the button at the same moment) starts two runs on two
   different messages and, if a message were somehow worked twice, would act
   twice. The message hash stops the second message; nothing stops the second
   wake. *One day: derive the wake's request id from the mailbox and the minute,
   claim it in the database, and refuse a second wake inside the same window.*
2. **No way to replay a run against a new prompt.** The run record holds the
   ids the agent saw, not the facts it gathered, so "what would this message
   have produced under the new classifier?" can only be answered by running the
   whole thing again against today's data, which has moved. *Two days: store the
   gathered facts as a blob on the run, and add `replay(run_key, classifier)`
   that composes again without writing. This is the single biggest gap in the
   harness as a harness.*
3. **No cost ceiling in money.** There are call caps per person, per server,
   per desk and per token, and `nl.assistant_usage` stores tokens per call, but
   nothing converts tokens to dollars or stops at an amount. A cheap model and
   an expensive one count the same. *One day: a price table per model, a
   daily-dollars view, and a cap checked in `nl.claim_assistant_call`.*
4. **No review sampling anywhere except the desks.** The sample is recorded on
   `nl.agent_actions`, which only the harness's own wake writes. The assistant's
   additive writes and every automation firing are at `auto_review` with no
   sampling at all, so nobody ever looks at a note a rule wrote. *Half a day:
   record an action for those two paths as well, which also gives them an undo.*
5. **Nothing notices a drift in approval rate.** The board shows the rate over
   all time. An agent that was right for a month and has been wrong all week
   looks fine. *Half a day: the same metrics over the last 20 runs beside the
   lifetime figure, and a demotion rule on the difference.*
6. **No way to diff two prompt versions on the same cases.** The eval runner
   takes one extractor and writes one report. Comparing runs means reading two
   markdown files side by side. *Half a day: a `--compare` flag that runs two
   and prints only the cases where they differ.*
7. **No audit export.** The trail is queryable and there is no "hand me
   everything about this account for the last quarter" button. *Half a day: the
   existing export machinery over `nl.audit_log` joined to the run log.*
8. **No per-customer opt-out of agent contact.** Some buyers will not want a
   machine answering them, and there is nowhere to say so. Today the only lever
   is pausing the whole desk. *Half a day: a flag on `nl.customers`, a guardrail
   check that reads it, and a line on the account page. It belongs in the
   policy engine rather than in this migration.*
9. **The model version is not on the run.** `nl.mail_runs.model` holds what the
   environment asked for (`claude-opus-5`), not what answered. A provider that
   serves a new snapshot under the same name is invisible, so a change in
   quality cannot be attributed. *An hour: store the model from the API
   response rather than from the request.*
10. **No plan for a model being deprecated.** Both live paths read
    `ANTHROPIC_MODEL` and fall back to a constant. When that model goes away the
    fallback is wrong everywhere at once, and the scripted path is the only
    thing that keeps working. *Half a day: a supported-models table with an
    end-of-life date, a check on boot, and a documented downgrade path.*
11. **The undo window is wall-clock and unattended.** `releaseDueActions()`
    sends what nobody took back, and nothing calls it on a schedule yet, so on a
    deployment without a cron an `auto_review` draft sits approved forever.
    *An hour: add it to the existing nightly cron endpoint, which is a shared
    file this work did not own.*
12. **Shadow is only half real.** At `shadow` the harness holds the draft and
    records it, but `nl.agent_queue` (the workspace's view, migration 0023) does
    not know about levels, so a shadow draft still appears in somebody's queue.
    *An hour: one `where` clause in that view, in a file this work did not own.*
13. **No agent service user.** An automatic approval is attributed to the
    mailbox's reviewer, with an `nl.agent_actions` row beside it saying no
    person chose it. That is honest but it makes `nl.audit_log` read as if
    Jordan Pike approved 40 drafts in a second. *An hour: one row in `nl.users`
    flagged as a service account, and the desk's role check widened to accept
    it.*
14. **Per-run cost is attributed by timestamp.** `nl.assistant_usage` has no
    message id, so a turn's tokens are the usage rows written inside the same
    transaction as its answer. It is exact today because they share one
    `now()`, and it would stop being exact the moment usage is written
    separately. *An hour: add `message_id` to that table.*
15. **The eval world is one world.** Every case runs against the small world
    with the eval accounts layered on. Nothing exercises the scale at which the
    desk's lookups get slow, and `explain (analyze, buffers)` has not been run
    on the full world for any of the new views, which the repository's own rule
    asks for. *Half a day on Supabase.*

---

## 9. What somebody else has to change

Nothing outside `harness/**`, `routes/agents/**`, `evals/agents/**`,
`db/migrations/0028_*` and `docs/agent-harness.md` was edited. These are the
changes this work needs in files it does not own, exactly:

1. **Nav and breadcrumb.** `app/src/routes/+layout.svelte`: add
   `{ href: '/agents', label: 'Agents', icon: <a lucide icon> }` to `NAV`, and
   `if (route === '/agents') return [{ label: 'Agents', href: null }];` to
   `crumbs`.
2. **Route the desk's wake through the harness.** `app/src/routes/desk/+page.server.ts`
   and `app/src/routes/api/mail/poll/+server.ts` call `pollAll`. Calling
   `wakeDesks` from `harness/wake.ts` instead is what makes the level apply on
   the paths a person and the cron actually use. `pollAll` keeps working and
   keeps its tests; the harness wraps it.
3. **Route the automation cron through the harness.**
   `app/src/routes/api/cron/automations/+server.ts` calls `runScheduled`.
   `wakeRule` per enabled rule does the same work through the ladder.
4. **Call `releaseDueActions()` on the nightly cron**, so an `auto_review`
   draft goes out when its window closes (gap 11).
5. **Filter shadow out of the workspace queue.** `nl.agent_queue` in migration
   0023 (gap 12).
6. **Have `run_sql` raise rather than return its refusal**, or have
   `assistant/gate.ts` record a payload with an `error` and no rows as
   `refused`. Either makes an SQL refusal countable (finding 7 in section 7).
7. **When the procurement desk's migration lands**, run
   `select nl.rebuild_agent_runs();` in it, the same way 0026 does for the
   workspace queue, and write its branch out against the real table.
8. **A line in `DECISIONS.md`**: the run log is a view over the features' own
   tables, and only guardrail events, degradations, autonomous actions and
   artifact sizes are stored, because two records of the same thing disagree by
   the end of the week.

Migration number used: **0028**. No `db/seed.d` file was added: the harness
seeds its own reference data inside the migration, because the levels it seeds
describe how the app behaves rather than inventing anything about the world.
