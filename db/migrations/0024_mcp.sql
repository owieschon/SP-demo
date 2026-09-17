-- 0024 An MCP server for the app, so a coding agent (Claude Code, Cursor,
-- Codex) can read Northline and ask for changes.
--
-- The rules that shape this migration:
--   * An outside agent gets the SAME safety model as the in-app assistant.
--     Read tools answer. Anything that would change a record becomes a
--     proposal in nl.assistant_proposals that a person approves in the app.
--     There is no path from here to a write, whatever the token's scopes are.
--   * A token is a bearer secret, so only its SHA-256 is stored. The secret
--     is shown once, when it is minted, and cannot be read back.
--   * A token acts as one named person. Everything it does runs as that
--     person, under the same row-level security as their own session.
--   * Every call is counted (per token per day, here in the database so a
--     restarted server does not forget the day) and logged.
--
-- Depends on 0001 (users, audit log, request ids) and 0017 (the assistant's
-- proposals). Nothing here is granted to nl_readonly: a token names a person,
-- and the SQL tool has no business reading credentials.

-- ---------------------------------------------------------------------------
-- Tokens
-- ---------------------------------------------------------------------------

create table nl.mcp_tokens (
  id           bigint generated always as identity (start with 7001) primary key,
  -- What this token is for, in a person's words: "Owen's laptop, Claude Code".
  label        text not null check (length(btrim(label)) between 1 and 60),
  -- The SHA-256 of the token, 64 lowercase hex characters. The token itself is
  -- never stored: minting shows it once and that is the only time anyone sees
  -- it. Unique, so the same secret cannot be registered twice.
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  -- The person this token acts as. Its reads and its proposals are theirs.
  user_id      int not null references nl.users (id),
  -- 'read' answers questions. 'propose' may also create a proposal for a
  -- person to approve. Neither one writes a business record.
  scopes       text[] not null check (
                 cardinality(scopes) between 1 and 2
                 and scopes <@ array['read', 'propose']::text[]),
  created_by   int not null references nl.users (id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  -- Set once and never unset: a revoked token stays in the list as history.
  revoked_at   timestamptz
);

comment on table nl.mcp_tokens is
  'Bearer tokens for the MCP endpoint. Only the SHA-256 is stored; the secret is shown once when it is minted (migration 0024).';

create index mcp_tokens_user_idx on nl.mcp_tokens (user_id);
create index mcp_tokens_live_idx on nl.mcp_tokens (revoked_at, created_at desc);

-- ---------------------------------------------------------------------------
-- What every call did
-- ---------------------------------------------------------------------------

create table nl.mcp_calls (
  id       bigint generated always as identity primary key,
  token_id bigint not null references nl.mcp_tokens (id) on delete cascade,
  -- The JSON-RPC method: 'tools/call', 'tools/list', 'initialize'.
  method   text not null check (length(method) between 1 and 40),
  -- The tool, when the method was tools/call. Empty otherwise.
  tool     text not null default '' check (length(tool) <= 60),
  ms       int not null default 0 check (ms >= 0),
  rows     int,
  -- ok: it answered. refused: the input, the scope or a check said no.
  -- capped: the day's limit was reached. failed: it raised.
  outcome  text not null check (outcome in ('ok', 'refused', 'capped', 'failed')),
  note     text not null default '',
  at       timestamptz not null default now()
);

comment on table nl.mcp_calls is
  'One row per MCP call: which token, which tool, how long, how it ended (migration 0024).';

create index mcp_calls_token_idx on nl.mcp_calls (token_id, at desc);
create index mcp_calls_tool_idx on nl.mcp_calls (tool, outcome);

-- One row per day per token, exactly like the assistant's counters: the cap
-- lives here so restarting the app does not reset the day.
create table nl.mcp_counters (
  on_day   date not null,
  token_id bigint not null references nl.mcp_tokens (id) on delete cascade,
  calls    int not null default 0 check (calls >= 0),
  primary key (on_day, token_id)
);

comment on table nl.mcp_counters is
  'Tool calls per token per day (migration 0024).';

-- ---------------------------------------------------------------------------
-- An MCP conversation is a real conversation
-- ---------------------------------------------------------------------------

-- A proposal belongs to a conversation (migration 0017), and an MCP proposal
-- is a real thing a person has to decide, so it gets a real conversation
-- rather than a second parallel queue. Its mode says where it came from.
alter table nl.assistant_conversations
  drop constraint assistant_conversations_mode_check;
alter table nl.assistant_conversations
  add constraint assistant_conversations_mode_check
  check (mode in ('mock', 'live', 'mcp'));

-- Its own start function, rather than a replacement for
-- nl.start_assistant_conversation, which checks the same two modes inside its
-- body and belongs to migration 0017. Everything after this is the assistant's
-- own path: nl.save_assistant_turn stores the turn and the proposal, and
-- nl.decide_assistant_proposal does the approving.
create function nl.start_mcp_conversation(p_title text, p_request_id text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_title  text := btrim(coalesce(p_title, ''));
  v_id     bigint;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'start_mcp_conversation');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if length(v_title) = 0 then
    raise exception 'A conversation needs a title.' using errcode = 'NL422';
  end if;

  insert into nl.assistant_conversations (user_id, title, mode)
  values (v_actor.id, left(v_title, 120), 'mcp')
  returning id, updated_at into v_id, v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'start_conversation', 'assistant_conversation', v_id::text, p_request_id,
          jsonb_build_object('mode', 'mcp'));

  v_result := jsonb_build_object('conversation_id', v_id, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Mint a token. The app generates the secret, hashes it, and passes only the
-- hash here, so the secret never reaches the database or a log.
create function nl.mint_mcp_token(
  p_label        text,
  p_user_id      int,
  p_scopes       text[],
  p_token_sha256 text,
  p_request_id   text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_label  text := btrim(coalesce(p_label, ''));
  v_scopes text[];
  v_target nl.users;
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'mint_mcp_token');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if not nl.is_admin() then
    raise exception 'Only an admin can mint an MCP token.' using errcode = 'NL403';
  end if;
  if length(v_label) < 1 or length(v_label) > 60 then
    raise exception 'A token needs a label of 1 to 60 characters, so it can be recognised later.'
      using errcode = 'NL422';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A token is stored as its SHA-256, which is 64 lowercase hex characters.'
      using errcode = 'NL422';
  end if;

  -- Sorted and without repeats, so two tokens with the same scopes look the
  -- same in the list.
  select array_agg(distinct s order by s) into v_scopes from unnest(coalesce(p_scopes, '{}'::text[])) s;
  if v_scopes is null or cardinality(v_scopes) = 0 or not (v_scopes <@ array['read', 'propose']::text[]) then
    raise exception 'The scopes are one or both of read and propose.' using errcode = 'NL422';
  end if;

  select * into v_target from nl.users where id = p_user_id and active;
  if not found then
    raise exception 'There is no active user %, so a token cannot act as them.', coalesce(p_user_id, 0)
      using errcode = 'NL404';
  end if;

  insert into nl.mcp_tokens (label, token_sha256, user_id, scopes, created_by)
  values (left(v_label, 60), p_token_sha256, p_user_id, v_scopes, v_actor.id)
  returning id into v_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'mint_mcp_token', 'mcp_token', v_id::text, p_request_id,
          jsonb_build_object('label', left(v_label, 60), 'acts_as', p_user_id,
                             'scopes', array_to_string(v_scopes, ',')));

  v_result := jsonb_build_object('token_id', v_id, 'label', left(v_label, 60),
                                 'acts_as', p_user_id,
                                 'scopes', array_to_string(v_scopes, ','));
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Revoke a token. It stops working on the next call and stays in the list.
create function nl.revoke_mcp_token(p_token_id bigint, p_request_id text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_token  nl.mcp_tokens;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'revoke_mcp_token');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if not nl.is_admin() then
    raise exception 'Only an admin can revoke an MCP token.' using errcode = 'NL403';
  end if;

  select * into v_token from nl.mcp_tokens where id = p_token_id for update;
  if not found then
    raise exception 'MCP token % does not exist.', coalesce(p_token_id, 0) using errcode = 'NL404';
  end if;
  if v_token.revoked_at is not null then
    raise exception 'MCP token % was already revoked.', p_token_id using errcode = 'NL422';
  end if;

  update nl.mcp_tokens set revoked_at = now() where id = p_token_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'revoke_mcp_token', 'mcp_token', p_token_id::text, p_request_id,
          jsonb_build_object('label', v_token.label, 'acts_as', v_token.user_id));

  v_result := jsonb_build_object('token_id', p_token_id, 'label', v_token.label, 'revoked', true);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Look a token up by the hash of the secret the caller sent, and note that it
