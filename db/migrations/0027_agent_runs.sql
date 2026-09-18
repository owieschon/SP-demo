-- 0027 The run trail: what an agent did, step by step, and a replay of it.
--
-- The claim this app makes is that a person only has to spend time on the
-- policies, because the agents can be trusted with the rest. Trust is not a
-- claim, it is a record. Migration 0021 already keeps one row per desk run
-- with its lookups on it, which answers "why did it say that" for the order
-- desk. This generalises it, so every agent leaves the same kind of record
-- and a sceptical reader has one place to look:
--
--   which agent, what woke it, what it read, which tools it called with
--   which arguments and what each returned in summary, what it decided,
--   what it REFUSED to do and under which rule, what it produced, how long
--   it took, and how many tokens if that is known.
--
-- Two rules shape the tables, because the point is trust and not telemetry:
--
--   1. A step never holds anything the disclosure policy would forbid its
--      reader from seeing. The trail goes through the same check as a draft
--      reply (app/src/lib/server/desk/policy.ts). A step that fails it is
--      stored WITHHELD: the label and the reason survive, the detail does
--      not. The check constraint below makes that a fact about the schema
--      and not a habit of the code above it, and a withheld step must carry
--      its reason, so the withholding is visible rather than silent.
--
--   2. A refusal is a first-class step with a rule on it, never a silence.
--      The constraint refuses a refusal step with no rule reference.
--      Refusals are the most persuasive thing in the whole record: a reply
--      that was not sent, and the rule that stopped it.
--
-- A run is also replayable. The inputs it read are recorded on the run, so
-- the same decisions can be made again after a prompt, a policy or an
-- extractor changed, and the two outcomes diffed. A replay is itself a run,
-- with replay_of pointing at the original and diff saying what changed.
--
-- Hand entry lives here too: a quote request that a person typed, because a
-- customer telephoned, is the same kind of desk item as one that arrived as
-- mail. It differs in one fact, so nl.mail_messages gains one column that
-- says which, and one function to write such a row.
--
-- Depends on 0001 to 0021. Nothing here is granted to nl_readonly: a step
-- can name a person, an account and what they pay.

-- ---------------------------------------------------------------------------
-- Where a desk item came from
-- ---------------------------------------------------------------------------

-- 'mail' is every message a provider delivered, which is all of them until
-- now, so the default is the truth for every existing row. 'person' is a
-- request somebody typed at the desk.
alter table nl.mail_messages
  add column source text not null default 'mail' check (source in ('mail', 'person')),
  add column entered_by int references nl.users (id);

comment on column nl.mail_messages.source is
  'How this desk item arrived: mail from a provider, or a person who typed it (migration 0027).';

