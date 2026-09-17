-- 0017 Ask Northline: the assistant's conversations, the lookups it made, and
-- the proposals a person has to approve before anything is written.
--
-- The rules that shape this migration:
--   * The assistant reads freely and can add a note or a next step. Anything
--     that changes or settles a record is GATED: the model cannot call it. It
--     can only propose it, and a person approves.
--   * A proposal is stored whole (its options, each with an exact tool, its
--     input and the row version that was current when it was made). Approval
--     takes an id, an option number, a row version and a request id, nothing
--     else: the values written come from the stored proposal.
--   * The tool that does the write is the same SQL function the pages use, run
--     as the person who approved, with a request id derived from the proposal
--     so a retry replays instead of writing twice.
--   * A conversation is private to the person who had it. The audit log, which
--     the whole team can read, still records every write it led to.
--   * The number of model calls per person per day and for the whole server per
--     day is counted here, in the database, not in the app's memory.
--
-- Depends on 0001 to 0014. Nothing here is granted to nl_readonly: these
-- tables hold people's questions.

-- ---------------------------------------------------------------------------
-- Conversations and what was said
-- ---------------------------------------------------------------------------

create table nl.assistant_conversations (
  id            bigint generated always as identity (start with 9001) primary key,
  user_id       int not null references nl.users (id),
  title         text not null check (length(title) between 1 and 120),
  -- Which model answered: the scripted demo model, or the real one.
  mode          text not null check (mode in ('mock', 'live')),
  -- Kept on the row so the per-conversation cap is one read, not a count.
  message_count int not null default 0 check (message_count >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default nl.now_ms()
);

comment on table nl.assistant_conversations is
  'One conversation with the assistant, private to the person who had it (migration 0017).';

create index assistant_conversations_user_idx
  on nl.assistant_conversations (user_id, updated_at desc);

create trigger assistant_conversations_touch before update on nl.assistant_conversations
  for each row execute function nl.touch_updated_at();

-- A conversation holds at most this many messages. A question and its answer
-- are two; a decision on a proposal is one more.
create function nl.assistant_message_cap() returns int
language sql immutable
set search_path = ''
as $$ select 40 $$;

create table nl.assistant_messages (
  id              bigint generated always as identity primary key,
  conversation_id bigint not null references nl.assistant_conversations (id) on delete cascade,
  -- Position in the conversation, from 1. Unique, so two turns cannot
  -- interleave into the same place.
  seq             int not null check (seq > 0),
  role            text not null check (role in ('question', 'answer', 'decision')),
  body            text not null check (length(body) between 1 and 20000),
  created_at      timestamptz not null default now(),
  unique (conversation_id, seq)
);

create index assistant_messages_conversation_idx
  on nl.assistant_messages (conversation_id, seq);

-- One row per tool the model asked for, whether it ran or was refused. This
-- is what the page shows under "what the assistant looked up", and what an
-- auditor reads to see that a gated tool never ran.
create table nl.assistant_tool_calls (
  id              bigint generated always as identity primary key,
  conversation_id bigint not null references nl.assistant_conversations (id) on delete cascade,
  message_id      bigint references nl.assistant_messages (id) on delete cascade,
  -- Which round of the turn asked for it, from 1.
  round           int not null check (round > 0),
  name            text not null check (length(name) between 1 and 60),
  risk            text not null check (risk in ('read', 'additive', 'gated', 'propose')),
  input           jsonb not null,
  -- ran: it did its work. gated: the runtime refused it because of its risk
  -- class. refused: the input did not validate. failed: it raised.
  outcome         text not null check (outcome in ('ran', 'gated', 'refused', 'failed')),
  rows            int,
  ms              int not null check (ms >= 0),
  note            text not null default '',
  created_at      timestamptz not null default now()
);

create index assistant_tool_calls_conversation_idx
  on nl.assistant_tool_calls (conversation_id, id);
create index assistant_tool_calls_message_idx on nl.assistant_tool_calls (message_id);
-- "Has a gated tool ever run?" should be one index scan.
create index assistant_tool_calls_risk_idx on nl.assistant_tool_calls (risk, outcome);

-- ---------------------------------------------------------------------------
-- Proposals: the only way the model can reach a write it may not call
-- ---------------------------------------------------------------------------

create table nl.assistant_proposals (
  id              bigint generated always as identity (start with 8001) primary key,
  conversation_id bigint not null references nl.assistant_conversations (id) on delete cascade,
  message_id      bigint references nl.assistant_messages (id) on delete set null,
  created_by      int not null references nl.users (id),
  summary         text not null check (length(summary) between 1 and 500),
  -- [{"label": "...", "tool": "record_outcome", "input": {...}, "version": "..."}]
  -- The app validates each option against its tool before this is stored.
  options         jsonb not null check (
                    jsonb_typeof(options) = 'array'
                    and jsonb_array_length(options) between 1 and 3),
  status          text not null default 'draft'
                    check (status in ('draft', 'approved', 'rejected', 'executed')),
  chosen_index    int check (chosen_index >= 0),
  decided_by      int references nl.users (id),
  decided_at      timestamptz,
  reason          text not null default '',
  -- What the executed write returned, and the last failure if one happened.
  result          jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default nl.now_ms(),
  -- A decided proposal names who decided, when, and (if approved) which option.
  constraint assistant_proposals_decision_recorded check (
    (status = 'draft' and chosen_index is null and decided_by is null and decided_at is null)
    or (status = 'rejected' and chosen_index is null and decided_by is not null and decided_at is not null)
    or (status in ('approved', 'executed')
        and chosen_index is not null and decided_by is not null and decided_at is not null)),
  -- Only an executed proposal carries a result.
  constraint assistant_proposals_result_when_executed check (status = 'executed' or result is null)
);

comment on table nl.assistant_proposals is
  'What the assistant proposed. Nothing is written until a person approves an option, and then from this row, not from the request (migration 0017).';

create index assistant_proposals_conversation_idx
  on nl.assistant_proposals (conversation_id, id desc);
create index assistant_proposals_created_by_idx on nl.assistant_proposals (created_by, status);
create index assistant_proposals_decided_by_idx on nl.assistant_proposals (decided_by);
create index assistant_proposals_message_idx on nl.assistant_proposals (message_id);

create trigger assistant_proposals_touch before update on nl.assistant_proposals
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- What the live model cost, and the daily call caps
-- ---------------------------------------------------------------------------

-- One row per call to the real model, so what the demo costs is measurable.
create table nl.assistant_usage (
  id                    bigint generated always as identity primary key,
  conversation_id       bigint references nl.assistant_conversations (id) on delete set null,
  user_id               int not null references nl.users (id),
  model                 text not null,
  -- Which round of the turn made this call, from 1.
  round                 int not null default 1 check (round > 0),
  input_tokens          int not null default 0 check (input_tokens >= 0),
  output_tokens         int not null default 0 check (output_tokens >= 0),
  cache_read_tokens     int not null default 0 check (cache_read_tokens >= 0),
  cache_creation_tokens int not null default 0 check (cache_creation_tokens >= 0),
  at                    timestamptz not null default now()
);

create index assistant_usage_user_idx on nl.assistant_usage (user_id, at desc);
create index assistant_usage_conversation_idx on nl.assistant_usage (conversation_id);

-- One row per day per scope: each person, and the whole server ('all', id 0).
create table nl.assistant_counters (
  on_day   date not null,
  scope    text not null check (scope in ('user', 'all')),
  scope_id int not null check (scope_id >= 0),
  calls    int not null default 0 check (calls >= 0),
  primary key (on_day, scope, scope_id),
  constraint assistant_counters_all_has_no_person check (scope <> 'all' or scope_id = 0)
);

comment on table nl.assistant_counters is
  'Model calls per person per day and for the whole server per day. The cap lives here so restarting the app does not reset it (migration 0017).';

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- How many calls are left today, without claiming one. For the page's
-- "x questions left today" line.
create function nl.assistant_calls_left(p_user_limit int, p_global_limit int) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'user_used', coalesce((select c.calls from nl.assistant_counters c
                           where c.on_day = nl.today() and c.scope = 'user'
                             and c.scope_id = nl.current_user_id()), 0),
    'user_limit', p_user_limit,
    'global_used', coalesce((select c.calls from nl.assistant_counters c
                             where c.on_day = nl.today() and c.scope = 'all' and c.scope_id = 0), 0),
    'global_limit', p_global_limit)
