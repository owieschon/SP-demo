# The context engine

> "In messy real world environments, operators won't have all this data
> available cleanly in a spreadsheet. Some of it can be assembled from emails
> and documents taken over time. The point is for the agents to be able to
> pick up context by exploring data sources."

An operator's knowledge is not in one table. It is in an ERP export, a legacy
CRM dump nobody has cleaned since 2024, two years of mail, an attachment
somebody printed to PDF, and a note a rep typed while on the phone. An agent
that guesses at that is worse than useless. An agent that re-derives it on
every call is slow, expensive and different every time.

So this is a mill. Raw material goes in one end; what comes out is a
**compiled, versioned, cited context bundle** an agent reads in one query.

| Piece | Where |
|---|---|
| Schema, the rules, the read path | `db/migrations/0031_context_engine.sql` |
| The seeded mess, and the facts made out of it | `db/seed.d/90_context.sql` |
| Normalizing, recognizing, shared types | `app/src/lib/context/**` |
| Adapters, extraction, resolution, promotion, the build | `app/src/lib/server/context/**` |
| Pages | `app/src/routes/context/**`, `app/src/lib/components/context/**` |
| Tests | `app/src/lib/server/context/{parse,engine,bundle}.test.ts` |

---

## The five steps, each one a table you can query

```
   SOURCES            what we read from, and how far we trust it (1 to 5)
      |
   SOURCE DOCUMENTS   one row per thing read, POINTING BACK at the row it
      |               really lives in. No bytes are copied.
   CLAIMS             "this source says this attribute of this subject is this
      |               value", with the locator and the verbatim snippet.
      |               Several claims may disagree. A claim is not a fact.
   FACTS              the one current answer, chosen by a written rule or by a
      |               person, carrying the claims that support it.
   BUNDLES            facts plus durable know-how plus policy, COMPILED per
                      subject and purpose, content-hashed and versioned.
```

### 1. Sources, through adapters over what already exists

`nl.sources` is the key, the kind (`erp_export`, `crm_export`, `inbox`,
`attachment`, `manual`, `derived`), the name, a **trust tier from 1 to 5**, the
refresh cadence, when it was last seen and what it is authoritative for.

The tiers are the whole of what the promotion rule knows about a source, so
they are worth arguing about once and then trusting:

| Tier | Source | Why |
|---|---|---|
| 5 | ERP customer master, ERP open sales lines | The system of record for what it covers |
| 4 | Purchase orders customers send in | Their own words on their own paperwork |
| 3 | Order desk inbox, the mail archive, a hand entry | Written correspondence, or a rep who heard it |
| 1 | Legacy CRM export, March 2024 | Known to be dirty, and three years old |

`nl.source_documents` is one row per thing read, with `ref_table` and `ref_id`
pointing home. **Nothing is copied.** `nl.source_document_text(id)` follows the
pointer and reads the words out of the real row, and that is what makes the
verbatim-span guard enforceable in the database rather than a promise the
application keeps.

`registerSources()` in `sources.ts` is six small adapters over the stores that
already exist: the order desk's live inbox (0021), the mail archive, activity
notes (0003), hand entries, the legacy CRM export and the staged ERP snapshot
lines (0010). Each is guarded by a `to_regclass`, so a database missing a
branch registers the rest and says nothing about the one it does not have.

**Why the mail archive is its own table.** `nl.mail_messages` is the order
desk's *working queue*: the agent picks up everything in it nobody has
answered. Back-filling two years of correspondence into it would look to the
desk like sixty people waiting for a reply. So the archive is its own store and
the engine registers both. That is the point of adapters: one engine, several
stores, nothing copied.

### 2. Claims before facts, and how a claim gets its meaning

An extraction that does not land on a registered attribute **is not a claim**.
It is an unparsed item in a queue. The dictionary, not the extractor, carries
the meaning.

`nl.context_attributes` holds, per attribute: type, unit, allowed values,
plausibility bounds, freshness horizon, **disclosure class** (internal,
customer, public) and **the surfaces allowed to consume it**. That last column
is the answer to "how should this context be applied": a packaging requirement
reaches a quote and the shipping paperwork and never touches a price, because
the dictionary says so and not because an extractor decided.

The six surfaces are in `nl.context_surfaces`, each marked external or not:

| Surface | External |
|---|---|
| `internal_review` | no |
| `buying` | no |
| `quoting` | yes |
| `promising_date` | yes |
| `replying_external` | yes |
| `shipping_paperwork` | yes |

