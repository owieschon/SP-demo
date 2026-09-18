# The MCP server

Northline speaks MCP, so a coding agent (Claude Code, Cursor, Codex) can work
in the app. A token acts as one named person, so what it may do is what that
person may do. How far it goes without asking is one dial: its rung on the
same autonomy ladder every other agent in this app stands on.

Files: `app/src/lib/server/mcp/**`, `app/src/routes/api/mcp/+server.ts`, the
connect page at `app/src/routes/settings/mcp/**`, migrations
`db/migrations/0024_mcp.sql` and `db/migrations/0044_mcp_autonomy.sql`. The
safety model it reuses is in [`assistant-gating.md`](assistant-gating.md), the
ladder is in [`agent-harness.md`](agent-harness.md), the authority grants are
in [`roles.md`](roles.md) and the caps are in
[`policy-engine.md`](policy-engine.md).

**This endpoint is public on the internet.** There is no session cookie on an
MCP request, so `/api/mcp` is a public path and the bearer token is the only
thing protecting it. What that means in practice, at each rung, is in
[section 8](#8-what-a-stolen-token-gets-and-what-it-does-not).

## 0. The workflow

1. **Mint a token on `/settings/mcp`.** It acts as you and starts at
   **suggest**.
2. **Paste one line into your coding agent.** The page has the exact line for
   Claude Code, Cursor and Codex, with the token already in it.
3. **Work in plain language.** It proposes, you approve in `/workspace`. When
   you trust it, raise its level on `/agents` and stop approving.

### What the level actually changes

Only one thing: whether a change is written down for you to approve, or made.

| Level | A tool that changes a record | Who is asked |
|---|---|---|
| **suggest** | offered as `propose_<name>`. Calling it writes a proposal and nothing else | you, in `/workspace` or on `/ask/<id>` |
| **act with review** | offered under its own name. Calling it makes the change and starts an undo window | nobody, but you can take it back on `/agents` for 60 minutes |
| **act** | offered under its own name. Calling it makes the change | nobody. One in twenty is reviewed afterwards, and a bad sample drops it back a rung |

The reads never change: they answer at every level and write nothing.

Raising the level is `nl.grant_authority` against the token's own principal in
`nl.users`, which is the same call, the same table and the same audit row as
raising a person's approval ceiling. A token is a principal like any other.
There is no MCP-shaped permission any more.

### What stays enforced at every level

- **Row-level security.** The token runs as its person. It never sees more
  than they would see signed in.
- **The person's authority and its ceiling.** Before any change,
  `nl.mcp_may_act` asks `nl.may_approve` for `approve_agent_proposal` at the
  value at risk, which reads the grant and its effective dates.
- **The policy engine's cap.** The same function asks
  `nl.resolve_policy('agents.approval_threshold', ...)`, which is the policy
  type migration 0034 wrote for exactly this question ("the value up to which
  an agent may act without a person") and which can be set per account. Its
  built-in default is 0 and its own note reads "nothing yet", so an answer
  that came from the built-in default is read as unwired rather than as zero
  dollars; the test is `policy_id`, which is null when nothing matched.
  **Nothing in this database sets one today**, so the person's own ceiling is
  what binds until somebody adds a policy on `/policies`.

  Either limit refuses with a message naming its own figure and the amount.
  Neither one quietly turns the call back into a proposal: the agent asked to
  act, and the honest answer is that it may not.
- **The pause switch.** A live pause on `mcp` (or on `all`) refuses every
  call that would change anything, at every level including suggest. Anybody
  signed in can pull it; only an admin can let it go.
- **The guardrails and the record.** `nl.record_agent_action` re-checks the
  rung and the pause in the database and stores the level acted at, the person
  acted as and the undo window, so a caller that got the decision wrong is
  refused rather than trusted.
- **The tool's own function.** A change goes through `decideProposal`, which
  is the identical function the approve button calls. Not a copy of it. There
  is no check the in-app path makes that this path skips.
- **The day's cap and the log.** 200 tool calls per token per day, counted in
  the database, and a row in `nl.mcp_calls` for every call.

### A note on the seam in migration 0031

`nl.authority_limit_override` was left in 0031 as the place the policy engine
would eventually cap an authority's limit, and it is still the null stub. It
cannot work as written, for two reasons worth recording: 0031 runs before
0034, so its own feature detection of `nl.resolve_policy` always fails on a
fresh build; and it looks a policy up by the authority's bare name, while
`nl.policy_types.key` must be dotted, so `approve_agent_proposal` could never
be a policy type even with the function replaced. Fixing it means changing a
function every `nl.may_approve` call in the app goes through, which is a
separate job. `nl.mcp_may_act` asks the policy engine directly instead, which
keeps the blast radius on this path.

### A note on the scopes

There used to be two, `read` and `propose`, and they were a second permission
system: they answered the same question the level answers, and because every
gated tool was only ever exposed as `propose_<name>`, the scope that mattered
was always the smaller one. **Migration 0044 dropped the column.** Nothing
reads a scope to decide whether a call is allowed. The level decides which
tools exist for a token, and the database decides whether the write is
permitted.

`McpTool.gate` (`'read' | 'propose' | 'change'`) survives in the code and is
a **description**, not a gate: it feeds the annotations an MCP client shows and
the connect page's three lists. Nothing branches on it for safety.

## 1. The endpoint

`POST /api/mcp`, MCP over streamable HTTP, JSON-RPC 2.0. It handles
`initialize`, `tools/list`, `tools/call` and `ping`, and answers `-32601` for
any other method.

It is stateless: `sessionIdGenerator` is undefined and `enableJsonResponse` is
on, so there is no session id, nothing is held between requests, and a client
can send `tools/call` without an `initialize` first. Vercel functions do not
keep a process between requests, so a server that pretended to hold sessions
would break the moment a second instance started.

`GET /api/mcp` answers **405** with `Allow: POST` and the server's metadata in
the body (the name, the protocol, the methods, and the exact connect command).
A GET would otherwise mean "open a stream and hold it", which a stateless
serverless function cannot do.

The protocol layer is the official `@modelcontextprotocol/sdk` (pinned to
1.30.0): `Server` with two request handlers, and
`WebStandardStreamableHTTPServerTransport`, which takes a Web `Request` and
returns a Web `Response`, which is exactly what SvelteKit hands us.

One small kindness: the SDK's transport requires
`Accept: application/json, text/event-stream`. This server always answers with
JSON, so `server.ts` fills that header in when a client did not send it. That
makes the endpoint usable from `curl`, which the connect page suggests.

## 2. Tokens

A token is 32 random bytes, base64url, with an `nlmcp_` prefix so a leaked one
is recognisable. **Only its SHA-256 is stored** (`nl.mcp_tokens`). The secret
is shown once, on the page that minted it, and cannot be read back: a lost
token is revoked and replaced, never recovered.

A token has:

| Field | What it is for |
|---|---|
| `label` | what it is, in a person's words, so it can be recognised later |
| `user_id` | the person it **acts as**. Every query runs as them |
| `principal_id` | its own agent-kind row in `nl.users`, whose `agent_autonomy` grant **is** its level. Null on a token minted before 0044, which reads as `suggest` |
| `last_used_at` | set on every attempt, including an attempt with a revoked token |
| `revoked_at` | set once, never unset; the token stays in the list as history |

Checking one (`tokens.ts`, `authenticate`):

1. the `Authorization: Bearer <token>` header is read, and nothing else in the
   request is looked at until this passes;
2. the token is hashed, and the hash is what is looked up. The plain text is
   never sent to Postgres, so it cannot end up in a query log or a backup;
3. the hashes are compared with `timingSafeEqual`, so the response time says
   nothing about how many characters were right;
4. a token that was never minted, a revoked token, and a token belonging to
   somebody who has left all come back as **the same 401 with the same
   words**. The answer says nothing about which tokens exist.

Minting and revoking are admin-only, enforced in `nl.mint_mcp_token` and
`nl.revoke_mcp_token` rather than only on the page, and each writes a row to
`nl.audit_log`.

**A token acts as one person.** Everything it does afterwards runs through
`db.asUser(that person)`, so row-level security decides the rest and an
outside agent can never see more than the person could see in the app.

**And a token is a principal.** `nl.mint_mcp_token` creates an agent-kind row
in `nl.users` for it (ids from `nl.mcp_principal_ids`, a band clear of people
and of the two desk agents) and grants it `agent_autonomy` level 1, which is
`suggest`. The level is **not** a column on `nl.mcp_tokens`: a column would be
a copy of the grant, and a copy goes stale the first time somebody dates a
grant forward, so the token stores the principal's id and the level is
resolved on read by `nl.mcp_token_level`.

Reading the whole answer at once, which is what `authenticate` does:

```sql
select nl.mcp_token_autonomy(<token id>);
-- { level, work_kind, ladder, paused, pause, may_act, undo_window_minutes }
```

`ladder` in that answer is `nl.agent_autonomy_for('mcp', <work kind>)`, the
same function every other agent asks. The three rungs are three kinds of MCP
work (`propose`, `act_with_review`, `act`) so that each one carries the
parameter its own rung needs: an undo window is only meaningful at
`auto_review` and a sample rate only at `auto`, which is what the constraints
on `nl.agent_autonomy` already say.

## 3. What an agent can do

| From | Tool | What it does |
|---|---|---|
| every level | `search_accounts` | find accounts by name, town or number |
| every level | `get_account` | one account in full, with its open commitments and open order lines |
| every level | `get_commitment` | one commitment, what has been delivered, the parts in scope |
| every level | `list_windows_closed_short` | commitments whose window closed short with no answer yet |
| every level | `get_part` | one part: stock, open orders, twelve months of sales, lead time |
| every level | `run_sql` | one read-only SELECT, with the assistant's own checks and caps |
| every level | `test_automation_rule` | try a rule without saving it |
| every level | `list_pending_approvals` | what is waiting for a person, and the page to decide it on |
| suggest | `propose_record_outcome` | ask to answer a closed-short commitment |
| suggest | `propose_set_confidence` | ask to change a commitment's confidence |
| suggest | `propose_decide_export` | ask to apply, release or discard an ERP export snapshot |
| suggest | `propose_save_automation_rule` | ask to save an automation rule |
| act with review | `record_outcome` | answer a closed-short commitment, for real |
| act with review | `set_confidence` | change a commitment's confidence, for real |
| act with review | `decide_export` | apply, release or discard an ERP export snapshot |
| act with review | `save_automation_rule` | save an automation rule |
| act with review | `add_note` | write a note on an account |
| act with review | `add_next_step` | add a next step on an account |

Every tool has a description written for an agent and a JSON Schema converted
from its zod schema, so `tools/list` is enough to use the server without
guessing. **`tools/list` shows only the tools this token's level offers**, so
it tells an agent the truth about what it can do right now rather than listing
things it would be refused for. The connect page shows the whole roster, with
the lowest level each tool appears at.

The list is **built from the assistant's registry**
(`app/src/lib/server/assistant/tools.ts`), not written a second time. A tool's
risk class there, and the token's level, decide the shape it is offered in:

- `read` is exposed as itself, at every level;
- `gated` is exposed as `propose_<name>` at `suggest`, and under its own name
  from `act with review` up;
- `additive` (`add_note`, `add_next_step`) is not exposed at `suggest`, and is
  exposed under its own name from `act with review` up;
- `propose_action` is the assistant's own plumbing and is not exposed at all.

A `propose_*` tool takes the gated tool's own input plus a required `summary`,
which is the sentence the person deciding reads. A tool offered under its own
name takes the same `summary`, and it matters more rather than less there:
nobody is being asked to approve, so that sentence is the only record of why
the change was made.

## 4. What an agent cannot do, at any level

- **Call a tool its level does not offer.** The lookup in `server.ts` takes
  the level, so at `suggest` there is no tool called `set_confidence` at all
  and there is no input that could run one. Asking for it by name is `-32602`,
  and the message names `propose_set_confidence` instead. This replaced the old
  scope check: one question, asked in one place, so `tools/list` and
  `tools/call` cannot fall out of step.
- **Go above its person's ceiling.** `nl.mcp_may_act` refuses and names the
  ceiling. There is no downgrade path: an agent that asked to act and may not
  is told so.
- **Act while `mcp` is paused.** Checked in `act.ts` before anything is
  written, and again inside `nl.record_agent_action`.
- **Raise its own level.** `nl.set_mcp_token_autonomy` goes through
  `nl.grant_authority`, which calls `nl.require_role_authority()`, and no MCP
  tool calls it. A level is raised by a person on `/agents`.
- **Approve a proposal it left for a person.** There is no approve tool.
  At `suggest`, approval happens in the app, by a signed-in person. At the
  acting rungs it does not propose in the first place.
- **Read anything about people through `run_sql`.** That tool runs as role
  `nl_readonly`, which has no grant at all on `nl.users`, `nl.contacts`,
  `nl.activities`, the assistant's tables or `nl.mcp_tokens`.
- **See more than the person it acts as.** Row-level security is the same as
  in the app, at every level.

## 5. How a proposal works

A `propose_*` call goes down the assistant's own path (`mcp/propose.ts`):

1. the call is handed to the assistant's **gate** (`assistant/gate.ts`) as a
   `propose_action` naming one gated tool and its input. The gate is the thing
   that refuses to run a gated tool. It validates the input against that
   tool's own zod schema, reads the row version the write would be held to, and
   builds the label from the validated input, not from anything the agent
   wrote;
2. `nl.start_mcp_conversation` starts a conversation with mode `mcp`, so the
   proposal has a page a person can open. (It is a separate function from
   `nl.start_assistant_conversation`, which checks for mode `mock` or `live`
   inside its own body and belongs to migration 0017.)
3. `nl.save_assistant_turn` stores the question, the answer, the tool call and
   the proposal, and writes an audit row.

From then on it is an ordinary proposal in `nl.assistant_proposals`: a person
approves it in the app, and `assistant/proposals.ts` does the write with the
row version captured at step 1, through the same SQL function the pages use,
with a request id derived from the proposal so a double approval writes once.

The tool answers with the proposal's id, the conversation's id, and
`approve_at: /ask/<conversation id>`, so an agent can tell a person exactly
where to look. `list_pending_approvals` is how it checks later whether the
proposal was decided.

## 5b. How acting works

At `auto_review` and `auto`, a gated tool is offered under its own name and
`mcp/act.ts` runs it. The order is the safety model, and every step is a
refusal before a write rather than after:

1. **the brake.** `nl.agent_paused('mcp')`, asked of the database rather than
   of the identity read at the start of the request, because somebody may have
   pulled it in the seconds since;
2. **the person's authority and the company's cap.** `nl.mcp_may_act` asks
   two things of what is already there: `nl.may_approve` for
   `approve_agent_proposal` at `nl.mcp_action_amount(tool, input)`, and
   `nl.resolve_policy('agents.approval_threshold', ...)` for the account the
   call is about. That amount is the commitment's `committed_value` for a
   commitment tool and zero for the rest, because those move no money.
   Refused above either limit, with that limit's figure and the amount in the
   message;
3. **the proposal.** The change is still written down first, through
   `mcp/propose.ts`, because that is what validates the input against the
   gated tool's own schema and captures the row version the write is held to;
4. **the decision.** `decideProposal`, the identical function the approve
   button on `/ask/<id>` calls. Not a variant of it. This is what makes "the
   MCP path never skips a check the in-app path makes" a fact about one
   function rather than a promise about two;
5. **the record.** `nl.record_agent_action` stores the rung, the person and
   the undo window (60 minutes at `auto_review`, none at `auto`), re-checks the
   rung and the pause, and writes the audit row.

So the record afterwards says a proposal was created, approved by this token's
person, executed, and that no human clicked anything. `/agents` lists it with
an undo button while its window is open, and `nl.claim_agent_undo` refuses
once the window has closed.

`add_note` and `add_next_step` take a shorter path: they are additive, so
there is no proposal to make and no row version to hold, and they run through
the same gate the in-app assistant runs them through. They were withheld from
MCP entirely before 0044, and the reason given was that an outside agent must
change nothing without a person. That reason was really the absence of a dial.
With one, "a person said this agent may add a note for me" is an authority
grant like any other, so they are offered from `auto_review` up.

## 6. The caps

| Cap | Value | Where |
|---|---|---|
| Tool calls per token per day | 200 (`MCP_DAILY_PER_TOKEN`) | `nl.claim_mcp_call`, claimed before the tool runs |
| Bytes per tool result | 16 KB | `assistant/wrap.ts`, `fitResult`, the same function and the same constant the assistant uses |
| Rows per SQL query | 1,000 | `assistant/sql.ts`, in the wrapping query |
| Statements per SQL call | 1 | `assistant/sql.ts`, `checkReadOnlySql` |
| Statement timeout | 10 seconds | `db.asReadonly` |

The daily cap is counted in `nl.mcp_counters`, keyed by day and token, so
restarting the app does not reset the day. `initialize`, `tools/list` and
`ping` do not count against it. Over the cap is **429** with a sentence that
says which cap and when it resets.

A result over 16 KB loses rows from the end and comes back with
`truncated: true` and a note saying how many of how many fit, which is the
same behaviour the assistant gets.

## 7. The log

Every call gets a row in `nl.mcp_calls`: the token, the method, the tool, how
long it took, how many rows, and how it ended (`ok`, `refused`, `capped`,
`failed`) with a note. Minting and revoking a token are in `nl.audit_log`,
along with every change of a token's level (as `grant_authority`, on entity
`user`, naming the token's principal). A proposal's own trail is the
assistant's: `nl.assistant_tool_calls` for the `propose_action` call, and
`nl.audit_log` for the turn, the decision and the write.

**A change an outside agent made is a query, not a claim.** Everything it
wrote is its person's in `nl.audit_log`, exactly as if they had clicked
approve, and what says they did not is `nl.agent_actions`:

```sql
select a.acted_at, a.action, a.at_level, u.full_name as acted_as,
       a.undo_until, a.status, a.detail ->> 'token_label' as token
from nl.agent_actions a
join nl.users u on u.id = a.acted_by
where a.agent = 'mcp'
order by a.acted_at desc;
```

`at_level` is the rung it acted at, stored rather than looked up, so a level
changed tomorrow does not rewrite why something was allowed today.

The old version of this section claimed "a gated tool never ran" and offered
`select count(*) from nl.assistant_tool_calls where risk = 'gated' and
outcome = 'ran'` as the proof. That claim was true when every token could
only propose and it is **not** true any more, so it has been taken out rather
than left to mislead. What replaced it is the query above: not "nothing was
written" but "here is everything that was, at whose authority, and whether it
was taken back."

## 8. What a stolen token gets, and what it does not

The endpoint is on the public internet and the token is the only thing in
front of it. **A token at `act` is more dangerous than a token at `suggest`,
and pretending otherwise would be dishonest.** Here is what each one gets.

**At `suggest`** somebody holding a valid token could:

- read the business book as the person that token acts as: accounts,
  commitments, parts, prices, margins, invoice lines, the ERP export, and
  whatever `run_sql` can reach as `nl_readonly`;
- create proposals in that person's name, which appear in the app for them to
  decide. That is noise in one person's queue, attributed to the token by
  label, and a proposal that is rejected is dead.

They could **not** write any business record, because no tool at that level
writes one, and could not approve a proposal, because approval needs a
signed-in person and a session cookie.

**At `act with review`** they could also make the changes that token's person
is authorised for: answer a commitment, move a confidence, decide an export
snapshot, save an automation rule, add a note or a next step. Each one lands
on `/agents` with an undo button and a 60 minute window, and each one is in
`nl.agent_actions` and `nl.audit_log` immediately.

**At `act`** they could make the same changes with no window to take them
back. One in twenty is put in front of a person afterwards, and a bad sample
drops the rung back automatically (`nl.demote_agents_on_sample`).

**The mitigation is the same at every level**, and it is not the token:

- **the ceiling.** The person's `approve_agent_proposal` grant, at the value
  at risk. A person with no such grant cannot have an agent act for them at
  all, whatever their token's level says, and a person with a ceiling of
  10,000 cannot have one act on a commitment worth more;
- **the policy engine's cap**, `agents.approval_threshold`, company wide or
  per account, asked in the same function. Unset in this database, so it is a
  lever rather than a live limit today;
- **the undo window** at `act with review`, and the whole action trail on
  `/agents` at both acting levels;
- **the pause switch**, which anybody signed in can pull and which refuses
  every change immediately, at every level;
- **the day's cap**, 200 calls, and the log of every one of them.

They still could **not**, at any level:

- raise their own level. That is `nl.grant_authority`, gated on
  `change_policy`, and no MCP tool reaches it;
- read anything about people: `nl.users`, `nl.contacts`, `nl.activities`, the
  assistant's conversations or `nl.mcp_tokens` are unreachable from `run_sql`,
  and no tool returns contact details;
- see another person's book, beyond what row-level security allows the person
  the token acts as;
- spend money. The MCP server never calls the model: it is tools and SQL, and
  Ask Northline's own API key is not on this path.

**The demo's tokens stay at `suggest`.** Nothing in the seed grants a token
more than level 1, and `nl.mint_mcp_token` mints at level 1, so the acting
rungs exist and are reachable but are not where anything starts.

What to do about a stolen one: revoke it at `/settings/mcp`, and pull the
brake on `/agents` first if it is at an acting level, because that takes
effect on the next call without needing an admin. Revoking stops it on its
next call, `nl.mcp_calls` shows everything it did, and `last_used_at` keeps
being updated after revocation, so a token that is still being tried is
visible.

## 9. Connecting

[Section 0](#0-the-workflow) is the three steps. This is the exact text for
each client. Mint a token at **`/settings/mcp`** (an admin only), choose the
person it acts as, and copy the secret on the spot: the page fills the live URL
and the fresh token into every snippet below.

**Claude Code**

```sh
claude mcp add --transport http northline https://<host>/api/mcp \
  --header "Authorization: Bearer <token>"
```

**Cursor**, in `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "northline": {
      "url": "https://<host>/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.northline]
url = "https://<host>/api/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

Codex has moved its HTTP server settings between versions; if it does not take
this, check `codex mcp add --help`.

**Without a client**, to see that it is alive:

```sh
curl -s https://<host>/api/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 10. The tests

`app/src/lib/server/mcp/mcp.test.ts`, 37 tests against a real database
(PGlite), with today pinned to 2026-09-17. The ones that hold the promises
above:

| Claim | Test |
|---|---|
| `initialize` answers with the server's name and tools capability | `the protocol > answers initialize ...` |
| `ping` answers | `the protocol > answers ping` |
| Every tool has a real description and an object JSON Schema | `the protocol > lists every tool with a description and a JSON Schema` |
| No tool that writes is listed, under any name | `the protocol > does not list a tool that writes, under any name` |
| An unknown method is `-32601` | `the protocol > answers an unknown method with -32601` |
| A malformed request is a JSON-RPC error with no stack trace | `the protocol > answers a malformed request with a JSON-RPC error, not a stack trace` |
| GET says what this is and how to connect | `the protocol > tells a GET what this endpoint is and how to connect` |
| A valid token reads | `the token > lets a valid one read` |
| No token is 401 | `the token > refuses a request with no token` |
| A revoked token is 401, worded exactly like a made-up one | `the token > refuses a token that was never minted, and a revoked one, with the same words` |
| A revoked token's attempt is still recorded | `the token > still records that a revoked token was tried` |
| The plain text is never stored, in the token table, the audit log or the request log | `the token > never stores the token in plain text` |
| A read-only token calling a propose tool is 403, and writes nothing | `scopes > refuses a propose tool to a read-only token with 403, and writes nothing` |
| A read-only token is not even shown the propose tools | `scopes > shows a read-only token only the tools it can call` |
| A gated tool is never executed directly, whatever the input | `a gated tool > is not callable directly, whatever the input` (four inputs, including a row version, plus five more tool names; the commitment's `updated_at` and every business table count are unchanged) |
| A propose tool creates a proposal and writes nothing else | `proposing a change > creates a proposal and writes nothing else` (ten table counts before and after, and the commitment's row version) |
| The proposal is a draft with the row version it would write against | `proposing a change > stores it as a draft on an MCP conversation ...` |
| The trail records a proposal, never a gated tool that ran | `proposing a change > records the tool call as a proposal, never as a gated tool that ran` |
| `run_sql` cannot write | `the SQL tool > cannot write, whichever way it is asked` (insert, update, delete, drop, a write in a CTE, a write function inside a SELECT) and `> writes nothing while being asked to` |
| `run_sql` refuses a second statement | `the SQL tool > refuses more than one statement` |
| `run_sql` cannot read the tables about people, or the token table | `the SQL tool > cannot read the tables about people` |
| A result over 16 KB is truncated with a note | `the caps > truncates a result over 16 KB and says so` |
| The daily cap refuses politely and lets `tools/list` through | `the caps > refuses politely when a token has used up the day` |
| Every call is logged with its tool, its time and how it ended | `the log > has a row for every call ...` |
| Minting and revoking are in the audit log | `the log > records minting and revoking in the audit log` |

The assistant's own 91 tests still pass unchanged, which is the other half of
the claim that this reuses its safety model rather than copying it.