-- was used.
--
-- This runs before anyone is signed in (there is no session cookie on an MCP
-- request), so it takes no request id and calls no require_active_user: like
-- nl.claim_request it is plumbing rather than a business write. It returns
-- what the app needs to decide, and null when there is no such token, so a
-- wrong token and a made-up token look exactly the same.
create function nl.authenticate_mcp_token(p_token_sha256 text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token  nl.mcp_tokens;
  v_active boolean;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select * into v_token from nl.mcp_tokens where token_sha256 = p_token_sha256;
  if not found then
    return null;
  end if;

  select u.active into v_active from nl.users u where u.id = v_token.user_id;

  -- A revoked token is still recorded as having been tried, which is how a
  -- leaked token shows up in the list after it was turned off.
  update nl.mcp_tokens set last_used_at = now() where id = v_token.id;

  return jsonb_build_object(
    'token_id', v_token.id,
    'label', v_token.label,
    'user_id', v_token.user_id,
    'scopes', array_to_string(v_token.scopes, ','),
    -- Handed back so the app can compare the hashes in constant time.
    'token_sha256', v_token.token_sha256,
    'revoked', v_token.revoked_at is not null,
    'user_active', coalesce(v_active, false));
end $$;

-- Claim one tool call for today for this token. Raises NL429 when the day is
-- used up, before the tool runs. Plumbing, like nl.claim_assistant_call: it
-- takes no request id because it has to count every attempt exactly once.
create function nl.claim_mcp_call(p_token_id bigint, p_limit int) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_used int;
begin
  if p_limit is null or p_limit < 0 then
    raise exception 'A daily cap is zero or more.' using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.mcp_tokens t where t.id = p_token_id) then
    raise exception 'MCP token % does not exist.', coalesce(p_token_id, 0) using errcode = 'NL404';
  end if;

  -- The insert locks the row for the rest of this transaction, so two calls at
  -- once cannot both slip past the cap.
  insert into nl.mcp_counters (on_day, token_id, calls)
  values (nl.today(), p_token_id, 1)
  on conflict (on_day, token_id) do update set calls = nl.mcp_counters.calls + 1
  returning calls into v_used;

  if v_used > p_limit then
    raise exception 'This token has made % calls today, which is its daily limit. It resets tomorrow.',
      p_limit using errcode = 'NL429';
  end if;

  return jsonb_build_object('used', v_used, 'limit', p_limit);