**Disclosure beats the surface list.** `credit_status_note` is listed on
`quoting` and marked internal: a person pricing a quote should see that the
account is on credit hold, and the customer must never be told. Being relevant
to a surface and being sayable on it are different questions, and that row is
the one that proves it.

**A parse is three separately checkable parts**, each with its own confidence:

- the **subject**, from entity resolution;
- the **attribute**, a dictionary lookup;
- the **value**, typed and normalized.

`nl.claims.confidence` is generated as the least of the three, because a
perfectly parsed value about the wrong customer is worth nothing. A claim
missing its subject is `unresolved`: kept, visible, never promoted.

**Scope is part of the parse**, and it is what makes context applicable. Every
claim carries `(customer, ship_to, item, item_family, vendor)` where null means
"all", plus a stored specificity score. On read, **most specific wins**, which
is the same precedence shape `nl.price_for` already uses, deliberately rather
than a second machinery. A certificate requirement can be customer-wide,
part-wide, or one combination, and both are facts.

**Effective dating, not just recency.** Four dates: `asserted_at` (when the
source says it was true), `captured_at` (when we read it), `valid_from` and
`valid_to`. "Your terms changed in March" is answerable, and a value past its
`valid_to` is not a fact any more.

### 3. Two-stage extraction, and a model is never alone

**Stage one** (`app/src/lib/context/recognize.ts`) is deterministic patterns
for the shapes that have a shape: payment terms, freight terms, carriers,
certificates, packaging and marking, a customer's own part number, a price
hold, a lead time, a minimum order, a buyer's replacement. Cheap, auditable,
the same answer every run, and it runs over everything.

**Stage two** (`extract.ts`) runs only on prose stage one found nothing in, and
only when there is enough of it to be worth a call. It must answer with a
dictionary attribute **and the verbatim span it read it from**, and then:

> **THE SPAN GUARD.** If the quoted span is not literally present in the source
> text, the claim is thrown away. Not lowered in confidence, not flagged:
> thrown away.

An invention with a citation on it is worse than one without, because it looks
checked. The model is injected, so the guard is tested with a fake one
(`parse.test.ts`). The same check runs again in `nl.record_claim` against
`nl.source_document_text`, so a caller that skips the TypeScript gets caught by
the database.

Every claim records its extractor **and its version**, which is what makes "one
bad extractor's output stops counting" a single statement
(`nl.revoke_extractor`, admin only) rather than a forensic exercise.

### 4. Validation before promotion

In order: **type**, **unit**, **domain** (is that actually one of our part
numbers, is that customer ours), **plausibility** (a 400 day lead time parses
and is still wrong), and a **cross-check** against the high-trust source (the
ERP knows whether an account ships on its own carrier account, so a hand entry
saying we pay the freight is caught).

A claim that fails is **not dropped silently**. It becomes a data-quality item
in `nl.context_review_items` with its snippet, beside the "I could not tell what
this means" queue, which is the same table with a different `kind`. Both are
first-class outcomes and both are on the second tab of the conflicts screen.

### 5. The promotion rule, written down and configurable

`nl.promote_claims(subject_kind, subject_id, attribute, request_id)`:

1. only claims that **count**: valid, effective today, above
   `promotion.min_confidence`, from an active source and an extractor nobody
   revoked, with a citation;
2. the winner is the **highest trust tier**, then the **most recent
   assertion**, then the **most corroborated**;
3. if a disagreeing rival is within `promotion.trust_gap_min` tiers of the
   winner **and** the disagreement is above `promotion.conflict_threshold`,
   nothing is promoted: a conflict is raised and a person decides;
4. a fact a **person** decided is never overwritten by this rule. It changes
   through `nl.resolve_context_conflict` and nowhere else.

Disagreement is a number from 0 to 1: two different strings are simply
different (1), two numbers are as far apart as the gap between them relative to
the larger, so 30 and 45 day terms disagree by a third and 44 and 45 hardly at
all.

The thresholds come from `nl.resolve_policy(text)` when the policy engine is in
this database, and from `nl.context_defaults` when it is not. `nl.context_setting`
feature-detects it with `to_regprocedure` and falls through quietly:

| Key | Default |
|---|---|
| `promotion.min_confidence` | 0.5 |
| `promotion.trust_gap_min` | 1 |
| `promotion.conflict_threshold` | 0.34 |
| `read.min_confidence` | 0.6 |
| `freshness.default_days` | 365 |

Every attribute has a freshness horizon, so `stale_after = asserted_at +
horizon`. A stale fact stays on the record, is **not served**, and asks to be
verified again. That is different from expired (`valid_to` in the past), and
both are different from missing. The screens keep the three apart because they
lead to different work.

