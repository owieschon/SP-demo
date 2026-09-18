-- 0042 The run trail: the steps behind a run, and a desk item a person typed.
--
-- Migration 0028 gave every agent a run record: nl.agent_runs is one row per
-- run, assembled from the tables the features already write, and
-- nl.agent_events holds the guardrail refusals and degradations that had
-- nowhere else to live. That answers what happened. It does not answer HOW,
-- and how is what a person needs before approving a draft without doing the
-- work again:
--
--   what it read, which tool it called WITH WHICH ARGUMENTS and what each
--   returned in summary, what it decided, and what it refused to do and
--   under which rule.
--
-- So this migration extends that record rather than starting a second one.
-- The trail hangs off the same run_key ('<agent>:<source_id>'), the same key
-- nl.agent_events uses, so a run, its events and its steps join without a
-- second id and nl.agent_runs stays exactly what 0028 made it.
--
-- What 0028 already had, and this does not repeat: the wake, the tool call
-- count, the tokens, the timing, the model, what was produced, who reviewed
-- it and what they did to it. What 0028 did not have, and this adds: the
-- steps, in order, with each tool call's arguments, and a refusal with its
-- rule that is not a guardrail (the disclosure policy refusing a reply, a
-- part the catalog does not know, a question asked instead of an assumption).
-- Those are deliberately NOT written as nl.agent_events: an event with
-- verdict 'refuse' counts against a promotion, and a desk agent asking a
-- sensible question is not a guardrail firing.
--
-- Two rules shape the steps, because the point is trust and not telemetry:
--
--   1. A step never holds anything the disclosure policy would forbid its
--      reader from seeing. This is checked twice, against two different
--      readers, because there are two of them:
--
--      WHEN IT IS WRITTEN, against the level the run's own output was drafted
--      at (the mailbox's, in `reader`). The trail goes through the same check
--      as a draft reply (app/src/lib/server/desk/policy.ts). A step that
--      fails it is stored WITHHELD: the label and the reason survive, the
--      detail does not. The constraint below makes that a fact about the
--      schema, and a withheld step must carry its reason, so the withholding
--      is visible rather than silent.
--
--      WHEN IT IS READ, against the person reading the trail, whose own
--      disclosure grant (0031) is a different question from the mailbox's. A
--      trail is written once and read by many people, so the write-time check
--      cannot answer this one. That is what `fact_kinds` below is for: each
--      step records which kinds of fact its detail rests on, and the reader
--      assembles the payload through nl.may_see(reader, kind), withholding
--      the detail of any step that names a kind they may not be shown. The
--      withholding is visible there too: the step, its label and the kind
--      held back all stay in the payload.
--
--      Both use the one vocabulary in nl.disclosure_allows (0031), so a
--      screen, an outgoing draft and a trail cannot disagree about whether
--      unit cost may be shown.
--
--   2. A refusal is a first-class step with a rule on it, never a silence.
--      The constraint refuses a refusal step with no rule reference.
--
-- Hand entry lives here too. A customer does telephone, so a person can still
-- enter a quote request, and it makes the same desk item an emailed one
-- makes: the same message row, worked by the same run machinery (0021's
-- nl.start_mail_run and nl.finish_mail_run), read by the same extractor and
-- checked by the same validation. It differs in one recorded fact, which is
-- the column added here: its source is a person.
--
-- Depends on 0001 to 0031: 0021 for the desk's runs, 0028 for the harness's
-- run record and its run key, and 0031 for nl.disclosure_allows and
-- nl.may_see. Nothing here is granted to nl_readonly: a step can name a
-- person, an account and what they pay.

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
  'How this desk item arrived: mail from a provider, or a person who typed it (migration 0042).';

-- A hand-entered quote request. It writes exactly the row a delivered message
-- writes, plus the two columns above, so everything downstream (the run, the
-- quote request, the queue, the harness's run log) treats it identically.
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

  -- The same idempotence delivered mail has: typing the same request twice in
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

-- ---------------------------------------------------------------------------
-- The trail
-- ---------------------------------------------------------------------------

-- One header per run that has a trail. Everything else about the run is in
-- nl.agent_runs (0028) under the same key; this holds only what a trail needs
-- and that view cannot carry.
create table nl.agent_run_trails (
  run_key    text primary key check (run_key ~ '^[a-z_]+:[0-9]+$'),
  agent      text not null check (agent <> ''),
  -- What woke it, said honestly. nl.agent_runs reads the wake off the source
  -- table, and the desk's source table cannot tell a message somebody typed
  -- from one that was delivered; this can, because the trail is written by
  -- the code that knows.
  woke_by    text not null check (woke_by in ('mail', 'signal', 'schedule', 'person')),
  woke_note  text not null default '',
  -- What it was working on, so a page can ask for the trails on one thing.
  entity     text,
  entity_id  bigint,
  -- The level this trail is read at, and whose facts the run is about:
  -- together, what the step check was run against.
  reader     text not null default 'internal' check (reader in ('customer', 'vendor', 'internal')),
  subject_no text,
  -- The context bundle version the run read, when the context engine is in
  -- this database. Null everywhere else; the app feature-detects it.
  bundle_version text,
  -- One sentence: what it decided.
  decision   text not null default '',
  step_count int not null default 0 check (step_count >= 0),
  refusals   int not null default 0 check (refusals >= 0),
  -- Everything a replay needs to make the same decisions again from the same
  -- recorded inputs. Never shown as a step; only the replay reads it.
  inputs     jsonb not null default '{}' check (jsonb_typeof(inputs) = 'object'),
  recorded_at timestamptz not null default now(),
  recorded_by int not null references nl.users (id)
);

comment on table nl.agent_run_trails is
  'How a run reached its decision, keyed to the run_key of nl.agent_runs (migration 0042).';

create index agent_run_trails_agent_idx on nl.agent_run_trails (agent, recorded_at desc);
create index agent_run_trails_entity_idx on nl.agent_run_trails (entity, entity_id);

create table nl.agent_run_steps (
  id        bigint generated always as identity primary key,
  run_key   text not null references nl.agent_run_trails (run_key) on delete cascade,
  -- In order, from 1. The order is the point: a trail that cannot be read top
  -- to bottom is a pile of events.
  seq       int not null check (seq > 0),
  kind      text not null check (kind in ('read', 'tool', 'decision', 'refusal', 'output', 'note')),
  label     text not null check (label <> ''),
  tool      text,
  -- What the tool was asked. This is the part 0028's tool_calls does not
  -- carry, and it is the part that makes a lookup checkable.
  args      jsonb,
  -- What came back, in summary. Never the rows themselves: a trail is
  -- evidence about a decision, not a second copy of the database.
  result    text not null default '',
  row_count int check (row_count is null or row_count >= 0),
  ms        int check (ms is null or ms >= 0),
  -- On a refusal: which rule, and what it says in plain English.
  rule      text,
  rule_note text not null default '',
  -- Which kinds of fact this step's detail rests on, in the one vocabulary
  -- nl.disclosure_allows (0031) defines. Empty means the detail rests on no
  -- business fact at all (a row count, a timing, the rule it refused under),
  -- and there is nothing for a reader's level to withhold.
  --
  -- This is what makes the read-time check possible: the reader does not have
  -- to parse the step's text to guess what is in it, because the step already
  -- says. The constraint keeps a typo out, which matters because an unknown
  -- kind is in no level's list, so a typo would quietly withhold the step
  -- from everybody and hide evidence rather than leak it.
  fact_kinds text[] not null default '{}'
    constraint agent_run_steps_fact_kinds_known
      check (fact_kinds <@ nl.disclosure_allows('internal')),
  withheld  boolean not null default false,
  withheld_reason text not null default '',
  unique (run_key, seq),
  -- A refusal without a rule reference is a shrug.
  constraint agent_run_steps_refusal_names_a_rule
    check (kind <> 'refusal' or (rule is not null and rule <> '')),
  -- A withheld step keeps its label and its reason and loses its detail.
  constraint agent_run_steps_withheld_keeps_nothing
    check (not withheld or (args is null and result = '' and withheld_reason <> ''))
);

comment on table nl.agent_run_steps is
  'The steps of one run, in order, with each tool call''s arguments. A step the disclosure policy would not let its reader see is stored withheld, with the reason (migration 0042).';

create index agent_run_steps_run_idx on nl.agent_run_steps (run_key, seq);

-- ---------------------------------------------------------------------------
-- Writing a trail
-- ---------------------------------------------------------------------------

-- One trail, header and steps, in one call, because a trail is written after
-- the run it describes and there is nothing to stream. Idempotent on the run
-- key: the same run transcribed twice is one trail.
--
-- A step arrives as {"kind", "label", "tool", "args", "result", "rows", "ms",
-- "rule", "rule_note", "fact_kinds", "withheld", "withheld_reason"}. When
-- withheld is true
-- this function throws the detail away itself rather than trusting the caller
-- to have done it, which is the only way rule 1 holds for a caller nobody has
-- read.
create function nl.record_agent_trail(
  p_run_key    text,
  p_agent      text,
  p_woke_by    text,
  p_woke_note  text,
  p_entity     text,
  p_entity_id  bigint,
  p_reader     text,
  p_subject_no text,
  p_bundle_version text,
  p_decision   text,
  p_inputs     jsonb,
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
  v_step   jsonb;
  v_seq    int := 0;
  v_kind   text;
  v_kinds  text[];
  v_withheld boolean;
  v_refusals int := 0;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_agent_trail');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_run_key is null or p_run_key !~ '^[a-z_]+:[0-9]+$' then
    raise exception 'A run key reads like order_desk:412, not %.', coalesce(p_run_key, 'empty')
      using errcode = 'NL422';
  end if;
  if p_agent is null or btrim(p_agent) = '' then
    raise exception 'A trail belongs to an agent.' using errcode = 'NL422';
  end if;
  if p_woke_by is null or p_woke_by not in ('mail', 'signal', 'schedule', 'person') then
    raise exception 'A run wakes on mail, a signal, a schedule or a person, not %.',
      coalesce(p_woke_by, 'empty') using errcode = 'NL422';
  end if;
  if p_reader is not null and p_reader not in ('customer', 'vendor', 'internal') then
    raise exception 'A trail is read at customer, vendor or internal level, not %.', p_reader
      using errcode = 'NL422';
  end if;
  if p_inputs is not null and jsonb_typeof(p_inputs) is distinct from 'object' then
    raise exception 'A trail''s inputs are a JSON object.' using errcode = 'NL422';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) is distinct from 'array' then
    raise exception 'Steps are a JSON array.' using errcode = 'NL422';
  end if;

  -- Already written. The agent's record has not changed, so neither has the
  -- trail of it.
  if exists (select 1 from nl.agent_run_trails t where t.run_key = p_run_key) then
    v_result := jsonb_build_object('run_key', p_run_key, 'recorded', false);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  insert into nl.agent_run_trails (
    run_key, agent, woke_by, woke_note, entity, entity_id, reader, subject_no,
    bundle_version, decision, inputs, recorded_by)
  values (
    p_run_key, btrim(p_agent), p_woke_by, left(coalesce(p_woke_note, ''), 300),
    p_entity, p_entity_id, coalesce(p_reader, 'internal'), p_subject_no,
    p_bundle_version, left(coalesce(p_decision, ''), 1000),
    coalesce(p_inputs, '{}'::jsonb), v_actor.id);

  for v_step in select value from jsonb_array_elements(p_steps)
  loop
    v_kind := v_step ->> 'kind';
    if v_kind is null or v_kind not in ('read', 'tool', 'decision', 'refusal', 'output', 'note') then
      raise exception 'Unknown step kind %.', coalesce(v_kind, 'empty') using errcode = 'NL422';
    end if;
    if coalesce(btrim(v_step ->> 'label'), '') = '' then
      raise exception 'Every step says what it was.' using errcode = 'NL422';
    end if;
    if v_kind = 'refusal' then
      if coalesce(btrim(v_step ->> 'rule'), '') = '' then
        raise exception 'A refusal names the rule it refused under.' using errcode = 'NL422';
      end if;
      v_refusals := v_refusals + 1;
    end if;

    v_withheld := coalesce((v_step ->> 'withheld')::boolean, false);
    if v_withheld and coalesce(btrim(v_step ->> 'withheld_reason'), '') = '' then
      raise exception 'A withheld step says why it was withheld.' using errcode = 'NL422';
    end if;

    -- The kinds of fact the step rests on, deduplicated. An unknown kind is
    -- refused by the constraint rather than stored, because a kind nothing
    -- recognises would withhold the step from every reader.
    if v_step ? 'fact_kinds' and jsonb_typeof(v_step -> 'fact_kinds') = 'array' then
      select coalesce(array_agg(distinct k), '{}')
        into v_kinds
        from jsonb_array_elements_text(v_step -> 'fact_kinds') as k;
    else
      v_kinds := '{}';
    end if;
    if not (v_kinds <@ nl.disclosure_allows('internal')) then
      raise exception 'A step rests on fact kinds this app does not know: %.',
        array_to_string(v_kinds, ', ') using errcode = 'NL422';
    end if;

    v_seq := v_seq + 1;
    insert into nl.agent_run_steps (
      run_key, seq, kind, label, tool, args, result, row_count, ms, rule, rule_note,
      fact_kinds, withheld, withheld_reason)
    values (
      p_run_key, v_seq, v_kind, left(btrim(v_step ->> 'label'), 300),
      left(v_step ->> 'tool', 100),
      -- Withheld: the detail is dropped here, not by the caller.
      case when v_withheld then null
           when v_step ? 'args' and jsonb_typeof(v_step -> 'args') <> 'null' then v_step -> 'args' end,
      case when v_withheld then '' else left(coalesce(v_step ->> 'result', ''), 2000) end,
      (v_step ->> 'rows')::int,
      (v_step ->> 'ms')::int,
      left(v_step ->> 'rule', 100),
      left(coalesce(v_step ->> 'rule_note', ''), 500),
      v_kinds,
      v_withheld,
      case when v_withheld then left(coalesce(v_step ->> 'withheld_reason', ''), 500) else '' end);
  end loop;

  update nl.agent_run_trails
     set step_count = v_seq, refusals = v_refusals
   where run_key = p_run_key;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'record_agent_trail', 'agent_run_trail', p_run_key, p_request_id,
          jsonb_build_object('agent', p_agent, 'woke_by', p_woke_by,
                             'steps', v_seq, 'refusals', v_refusals));

  v_result := jsonb_build_object('run_key', p_run_key, 'recorded', true,
                                 'steps', v_seq, 'refusals', v_refusals);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- The run log with its trail: 0028's row per run, plus how it got there.
-- A run with no trail is still a row here, with nulls, because most runs in a
-- database that predates this migration have none.
create view nl.agent_run_trail_log with (security_invoker = true) as
select l.*,
       t.woke_by                              as trail_woke_by,
       t.woke_note                            as trail_woke_note,
       t.entity                               as trail_entity,
       t.entity_id                            as trail_entity_id,
       t.reader                               as trail_reader,
       t.subject_no                           as trail_subject_no,
       t.bundle_version                       as trail_bundle_version,
       t.decision                             as trail_decision,
       coalesce(t.step_count, 0)              as trail_steps,
       coalesce(t.refusals, 0)                as trail_refusals,
       t.recorded_at                          as trail_recorded_at
from nl.agent_run_log l
left join nl.agent_run_trails t on t.run_key = l.run_key;

comment on view nl.agent_run_trail_log is
  'nl.agent_run_log with the trail that says how the run reached its decision (migration 0042).';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.agent_run_trails enable row level security;
alter table nl.agent_run_steps enable row level security;

-- What the agents did is the company's record, not one person's, so the whole
-- team reads it: a trail only its author can read is not a trail. Nobody
-- writes either table directly. There is no insert, update or delete policy on
-- either, and the function above is security definer, so a step exists only
-- because that function agreed to write it.
create policy agent_run_trails_read on nl.agent_run_trails for select to nl_app using (true);
create policy agent_run_steps_read on nl.agent_run_steps for select to nl_app using (true);

grant select on nl.agent_run_trails, nl.agent_run_steps, nl.agent_run_trail_log to nl_app;

-- nl_readonly gets nothing: a step names accounts, people and prices.

grant execute on function
  nl.record_desk_request(int, text, text, text, text, text, text),
  nl.record_agent_trail(text, text, text, text, text, bigint, text, text, text, text, jsonb, jsonb, text)
to nl_app;