end $$;

-- Record one call. Plumbing again: every call is logged exactly once, whether
-- it answered, was refused or raised.
create function nl.log_mcp_call(
  p_token_id bigint,
  p_method   text,
  p_tool     text,
  p_ms       int,
  p_rows     int,
  p_outcome  text,
  p_note     text
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_outcome is null or p_outcome not in ('ok', 'refused', 'capped', 'failed') then
    raise exception 'A call ended ok, refused, capped or failed, not %.', coalesce(p_outcome, 'empty')
      using errcode = 'NL422';
  end if;

  insert into nl.mcp_calls (token_id, method, tool, ms, rows, outcome, note)
  values (p_token_id, left(coalesce(p_method, 'unknown'), 40), left(coalesce(p_tool, ''), 60),
          greatest(coalesce(p_ms, 0), 0), p_rows, p_outcome, left(coalesce(p_note, ''), 500))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.mcp_tokens enable row level security;
alter table nl.mcp_calls enable row level security;
alter table nl.mcp_counters enable row level security;

-- Readable by anyone in the app, and by the not-yet-signed-in transaction that
-- authenticates a call. What is stored is a SHA-256 of 32 random bytes, not a
-- secret anyone can use, and who holds a token is the same kind of fact as the
-- audit log, which the whole team can read. Only an admin can add one or turn
-- one off.
create policy mcp_tokens_read on nl.mcp_tokens for select to nl_app using (true);
create policy mcp_tokens_insert on nl.mcp_tokens for insert to nl_app
  with check ((select nl.is_admin()));
-- Two kinds of update, and nothing else is granted: an admin revokes, and the
-- authenticating transaction (nobody signed in) notes the last use.
create policy mcp_tokens_update on nl.mcp_tokens for update to nl_app
  using ((select nl.current_user_id()) is null or (select nl.is_admin()))
  with check ((select nl.current_user_id()) is null or (select nl.is_admin()));

create policy mcp_calls_read on nl.mcp_calls for select to nl_app using (true);
create policy mcp_calls_insert on nl.mcp_calls for insert to nl_app
  with check (exists (select 1 from nl.mcp_tokens t where t.id = token_id));

create policy mcp_counters_read on nl.mcp_counters for select to nl_app using (true);
create policy mcp_counters_insert on nl.mcp_counters for insert to nl_app
  with check (exists (select 1 from nl.mcp_tokens t where t.id = token_id));
create policy mcp_counters_update on nl.mcp_counters for update to nl_app
  using (exists (select 1 from nl.mcp_tokens t where t.id = token_id))
  with check (exists (select 1 from nl.mcp_tokens t where t.id = token_id));

grant select, insert on nl.mcp_tokens to nl_app;
grant update (last_used_at, revoked_at) on nl.mcp_tokens to nl_app;
grant select, insert on nl.mcp_calls to nl_app;
grant select, insert on nl.mcp_counters to nl_app;
grant update (calls) on nl.mcp_counters to nl_app;
-- nl_readonly gets nothing here: these tables name people and hold credentials.

grant execute on function
  nl.start_mcp_conversation(text, text),
  nl.mint_mcp_token(text, int, text[], text, text),
  nl.revoke_mcp_token(bigint, text),
  nl.authenticate_mcp_token(text),
  nl.claim_mcp_call(bigint, int),
  nl.log_mcp_call(bigint, text, text, int, int, text, text)
to nl_app;