---

## The read path: compile, do not assemble

`nl.context_for(entity_kind, entity_id, purpose)` **serves a compiled bundle**.
It does no assembling: one index lookup and a jsonb read.

A bundle (`nl.context_bundles`) holds the facts above the bar with their
citations, what has gone stale, what has expired, the playbooks in scope and
the policy values in force, with a content hash and a version.
`nl.compile_context_bundle` bumps the version **only when the hash changes**;
a recompile that finds nothing new moves `built_at` and leaves the version
alone, which is what makes a recorded version worth recording.

Three answers, and they are different things:

- **served**: context you may use;
- **served, `bundle_stale: true`**: the mill has not refreshed in 36 hours.
  Still the last good context, and it says how old it is, because an agent
  running on stale context and saying so beats an agent guessing;
- **served false**: nothing above the bar, either because nothing was compiled
  or because everything for that purpose has expired. It refuses with a reason
  rather than handing back an empty object that reads like "nothing is
  required here".

`nl.context_value(kind, id, attribute, item_no, ship_to)` answers one question
with scope precedence applied, for a caller that wants one value rather than a
bundle. `nl.context_bundle_version(...)` serves one frozen version, so an
evaluation replays against context that cannot move under it.

**Coverage.** `nl.context_coverage()` reports, per subject kind and attribute,
how many of the subjects that matter have a fresh fact, a stale one, or nothing
at all, worst first. `nl.context_gaps(kind, attribute)` names the subjects
behind a gap, heaviest first. That list is not a statistic, it is the work list,
and it is what sends an agent exploring.

**Measured:** on the `small` world under PGlite (Postgres 17 compiled to
WebAssembly, slower than the real thing), `nl.context_for` runs at a median of
7.5 ms and a p95 of 14 ms over 40 calls. The claim it holds to is that serving
a bundle is one index lookup and a jsonb read, not that WebAssembly is fast.
It has not been measured on the full world.

---

## Exploring, as a tool rather than a crawl

`explore_sources(subject, attribute?)` searches the raw material already in the
database for evidence about one subject and proposes claims with citations.

Three things it deliberately does **not** do:

- it does not write a fact. It writes **claims**. Promotion is a separate step
  with its own written rule, and keeping the two apart is what stops an
  exploration from deciding what is true;
- it does not send anything. There is no mail client in that file and no way to
  reach one;
- it does not invent. Stage one is patterns; stage two must quote.

Its answer says what it read, what it proposed, what it could not parse, and
**what would promote and what would go to a person** without doing either, so
an agent can report the state honestly instead of guessing at it.

`runContextBuild()` is the mill on a schedule: register what the stores hold,
read the coverage list, explore for the subjects that matter most worst gap
first, promote what the rules allow, and recompile only the bundles whose
content changed. `nl.context_build()` is the SQL-only half, for a schedule that
would rather call one function.

### Recording which context an action read

An agent that reads a bundle records the version on the **agent harness's own
run record** (migration 0028), as a named check called `context_bundle` with a
verdict of `pass`, or `degraded` when the bundle is behind. That is the
harness's own vocabulary for running on the last good thing and saying so.
`nl.context_reads` holds the same fact indexed by subject, which is what the
entity page reads to answer "which actions read which version of *this*
account's context"; the harness event is the record of account.

That gives three things a dashboard cannot: a reply can be explained after the
fact, an evaluation is replayable against a frozen bundle rather than a moving
database, and a bad fact can be traced forward to every action that used it.

---

## Two tiers of context

**Tier one is durable know-how**: how we quote, what a certificate of
conformance is, what "collect" means on our paperwork, how short stock is
allocated. Authored, reviewed, versioned, and not extracted from anything.
`nl.playbooks`, five of them seeded. It does not decay the way a fact does.

**Tier two is volatile fact**: this customer's freight terms, this vendor's
current lead time, who the buyer is now. Extracted, dated, decaying, cited.

An agent needs both, and confusing them is how a demo ends up either
hallucinating policy or re-deriving the obvious on every call. Both are
compiled into the same bundle, and a playbook marked internal stays out of an
external one exactly as a fact does.

### Compared with a documentation context mill

The build-and-version pattern is the same one a documentation context mill
uses: declared sources, an assembly step, a self-contained versioned manifest
handed to any agent. Two things are different here because the subject matter
is different. It is applied to **operational facts about entities** rather than
to documentation, so a bundle is per subject and per purpose rather than per
topic. And **citations and decay are added**, because a fact about a customer
expires and a document does not: every fact carries the words it came from, and
every attribute has a horizon past which it stops being served and starts
asking to be checked.

