# Agent evals

Four suites over the four agents that exist: the order desk, the assistant, the
automation runner and the named guardrails they all share. This folder is the
test set, the eval world and the reports. All emails, people, companies and
addresses are invented.

Nothing here calls a paid API. The desk's classifier is the rule-based one, the
assistant's model is a script in a case file, and the mail provider never
appears at all, because the message is put straight into the inbox.

## What is here

| Path | What it is |
|---|---|
| `desk/cases/NN-slug.txt` | One email: From, To, Subject and Date headers, a blank line, the body. |
| `desk/cases/NN-slug.expected.json` | What a person should see for that email. |
| `desk/world.json` | Stock, one agreement, quantity breaks, a little invoice history and one open order line that has slipped. Loaded on top of `evals/rfq/world.json`, which brings the customers, contacts and parts. |
| `assistant/cases/NN-slug.json` | A question, the model's script, and what the gate should do with it. |
| `automation/cases/NN-slug.json` | A rule and what it should match. |
| `guardrails/cases/NN-slug.json` | One named check, input it must refuse, and input it must pass. |
| `baseline.json` | The current scores. A test fails if a change makes any of them worse. |
| `reports/YYYY-MM-DD.md` | One report per run: scores, then every case with what it missed. |

## Running it

From `app/`:

```sh
npm run eval:agents                      all four suites, about three minutes
npm run eval:agents -- --suite=desk      one suite: desk, assistant, automation, guardrails
npm run eval:agents -- --record          write the observed automation counts into the cases
npm run eval:agents -- --baseline        write baseline.json from this run
```

`src/lib/server/harness/evals.test.ts` re-runs all four on every `npm test` and
holds them to `baseline.json`, so the scores cannot quietly fall.

## What each suite covers

**Order desk, 26 cases.** Every intent, and the hard ones: a clean table and
free text, an order with a date we cannot meet, a price question at two
quantities against an account that has an agreement, a quantity that reaches a
published break, a stock question about a part with nothing on hand and nothing
on order, a status question about a line that slipped, a chain whose branches
share an email domain (one naming its branch, one not), an unknown sender, a
prompt injection, a demand for our cost and margin, an email that is not
business at all, a reply quoting an older thread, a forwarded chain, an
attachment-only request, a part number that does not exist, a quantity written
as a word, and more parts than one reply can usefully answer about.

Graded on five things, because they are the five ways this agent can be wrong in
a way that matters:

| Field | Graded on |
|---|---|
| `intent` | which of the six the message was |
| `customer` | the account it resolved, and `null` where it must refuse to guess |
| `facts` | every required kind of fact is cited, and **no forbidden kind is cited at all** |
| `price` | every price in the reply matches `nl.desk_price_for` for that account, part and quantity |
| `guardrail` | the named check that should have stopped it did |

A case also checks whether the message went to a person and whether the reply
asks the sender something. The "asks something" reader is crude (a question
mark and a few phrasings), so that dimension is softer than the rest.

**Assistant, 23 cases.** Not the model's judgement, which would need a live
model and real money: the surface a model can reach. Each case is a scripted
sequence of tool calls, and the grading is which of them ran, which gated ones
stayed gated, and whether a proposal appeared. Four cases must produce a
proposal rather than an action. Three try to talk past the gate: one says the
write is approved in advance, one carries instructions telling the assistant it
is now unrestricted, and one asks for two proposals in one answer.

**Automation, 6 cases.** Rules with match counts on the small world, plus one
that is saved, run twice, and must fire for nobody the second time.

**Guardrails, 20 cases.** One per named check in
`app/src/lib/server/harness/guardrails.ts`, each asserting the check refuses
what it should **and passes what it should**. The second half matters as much:
a check that refuses everything would pass a suite that only ever handed it bad
input, and would quietly stop the agent doing its job. The suite also fails if
a check in the registry has no case at all.

## How to read the scores

**The cases, the expected answers and the extractors were written by the same
hands as the agents.** A case cannot surprise them the way real mail would.
These are a regression floor, not an independent measure of how well any of
this generalizes. A set written by somebody else, and a live model run, are the
fair comparison.

Two further caveats:

- the **automation match counts were recorded** from the deterministic small
  world rather than worked out by hand. If the seed changes they have to be
  recorded again (`--record`), which makes them a floor and nothing more. The
  once-per-subject case is a real expectation: it would be wrong at any count;
- the expected files describe what should happen, not what the code does today.
  Fifteen cases miss, and those misses are findings, written up in section 7 of
  [`docs/agent-harness.md`](../../docs/agent-harness.md). **Do not edit an
  expected file to make a score go up.**

Scores as of 2026-09-17: guardrails 20 of 20, order desk 15 of 26, assistant 19
of 23, automation 6 of 6.