$$;

-- Claim one model call for today. Raises NL429 when either cap is reached, so
-- the caller never starts a turn it cannot finish. Like nl.claim_request this
-- is plumbing rather than a business write: it takes no request id, because it
-- has to count every attempt exactly once.
create function nl.claim_assistant_call(p_user_limit int, p_global_limit int) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_actor  nl.users;
  v_day    date := nl.today();
  v_user   int;
  v_global int;
begin
  v_actor := nl.require_active_user();

  if p_user_limit is null or p_user_limit < 0 or p_global_limit is null or p_global_limit < 0 then
    raise exception 'A daily cap is zero or more.' using errcode = 'NL422';
  end if;

  -- Claim the person's call first. The insert locks the row for the rest of
  -- this transaction, so two questions at once cannot both slip past the cap.
  insert into nl.assistant_counters (on_day, scope, scope_id, calls)
  values (v_day, 'user', v_actor.id, 1)
  on conflict (on_day, scope, scope_id) do update set calls = nl.assistant_counters.calls + 1
  returning calls into v_user;

  insert into nl.assistant_counters (on_day, scope, scope_id, calls)
  values (v_day, 'all', 0, 1)
  on conflict (on_day, scope, scope_id) do update set calls = nl.assistant_counters.calls + 1
  returning calls into v_global;

  if v_user > p_user_limit then
    raise exception 'You have asked the assistant % times today, which is the daily limit. It resets tomorrow.',
      p_user_limit using errcode = 'NL429';
  end if;
  if v_global > p_global_limit then
    raise exception 'The assistant has answered % questions across the whole demo today, which is the daily limit. It resets tomorrow.',
      p_global_limit using errcode = 'NL429';
  end if;

  return jsonb_build_object('user_used', v_user, 'user_limit', p_user_limit,
                            'global_used', v_global, 'global_limit', p_global_limit);