---

## Over MCP

The compiled bundles are exposed as MCP resources, so an outside agent gets
exactly what our own agents get, byte for byte, with its version:

```
northline://context/customer/1214/quoting          the current version
northline://context/customer/1214/quoting?v=7      that exact version
```

The payload is the same jsonb `nl.context_for` returns, which is what the test
comparing the two is comparing: one value with itself. There is a
`get_context` tool as well, for a client with no resource support, and
`context_coverage`, so an outside agent can see the gaps too.

**Wiring.** `app/src/lib/server/context/mcp.ts` is written and tested and is
**not yet registered** on the MCP endpoint, because `app/src/lib/server/mcp/**`
belongs to another feature. The two handlers and the one tool entry are at the
bottom of that file.

---

## The screens

`/context` is three screens and only three.

**Coverage** (`/context`) is the work list: the sources and their trust tiers,
then every attribute with how many of the subjects that matter are verified,
stale or missing, worst first. Each row opens to name the worst offenders and
carries the control that goes and looks.

**Conflicts and queries** (`/context/conflicts`) is where a person decides. Two
claims side by side with **both citations**, one click to accept either, and a
note for the record. The rule's preference is labelled and not pre-selected:
the whole reason the row exists is that the rule was not confident enough, and
putting a thumb on the scale would make the queue a rubber stamp. The second
tab is "could not tell": unparsed extractions, failed validations, and claims
with nobody to attach them to.

**One entity's context** (`/context/<kind>/<id>`) has two halves. The top is
what an *agent* reads: the compiled bundle for one purpose, with its version,
its hash and its age. Switching the purpose changes which facts are in it,
which is the dictionary's surfaces and disclosure rules working in front of
you. The bottom is the whole record: every fact including the stale ones, each
with the words it came from, its source, its date, its confidence and who
decided it.

**A fact is never shown without its citation.** Not behind a click, not in a
tooltip. The snippet is the reason to believe the row, so it is part of the
row. Where the source has a page in this app, the citation links to it.

---

## What a real deployment would add

Everything in this repository is a demo on invented data. Here is the honest
line between what is real machinery and what is scaffolding.

**What would be added:**

- **Connectors.** The adapters read stores that are already in this database.
  A real deployment replaces each one with a connector that pulls from the
  system itself: an ERP API or a nightly file drop, a CRM's REST API, a mail
  provider. The `nl.sources` row, the trust tier, the source document and the
  pointer home all stay exactly as they are; what changes is where
  `registerSources` gets its rows.
- **OAuth and secrets.** Mail and CRM connectors need a per-tenant OAuth grant,
  token refresh and a secret store. None of that exists here, and none of it
  touches anything below `nl.source_documents`.
- **Incremental sync.** Adapters here re-register the most recent 500 rows per
  store and rely on an upsert. A real one keeps a cursor per source (a
  watermark, a delta token, a `since` id), handles deletions and backfills the
  history once.
- **Rate limits and back-off.** A provider will throttle. That is a connector
  concern and a queue, not a schema concern.
- **A document store.** Attachment bytes live in `nl.rfq_attachments` and
  `nl.mail_attachments` today, which is fine at this size and wrong at
  production volume. Bytes belong in object storage with the row holding a key.
  `nl.source_document_pages` (the text a reader produced) would stay.
- **A real stage-two model.** The prose extractor here is an injected interface
  whose default finds nothing. A deployment passes a real client. The span
  guard, the dictionary check and the validation ladder do not change, which is
  the point of them being outside the model.
- **Scale work.** Coverage walks the subjects that matter with a limit; on a
  book of fifty thousand accounts it would be materialized and refreshed. The
  bundle table would need a retention rule for old versions.

**What would not change:**

- the five steps and their tables;
- the dictionary as the place meaning lives, including surfaces and disclosure;
- the three-part parse and its three confidences;
- the scope tuple and most-specific-wins;
- the span guard, in both places;
- the promotion rule, its thresholds and the conflict queue;
- a person's decision beating the rule and being recorded as theirs;
- compiled, content-hashed, versioned bundles, and recording the version an
  action read;
- every fact carrying the words it came from.

---

## Tests

`npx vitest run src/lib/server/context --maxWorkers=1`: 79 tests in three files.

`parse.test.ts` (24, no database):

