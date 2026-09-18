# The MCP server

Northline speaks MCP, so a coding agent (Claude Code, Cursor, Codex) can read
the app and ask for changes. The point of it is that an outside agent gets the
same safety model as the in-app assistant: read tools answer directly, and
anything that would change a record becomes a proposal a person approves in
the app.

Files: `app/src/lib/server/mcp/**`, `app/src/routes/api/mcp/+server.ts`, the
connect page at `app/src/routes/settings/mcp/**`, migration
`db/migrations/0024_mcp.sql`. The safety model it reuses is in
[`assistant-gating.md`](assistant-gating.md).

**This endpoint is public on the internet.** There is no session cookie on an
MCP request, so `/api/mcp` is a public path and the bearer token is the only
thing protecting it. What that means in practice is in
[section 8](#8-what-a-stolen-token-gets-and-what-it-does-not).

## 0. The workflow, end to end

What a person actually does, in order. The rest of this document is the
mechanics behind each step.

**1. Sign in to the app as yourself.** The sign-in picker, no password. This
matters because the token you are about to mint acts as one person, and that
person is you.

**2. An admin mints a token** on `/settings/mcp`, choosing its scopes:
`read` alone, or `read` and `propose`. The secret is shown **once** on the
page that minted it and only its SHA-256 is kept, so a lost token is revoked
and replaced rather than recovered.

**3. Paste one line into your coding agent.** The connect page prints the
exact command or config for Claude Code, Cursor and Codex, with the endpoint
and the header filled in, plus a `curl` to try it with no client at all. For
Claude Code it is one `claude mcp add --transport http` command.

**4. Ask questions in plain language.** Your agent now has eight read tools:
find an account, read one in full with its open commitments and order lines,
read a commitment and what has been delivered against it, read a part with
its stock and lead time and twelve months of sales, list the windows that
closed short with nobody's answer on them, list what is waiting for a person,
try an automation rule without saving it, and run one read-only SELECT with
the assistant's own caps. Every one of them runs as **you**, through
`db.asUser`, so row-level security decides what comes back and the agent can
never see more than you could see on screen.

**5. Ask for a change, and watch it not happen.** There is no write tool.
The four `propose_*` tools create an item in the same approval queue the
people in the app already work from: answer a closed-short commitment, set a
commitment's confidence, decide an ERP export snapshot, save an automation
rule. The agent gets back the id of the proposal and the URL of the page to
decide it on.

**6. Approve it in the app.** Open `/workspace`, read what was proposed and
the facts it used, then approve, edit and approve, or reject. **The write
happens under your name, not the agent's**, with your session, your
authority and an audit row that says a person decided it. That is the whole
point of the split: the agent did the work, you took the decision.

**7. The agent can follow up.** `list_pending_approvals` shows what it is
waiting on, and the read tools confirm what changed once you have decided.

**8. Revoke the token when you are done.** Revoking is admin-only and
audited, and the token stays in the list afterwards as history rather than
disappearing.

### What this does not let you do

Drive the business unsupervised. A coding agent connected this way can read
everything you can read and can ask for four specific changes. It cannot
send an email, release a purchase order, change a policy, promote another
agent, or add so much as a note: `add_note` and `add_next_step` exist in the
in-app assistant and are **deliberately not exposed here**, because the
promise this endpoint makes is that an outside agent changes nothing without
a person.

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
| `scopes` | `read`, `propose`, or both |
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

## 3. What an agent can do

| Scope | Tool | What it does |
|---|---|---|
| `read` | `search_accounts` | find accounts by name, town or number |
| `read` | `get_account` | one account in full, with its open commitments and open order lines |
| `read` | `get_commitment` | one commitment, what has been delivered, the parts in scope |
| `read` | `list_windows_closed_short` | commitments whose window closed short with no answer yet |
| `read` | `get_part` | one part: stock, open orders, twelve months of sales, lead time |
| `read` | `run_sql` | one read-only SELECT, with the assistant's own checks and caps |
| `read` | `test_automation_rule` | try a rule without saving it |
| `read` | `list_pending_approvals` | what is waiting for a person, and the page to decide it on |
| `propose` | `propose_record_outcome` | ask to answer a closed-short commitment |
| `propose` | `propose_set_confidence` | ask to change a commitment's confidence |
| `propose` | `propose_decide_export` | ask to apply, release or discard an ERP export snapshot |
| `propose` | `propose_save_automation_rule` | ask to save an automation rule |

Every tool has a description written for an agent and a JSON Schema converted
from its zod schema, so `tools/list` is enough to use the server without
guessing. `tools/list` shows only the tools the token's scopes cover.

The list is **built from the assistant's registry**
(`app/src/lib/server/assistant/tools.ts`), not written a second time. A tool's
risk class there decides what happens here:

- `read` is exposed as itself;
- `gated` is exposed as `propose_<name>` and never as itself;
- `additive` (`add_note`, `add_next_step`) is **deliberately not exposed**.
  Those two do insert a row, and the promise this endpoint makes is that an
  outside agent changes nothing without a person. An agent that wants a note
  written asks a person for one;
- `propose_action` is the assistant's own plumbing and is not exposed either.

A `propose_*` tool takes the gated tool's own input plus a required `summary`,
which is the sentence the person deciding reads.

## 4. What an agent cannot do

- **Call a tool that writes.** `record_outcome`, `set_confidence`,
  `decide_export` and `save_automation_rule` are not in the list at all, so
  there is no input that could run one. Asking for one by name is `-32602`
  with a message pointing at the `propose_` tool.
- **Approve its own proposal.** There is no approve tool, and `propose`
  scope does not create one. Approval happens on `/ask/<id>` in the app, by a
  signed-in person, through `assistant/proposals.ts`.
- **Read anything about people through `run_sql`.** That tool runs as role
  `nl_readonly`, which has no grant at all on `nl.users`, `nl.contacts`,
  `nl.activities`, the assistant's tables or `nl.mcp_tokens`.
- **See more than the person it acts as.** Row-level security is the same as
  in the app.

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
`failed`) with a note. Minting and revoking a token are in `nl.audit_log`. A
proposal's own trail is the assistant's: `nl.assistant_tool_calls` for the
`propose_action` call, and `nl.audit_log` for the turn, the decision and the
write.