-- A hand-entered quote request. It writes exactly the row a delivered
-- message writes, plus the two columns above, so everything downstream (the
-- agent, the run, the draft, the queue) treats it identically.
--
-- Security definer for the same reason as nl.record_mail_message: no role has
-- INSERT on nl.mail_messages, so a row exists only if a function agreed to
-- make it.
create function nl.record_desk_request(
  p_mailbox_id  int,
  p_from        text,
  p_from_name   text,
  p_subject     text,
  p_body        text,
  p_body_stripped text,
  p_request_id  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_mailbox nl.mailboxes;
  v_key     text;
  v_id      bigint;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_desk_request');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_mailbox from nl.mailboxes where id = p_mailbox_id;
  if not found then
    raise exception 'Desk % does not exist.', coalesce(p_mailbox_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not v_mailbox.active then
    raise exception 'Desk % is switched off.', v_mailbox.address using errcode = 'NL422';
  end if;
  if p_from is null or btrim(p_from) = '' then
    raise exception 'A request needs somebody it came from.' using errcode = 'NL422';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 100000 then
    raise exception 'A request is 1 to 100,000 characters.' using errcode = 'NL422';
  end if;

  v_key := nl.mail_content_key(p_mailbox_id, p_from, p_subject, p_body, nl.now_ms());

  -- The same idempotence as delivered mail: typing the same request twice in
  -- the same minute is one request, not two.
  select id into v_id from nl.mail_messages where content_sha256 = v_key;
  if found then
    v_result := jsonb_build_object('message_id', v_id, 'duplicate', true);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  insert into nl.mail_messages (
    mailbox_id, from_address, from_name, to_addresses, subject, body_text, body_stripped,
    received_at, content_sha256, source, entered_by)
  values (
    p_mailbox_id, lower(btrim(p_from)), left(coalesce(p_from_name, ''), 200),
    array[v_mailbox.address], left(coalesce(p_subject, ''), 300), p_body,
    coalesce(nullif(btrim(coalesce(p_body_stripped, '')), ''), p_body),
    nl.now_ms(), v_key, 'person', v_actor.id)
  returning id into v_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'record_desk_request', 'mail_message', v_id::text, p_request_id,
          jsonb_build_object('desk', v_mailbox.address, 'from', lower(btrim(p_from)),
                             'subject', left(coalesce(p_subject, ''), 300)));

  v_result := jsonb_build_object('message_id', v_id, 'duplicate', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Tie a hand-entered desk item to the quote request that was read out of it,
-- and record what the reading decided, which is the same set of columns
-- nl.finish_mail_run writes for a message that arrived as mail.
--
-- A hand-entered request never produces a reply to send: the customer is on
-- the telephone, not in the inbox. So this is the end of that path, and the
-- message ends 'drafted' when the quote request needs nobody, or
-- 'needs_person' when it does, which is exactly what those two statuses mean
-- for a message that arrived as mail.
create function nl.attach_desk_request_draft(
  p_message_id   bigint,
  p_rfq_draft_id bigint,
  p_status       text,
  p_intent       text,
  p_confidence   numeric,
  p_summary      text,
  p_customer_no  text,
  p_contact_id   bigint,
  p_match_reason text,
  p_request_id   text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_message nl.mail_messages;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'attach_desk_request_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_message from nl.mail_messages where id = p_message_id for update;
  if not found then
    raise exception 'Desk item % does not exist.', coalesce(p_message_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_message.source <> 'person' then
    raise exception 'Desk item % arrived as mail; the agent''s own run records what it decided.', p_message_id
      using errcode = 'NL422';
  end if;
  if p_status is null or p_status not in ('drafted', 'needs_person', 'ignored') then
    raise exception 'A read request ends drafted, needs_person or ignored, not %.',
      coalesce(p_status, 'empty') using errcode = 'NL422';
  end if;
  if p_rfq_draft_id is not null
     and not exists (select 1 from nl.rfq_drafts d where d.id = p_rfq_draft_id) then
    raise exception 'Quote request % does not exist.', p_rfq_draft_id using errcode = 'NL404';
  end if;
  if p_contact_id is not null and not exists (
    select 1 from nl.contacts ct
    where ct.id = p_contact_id and ct.customer_no = p_customer_no) then
    raise exception 'Contact % is not at account %.', p_contact_id,
      coalesce(p_customer_no, 'none') using errcode = 'NL422';
  end if;

  update nl.mail_messages
     set rfq_draft_id      = coalesce(p_rfq_draft_id, rfq_draft_id),
         status            = p_status,
         intent            = coalesce(p_intent, intent),
         intent_confidence = p_confidence,
         summary           = left(coalesce(p_summary, ''), 1000),
         customer_no       = p_customer_no,
         contact_id        = p_contact_id,
         match_reason      = left(coalesce(p_match_reason, ''), 500)
   where id = p_message_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'attach_desk_request_draft', 'mail_message', p_message_id::text,
          p_request_id,
          jsonb_build_object('rfq_draft_id', p_rfq_draft_id, 'status', p_status,
                             'customer_no', p_customer_no));

  v_result := jsonb_build_object('message_id', p_message_id, 'rfq_draft_id', p_rfq_draft_id,
                                 'status', p_status);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create table nl.agent_runs (
  id           bigint generated always as identity primary key,
  -- Which agent woke: 'order_desk', 'procurement_desk', and whatever comes
  -- next. Text and not an enum, so a new agent needs no migration.
  agent        text not null check (agent <> ''),
  -- What woke it. These four are the only ways anything in this app starts:
  -- mail arrived, a signal fired, a schedule came round, a person asked.
  -- A replay is the fifth, and it is always a person asking.
  woke_by      text not null check (woke_by in ('mail', 'signal', 'schedule', 'person', 'replay')),
  woke_note    text not null default '',
  -- What it was working on: 'mail_message', 'quote_request', 'commitment'.
  entity       text,
  entity_id    bigint,
  -- The disclosure level this trail is read at, and whose facts the run is
  -- about. Together they are what the step check is run against.
  reader       text not null default 'internal' check (reader in ('customer', 'vendor', 'internal')),
  subject_no   text,
  mode         text not null check (mode in ('mock', 'live')),
  model        text,
  -- The version of the context bundle the run read, when the context engine
  -- is present in this database. Null everywhere else, and the app
  -- feature-detects rather than assuming.
  bundle_version text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  int check (duration_ms is null or duration_ms >= 0),
  input_tokens  int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  outcome      text not null default 'running'
                 check (outcome in ('running', 'drafted', 'needs_person', 'ignored',
                                    'refused', 'failed', 'replayed')),
  -- One sentence: what it decided.
  decision     text not null default '',
  refusals     int not null default 0 check (refusals >= 0),
  step_count   int not null default 0 check (step_count >= 0),
  -- What came out of it: a mail draft, a quote request, a purchase request.
  produced_kind text,
  produced_id   bigint,
  produced      jsonb not null default '{}' check (jsonb_typeof(produced) = 'object'),
  -- Everything the run read that a replay needs to make the same decisions
  -- again. Never shown as a step; only the replay reads it.
  inputs       jsonb not null default '{}' check (jsonb_typeof(inputs) = 'object'),
  replay_of    bigint references nl.agent_runs (id) on delete set null,
  -- On a replay: 'same', 'wording' or 'decision'.
  diff         text check (diff is null or diff in ('same', 'wording', 'decision')),
  -- The agent's own record this trail was taken from, so transcribing the
  -- same work twice cannot make two trails of it.
  source_kind  text,
  source_id    bigint,
  error        text,
  constraint agent_runs_replay_is_woken_by_a_person
    check (replay_of is null or woke_by = 'replay'),
  constraint agent_runs_diff_is_a_replay
    check (diff is null or replay_of is not null)
);

comment on table nl.agent_runs is
  'One agent run: what woke it, what it decided, what it refused and what it produced (migration 0027).';

create index agent_runs_agent_idx on nl.agent_runs (agent, started_at desc, id desc);
create index agent_runs_entity_idx on nl.agent_runs (entity, entity_id);
create index agent_runs_produced_idx on nl.agent_runs (produced_kind, produced_id);
create index agent_runs_replay_idx on nl.agent_runs (replay_of);

-- Transcribing one piece of the agent's own record makes one trail of it,
-- however many times the app asks.
create unique index agent_runs_source_idx on nl.agent_runs (source_kind, source_id)
  where source_kind is not null;

-- ---------------------------------------------------------------------------
-- Steps
-- ---------------------------------------------------------------------------

create table nl.agent_run_steps (
  id        bigint generated always as identity primary key,
  run_id    bigint not null references nl.agent_runs (id) on delete cascade,
  -- In order, from 1. The order is the point: a trail that cannot be read
  -- top to bottom is a pile of events.
  seq       int not null check (seq > 0),
  kind      text not null check (kind in ('read', 'tool', 'decision', 'refusal', 'output', 'note')),
  label     text not null check (label <> ''),
  tool      text,
  args      jsonb,
  -- What it returned, in summary. Never the rows themselves: a trail is
  -- evidence about a decision, not a second copy of the database.
  result    text not null default '',
  row_count int check (row_count is null or row_count >= 0),
  ms        int check (ms is null or ms >= 0),
  -- On a refusal: which rule, and what it says in plain English.
  rule      text,
  rule_note text not null default '',
  withheld  boolean not null default false,
  withheld_reason text not null default '',
  created_at timestamptz not null default now(),
  unique (run_id, seq),
  -- A refusal without a rule reference is a shrug.
  constraint agent_run_steps_refusal_names_a_rule
    check (kind <> 'refusal' or (rule is not null and rule <> '')),
  -- A withheld step keeps its label and its reason and loses its detail.
  constraint agent_run_steps_withheld_keeps_nothing
    check (not withheld or (args is null and result = '' and withheld_reason <> ''))
);

comment on table nl.agent_run_steps is
  'The steps of one run, in order. A step that the disclosure policy would not let its reader see is stored withheld, with the reason (migration 0027).';

create index agent_run_steps_run_idx on nl.agent_run_steps (run_id, seq);

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Open a run. With p_source_kind set this is idempotent on that source: the
-- run that already transcribes it comes back with existing = true and
-- nothing is written.
create function nl.start_agent_run(
  p_agent       text,
  p_woke_by     text,
  p_woke_note   text,
  p_entity      text,
  p_entity_id   bigint,
  p_reader      text,
  p_subject_no  text,
  p_mode        text,
  p_model       text,
  p_bundle_version text,
  p_inputs      jsonb,
  p_replay_of   bigint,
  p_source_kind text,
  p_source_id   bigint,
  -- When the work really began, for a trail transcribed from an agent's own
  -- record after the fact. Null means now.
  p_started_at  timestamptz,
  p_request_id  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'start_agent_run');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_agent is null or btrim(p_agent) = '' then
    raise exception 'A run belongs to an agent.' using errcode = 'NL422';
  end if;
  if p_woke_by is null or p_woke_by not in ('mail', 'signal', 'schedule', 'person', 'replay') then
    raise exception 'A run wakes on mail, a signal, a schedule, a person or a replay, not %.',
      coalesce(p_woke_by, 'empty') using errcode = 'NL422';
  end if;
  if p_mode is null or p_mode not in ('mock', 'live') then
    raise exception 'A run is in mock or live mode, not %.', coalesce(p_mode, 'empty') using errcode = 'NL422';
  end if;
  if p_reader is not null and p_reader not in ('customer', 'vendor', 'internal') then
    raise exception 'A trail is read at customer, vendor or internal level, not %.', p_reader
      using errcode = 'NL422';
  end if;
  if p_inputs is not null and jsonb_typeof(p_inputs) is distinct from 'object' then
    raise exception 'A run''s inputs are a JSON object.' using errcode = 'NL422';
  end if;
  if p_replay_of is not null then
    if p_woke_by <> 'replay' then
      raise exception 'A replay is woken by a replay.' using errcode = 'NL422';
    end if;
    if not exists (select 1 from nl.agent_runs where id = p_replay_of) then
      raise exception 'Run % does not exist.', p_replay_of using errcode = 'NL404';
    end if;
  end if;

  if p_source_kind is not null then
    select id into v_id from nl.agent_runs
    where source_kind = p_source_kind and source_id = p_source_id;
    if found then
      v_result := jsonb_build_object('run_id', v_id, 'existing', true);
      perform nl.finish_request(p_request_id, v_result);
      return v_result;
    end if;
  end if;

  insert into nl.agent_runs (
    agent, woke_by, woke_note, entity, entity_id, reader, subject_no, mode, model,
    bundle_version, inputs, replay_of, source_kind, source_id, started_at)
  values (
    btrim(p_agent), p_woke_by, left(coalesce(p_woke_note, ''), 300), p_entity, p_entity_id,
    coalesce(p_reader, 'internal'), p_subject_no, p_mode, p_model,
    p_bundle_version, coalesce(p_inputs, '{}'::jsonb), p_replay_of, p_source_kind, p_source_id,
    coalesce(p_started_at, now()))
  returning id into v_id;

  v_result := jsonb_build_object('run_id', v_id, 'existing', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Add steps to an open run, in the order they are given.
--
-- A step arrives as {"kind", "label", "tool", "args", "result", "rows", "ms",
-- "rule", "rule_note", "withheld", "withheld_reason"}. When withheld is
-- true this function throws the detail away itself rather than trusting the
-- caller to have done it, which is the only way rule 1 holds for a caller
-- nobody has read.
create function nl.append_agent_steps(
  p_run_id     bigint,
  p_steps      jsonb,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_run    nl.agent_runs;
  v_step   jsonb;
  v_seq    int;
  v_added  int := 0;
  v_kind   text;
  v_withheld boolean;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'append_agent_steps');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_run from nl.agent_runs where id = p_run_id for update;
  if not found then
    raise exception 'Run % does not exist.', coalesce(p_run_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_run.finished_at is not null then
    raise exception 'Run % has already finished.', p_run_id using errcode = 'NL422';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) is distinct from 'array' then
    raise exception 'Steps are a JSON array.' using errcode = 'NL422';
  end if;

  select coalesce(max(seq), 0) into v_seq from nl.agent_run_steps where run_id = p_run_id;

  for v_step in select value from jsonb_array_elements(p_steps)
  loop
    v_kind := v_step ->> 'kind';
    if v_kind is null or v_kind not in ('read', 'tool', 'decision', 'refusal', 'output', 'note') then
      raise exception 'Unknown step kind %.', coalesce(v_kind, 'empty') using errcode = 'NL422';
    end if;
    if coalesce(btrim(v_step ->> 'label'), '') = '' then
      raise exception 'Every step says what it was.' using errcode = 'NL422';
    end if;
    if v_kind = 'refusal' and coalesce(btrim(v_step ->> 'rule'), '') = '' then
      raise exception 'A refusal names the rule it refused under.' using errcode = 'NL422';
    end if;

    v_withheld := coalesce((v_step ->> 'withheld')::boolean, false);
    if v_withheld and coalesce(btrim(v_step ->> 'withheld_reason'), '') = '' then
      raise exception 'A withheld step says why it was withheld.' using errcode = 'NL422';
    end if;

    v_seq := v_seq + 1;
    insert into nl.agent_run_steps (
      run_id, seq, kind, label, tool, args, result, row_count, ms, rule, rule_note,
      withheld, withheld_reason)
    values (
      p_run_id, v_seq, v_kind, left(btrim(v_step ->> 'label'), 300),
      left(v_step ->> 'tool', 100),
      -- Withheld: the detail is dropped here, not by the caller.
      case when v_withheld then null
           when v_step ? 'args' and jsonb_typeof(v_step -> 'args') <> 'null' then v_step -> 'args' end,
      case when v_withheld then '' else left(coalesce(v_step ->> 'result', ''), 2000) end,
      (v_step ->> 'rows')::int,
      (v_step ->> 'ms')::int,
      left(v_step ->> 'rule', 100),
      left(coalesce(v_step ->> 'rule_note', ''), 500),
      v_withheld,
      case when v_withheld then left(coalesce(v_step ->> 'withheld_reason', ''), 500) else '' end);
    v_added := v_added + 1;
  end loop;

  update nl.agent_runs
     set step_count = (select count(*) from nl.agent_run_steps s where s.run_id = p_run_id),
         refusals   = (select count(*) from nl.agent_run_steps s
                       where s.run_id = p_run_id and s.kind = 'refusal')
   where id = p_run_id;

  v_result := jsonb_build_object('run_id', p_run_id, 'added', v_added, 'steps', v_seq);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Close a run. Every run ends: a run left open reads as work in progress
-- when nobody is working, which is the one thing worse than no record.
create function nl.finish_agent_run(
  p_run_id      bigint,
  p_outcome     text,
  p_decision    text,
  p_duration_ms int,
  p_input_tokens  int,
  p_output_tokens int,
  p_produced_kind text,
  p_produced_id   bigint,
  p_produced      jsonb,
  p_diff        text,
  p_error       text,
  -- When the work really ended, for a transcribed trail. Null means now.
  p_finished_at timestamptz,
  p_request_id  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_run    nl.agent_runs;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'finish_agent_run');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_run from nl.agent_runs where id = p_run_id for update;
  if not found then
    raise exception 'Run % does not exist.', coalesce(p_run_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_run.finished_at is not null then
    raise exception 'Run % has already finished.', p_run_id using errcode = 'NL422';
  end if;
  if p_outcome is null
     or p_outcome not in ('drafted', 'needs_person', 'ignored', 'refused', 'failed', 'replayed') then
    raise exception 'A run ends drafted, needs_person, ignored, refused, failed or replayed, not %.',
      coalesce(p_outcome, 'empty') using errcode = 'NL422';
  end if;
  if p_diff is not null and p_diff not in ('same', 'wording', 'decision') then
    raise exception 'A replay diffs the same, the wording or the decision, not %.', p_diff
      using errcode = 'NL422';
  end if;
  if p_diff is not null and v_run.replay_of is null then
    raise exception 'Only a replay has a diff.' using errcode = 'NL422';
  end if;
  if p_produced is not null and jsonb_typeof(p_produced) is distinct from 'object' then
    raise exception 'What a run produced is a JSON object.' using errcode = 'NL422';
  end if;

  update nl.agent_runs
     set finished_at   = greatest(coalesce(p_finished_at, now()), v_run.started_at),
         outcome       = p_outcome,
         decision      = left(coalesce(p_decision, ''), 1000),
         duration_ms   = greatest(coalesce(p_duration_ms, 0), 0),
         input_tokens  = greatest(coalesce(p_input_tokens, 0), 0),
         output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
         produced_kind = p_produced_kind,
         produced_id   = p_produced_id,
         produced      = coalesce(p_produced, '{}'::jsonb),
         diff          = p_diff,
         error         = left(p_error, 1000)
   where id = p_run_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'finish_agent_run', 'agent_run', p_run_id::text, p_request_id,
          jsonb_build_object('agent', v_run.agent, 'woke_by', v_run.woke_by,
                             'outcome', p_outcome, 'refusals', v_run.refusals,
                             'steps', v_run.step_count, 'replay_of', v_run.replay_of,
                             'diff', p_diff));

  v_result := jsonb_build_object('run_id', p_run_id, 'outcome', p_outcome, 'diff', p_diff);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- One row per run for the run list: the wake reason, the outcome, how long it
-- took, and whether a person changed anything afterwards.
--
-- "Afterwards" is read off the thing the run produced. For a mail draft that
-- is the draft's own record: a person edited it, rejected it, approved it or
-- has not looked yet. Nothing else can answer it, because only the product
-- knows what happened to it.
create view nl.agent_run_list with (security_invoker = true) as
select
  r.id,
  r.agent,
  r.woke_by,
  r.woke_note,
  r.entity,
  r.entity_id,
  r.reader,
  r.subject_no,
  r.mode,
  r.model,
  r.bundle_version,
  r.started_at,
  r.finished_at,
  r.duration_ms,
  r.input_tokens,
  r.output_tokens,
  r.outcome,
  r.decision,
  r.refusals,
  r.step_count,
  r.produced_kind,
  r.produced_id,
  r.replay_of,
  r.diff,
  r.error,
  (select count(*) from nl.agent_runs p where p.replay_of = r.id)::int as replays,
  case
    when r.produced_kind = 'mail_draft' and d.id is not null then
      case
        when d.status = 'rejected' then 'rejected'
        when d.edited then 'edited'
        when d.status in ('approved', 'sent') then 'approved as written'
        else 'not looked at yet'
      end
    when r.produced_kind is null then null
    else 'unknown'
  end as human_change
from nl.agent_runs r
left join nl.mail_drafts d
  on r.produced_kind = 'mail_draft' and d.id = r.produced_id;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.agent_runs enable row level security;
alter table nl.agent_run_steps enable row level security;

-- What the agents did is the company's record, not one person's, so the whole
-- team reads it: a trail nobody but its own author can read is not a trail.
-- Nobody writes any of it directly. There is no insert, update or delete
-- policy on either table, and the functions above are security definer, so a
-- step exists only because a function agreed to write it.
create policy agent_runs_read on nl.agent_runs for select to nl_app using (true);
create policy agent_run_steps_read on nl.agent_run_steps for select to nl_app using (true);

grant select on nl.agent_runs, nl.agent_run_steps, nl.agent_run_list to nl_app;

-- nl_readonly gets nothing: a step names accounts, people and prices.

grant execute on function
  nl.record_desk_request(int, text, text, text, text, text, text),
  nl.attach_desk_request_draft(bigint, bigint, text, text, numeric, text, text, bigint, text, text),
  nl.start_agent_run(text, text, text, text, bigint, text, text, text, text, text, jsonb, bigint, text, bigint, timestamptz, text),
  nl.append_agent_steps(bigint, jsonb, text),
  nl.finish_agent_run(bigint, text, text, int, int, int, text, bigint, jsonb, text, text, timestamptz, text)
to nl_app;