end $$;

-- Start a conversation. The title is the first question, shortened by the app.
create function nl.start_assistant_conversation(
  p_title      text,
  p_mode       text,
  p_request_id text
) returns jsonb
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
  v_replay := nl.claim_request(p_request_id, 'start_assistant_conversation');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if length(v_title) = 0 then
    raise exception 'A conversation needs a title.' using errcode = 'NL422';
  end if;
  if p_mode is null or p_mode not in ('mock', 'live') then
    raise exception 'A conversation runs in mock or live mode, not %.', coalesce(p_mode, 'empty')
      using errcode = 'NL422';
  end if;

  insert into nl.assistant_conversations (user_id, title, mode)
  values (v_actor.id, left(v_title, 120), p_mode)
  returning id, updated_at into v_id, v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'start_conversation', 'assistant_conversation', v_id::text, p_request_id,
          jsonb_build_object('mode', p_mode));

  v_result := jsonb_build_object('conversation_id', v_id, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Store one finished turn: the question, the answer, every tool the model
-- asked for, the proposal it made (if any) and what the call cost.
--
-- One write for the whole turn, so a double submit claims the same request id
-- and gets the first turn back instead of saying everything twice.
create function nl.save_assistant_turn(
  p_conversation_id bigint,
  p_question        text,
  p_answer          text,
  p_lookups         jsonb,
  p_proposal        jsonb,
  p_usage           jsonb,
  p_request_id      text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay      jsonb;
  v_actor       nl.users;
  v_conv        nl.assistant_conversations;
  v_question    text := btrim(coalesce(p_question, ''));
  v_answer      text := btrim(coalesce(p_answer, ''));
  v_seq         int;
  v_question_id bigint;
  v_answer_id   bigint;
  v_proposal_id bigint;
  v_lookup      jsonb;
  v_round       int;
  v_option      jsonb;
  v_result      jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'save_assistant_turn');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  -- Row-level security hides other people's conversations, so "not found"
  -- covers both a wrong id and somebody else's conversation.
  select * into v_conv from nl.assistant_conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'Conversation % does not exist.', p_conversation_id using errcode = 'NL404';
  end if;
  if v_conv.user_id <> v_actor.id then
    raise exception 'Conversation % belongs to someone else.', p_conversation_id using errcode = 'NL403';
  end if;
  if length(v_question) = 0 or length(v_answer) = 0 then
    raise exception 'A turn has a question and an answer.' using errcode = 'NL422';
  end if;
  if v_conv.message_count + 2 > nl.assistant_message_cap() then
    raise exception 'This conversation has reached % messages. Start a new one.', nl.assistant_message_cap()
      using errcode = 'NL422';
  end if;
  if jsonb_typeof(p_lookups) is distinct from 'array' then
    raise exception 'The lookups are a JSON array.' using errcode = 'NL422';
  end if;

  select coalesce(max(m.seq), 0) into v_seq
  from nl.assistant_messages m where m.conversation_id = p_conversation_id;

  insert into nl.assistant_messages (conversation_id, seq, role, body)
  values (p_conversation_id, v_seq + 1, 'question', left(v_question, 20000))
  returning id into v_question_id;

  insert into nl.assistant_messages (conversation_id, seq, role, body)
  values (p_conversation_id, v_seq + 2, 'answer', left(v_answer, 20000))
  returning id into v_answer_id;

  -- One row per tool call, in the order the model asked for them.
  v_round := 0;
  for v_lookup in select value from jsonb_array_elements(p_lookups)
  loop
    v_round := v_round + 1;
    if coalesce(v_lookup ->> 'name', '') = ''
       or coalesce(v_lookup ->> 'risk', '') not in ('read', 'additive', 'gated', 'propose')
       or coalesce(v_lookup ->> 'outcome', '') not in ('ran', 'gated', 'refused', 'failed') then
      raise exception 'A lookup names a tool, its risk class and how it ended.' using errcode = 'NL422';
    end if;
    insert into nl.assistant_tool_calls (conversation_id, message_id, round, name, risk, input,
                                         outcome, rows, ms, note)
    values (p_conversation_id, v_answer_id,
            coalesce((v_lookup ->> 'round')::int, v_round),
            left(v_lookup ->> 'name', 60), v_lookup ->> 'risk',
            coalesce(v_lookup -> 'input', '{}'::jsonb), v_lookup ->> 'outcome',
            (v_lookup ->> 'rows')::int, greatest(coalesce((v_lookup ->> 'ms')::int, 0), 0),
            left(coalesce(v_lookup ->> 'note', ''), 500));
  end loop;

  -- The proposal, if the model made one. Its options were validated against
  -- the tool registry by the app before it got here; these checks are the
  -- backstop that a stored option always names a tool and carries an input.
  if p_proposal is not null and p_proposal <> 'null'::jsonb then
    if jsonb_typeof(p_proposal -> 'options') is distinct from 'array'
       or jsonb_array_length(p_proposal -> 'options') < 1
       or jsonb_array_length(p_proposal -> 'options') > 3 then
      raise exception 'A proposal offers one to three options.' using errcode = 'NL422';
    end if;
    for v_option in select value from jsonb_array_elements(p_proposal -> 'options')
    loop
      if coalesce(v_option ->> 'tool', '') = ''
         or coalesce(v_option ->> 'label', '') = ''
         or jsonb_typeof(v_option -> 'input') is distinct from 'object' then
        raise exception 'Every option names a tool, a label and an input object.' using errcode = 'NL422';
      end if;
    end loop;

    insert into nl.assistant_proposals (conversation_id, message_id, created_by, summary, options)
    values (p_conversation_id, v_answer_id, v_actor.id,
            left(btrim(coalesce(p_proposal ->> 'summary', 'Proposed action')), 500),
            p_proposal -> 'options')
    returning id into v_proposal_id;
  end if;

  -- One usage row per call to the real model. Scripted demo mode sends none.
  if p_usage is not null and jsonb_typeof(p_usage) = 'array' then
    insert into nl.assistant_usage (conversation_id, user_id, model, round, input_tokens,
                                    output_tokens, cache_read_tokens, cache_creation_tokens)
    select p_conversation_id, v_actor.id, coalesce(u.value ->> 'model', 'unknown'),
           greatest(coalesce((u.value ->> 'round')::int, 1), 1),
           greatest(coalesce((u.value ->> 'input_tokens')::int, 0), 0),
           greatest(coalesce((u.value ->> 'output_tokens')::int, 0), 0),
           greatest(coalesce((u.value ->> 'cache_read_tokens')::int, 0), 0),
           greatest(coalesce((u.value ->> 'cache_creation_tokens')::int, 0), 0)
    from jsonb_array_elements(p_usage) u;
  end if;

  update nl.assistant_conversations
     set message_count = v_conv.message_count + 2
   where id = p_conversation_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'save_turn', 'assistant_conversation', p_conversation_id::text, p_request_id,
          jsonb_build_object('lookups', jsonb_array_length(p_lookups),
                             'gated', (select count(*) from jsonb_array_elements(p_lookups) l
                                       where l.value ->> 'outcome' = 'gated'),
                             'proposal_id', v_proposal_id));

  v_result := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'question_id', v_question_id,
    'answer_id', v_answer_id,
    'proposal_id', v_proposal_id,
    'message_count', v_conv.message_count + 2);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- A person decides. Approving only records the decision and which option;