That is what makes "a gated tool never ran" a query rather than a claim:

```sql
select count(*) from nl.assistant_tool_calls where risk = 'gated' and outcome = 'ran';
```

## 8. What a stolen token gets, and what it does not

The endpoint is on the public internet and the token is the only thing in
front of it. Somebody holding a valid token **could**:

- read the business book as the person that token acts as: accounts,
  commitments, parts, prices, margins, invoice lines, the ERP export, and
  whatever `run_sql` can reach as `nl_readonly`;
- create proposals in that person's name, which appear in the app for them to
  decide. That is noise in one person's queue, attributed to the token by
  label, and a proposal that is rejected is dead.

They **could not**:

- write any business record. There is no MCP tool that writes, and the gate
  refuses a gated tool before it parses its input;
- approve a proposal, including one they created. Approval needs a signed-in
  person and a session cookie;
- read anything about people: `nl.users`, `nl.contacts`, `nl.activities`, the
  assistant's conversations or `nl.mcp_tokens` are unreachable from `run_sql`,
  and no tool returns contact details;
- see another person's book, beyond what row-level security allows the person
  the token acts as;
- spend money. The MCP server never calls the model: it is tools and SQL, and
  Ask Northline's own API key is not on this path.

What to do about one: revoke it at `/settings/mcp`. It stops working on its
next call, `nl.mcp_calls` shows everything it did, and `last_used_at` keeps
being updated after revocation, so a token that is still being tried is
visible.

## 9. Connecting

Mint a token at **`/settings/mcp`** (an admin only), choose the person it acts
as, and copy the secret on the spot. The page fills the live URL and the fresh
token into every snippet below.

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