| Proves | Tests |
|---|---|
| "net 45" becomes 45 days with its unit, and only that column is filled | 1 |
| "3 to 4 weeks" becomes 21 to 28 days; a single figure becomes a range | 2 |
| Freight words, certificates, money and dates read onto their types | 4 |
| A backwards range, and a number given to a date attribute, are refused | 2 |
| Two facts out of one letter, each with its own line and whole-line snippet | 1 |
| A question is not an agreement | 1 |
| A customer's own part number is paired with ours and scoped to the part | 1 |
| The same thing said twice is one claim | 1 |
| A pattern for an attribute this dictionary lacks is skipped | 1 |
| Chasing one attribute reads only that one | 1 |
| A model claim whose span IS in the text is accepted, with the right line | 1 |
| **A model claim whose span is NOT in the text is thrown away** | 1 |
| An attribute not in the dictionary is refused and keeps its words | 1 |
| A value that will not type becomes a query rather than disappearing | 1 |
| A model is not asked when stage one already read the document | 2 |
| The span check folds whitespace and refuses a two-character "quote" | 1 |

`engine.test.ts` (33, on the small world):

| Proves | Tests |
|---|---|
| Three sources disagree and the highest trust tier wins, with the rule on the row | 1 |
| A high-trust source beats a newer low-trust one | 1 |
| A disagreement no source outranks goes to a person and promotes nothing | 1 |
| A disagreement under the threshold promotes, newest first | 1 |
| A revoked extractor's claims stop counting, and stay on the record | 1 |
| Revoking is an administrator's call | 1 |
| A person's decision beats the rule, is recorded as theirs, and survives the rule running again | 1 |
| A conflict that moved since the page loaded is a 409 | 1 |
| A claim with no citation is refused | 1 |
| An attribute not in the dictionary is refused | 1 |
| A snippet that is not in the source document is refused | 1 |
| A value that fails validation becomes a data-quality item with its words | 1 |
| A part-scoped attribute with no part is refused; so is a subject that is not ours | 2 |
| The same evidence read twice writes one claim | 1 |
| A customer-wide and a customer-plus-part requirement both hold, and the specific one answers | 1 |
| A fact past its horizon is stale, and is reported rather than served | 1 |
| A fact past its valid_to does not come back, and the bundle refuses with a reason | 1 |
| A buyer on file resolves; a shared domain asks a person; an unknown sender stays unresolved | 3 |
| An unresolved claim never becomes a fact | 1 |
| explore_sources writes claims and no facts, and says what would promote | 1 |
| It chases one attribute, and does nothing about one the dictionary lacks | 2 |
| nl.context_for serves only what is above the bar, and every fact has its citations | 1 |
| An internal attribute never reaches an external bundle, even on a surface it names | 1 |
| Nothing compiled refuses with a reason | 1 |
| Coverage reports an attribute the seeded mess never mentions, and is ordered worst first | 1 |
| Gaps name the subjects behind one, heaviest first | 1 |
| The seeded world has facts, a conflict, a stale fact, a query and playbooks | 1 |
| The seeded conflicts have both citations on them | 1 |
| The legacy export is still dirty: duplicates, a phone in a name field, two terms | 1 |

`bundle.test.ts` (22, on the small world):

| Proves | Tests |
|---|---|
| A recompile with no change does not move the version | 1 |
| Promoting a claim moves it, and the new fact arrives with its citation | 1 |
| Every earlier version still resolves, and does not have what came later | 1 |
| A playbook edit recompiles every bundle in its scope and none outside it | 1 |
| The house playbooks are in their surfaces' bundles | 1 |
| An internal playbook stays out of an external bundle | 1 |
| The version an action read is recorded and still resolves after recompiles | 1 |
| **The bundle it read goes on the agent harness's own run record** | 1 |
| Recording a read of a bundle that does not exist is a 404 | 1 |
| The MCP resource is byte for byte what nl.context_for returns | 1 |
| One frozen version by uri | 1 |
| A uri it does not recognise is refused rather than guessed at | 2 |
| The listing is real: every resource listed can be read | 1 |
| The tool answers the same way, and refuses a version that is not there | 1 |
| Coverage over MCP | 1 |
| The adapters are idempotent | 1 |
| The build works through the gaps and invents no citations | 1 |
| A SQL-only entry point a schedule can call | 1 |
| A stale bundle still serves and labels its age | 1 |
| The entity page gets all six purposes with their versions and ages | 1 |
| nl.context_for answers in single-digit milliseconds | 1 |

No test calls a paid API: the prose model is an injected interface and the
tests pass a fake one.