-- the write itself happens next, through that option's own SQL function, and
-- nl.finish_assistant_proposal closes the loop.
--
-- Approve:  draft -> approved, or approved -> approved (a retry of the same
--           option, after a failed execution).
-- Reject:   draft -> rejected, and that is final.
create function nl.decide_assistant_proposal(
  p_proposal_id         bigint,
  p_decision            text,
  p_option_index        int,
  p_reason              text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay   jsonb;
  v_actor    nl.users;
  v_proposal nl.assistant_proposals;
  v_conv     nl.assistant_conversations;
  v_option   jsonb;
  v_seq      int;
  v_body     text;
  v_at       timestamptz;
  v_result   jsonb;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'A decision is approve or reject, not %.', coalesce(p_decision, 'empty')
      using errcode = 'NL422';
  end if;

  v_replay := nl.claim_request(p_request_id, p_decision || '_assistant_proposal');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  -- Lock the proposal so two decisions on it cannot interleave.
  select * into v_proposal from nl.assistant_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'Proposal % does not exist.', p_proposal_id using errcode = 'NL404';
  end if;
  -- The policy already limits this to the person whose conversation it is;
  -- the check makes the rule explicit.
  if v_proposal.created_by <> v_actor.id then
    raise exception 'Proposal % belongs to someone else.', p_proposal_id using errcode = 'NL403';
  end if;
  if v_proposal.updated_at is distinct from p_expected_updated_at then
    raise exception 'Proposal % changed since it was loaded. Reload it and decide again.', p_proposal_id
      using errcode = 'NL409';
  end if;
  if v_proposal.status = 'rejected' then
    raise exception 'Proposal % was rejected, which is final.', p_proposal_id using errcode = 'NL422';
  end if;
  if v_proposal.status = 'executed' then
    raise exception 'Proposal % already ran.', p_proposal_id using errcode = 'NL422';
  end if;

  if p_decision = 'approve' then
    if p_option_index is null or p_option_index < 0
       or p_option_index >= jsonb_array_length(v_proposal.options) then
      raise exception 'Proposal % has no option %.', p_proposal_id, coalesce(p_option_index, -1)
        using errcode = 'NL422';
    end if;
    -- A retry has to be the same option; a different one is a new decision
    -- and needs a new proposal.
    if v_proposal.status = 'approved' and v_proposal.chosen_index is distinct from p_option_index then
      raise exception 'Proposal % was already approved with option %.', p_proposal_id, v_proposal.chosen_index
        using errcode = 'NL422';
    end if;
    v_option := v_proposal.options -> p_option_index;
    v_body := format('Approved: %s', v_option ->> 'label');
  else
    v_body := format('Rejected: %s', coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'no reason given'));
  end if;

  select * into v_conv from nl.assistant_conversations where id = v_proposal.conversation_id for update;
  if v_conv.message_count + 1 > nl.assistant_message_cap() then
    raise exception 'This conversation has reached % messages. Start a new one.', nl.assistant_message_cap()
      using errcode = 'NL422';
  end if;

  -- The decision goes into the conversation, so the model sees it on the next
  -- question and does not propose the same thing again.
  select coalesce(max(m.seq), 0) into v_seq
  from nl.assistant_messages m where m.conversation_id = v_proposal.conversation_id;
  insert into nl.assistant_messages (conversation_id, seq, role, body)
  values (v_proposal.conversation_id, v_seq + 1, 'decision', left(v_body, 20000));

  update nl.assistant_conversations
     set message_count = v_conv.message_count + 1
   where id = v_proposal.conversation_id;

  update nl.assistant_proposals
     set status       = case when p_decision = 'approve' then 'approved' else 'rejected' end,
         chosen_index = case when p_decision = 'approve' then p_option_index end,
         decided_by   = v_actor.id,
         decided_at   = now(),
         reason       = left(coalesce(p_reason, ''), 500),
         error        = null
   where id = p_proposal_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_at;
  if not found then
    raise exception 'Proposal % changed since it was loaded. Reload it and decide again.', p_proposal_id
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', p_decision || '_proposal', 'assistant_proposal', p_proposal_id::text, p_request_id,
          jsonb_build_object('conversation_id', v_proposal.conversation_id,
                             'option', p_option_index,
                             'tool', v_option ->> 'tool',
                             'reason', left(coalesce(p_reason, ''), 500)));

  v_result := jsonb_build_object(
    'proposal_id', p_proposal_id,
    'status', case when p_decision = 'approve' then 'approved' else 'rejected' end,
    'option', p_option_index,
    'tool', v_option ->> 'tool',
    'input', v_option -> 'input',
    'version', v_option ->> 'version',
    'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Close an approved proposal: 'executed' with what the write returned, or
-- still 'approved' with the error, so the person can try again.
create function nl.finish_assistant_proposal(
  p_proposal_id bigint,
  p_result      jsonb,
  p_error       text,
  p_request_id  text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay   jsonb;
  v_actor    nl.users;
  v_proposal nl.assistant_proposals;
  v_at       timestamptz;
  v_result   jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'finish_assistant_proposal');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  select * into v_proposal from nl.assistant_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'Proposal % does not exist.', p_proposal_id using errcode = 'NL404';
  end if;
  if v_proposal.created_by <> v_actor.id then
    raise exception 'Proposal % belongs to someone else.', p_proposal_id using errcode = 'NL403';
  end if;
  if v_proposal.status <> 'approved' then
    raise exception 'Proposal % is %, so there is nothing to finish.', p_proposal_id, v_proposal.status
      using errcode = 'NL422';
  end if;
  if (p_result is null) = (p_error is null) then
    raise exception 'Finishing a proposal reports either a result or an error.' using errcode = 'NL422';
  end if;

  if p_result is not null then
    update nl.assistant_proposals
       set status = 'executed', result = p_result, error = null
     where id = p_proposal_id
    returning updated_at into v_at;
  else
    update nl.assistant_proposals
       set error = left(p_error, 500)
     where id = p_proposal_id
    returning updated_at into v_at;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', case when p_result is not null then 'execute_proposal' else 'proposal_failed' end,
          'assistant_proposal', p_proposal_id::text, p_request_id,
          jsonb_build_object('conversation_id', v_proposal.conversation_id,
                             'option', v_proposal.chosen_index,
                             'tool', (v_proposal.options -> v_proposal.chosen_index) ->> 'tool',
                             'result', p_result, 'error', left(coalesce(p_error, ''), 500)));

  v_result := jsonb_build_object(
    'proposal_id', p_proposal_id,
    'status', case when p_result is not null then 'executed' else 'approved' end,
    'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.assistant_conversations enable row level security;
alter table nl.assistant_messages enable row level security;
alter table nl.assistant_tool_calls enable row level security;
alter table nl.assistant_proposals enable row level security;
alter table nl.assistant_usage enable row level security;
alter table nl.assistant_counters enable row level security;

-- A conversation is what one person asked and what the assistant answered.
-- Only that person reads it, admins included. The audit log is where the team
-- sees what it led to.
create policy assistant_conversations_own on nl.assistant_conversations for select to nl_app
  using (user_id = (select nl.current_user_id()));
create policy assistant_conversations_insert on nl.assistant_conversations for insert to nl_app
  with check (user_id = (select nl.current_user_id()));
create policy assistant_conversations_update on nl.assistant_conversations for update to nl_app
  using (user_id = (select nl.current_user_id()))
  with check (user_id = (select nl.current_user_id()));

-- The child tables reach their owner through the conversation.
create policy assistant_messages_own on nl.assistant_messages for select to nl_app
  using (exists (select 1 from nl.assistant_conversations c
                 where c.id = conversation_id and c.user_id = (select nl.current_user_id())));
create policy assistant_messages_insert on nl.assistant_messages for insert to nl_app
  with check (exists (select 1 from nl.assistant_conversations c
                      where c.id = conversation_id and c.user_id = (select nl.current_user_id())));

create policy assistant_tool_calls_own on nl.assistant_tool_calls for select to nl_app
  using (exists (select 1 from nl.assistant_conversations c
                 where c.id = conversation_id and c.user_id = (select nl.current_user_id())));
create policy assistant_tool_calls_insert on nl.assistant_tool_calls for insert to nl_app
  with check (exists (select 1 from nl.assistant_conversations c
                      where c.id = conversation_id and c.user_id = (select nl.current_user_id())));

create policy assistant_proposals_own on nl.assistant_proposals for select to nl_app
  using (created_by = (select nl.current_user_id()));
create policy assistant_proposals_insert on nl.assistant_proposals for insert to nl_app
  with check (created_by = (select nl.current_user_id())
              and status = 'draft'
              and exists (select 1 from nl.assistant_conversations c
                          where c.id = conversation_id and c.user_id = (select nl.current_user_id())));
create policy assistant_proposals_update on nl.assistant_proposals for update to nl_app
  using (created_by = (select nl.current_user_id()))
  with check (created_by = (select nl.current_user_id()));

create policy assistant_usage_own on nl.assistant_usage for select to nl_app
  using (user_id = (select nl.current_user_id()));
create policy assistant_usage_insert on nl.assistant_usage for insert to nl_app
  with check (user_id = (select nl.current_user_id()));

-- A person sees their own counter and the server's total, and can only ever
-- add to them (nl.claim_assistant_call does the arithmetic).
create policy assistant_counters_read on nl.assistant_counters for select to nl_app
  using (scope = 'all' or scope_id = (select nl.current_user_id()));
create policy assistant_counters_insert on nl.assistant_counters for insert to nl_app
  with check ((scope = 'all' and scope_id = 0) or scope_id = (select nl.current_user_id()));
create policy assistant_counters_update on nl.assistant_counters for update to nl_app
  using ((scope = 'all' and scope_id = 0) or scope_id = (select nl.current_user_id()))
  with check ((scope = 'all' and scope_id = 0) or scope_id = (select nl.current_user_id()));

grant select, insert on nl.assistant_conversations, nl.assistant_messages,
  nl.assistant_tool_calls, nl.assistant_proposals, nl.assistant_usage,
  nl.assistant_counters to nl_app;
grant update (message_count, updated_at) on nl.assistant_conversations to nl_app;
grant update (status, chosen_index, decided_by, decided_at, reason, result, error, updated_at)
  on nl.assistant_proposals to nl_app;
grant update (calls) on nl.assistant_counters to nl_app;
-- nl_readonly gets nothing here: these tables hold people's questions.

grant execute on function
  nl.assistant_message_cap(),
  nl.assistant_calls_left(int, int),
  nl.claim_assistant_call(int, int),
  nl.start_assistant_conversation(text, text, text),
  nl.save_assistant_turn(bigint, text, text, jsonb, jsonb, jsonb, text),
  nl.decide_assistant_proposal(bigint, text, int, text, timestamptz, text),
  nl.finish_assistant_proposal(bigint, jsonb, text, text)
to nl_app;
