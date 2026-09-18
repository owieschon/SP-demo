-- 0028 The agent harness: one run record over every agent, the guardrail and
-- degradation events that had nowhere to live, the autonomy ladder, and the
-- metrics that decide a promotion.
--
-- The rules that shape this migration:
--
--   * ONE SHAPE, NO SECOND COPY. Four features already record what their
--     agent did: nl.mail_runs (0021), nl.assistant_messages with
--     nl.assistant_tool_calls (0017), nl.mcp_calls (0024) and
--     nl.automation_runs (0013). This migration does not copy any of it. It
--     puts one view over them, nl.agent_runs, with the same columns whichever
--     agent a row came from.
--   * ONLY WHAT IS MISSING IS STORED. Two things are nowhere today: which
--     named guardrail refused a run, and whether a run degraded to a cheaper
--     honest path and why. Those are rows in nl.agent_events, keyed to a run
--     by its run_key, so the unified view joins them rather than duplicating
--     them.
--   * BUILT FROM THE SOURCES PRESENT. A view cannot name a table that is not
--     there, so the view text is assembled by a function, exactly as
--     nl.agent_queue is in 0023. The procurement desk's own table does not
--     exist yet; when it lands, run nl.rebuild_agent_runs() in that migration.
--   * ROW-LEVEL SECURITY IS UNTOUCHED. Every branch is security_invoker, so a
--     person sees the runs their own policies let them see: the desk's runs are
--     the team's, a conversation with the assistant is only ever its own
--     person's. The log widens nobody's view by a row.
--   * NOTHING PROMOTES ITSELF. A level is a person's write through
--     nl.set_agent_autonomy, which is admin only, refuses a promotion the
--     numbers do not support, refuses skipping a level, and records who did it.
--
-- Depends on 0001 (users, audit log, request ids), 0013 (automation runs),
-- 0017 (assistant), 0021 (the desks), 0023 (queue decisions) and 0024 (MCP).
-- See docs/agent-harness.md.

-- ---------------------------------------------------------------------------
-- The agents and the kinds of work they do
-- ---------------------------------------------------------------------------

-- One row per (agent, kind of work). This is the grain the autonomy ladder
-- works at, because a quote reply is not a stock question: the same agent can
-- be trusted with one and not the other.
create table nl.agent_work_kinds (
  agent       text not null check (agent in
                ('order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp')),
  work_kind   text not null check (work_kind ~ '^[a-z][a-z_]{1,30}$'),
  label       text not null check (length(label) between 3 and 60),
  -- Who reviews this kind of work, in plain words, so the page can say it.
  reviewer    text not null default '',
  description text not null default '',
  primary key (agent, work_kind)
);

comment on table nl.agent_work_kinds is
  'Every agent and every kind of work it does. The grain the autonomy ladder and the metrics use (migration 0028).';

insert into nl.agent_work_kinds (agent, work_kind, label, reviewer, description) values
  ('order_desk', 'rfq', 'Quote reply', 'the mailbox reviewer',
   'A customer asked for a quote. The reply prices every line and gives a date.'),
  ('order_desk', 'purchase_order', 'Order acknowledgement', 'the mailbox reviewer',
   'A customer sent an order. The reply confirms what we can hold to and what we cannot.'),
  ('order_desk', 'price_question', 'Price answer', 'the mailbox reviewer',
   'A customer asked what a part costs them, at one or more quantities.'),
  ('order_desk', 'stock_question', 'Stock or lead time answer', 'the mailbox reviewer',
   'A customer asked what can ship and when. Never a shelf quantity.'),
  ('order_desk', 'order_status', 'Order status answer', 'the mailbox reviewer',
   'A customer asked where an order is. Promised dates and what is running late.'),
  ('order_desk', 'other', 'Question back to the sender', 'the mailbox reviewer',
   'The desk could not tell what the message was, so it asks.'),
  ('procurement_desk', 'vendor_reply', 'Vendor reply', 'the mailbox reviewer',
   'A reply to a supplier on the procurement desk, whatever the message asked.'),
  ('procurement_desk', 'purchase_request', 'Purchase request', 'the buyer',
   'A request to buy, raised from the replenishment maths. Not in this database yet.'),
  ('assistant', 'question', 'Answered question', 'nobody',
   'A read-only answer out of the book. Nothing is written, and nobody reviews it.'),
  ('assistant', 'additive_write', 'Note or next step', 'nobody, after the fact',
   'A note or a next step the assistant added. It only inserts a row, and a person can close it.'),
  ('assistant', 'proposal', 'Proposed change', 'the person who asked',
   'A change the assistant may not make on its own. It runs only when a person approves an option.'),
  ('automation', 'next_step', 'Rule next step', 'nobody, after the fact',
   'A next step written by a rule a person switched on. Once per subject, ever.'),
  ('automation', 'note', 'Rule note', 'nobody, after the fact',
   'A note written by a rule a person switched on. Once per subject, ever.'),
  ('mcp', 'read', 'Answered a coding agent', 'nobody',
   'A read tool answered an outside agent over MCP. Writes nothing.'),
  ('mcp', 'propose', 'Proposal from a coding agent', 'the person the token acts as',
   'An outside agent asked for a change. It becomes a proposal in the app.');

-- ---------------------------------------------------------------------------
-- The autonomy ladder
-- ---------------------------------------------------------------------------

-- Four levels, in order. The ordinal is what makes "one step at a time" and
-- "this is a demotion" checkable rather than a matter of reading the names.
--
--   shadow       it drafts, nobody sees it
--   suggest      a person reviews every one (where most of this app is today)
--   auto_review  it acts, a person can undo inside a window
--   auto         it acts, a sampled share is reviewed afterwards
create function nl.agent_level_ordinal(p_level text) returns int
language sql immutable
set search_path = ''
as $$
  select case p_level
    when 'shadow' then 1
    when 'suggest' then 2
    when 'auto_review' then 3
    when 'auto' then 4
  end
$$;

create table nl.agent_autonomy (
  agent                text not null,
  work_kind            text not null,
  level                text not null check (level in ('shadow', 'suggest', 'auto_review', 'auto')),
  -- auto_review only: how long a person has to undo what it did.
  undo_window_minutes  int not null default 0 check (undo_window_minutes between 0 and 10080),
  -- auto only: the share of runs a person looks at afterwards, 0.05 = one in twenty.
  sample_rate          numeric(4, 3) not null default 0 check (sample_rate between 0 and 1),
  -- Null only for the levels this migration seeds, which describe how the app
  -- already behaves. Every change after that names a person.
  set_by               int references nl.users (id),
  set_at               timestamptz not null default now(),
  note                 text not null default '',
  updated_at           timestamptz not null default nl.now_ms(),
  primary key (agent, work_kind),
  foreign key (agent, work_kind) references nl.agent_work_kinds (agent, work_kind) on delete cascade,
  -- An undo window only means something at auto_review, and a sample only at auto.
  constraint agent_autonomy_window_fits_level check (level = 'auto_review' or undo_window_minutes = 0),
  constraint agent_autonomy_sample_fits_level check (level = 'auto' or sample_rate = 0)
);

comment on table nl.agent_autonomy is
  'The autonomy level per agent per kind of work. The code reads this before it lets an agent act (migration 0028).';

create trigger agent_autonomy_touch before update on nl.agent_autonomy
  for each row execute function nl.touch_updated_at();

-- The seeded levels describe what this app does TODAY, not an aspiration.
-- Every mail draft is reviewed; an assistant answer is read-only and nobody
-- reviews it; a note, a next step and a rule firing are additive writes that
-- happen without review and can be undone by hand.
insert into nl.agent_autonomy (agent, work_kind, level, undo_window_minutes, sample_rate, note) values
  ('order_desk', 'rfq', 'suggest', 0, 0, 'Every quote reply is read by the mailbox reviewer before it goes out.'),
  ('order_desk', 'purchase_order', 'suggest', 0, 0, 'Every order acknowledgement is read before it goes out.'),
  ('order_desk', 'price_question', 'suggest', 0, 0, 'Every price answer is read before it goes out.'),
  ('order_desk', 'stock_question', 'suggest', 0, 0, 'Every stock answer is read before it goes out.'),
  ('order_desk', 'order_status', 'suggest', 0, 0, 'Every status answer is read before it goes out.'),
  ('order_desk', 'other', 'suggest', 0, 0, 'A message the desk could not read always goes to a person.'),
  ('procurement_desk', 'vendor_reply', 'suggest', 0, 0, 'Every vendor reply is read before it goes out.'),
  ('procurement_desk', 'purchase_request', 'suggest', 0, 0, 'A purchase request is a buyer''s decision.'),
  ('assistant', 'question', 'auto', 0, 0, 'A read-only answer. Nobody reviews it, and nothing is sampled yet.'),
  ('assistant', 'additive_write', 'auto_review', 1440, 0,
   'A note or next step is written without review. The undo is a person closing it by hand.'),
  ('assistant', 'proposal', 'suggest', 0, 0, 'A proposal only runs when a person approves an option.'),
  ('automation', 'next_step', 'auto_review', 1440, 0,
   'A rule a person switched on writes on its own. The undo is closing the next step.'),
  ('automation', 'note', 'auto_review', 1440, 0, 'A rule a person switched on writes on its own.'),
  ('mcp', 'read', 'auto', 0, 0, 'A read tool over MCP answers directly, as the person the token acts as.'),
  ('mcp', 'propose', 'suggest', 0, 0, 'An outside agent''s change is a proposal a person approves in the app.');

-- Every change of level, append only, with the numbers as they stood when it
-- was made. "Why is this on auto?" is then a query and not a memory.
--
-- A promotion is always a person's (changed_via = 'person'). The one change
-- that happens without one is the automatic demotion off 'auto' when the
-- sampled reviews go bad, which is changed_via = 'rule' and names no person,
-- because pretending somebody decided it would be a lie in the audit trail.
create table nl.agent_autonomy_changes (
  id          bigint generated always as identity (start with 5001) primary key,
  agent       text not null,
  work_kind   text not null,
  from_level  text not null,
  to_level    text not null,
  changed_via text not null default 'person' check (changed_via in ('person', 'rule')),
  changed_by  int references nl.users (id),
  changed_at  timestamptz not null default now(),
  reason      text not null default '',
  -- The metrics row that justified it, as it read at that moment.
  metrics     jsonb not null default '{}',
  request_id  text not null check (length(request_id) between 8 and 100),
  unique (agent, work_kind, request_id),
  -- A person's change names the person. A rule's names none.
  constraint agent_autonomy_changes_person_named check (
    (changed_via = 'person' and changed_by is not null)
    or (changed_via = 'rule' and changed_by is null))
);

comment on table nl.agent_autonomy_changes is
  'Who moved an agent up or down a level, when, why, and what the numbers were (migration 0028).';

create index agent_autonomy_changes_recent_idx on nl.agent_autonomy_changes (changed_at desc, id desc);
create index agent_autonomy_changes_by_idx on nl.agent_autonomy_changes (changed_by);

-- The promotion rule, as data rather than as a paragraph. One row per step up.
create table nl.agent_promotion_rules (
  from_level         text not null,
  to_level           text not null,
  -- Runs of this kind of work that have been reviewed and decided.
  min_reviewed       int not null check (min_reviewed >= 0),
  -- Of those, the share approved as written or approved after an edit.
  min_approval_rate  numeric(4, 3) not null check (min_approval_rate between 0 and 1),
  -- Of the approved ones, the share a person had to change first.
  max_edit_rate      numeric(4, 3) not null check (max_edit_rate between 0 and 1),
  -- No guardrail may have refused a run in the last this-many runs.
  refusal_window     int not null check (refusal_window > 0),
  max_refusals       int not null check (max_refusals >= 0),
  -- A person still has to sign it off. Always true today; a column so a later
  -- decision to let something promote itself is a visible change to data.
  requires_signoff   boolean not null default true,
  primary key (from_level, to_level)
);

comment on table nl.agent_promotion_rules is
  'What an agent has to show before a person may move it up a level (migration 0028).';

insert into nl.agent_promotion_rules
  (from_level, to_level, min_reviewed, min_approval_rate, max_edit_rate, refusal_window, max_refusals) values
  ('shadow', 'suggest', 20, 0.900, 0.250, 50, 0),
  ('suggest', 'auto_review', 50, 0.950, 0.100, 100, 0),
  ('auto_review', 'auto', 200, 0.980, 0.050, 200, 0);

-- ---------------------------------------------------------------------------
-- The events that had nowhere to live
-- ---------------------------------------------------------------------------

-- One row per notable thing that happened to a run and is not already
-- recorded by the feature that owns it:
--
--   guardrail   a named check refused the run, or sent it to a person
--   degraded    the run fell back to a cheaper honest path, and why
--   autonomy    the harness acted, or declined to act, because of the level
--
-- A run is named by its run_key, which is '<agent>:<source_id>' and is exactly
-- the key nl.agent_runs carries, so the two join without a second id.
create table nl.agent_events (
  id         bigint generated always as identity (start with 4001) primary key,
  agent      text not null check (agent in
               ('order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp')),
  run_key    text not null check (run_key ~ '^[a-z_]+:[0-9]+$'),
  work_kind  text not null default '',
  kind       text not null check (kind in ('guardrail', 'degraded', 'autonomy')),
  -- The check's id from the registry in app/src/lib/server/harness/guardrails.ts,
  -- or the degradation's reason code, or the autonomy decision.
  check_id   text not null check (length(check_id) between 1 and 60),
  verdict    text not null check (verdict in ('pass', 'refuse', 'needs_person', 'degraded', 'noted')),
  detail     text not null default '',
  at         timestamptz not null default now(),
  request_id text not null check (length(request_id) between 8 and 100),
  -- The same event, from a retried wake, is one row.
  unique (run_key, kind, check_id, request_id)
);

comment on table nl.agent_events is
  'Guardrail refusals, degradations and autonomy decisions, keyed to a run. The part of a run record that no feature stored (migration 0028).';

create index agent_events_run_idx on nl.agent_events (run_key);
create index agent_events_kind_idx on nl.agent_events (agent, kind, verdict, at desc);
create index agent_events_recent_idx on nl.agent_events (at desc, id desc);

-- Record one event. Follows the repository's write rules: it claims the
-- request id, requires an active user, checks its fields with NL4xx codes, and
-- writes an audit row for anything that is not a plain pass (a pass is the
-- normal case and would drown the audit log).
create function nl.record_agent_event(
  p_agent      text,
  p_run_key    text,
  p_work_kind  text,
  p_kind       text,
  p_check_id   text,
  p_verdict    text,
  p_detail     text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_agent_event');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_agent is null or p_agent not in
       ('order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp') then
    raise exception 'There is no agent called %.', coalesce(p_agent, 'empty') using errcode = 'NL422';
  end if;
  if p_run_key is null or p_run_key !~ '^[a-z_]+:[0-9]+$' then
    raise exception 'A run key reads like order_desk:412, not %.', coalesce(p_run_key, 'empty')
      using errcode = 'NL422';
  end if;
  if p_kind is null or p_kind not in ('guardrail', 'degraded', 'autonomy') then
    raise exception 'An event is a guardrail, a degraded or an autonomy event, not %.',
      coalesce(p_kind, 'empty') using errcode = 'NL422';
  end if;
  if p_check_id is null or length(btrim(p_check_id)) = 0 or length(p_check_id) > 60 then
    raise exception 'An event names the check or the reason it is about.' using errcode = 'NL422';
  end if;
  if p_verdict is null or p_verdict not in ('pass', 'refuse', 'needs_person', 'degraded', 'noted') then
    raise exception 'A verdict is pass, refuse, needs_person, degraded or noted, not %.',
      coalesce(p_verdict, 'empty') using errcode = 'NL422';
  end if;

  insert into nl.agent_events (agent, run_key, work_kind, kind, check_id, verdict, detail, request_id)
  values (p_agent, p_run_key, left(coalesce(p_work_kind, ''), 30), p_kind, p_check_id, p_verdict,
          left(coalesce(p_detail, ''), 1000), p_request_id)
  on conflict (run_key, kind, check_id, request_id) do nothing
  returning id, at into v_id, v_at;

  if v_id is null then
    select e.id, e.at into v_id, v_at
    from nl.agent_events e
    where e.run_key = p_run_key and e.kind = p_kind
      and e.check_id = p_check_id and e.request_id = p_request_id;
    v_result := jsonb_build_object('event_id', v_id, 'at', v_at, 'recorded', false);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  if p_verdict <> 'pass' then
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (v_actor.id, 'assistant', 'agent_event', 'agent_event', v_id::text, p_request_id,
            jsonb_build_object('agent', p_agent, 'run_key', p_run_key, 'kind', p_kind,
                               'check_id', p_check_id, 'verdict', p_verdict,
                               'detail', left(coalesce(p_detail, ''), 500)));
  end if;

  v_result := jsonb_build_object('event_id', v_id, 'at', v_at, 'recorded', true);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- The pause switch
-- ---------------------------------------------------------------------------

-- One live row per paused agent, or the agent 'all', which pauses every one of
-- them. Anybody active may pull it; only an administrator may let it go. That
-- asymmetry is deliberate: hitting the brake should never need a permission,
-- and releasing it should.
create table nl.agent_pauses (
  id         bigint generated always as identity (start with 3001) primary key,
  agent      text not null check (agent in
               ('all', 'order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp')),
  reason     text not null default '',
  paused_by  int not null references nl.users (id),
  paused_at  timestamptz not null default now(),
  lifted_by  int references nl.users (id),
  lifted_at  timestamptz,
  request_id text not null check (length(request_id) between 8 and 100),
  unique (agent, request_id),
  constraint agent_pauses_lift_recorded check (
    (lifted_at is null and lifted_by is null) or (lifted_at is not null and lifted_by is not null))
);

comment on table nl.agent_pauses is
  'The brake. A live row here stops an agent acting on its own, immediately (migration 0028).';

-- At most one live pause per agent, so "is it paused" is one index lookup and
-- lifting one cannot leave another behind.
create unique index agent_pauses_live_idx on nl.agent_pauses (agent) where lifted_at is null;
create index agent_pauses_recent_idx on nl.agent_pauses (paused_at desc, id desc);

-- Is this agent stopped, and by whom? Reads through 'all', so a global pause
-- answers for every agent without anything having to copy it.
create function nl.agent_paused(p_agent text) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('paused', true, 'scope', p.agent, 'reason', p.reason,
                               'paused_by', p.paused_by, 'paused_by_name', u.full_name,
                               'paused_at', p.paused_at)
     from nl.agent_pauses p
     join nl.users u on u.id = p.paused_by
     where p.lifted_at is null and p.agent in ('all', p_agent)
     -- A global pause is the stronger answer, so it wins.
     order by (p.agent = 'all') desc, p.paused_at desc
     limit 1),
    jsonb_build_object('paused', false, 'scope', p_agent))
$$;

create function nl.set_agent_pause(
  p_agent      text,
  p_paused     boolean,
  p_reason     text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_live   nl.agent_pauses;
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_agent_pause');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_agent is null or p_agent not in
       ('all', 'order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp') then
    raise exception 'There is no agent called %. Use all to stop every one of them.',
      coalesce(p_agent, 'empty') using errcode = 'NL422';
  end if;

  select * into v_live from nl.agent_pauses
  where agent = p_agent and lifted_at is null
  for update;

  if coalesce(p_paused, false) then
    if found then
      v_result := jsonb_build_object('agent', p_agent, 'paused', true, 'changed', false,
                                     'pause_id', v_live.id);
      perform nl.finish_request(p_request_id, v_result);
      return v_result;
    end if;
    insert into nl.agent_pauses (agent, reason, paused_by, request_id)
    values (p_agent, left(coalesce(p_reason, ''), 500), v_actor.id, p_request_id)
    returning id into v_id;
    v_result := jsonb_build_object('agent', p_agent, 'paused', true, 'changed', true, 'pause_id', v_id);
  else
    -- Letting it go is the administrator's.
    if not nl.is_admin() then
      raise exception 'Anybody can pause an agent. Only an administrator can start it again.'
        using errcode = 'NL403';
    end if;
    if not found then
      v_result := jsonb_build_object('agent', p_agent, 'paused', false, 'changed', false);
      perform nl.finish_request(p_request_id, v_result);
      return v_result;
    end if;
    update nl.agent_pauses
       set lifted_by = v_actor.id, lifted_at = now()
     where id = v_live.id;
    v_id := v_live.id;
    v_result := jsonb_build_object('agent', p_agent, 'paused', false, 'changed', true, 'pause_id', v_id);
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', case when coalesce(p_paused, false) then 'pause_agent' else 'start_agent' end,
          'agent_pause', p_agent, p_request_id,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 500), 'pause_id', v_id));

  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- What an agent did on its own, and how to take it back
-- ---------------------------------------------------------------------------

-- One row per action an agent took without asking first. This table is not a
-- copy of the write: the write is in the feature's own table and its own audit
-- row. This is the record of the AUTHORITY it acted under, the window a person
-- has to reverse it, and whether it was reversed or sampled.
create table nl.agent_actions (
  id                 bigint generated always as identity (start with 2001) primary key,
  agent              text not null check (agent in
                       ('order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp')),
  work_kind          text not null,
  run_key            text not null check (run_key ~ '^[a-z_]+:[0-9]+$'),
  -- The function it called and the row it changed, so an undo knows what to
  -- reverse and an auditor knows what happened.
  action             text not null check (length(action) between 3 and 60),
  entity             text not null check (length(entity) between 3 and 40),
  entity_id          text not null check (length(entity_id) between 1 and 40),
  -- The level that allowed it, stored: a level changed tomorrow must not
  -- rewrite why something was allowed today.
  at_level           text not null check (at_level in ('auto_review', 'auto')),
  -- The person the agent acted as. Every write it made is theirs in the audit
  -- trail, and this row is what says a person did not choose it.
  acted_by           int not null references nl.users (id),
  acted_at           timestamptz not null default now(),
  -- Null at 'auto': it went out at once and there is nothing to hold.
  undo_until         timestamptz,
  -- Chosen at 'auto' by nl.agent_sampled(), which is deterministic, so the
  -- same run is always either in the sample or not.
  sampled            boolean not null default false,
  sample_verdict     text check (sample_verdict in ('good', 'bad')),
  sample_reviewed_by int references nl.users (id),
  sample_reviewed_at timestamptz,
  status             text not null default 'done'
                       check (status in ('done', 'undoing', 'undone', 'irreversible')),
  undone_by          int references nl.users (id),
  undone_at          timestamptz,
  undo_reason        text not null default '',
  detail             jsonb not null default '{}',
  request_id         text not null check (length(request_id) between 8 and 100),
  updated_at         timestamptz not null default nl.now_ms(),
  unique (run_key, action, request_id),
  constraint agent_actions_undo_recorded check (
    (status <> 'undone' and undone_by is null and undone_at is null)
    or (status = 'undone' and undone_by is not null and undone_at is not null)),
  constraint agent_actions_sample_recorded check (
    (sample_verdict is null and sample_reviewed_by is null and sample_reviewed_at is null)
    or (sample_verdict is not null and sample_reviewed_by is not null and sample_reviewed_at is not null)),
  constraint agent_actions_sample_needs_sampling check (sampled or sample_verdict is null)
);

comment on table nl.agent_actions is
  'Every action an agent took on its own: the authority it used, the window to reverse it, and whether it was reversed or sampled (migration 0028).';

create index agent_actions_run_idx on nl.agent_actions (run_key);
create index agent_actions_recent_idx on nl.agent_actions (acted_at desc, id desc);
create index agent_actions_open_idx on nl.agent_actions (status, undo_until);
create index agent_actions_sample_idx on nl.agent_actions (agent, work_kind, sampled, sample_verdict);
create index agent_actions_entity_idx on nl.agent_actions (entity, entity_id);

create trigger agent_actions_touch before update on nl.agent_actions
  for each row execute function nl.touch_updated_at();

-- Is this run in the review sample? Deterministic on the run key, so it is the
-- same answer every time the question is asked, and a test can pick a key that
-- is in the sample and one that is not. hashtext is stable within a major
-- version, which is all this needs: the answer only has to be consistent, not
-- portable.
create function nl.agent_sampled(p_run_key text, p_rate numeric) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when coalesce(p_rate, 0) <= 0 then false
    when p_rate >= 1 then true
    else (abs(pg_catalog.hashtext(p_run_key)) % 1000) < (p_rate * 1000)
  end
$$;

create function nl.record_agent_action(
  p_agent        text,
  p_work_kind    text,
  p_run_key      text,
  p_action       text,
  p_entity       text,
  p_entity_id    text,
  p_at_level     text,
  p_undo_minutes int,
  p_detail       jsonb,
  p_request_id   text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_level   nl.agent_autonomy;
  v_sampled boolean;
  v_until   timestamptz;
  v_id      bigint;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_agent_action');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_at_level is null or p_at_level not in ('auto_review', 'auto') then
    raise exception 'An agent only acts on its own at auto_review or auto, not at %.',
      coalesce(p_at_level, 'empty') using errcode = 'NL422';
  end if;
  if p_run_key is null or p_run_key !~ '^[a-z_]+:[0-9]+$' then
    raise exception 'A run key reads like order_desk:412, not %.', coalesce(p_run_key, 'empty')
      using errcode = 'NL422';
  end if;

  select * into v_level from nl.agent_autonomy a
  where a.agent = p_agent and a.work_kind = p_work_kind;
  if not found then
    raise exception 'There is no agent % doing %.',
      coalesce(p_agent, 'empty'), coalesce(p_work_kind, 'empty') using errcode = 'NL404';
  end if;
  -- The level in the database decides, not the level the caller believes in.
  if v_level.level <> p_at_level then
    raise exception '% doing % is at %, so it may not act at %.',
      p_agent, p_work_kind, v_level.level, p_at_level using errcode = 'NL403';
  end if;
  if (nl.agent_paused(p_agent) ->> 'paused')::boolean then
    raise exception '% is paused, so it may not act. Start it again first.', p_agent
      using errcode = 'NL403';
  end if;

  v_sampled := p_at_level = 'auto' and nl.agent_sampled(p_run_key, v_level.sample_rate);
  v_until := case
    when p_at_level = 'auto_review' then now() + (coalesce(p_undo_minutes, v_level.undo_window_minutes)
                                                  || ' minutes')::interval
  end;

  insert into nl.agent_actions (agent, work_kind, run_key, action, entity, entity_id, at_level,
                                acted_by, undo_until, sampled, detail, request_id)
  values (p_agent, p_work_kind, p_run_key, p_action, p_entity, p_entity_id, p_at_level,
          v_actor.id, v_until, v_sampled, coalesce(p_detail, '{}'::jsonb), p_request_id)
  on conflict (run_key, action, request_id) do nothing
  returning id into v_id;

  if v_id is null then
    select a.id, a.undo_until, a.sampled into v_id, v_until, v_sampled
    from nl.agent_actions a
    where a.run_key = p_run_key and a.action = p_action and a.request_id = p_request_id;
    v_result := jsonb_build_object('action_id', v_id, 'undo_until', v_until,
                                   'sampled', v_sampled, 'recorded', false);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'agent_acted', 'agent_action', v_id::text, p_request_id,
          jsonb_build_object('agent', p_agent, 'work_kind', p_work_kind, 'run_key', p_run_key,
                             'did', p_action, 'on', p_entity || ' ' || p_entity_id,
                             'at_level', p_at_level, 'undo_until', v_until, 'sampled', v_sampled));

  v_result := jsonb_build_object('action_id', v_id, 'undo_until', v_until,
                                 'sampled', v_sampled, 'recorded', true);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Taking one back, in two steps, for the same reason approving and sending are
-- two steps: the window is checked and the row is locked BEFORE anything is
-- reversed, and the reversal itself goes through the feature's own checked
-- function. This one says whether an undo may start and what to reverse.
create function nl.claim_agent_undo(
  p_action_id  bigint,
  p_reason     text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_action nl.agent_actions;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'claim_agent_undo');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_action from nl.agent_actions where id = p_action_id for update;
  if not found then
    raise exception 'There is no agent action %.', coalesce(p_action_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  -- The person it acted as, or an administrator. On the desks that is the
  -- mailbox's reviewer, which is the same person who could have approved it.
  if v_action.acted_by <> v_actor.id and not nl.is_admin() then
    raise exception 'Only %s or an administrator can undo this.',
      (select u.full_name from nl.users u where u.id = v_action.acted_by) using errcode = 'NL403';
  end if;
  if v_action.status = 'undone' then
    raise exception 'That action was already undone.' using errcode = 'NL422';
  end if;
  if v_action.status = 'irreversible' then
    raise exception 'That action cannot be undone: %', v_action.undo_reason using errcode = 'NL422';
  end if;
  if v_action.undo_until is null then
    raise exception 'That action had no undo window: it was taken at %, which sends at once. Put it right by hand.',
      v_action.at_level using errcode = 'NL422';
  end if;
  if v_action.undo_until < now() then
    raise exception 'The window to undo this closed at %. Put it right by hand.',
      to_char(v_action.undo_until, 'FMDay FMMonth FMDD, HH24:MI') using errcode = 'NL422';
  end if;

  update nl.agent_actions
     set status = 'undoing', undo_reason = left(coalesce(p_reason, ''), 500)
   where id = p_action_id;

  v_result := jsonb_build_object('action_id', p_action_id, 'entity', v_action.entity,
                                 'entity_id', v_action.entity_id, 'agent', v_action.agent,
                                 'work_kind', v_action.work_kind, 'did', v_action.action,
                                 'detail', v_action.detail, 'may_undo', true);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- And this one records how it went. Reversed: 'undone'. Could not be reversed:
-- back to 'done' with the note, or 'irreversible' when it can never be.
create function nl.finish_agent_undo(
  p_action_id    bigint,
  p_undone       boolean,
  p_note         text,
  p_irreversible boolean,
  p_request_id   text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_action nl.agent_actions;
  v_status text;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'finish_agent_undo');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_action from nl.agent_actions where id = p_action_id for update;
  if not found then
    raise exception 'There is no agent action %.', coalesce(p_action_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  if v_action.status <> 'undoing' then
    raise exception 'Action % is %, so no undo is in progress.', p_action_id, v_action.status
      using errcode = 'NL422';
  end if;

  v_status := case
    when coalesce(p_undone, false) then 'undone'
    when coalesce(p_irreversible, false) then 'irreversible'
    else 'done'
  end;

  update nl.agent_actions
     set status      = v_status,
         undone_by   = case when v_status = 'undone' then v_actor.id end,
         undone_at   = case when v_status = 'undone' then now() end,
         -- An undo keeps the reason the person gave when they asked for it. A
         -- failed or impossible one keeps why it could not be done.
         undo_reason = case when v_status = 'undone' then v_action.undo_reason
                            else left(coalesce(nullif(btrim(coalesce(p_note, '')), ''),
                                               v_action.undo_reason), 500) end
   where id = p_action_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'undo_agent_action', 'agent_action', p_action_id::text, p_request_id,
          jsonb_build_object('status', v_status, 'did', v_action.action,
                             'on', v_action.entity || ' ' || v_action.entity_id,
                             'note', left(coalesce(p_note, ''), 500)));

  v_result := jsonb_build_object('action_id', p_action_id, 'status', v_status);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- A person's verdict on one sampled action. At 'auto' nobody approves
-- beforehand, so this is the only review there is, and it is what the
-- automatic demotion reads.
create function nl.review_sampled_action(
  p_action_id  bigint,
  p_verdict    text,
  p_note       text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_action nl.agent_actions;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'review_sampled_action');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_verdict is null or p_verdict not in ('good', 'bad') then
    raise exception 'A sampled action is good or bad, not %.', coalesce(p_verdict, 'empty')
      using errcode = 'NL422';
  end if;

  select * into v_action from nl.agent_actions where id = p_action_id for update;
  if not found then
    raise exception 'There is no agent action %.', coalesce(p_action_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  if not v_action.sampled then
    raise exception 'Action % is not in the review sample.', p_action_id using errcode = 'NL422';
  end if;
  if v_action.sample_verdict is not null then
    raise exception 'Action % was already reviewed as %.', p_action_id, v_action.sample_verdict
      using errcode = 'NL422';
  end if;

  update nl.agent_actions
     set sample_verdict = p_verdict, sample_reviewed_by = v_actor.id, sample_reviewed_at = now(),
         undo_reason = case when p_verdict = 'bad' then left(coalesce(p_note, ''), 500) else undo_reason end
   where id = p_action_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'review_sampled_action', 'agent_action', p_action_id::text, p_request_id,
          jsonb_build_object('verdict', p_verdict, 'agent', v_action.agent,
                             'work_kind', v_action.work_kind,
                             'note', left(coalesce(p_note, ''), 500)));

  v_result := jsonb_build_object('action_id', p_action_id, 'verdict', p_verdict);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- What the sample says, per agent and kind of work.
create view nl.agent_sample_scores with (security_invoker = true) as
select a.agent,
       a.work_kind,
       count(*) filter (where a.sampled)::int                                as sampled,
       count(*) filter (where a.sample_verdict is not null)::int             as sample_reviewed,
       count(*) filter (where a.sample_verdict = 'good')::int                as sample_good,
       count(*) filter (where a.sample_verdict = 'bad')::int                 as sample_bad,
       round((count(*) filter (where a.sample_verdict = 'good')::numeric)
             / nullif(count(*) filter (where a.sample_verdict is not null), 0), 4) as sample_pass_rate,
       count(*) filter (where a.status = 'undone')::int                      as undone,
       count(*)::int                                                         as acted
from nl.agent_actions a
group by a.agent, a.work_kind;

-- ---------------------------------------------------------------------------
-- How big an edit was
-- ---------------------------------------------------------------------------

-- The agent's own output, as a length and a hash, written when it produces
-- something a person can rewrite. Not the text: the text is already in the
-- feature's table, and this is what is left after a person overwrites it.
-- Without this row "how big was the edit" is unanswerable, because
-- nl.approve_mail_draft overwrites the body in place.
create table nl.agent_artifacts (
  entity     text not null check (length(entity) between 3 and 40),
  entity_id  text not null check (length(entity_id) between 1 and 40),
  run_key    text not null check (run_key ~ '^[a-z_]+:[0-9]+$'),
  agent      text not null,
  work_kind  text not null default '',
  chars      int not null check (chars >= 0),
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  at         timestamptz not null default now(),
  request_id text not null check (length(request_id) between 8 and 100),
  primary key (entity, entity_id)
);

comment on table nl.agent_artifacts is
  'The size and hash of what an agent wrote, so an edit by a person can be measured after the text is overwritten (migration 0028).';

create index agent_artifacts_run_idx on nl.agent_artifacts (run_key);

create function nl.record_agent_artifact(
  p_entity     text,
  p_entity_id  text,
  p_run_key    text,
  p_agent      text,
  p_work_kind  text,
  p_chars      int,
  p_sha256     text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_agent_artifact');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'An artifact is recorded with the SHA-256 of what was written.'
      using errcode = 'NL422';
  end if;

  insert into nl.agent_artifacts (entity, entity_id, run_key, agent, work_kind, chars, sha256, request_id)
  values (p_entity, p_entity_id, p_run_key, p_agent, left(coalesce(p_work_kind, ''), 30),
          greatest(coalesce(p_chars, 0), 0), p_sha256, p_request_id)
  on conflict (entity, entity_id) do nothing;

  v_result := jsonb_build_object('entity', p_entity, 'entity_id', p_entity_id, 'chars', p_chars);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- How much a person changed, for the drafts where the agent's own size was
-- recorded. changed reads the hash, so a rewrite that happens to be the same
-- length still counts as one.
create view nl.agent_edit_sizes with (security_invoker = true) as
select f.run_key,
       f.entity,
       f.entity_id,
       f.chars                                                  as agent_chars,
       length(d.body)                                           as final_chars,
       abs(length(d.body) - f.chars)                            as delta_chars,
       round(100.0 * abs(length(d.body) - f.chars) / greatest(f.chars, 1), 1) as delta_percent,
       (encode(sha256(d.body::bytea), 'hex') <> f.sha256)       as changed
from nl.agent_artifacts f
join nl.mail_drafts d on f.entity = 'mail_draft' and d.id::text = f.entity_id;

comment on view nl.agent_edit_sizes is
  'What a person changed on a draft the agent wrote: characters and whether the text differs at all (migration 0028).';

-- ---------------------------------------------------------------------------
-- One run record for every agent action
-- ---------------------------------------------------------------------------

-- One SELECT in the run log's shape for one source, or null when that source
-- is not in this database. Every branch casts every column, so the union has
-- one type per column whichever branches are in it.
--
-- The shape, once:
--   agent, work_kind, run_key, source_id, woke_by, wake_detail,
--   subject_kind, subject_no, input_ids, tool_calls, tool_call_count,
--   mode, model, input_tokens, output_tokens, produced, produced_ref,
--   acted_as, review_state, reviewed_by, reviewed_at,
--   outcome, started_at, finished_at, ms
create function nl.agent_runs_fragment(p_source text) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_table text;
begin
  -- 1. The desks. One table, two agents: which one it is comes from the
  -- mailbox's kind, because an order desk and a procurement desk read the same
  -- inbox machinery and answer to different rules.
  if p_source = 'desk' then
    if pg_catalog.to_regclass('nl.mail_runs') is null then
      return null;
    end if;
    return $frag$
      select (case when b.kind = 'orders' then 'order_desk' else 'procurement_desk' end)::text as agent,
             -- The intent lives on the message, which is where the run wrote
             -- it. On the procurement desk what matters is that it is a vendor
             -- reply, so every intent rolls up to one kind of work there.
             (case when b.kind = 'orders' then coalesce(m.intent, 'other')
                   else 'vendor_reply' end)::text                    as work_kind,
             ((case when b.kind = 'orders' then 'order_desk' else 'procurement_desk' end)
               || ':' || r.id)::text                                 as run_key,
             r.id::bigint                                            as source_id,
             'mail'::text                                            as woke_by,
             ('Mail from ' || m.from_address)::text                   as wake_detail,
             (case when m.customer_no is not null then 'account'
                   when m.vendor_no is not null then 'vendor' end)::text as subject_kind,
             coalesce(m.customer_no, m.vendor_no)::text              as subject_no,
             jsonb_build_object('message_id', m.id, 'mailbox_id', r.mailbox_id,
                                'customer_no', m.customer_no, 'vendor_no', m.vendor_no,
                                'contact_id', m.contact_id)          as input_ids,
             coalesce((select jsonb_agg(jsonb_build_object(
                                'name', l ->> 'name', 'ms', l -> 'ms',
                                'rows', l -> 'rows', 'outcome', 'ran'))
                       from jsonb_array_elements(r.lookups) l), '[]'::jsonb) as tool_calls,
             r.lookup_count::int                                     as tool_call_count,
             r.mode::text                                            as mode,
             r.model::text                                           as model,
             r.input_tokens::int                                     as input_tokens,
             r.output_tokens::int                                    as output_tokens,
             (case when d.id is null then 'No draft'
                   else 'Draft M-' || d.id end)::text                as produced,
             jsonb_build_object('draft_id', d.id, 'rfq_draft_id', m.rfq_draft_id) as produced_ref,
             b.reviewer_id::int                                      as acted_as,
             (case
                when d.id is null then 'none'
                when d.status = 'draft' then 'waiting'
                when d.status = 'rejected' then 'rejected'
                when d.edited then 'edited_approved'
                else 'approved'
              end)::text                                             as review_state,
             d.reviewed_by::int                                      as reviewed_by,
             d.reviewed_at                                           as reviewed_at,
             (case r.outcome
                when 'drafted' then 'ok'
                when 'needs_person' then 'needs_person'
                when 'ignored' then 'ignored'
                when 'failed' then 'failed'
                else 'running'
              end)::text                                             as outcome,
             r.started_at                                            as started_at,
             r.finished_at                                           as finished_at,
             (extract(epoch from (coalesce(r.finished_at, r.started_at) - r.started_at)) * 1000)::int as ms
      from nl.mail_runs r
      join nl.mail_messages m on m.id = r.message_id
      join nl.mailboxes b on b.id = r.mailbox_id
      left join nl.mail_drafts d on d.id = r.draft_id
    $frag$;

  -- 2. The assistant. One run is one answered question: the answer message,
  -- with the tools it asked for and the proposal it made, if it made one.
  elsif p_source = 'assistant' then
    if pg_catalog.to_regclass('nl.assistant_messages') is null then
      return null;
    end if;
    return $frag$
      select 'assistant'::text                                       as agent,
             (case when p.id is not null then 'proposal'
                   when t.additive > 0 then 'additive_write'
                   else 'question' end)::text                        as work_kind,
             ('assistant:' || a.id)::text                            as run_key,
             a.id::bigint                                            as source_id,
             'person'::text                                          as woke_by,
             ('Asked by ' || u.full_name)::text                      as wake_detail,
             (case when cu.customer_no is not null then 'account' end)::text as subject_kind,
             cu.customer_no::text                                    as subject_no,
             jsonb_build_object('conversation_id', a.conversation_id, 'question_id', q.id) as input_ids,
             coalesce(t.calls, '[]'::jsonb)                          as tool_calls,
             coalesce(t.call_count, 0)::int                          as tool_call_count,
             c.mode::text                                            as mode,
             coalesce(g.model, case when c.mode = 'mock' then 'scripted-demo' end)::text as model,
             coalesce(g.input_tokens, 0)::int                        as input_tokens,
             coalesce(g.output_tokens, 0)::int                       as output_tokens,
             (case when p.id is not null then 'Proposal P-' || p.id else 'An answer' end)::text as produced,
             jsonb_build_object('proposal_id', p.id, 'answer_id', a.id) as produced_ref,
             c.user_id::int                                          as acted_as,
             (case
                when p.id is null then 'none'
                when p.status = 'draft' then 'waiting'
                when p.status = 'rejected' then 'rejected'
                else 'approved'
              end)::text                                             as review_state,
             p.decided_by::int                                       as reviewed_by,
             p.decided_at                                            as reviewed_at,
             (case when t.refused > 0 and t.ran = 0 then 'refused' else 'ok' end)::text as outcome,
             a.created_at                                            as started_at,
             a.created_at                                            as finished_at,
             coalesce(t.ms, 0)::int                                  as ms
      from nl.assistant_messages a
      join nl.assistant_conversations c on c.id = a.conversation_id
      join nl.users u on u.id = c.user_id
      left join nl.assistant_messages q
             on q.conversation_id = a.conversation_id and q.seq = a.seq - 1 and q.role = 'question'
      left join lateral (
        select jsonb_agg(jsonb_build_object('name', tc.name, 'risk', tc.risk,
                                            'outcome', tc.outcome, 'ms', tc.ms, 'rows', tc.rows)
                         order by tc.id)                             as calls,
               count(*)                                              as call_count,
               sum(tc.ms)                                            as ms,
               count(*) filter (where tc.risk = 'additive' and tc.outcome = 'ran') as additive,
               count(*) filter (where tc.outcome = 'ran')            as ran,
               count(*) filter (where tc.outcome in ('refused', 'gated', 'failed')) as refused
        from nl.assistant_tool_calls tc
        where tc.message_id = a.id
      ) t on true
      left join lateral (
        select pr.* from nl.assistant_proposals pr where pr.message_id = a.id order by pr.id limit 1
      ) p on true
      left join lateral (
        -- assistant_usage has no message id, so a turn's tokens are the usage
        -- rows written inside the same transaction as its answer. See the gaps
        -- in docs/agent-harness.md.
        select sum(us.input_tokens) as input_tokens, sum(us.output_tokens) as output_tokens,
               max(us.model) as model
        from nl.assistant_usage us
        where us.conversation_id = a.conversation_id
          and us.at between coalesce(q.created_at, a.created_at) and a.created_at
      ) g on true
      left join lateral (
        select cm.customer_no
        from nl.commitments cm
        where cm.id = (case when (p.options -> 0 -> 'input' ->> 'commitment_id') ~ '^[0-9]+$'
                            then (p.options -> 0 -> 'input' ->> 'commitment_id')::bigint end)
      ) cu on true
      where a.role = 'answer' and c.mode in ('mock', 'live')
    $frag$;

  -- 3. MCP reads, and propose calls that never became a proposal. A propose
  -- call that worked is the branch below, because there the proposal is the
  -- thing a person decides.
  elsif p_source = 'mcp_calls' then
    if pg_catalog.to_regclass('nl.mcp_calls') is null then
      return null;
    end if;
    return $frag$
      select 'mcp'::text                                             as agent,
             (case when k.tool like 'propose%' then 'propose' else 'read' end)::text as work_kind,
             ('mcp:' || k.id)::text                                  as run_key,
             k.id::bigint                                            as source_id,
             'token'::text                                           as woke_by,
             ('Coding agent: ' || t.label)::text                     as wake_detail,
             null::text                                              as subject_kind,
             null::text                                              as subject_no,
             jsonb_build_object('token_id', k.token_id, 'method', k.method) as input_ids,
             jsonb_build_array(jsonb_build_object('name', nullif(k.tool, ''), 'risk', 'read',
                                                  'outcome', k.outcome, 'ms', k.ms, 'rows', k.rows)) as tool_calls,
             1::int                                                  as tool_call_count,
             'n/a'::text                                             as mode,
             null::text                                              as model,
             0::int                                                  as input_tokens,
             0::int                                                  as output_tokens,
             (case k.outcome when 'ok' then 'Answered' else initcap(k.outcome) end)::text as produced,
             jsonb_build_object('note', k.note)                      as produced_ref,
             t.user_id::int                                          as acted_as,
             'none'::text                                            as review_state,
             null::int                                               as reviewed_by,
             null::timestamptz                                       as reviewed_at,
             (case k.outcome
                when 'ok' then 'ok'
                when 'refused' then 'refused'
                when 'capped' then 'refused'
                else 'failed'
              end)::text                                             as outcome,
             k.at                                                    as started_at,
             k.at                                                    as finished_at,
             k.ms::int                                               as ms
      from nl.mcp_calls k
      join nl.mcp_tokens t on t.id = k.token_id
      where k.method = 'tools/call'
        and not (k.tool like 'propose%' and k.outcome = 'ok')
    $frag$;

  -- 4. A proposal an outside agent made over MCP. Its conversation's mode is
  -- 'mcp', which is how it is told apart from the in-app assistant's.
  elsif p_source = 'mcp_proposals' then
    if pg_catalog.to_regclass('nl.assistant_proposals') is null then
      return null;
    end if;
    return $frag$
      select 'mcp'::text                                             as agent,
             'propose'::text                                         as work_kind,
             ('mcp_proposal:' || p.id)::text                         as run_key,
             p.id::bigint                                            as source_id,
             'token'::text                                           as woke_by,
             'Coding agent over MCP'::text                            as wake_detail,
             (case when cu.customer_no is not null then 'account' end)::text as subject_kind,
             cu.customer_no::text                                    as subject_no,
             jsonb_build_object('conversation_id', p.conversation_id, 'proposal_id', p.id) as input_ids,
             coalesce((select jsonb_agg(jsonb_build_object('name', tc.name, 'risk', tc.risk,
                                                           'outcome', tc.outcome, 'ms', tc.ms)
                                        order by tc.id)
                       from nl.assistant_tool_calls tc
                       where tc.conversation_id = p.conversation_id), '[]'::jsonb) as tool_calls,
             (select count(*)::int from nl.assistant_tool_calls tc
              where tc.conversation_id = p.conversation_id)          as tool_call_count,
             'n/a'::text                                             as mode,
             null::text                                              as model,
             0::int                                                  as input_tokens,
             0::int                                                  as output_tokens,
             ('Proposal P-' || p.id)::text                           as produced,
             jsonb_build_object('proposal_id', p.id)                 as produced_ref,
             p.created_by::int                                       as acted_as,
             (case p.status
                when 'draft' then 'waiting'
                when 'rejected' then 'rejected'
                else 'approved'
              end)::text                                             as review_state,
             p.decided_by::int                                       as reviewed_by,
             p.decided_at                                            as reviewed_at,
             'ok'::text                                              as outcome,
             p.created_at                                            as started_at,
             p.created_at                                            as finished_at,
             0::int                                                  as ms
      from nl.assistant_proposals p
      join nl.assistant_conversations c on c.id = p.conversation_id and c.mode = 'mcp'
      left join lateral (
        select cm.customer_no
        from nl.commitments cm
        where cm.id = (case when (p.options -> 0 -> 'input' ->> 'commitment_id') ~ '^[0-9]+$'
                            then (p.options -> 0 -> 'input' ->> 'commitment_id')::bigint end)
      ) cu on true
    $frag$;

  -- 5. The automation runner. One run is one rule run once, which fires for
  -- every subject it matched and has not fired for before.
  elsif p_source = 'automation' then
    if pg_catalog.to_regclass('nl.automation_runs') is null then
      return null;
    end if;
    return $frag$
      select 'automation'::text                                      as agent,
             (r.action ->> 'kind')::text                              as work_kind,
             ('automation:' || n.id)::text                           as run_key,
             n.id::bigint                                            as source_id,
             (case n.via when 'schedule' then 'schedule' else 'person' end)::text as woke_by,
             ('Rule: ' || r.name)::text                              as wake_detail,
             null::text                                              as subject_kind,
             null::text                                              as subject_no,
             jsonb_build_object('rule_id', r.id, 'trigger', r.trigger) as input_ids,
             jsonb_build_array(jsonb_build_object('name', 'match_' || r.trigger, 'risk', 'read',
                                                  'outcome', 'ran', 'rows', n.matched)) as tool_calls,
             1::int                                                  as tool_call_count,
             'n/a'::text                                             as mode,
             null::text                                              as model,
             0::int                                                  as input_tokens,
             0::int                                                  as output_tokens,
             (coalesce(n.fired, 0) || ' of ' || coalesce(n.matched, 0) || ' fired')::text as produced,
             jsonb_build_object('rule_id', r.id, 'fired', n.fired, 'skipped', n.skipped) as produced_ref,
             n.run_by::int                                           as acted_as,
             'none'::text                                            as review_state,
             null::int                                               as reviewed_by,
             null::timestamptz                                       as reviewed_at,
             (case when n.error is not null then 'failed'
                   when n.finished_at is null then 'running'
                   else 'ok' end)::text                              as outcome,
             n.started_at                                            as started_at,
             n.finished_at                                           as finished_at,
             0::int                                                  as ms
      from nl.automation_runs n
      join nl.automation_rules r on r.id = n.rule_id
    $frag$;

  -- 6. The procurement desk's own requests. Not in this database yet: when
  -- that migration lands, it runs nl.rebuild_agent_runs() and this branch
  -- picks the table up. Only the four columns the log cannot do without are
  -- assumed; see docs/workspace.md for the same pattern.
  elsif p_source = 'purchase' then
    v_table := nl.agent_queue_table(array['purchase_requests', 'purchase_request_drafts']);
    if v_table is null then
      return null;
    end if;
    if not (nl.agent_queue_has_column(v_table, 'id')
            and nl.agent_queue_has_column(v_table, 'status')
            and nl.agent_queue_has_column(v_table, 'created_at')
            and nl.agent_queue_has_column(v_table, 'updated_at')) then
      return null;
    end if;
    return format($frag$
      select 'procurement_desk'::text                                as agent,
             'purchase_request'::text                                as work_kind,
             ('procurement_desk:' || d.id)::text                     as run_key,
             d.id::bigint                                            as source_id,
             'signal'::text                                          as woke_by,
             'Replenishment signal'::text                            as wake_detail,
             (case when %1$s is not null then 'vendor' end)::text     as subject_kind,
             (%1$s)::text                                            as subject_no,
             jsonb_build_object('purchase_request_id', d.id)          as input_ids,
             '[]'::jsonb                                             as tool_calls,
             0::int                                                  as tool_call_count,
             'n/a'::text                                             as mode,
             null::text                                              as model,
             0::int                                                  as input_tokens,
             0::int                                                  as output_tokens,
             ('Purchase request ' || d.id)::text                     as produced,
             jsonb_build_object('purchase_request_id', d.id)          as produced_ref,
             (%2$s)::int                                             as acted_as,
             (case when d.status in ('draft', 'waiting', 'pending', 'proposed') then 'waiting'
                   when d.status = 'rejected' then 'rejected'
                   else 'approved' end)::text                        as review_state,
             null::int                                               as reviewed_by,
             null::timestamptz                                       as reviewed_at,
             'ok'::text                                              as outcome,
             d.created_at                                            as started_at,
             d.updated_at                                            as finished_at,
             0::int                                                  as ms
      from nl.%3$I d
    $frag$,
      nl.agent_queue_column(v_table, 'vendor_no', 'd', 'null::text'),
      nl.agent_queue_column(v_table, 'created_by', 'd', 'null'),
      v_table);
  end if;

  return null;
end $$;

-- Which sources are in the log as it stands, so a page can say "this database
-- has no purchase requests yet" instead of leaving somebody wondering.
create function nl.agent_runs_sources() returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_object_agg(s.name, nl.agent_runs_fragment(s.name) is not null)
  from unnest(array['desk', 'assistant', 'mcp_calls', 'mcp_proposals', 'automation', 'purchase'])
    as s(name)
$$;

-- Build (or rebuild) nl.agent_runs from the sources present. Run it again
-- after any migration that adds one. DDL, so deliberately not granted to
-- nl_app: the schema's owner runs it.
create function nl.rebuild_agent_runs() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_parts text[] := '{}';
  v_name  text;
  v_sql   text;
begin
  foreach v_name in array array['desk', 'assistant', 'mcp_calls', 'mcp_proposals', 'automation', 'purchase']
  loop
    v_sql := nl.agent_runs_fragment(v_name);
    if v_sql is not null then
      v_parts := v_parts || v_sql;
    end if;
  end loop;

  if cardinality(v_parts) = 0 then
    raise exception 'The agent run log has no sources at all, which cannot be right.'
      using errcode = 'NL422';
  end if;

  execute format(
    'create or replace view nl.agent_runs with (security_invoker = true) as %s',
    array_to_string(v_parts, ' union all '));
  execute 'grant select on nl.agent_runs to nl_app';

  return nl.agent_runs_sources();
end $$;

select nl.rebuild_agent_runs();

comment on view nl.agent_runs is
  'One row per agent action, one shape across agents, from the tables the features already write. Rebuild with nl.rebuild_agent_runs() after adding a source (migration 0028).';

-- The run log a person reads: every run, with the guardrail that refused it
-- and the degradation that changed how it answered, from nl.agent_events.
create view nl.agent_run_log with (security_invoker = true) as
select r.*,
       e.guardrail,
       e.guardrail_reason,
       (e.degraded_reason is not null)       as degraded,
       e.degraded_reason,
       coalesce(e.events, '[]'::jsonb)       as events,
       a.level                               as level_at_read
from nl.agent_runs r
left join lateral (
  select (array_agg(v.check_id order by v.id) filter (where v.kind = 'guardrail' and v.verdict <> 'pass'))[1] as guardrail,
         (array_agg(v.detail  order by v.id) filter (where v.kind = 'guardrail' and v.verdict <> 'pass'))[1] as guardrail_reason,
         (array_agg(v.check_id order by v.id) filter (where v.kind = 'degraded'))[1] as degraded_reason,
         jsonb_agg(jsonb_build_object('kind', v.kind, 'check_id', v.check_id,
                                      'verdict', v.verdict, 'detail', v.detail, 'at', v.at)
                   order by v.id) as events
  from nl.agent_events v
  where v.run_key = r.run_key
) e on true
left join nl.agent_autonomy a on a.agent = r.agent and a.work_kind = r.work_kind;

comment on view nl.agent_run_log is
  'nl.agent_runs with its guardrail refusals, degradations and current autonomy level (migration 0028).';

-- ---------------------------------------------------------------------------
-- The numbers that decide a promotion
-- ---------------------------------------------------------------------------

create view nl.agent_metrics with (security_invoker = true) as
select l.agent,
       l.work_kind,
       count(*)::int                                                          as runs,
       count(*) filter (where l.review_state = 'waiting')::int                as waiting,
       count(*) filter (where l.review_state in ('approved', 'edited_approved', 'rejected'))::int
                                                                              as reviewed,
       count(*) filter (where l.review_state = 'approved')::int               as approved,
       count(*) filter (where l.review_state = 'edited_approved')::int        as edited,
       count(*) filter (where l.review_state = 'rejected')::int               as rejected,
       count(*) filter (where l.guardrail is not null)::int                   as refusals,
       count(*) filter (where l.degraded)::int                                as degradations,
       count(*) filter (where l.outcome = 'failed')::int                      as failures,
       count(*) filter (where l.outcome = 'needs_person')::int                as sent_to_a_person,
       -- Of the runs somebody decided, the share approved either way.
       round(
         (count(*) filter (where l.review_state in ('approved', 'edited_approved'))::numeric)
         / nullif(count(*) filter (where l.review_state in ('approved', 'edited_approved', 'rejected')), 0),
         4)                                                                   as approval_rate,
       -- Of the approved ones, the share a person had to change first.
       round(
         (count(*) filter (where l.review_state = 'edited_approved')::numeric)
         / nullif(count(*) filter (where l.review_state in ('approved', 'edited_approved')), 0),
         4)                                                                   as edit_rate,
       round(
         (count(*) filter (where l.review_state = 'rejected')::numeric)
         / nullif(count(*) filter (where l.review_state in ('approved', 'edited_approved', 'rejected')), 0),
         4)                                                                   as rejection_rate,
       -- How long a person took to decide, in minutes.
       round(avg(extract(epoch from (l.reviewed_at - l.finished_at))::numeric / 60)
             filter (where l.reviewed_at is not null), 1)                     as avg_review_minutes,
       round((percentile_cont(0.5) within group (
                order by extract(epoch from (l.reviewed_at - l.finished_at)) / 60))::numeric, 1)
                                                                              as median_review_minutes,
       -- How big the edits were, for the runs whose output was measured.
       count(es.run_key) filter (where es.changed)::int                       as edits_measured,
       round(avg(es.delta_chars) filter (where es.changed), 0)                as avg_edit_chars,
       max(es.delta_chars) filter (where es.changed)                          as max_edit_chars,
       max(l.started_at)                                                      as last_run_at
from nl.agent_run_log l
left join nl.agent_edit_sizes es on es.run_key = l.run_key
group by l.agent, l.work_kind;

comment on view nl.agent_metrics is
  'Volume, approval rate, edit rate, rejections, guardrail refusals, degradations and time to review, per agent and kind of work (migration 0028).';

-- Guardrail refusals inside the promotion rule's window, which is the last N
-- runs of that kind rather than the last N days: a quiet week should not clear
-- a refusal off the record.
create view nl.agent_recent_refusals with (security_invoker = true) as
with ranked as (
  select l.agent, l.work_kind, l.guardrail,
         row_number() over (partition by l.agent, l.work_kind
                            order by l.started_at desc, l.source_id desc) as rn
  from nl.agent_run_log l
)
select r.agent, r.work_kind, p.refusal_window,
       count(*) filter (where r.guardrail is not null)::int as refusals,
       count(*)::int                                       as of_runs
from ranked r
join nl.agent_autonomy a on a.agent = r.agent and a.work_kind = r.work_kind
left join nl.agent_promotion_rules p on p.from_level = a.level
where r.rn <= coalesce(p.refusal_window, 100)
group by r.agent, r.work_kind, p.refusal_window;

-- The board: for each agent and kind of work, its level, its numbers, the rule
-- for the next step up, and whether it qualifies right now.
create view nl.agent_autonomy_board with (security_invoker = true) as
select k.agent,
       k.work_kind,
       k.label,
       k.reviewer,
       k.description,
       a.level,
       a.undo_window_minutes,
       a.sample_rate,
       a.set_by,
       su.full_name                                  as set_by_name,
       a.set_at,
       a.note,
       p.to_level                                    as next_level,
       p.min_reviewed,
       p.min_approval_rate,
       p.max_edit_rate,
       p.refusal_window,
       p.max_refusals,
       p.requires_signoff,
       coalesce(m.runs, 0)                           as runs,
       coalesce(m.waiting, 0)                        as waiting,
       coalesce(m.reviewed, 0)                       as reviewed,
       coalesce(m.approved, 0)                       as approved,
       coalesce(m.edited, 0)                         as edited,
       coalesce(m.rejected, 0)                       as rejected,
       coalesce(m.refusals, 0)                       as refusals,
       coalesce(m.degradations, 0)                   as degradations,
       coalesce(m.failures, 0)                       as failures,
       m.approval_rate,
       m.edit_rate,
       m.rejection_rate,
       m.avg_review_minutes,
       m.median_review_minutes,
       coalesce(m.edits_measured, 0)                 as edits_measured,
       m.avg_edit_chars,
       m.max_edit_chars,
       m.last_run_at,
       coalesce(rr.refusals, 0)                      as recent_refusals,
       coalesce(rr.of_runs, 0)                       as recent_of_runs,
       coalesce(sc.acted, 0)                         as acted_alone,
       coalesce(sc.undone, 0)                        as undone,
       coalesce(sc.sampled, 0)                       as sampled,
       coalesce(sc.sample_reviewed, 0)               as sample_reviewed,
       sc.sample_pass_rate,
       -- The brake, read through the global pause as well as this agent's own.
       (nl.agent_paused(k.agent) ->> 'paused')::boolean            as paused,
       nl.agent_paused(k.agent) ->> 'reason'                       as paused_reason,
       nl.agent_paused(k.agent) ->> 'paused_by_name'               as paused_by_name,
       -- Whether the numbers clear the rule for the next step up. It says
       -- nothing about the sign-off, which is a person's and is not a number.
       (p.to_level is not null
        and coalesce(m.reviewed, 0) >= p.min_reviewed
        and coalesce(m.approval_rate, 0) >= p.min_approval_rate
        and coalesce(m.edit_rate, 0) <= p.max_edit_rate
        and coalesce(rr.refusals, 0) <= p.max_refusals)               as qualifies,
       -- Why not, in the order the rule reads, for the page and for the
       -- refusal nl.set_agent_autonomy raises.
       (case
          when p.to_level is null then 'This is the top level.'
          when coalesce(m.reviewed, 0) < p.min_reviewed
            then coalesce(m.reviewed, 0) || ' of ' || p.min_reviewed || ' reviewed runs so far.'
          when coalesce(m.approval_rate, 0) < p.min_approval_rate
            then 'Approval rate ' || round(100 * coalesce(m.approval_rate, 0), 1)
                 || '%, and the rule asks for ' || round(100 * p.min_approval_rate, 1) || '%.'
          when coalesce(m.edit_rate, 0) > p.max_edit_rate
            then 'Edit rate ' || round(100 * coalesce(m.edit_rate, 0), 1)
                 || '%, and the rule allows ' || round(100 * p.max_edit_rate, 1) || '%.'
          when coalesce(rr.refusals, 0) > p.max_refusals
            then coalesce(rr.refusals, 0) || ' guardrail refusal(s) in the last '
                 || coalesce(rr.of_runs, 0) || ' runs, and the rule allows ' || p.max_refusals || '.'
          else 'The numbers clear the rule. A person still has to sign it off.'
        end)::text                                                    as verdict
from nl.agent_work_kinds k
join nl.agent_autonomy a on a.agent = k.agent and a.work_kind = k.work_kind
left join nl.agent_promotion_rules p on p.from_level = a.level
left join nl.agent_metrics m on m.agent = k.agent and m.work_kind = k.work_kind
left join nl.agent_recent_refusals rr on rr.agent = k.agent and rr.work_kind = k.work_kind
left join nl.agent_sample_scores sc on sc.agent = k.agent and sc.work_kind = k.work_kind
left join nl.users su on su.id = a.set_by;

comment on view nl.agent_autonomy_board is
  'Every agent and kind of work: its level, its numbers, the rule for the next step up, and whether it qualifies (migration 0028).';

-- ---------------------------------------------------------------------------
-- Moving a level, which is always a person's write
-- ---------------------------------------------------------------------------

-- Security definer, so the numbers it checks are the whole book's and not the
-- caller's row-level-security view of it, and admin only, checked here rather
-- than only on the page.
--
-- Up: one step at a time, and only when nl.agent_autonomy_board says the
-- numbers clear the rule. Down: always allowed, immediately, any distance.
create function nl.set_agent_autonomy(
  p_agent      text,
  p_work_kind  text,
  p_level      text,
  p_reason     text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_current text;
  v_board   nl.agent_autonomy_board;
  v_from    int;
  v_to      int;
  v_metrics jsonb;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_agent_autonomy');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if not nl.is_admin() then
    raise exception 'Only an administrator can change what an agent may do on its own.'
      using errcode = 'NL403';
  end if;

  if p_level is null or nl.agent_level_ordinal(p_level) is null then
    raise exception 'A level is shadow, suggest, auto_review or auto, not %.',
      coalesce(p_level, 'empty') using errcode = 'NL422';
  end if;

  select * into v_board
  from nl.agent_autonomy_board b
  where b.agent = p_agent and b.work_kind = p_work_kind;
  if not found then
    raise exception 'There is no agent % doing %.',
      coalesce(p_agent, 'empty'), coalesce(p_work_kind, 'empty') using errcode = 'NL404';
  end if;
  v_current := v_board.level;

  v_from := nl.agent_level_ordinal(v_current);
  v_to   := nl.agent_level_ordinal(p_level);

  v_metrics := jsonb_build_object(
    'runs', v_board.runs, 'reviewed', v_board.reviewed, 'approved', v_board.approved,
    'edited', v_board.edited, 'rejected', v_board.rejected,
    'approval_rate', v_board.approval_rate, 'edit_rate', v_board.edit_rate,
    'recent_refusals', v_board.recent_refusals, 'recent_of_runs', v_board.recent_of_runs);

  if v_to = v_from then
    v_result := jsonb_build_object('agent', p_agent, 'work_kind', p_work_kind,
                                   'level', v_current, 'changed', false,
                                   'reason', 'It is already at that level.');
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  if v_to > v_from then
    if v_to - v_from > 1 then
      raise exception 'A level goes up one step at a time: % is next after %.',
        (select r.to_level from nl.agent_promotion_rules r where r.from_level = v_current), v_current
        using errcode = 'NL422';
    end if;
    if not coalesce(v_board.qualifies, false) then
      raise exception 'Not yet: %', v_board.verdict using errcode = 'NL422';
    end if;
  end if;

  update nl.agent_autonomy a
     set level               = p_level,
         undo_window_minutes = case when p_level = 'auto_review'
                                    then greatest(a.undo_window_minutes, 60) else 0 end,
         sample_rate         = case when p_level = 'auto'
                                    then greatest(a.sample_rate, 0.050) else 0 end,
         set_by              = v_actor.id,
         set_at              = now(),
         note                = left(coalesce(p_reason, ''), 500)
   where a.agent = p_agent and a.work_kind = p_work_kind;

  insert into nl.agent_autonomy_changes
    (agent, work_kind, from_level, to_level, changed_via, changed_by, reason, metrics, request_id)
  values (p_agent, p_work_kind, v_current, p_level, 'person', v_actor.id,
          left(coalesce(p_reason, ''), 500), v_metrics, p_request_id);

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'set_agent_autonomy', 'agent_autonomy',
          p_agent || ':' || p_work_kind, p_request_id,
          jsonb_build_object('from', v_current, 'to', p_level,
                             'reason', left(coalesce(p_reason, ''), 500), 'metrics', v_metrics));

  v_result := jsonb_build_object('agent', p_agent, 'work_kind', p_work_kind,
                                 'level', p_level, 'from_level', v_current,
                                 'changed', true, 'metrics', v_metrics);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- What the code asks before it lets an agent act on its own. One function, so
-- "the code honours the level" is one call and not a habit. The pause is part
-- of the answer, because an agent that may act but is paused may not act.
create function nl.agent_autonomy_for(p_agent text, p_work_kind text) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
           'agent', a.agent,
           'work_kind', a.work_kind,
           'level', a.level,
           'undo_window_minutes', a.undo_window_minutes,
           'sample_rate', a.sample_rate,
           'paused', (nl.agent_paused(a.agent) ->> 'paused')::boolean,
           'pause', nl.agent_paused(a.agent),
           -- What each level means for the run about to happen.
           'may_act', a.level in ('auto_review', 'auto')
                      and not (nl.agent_paused(a.agent) ->> 'paused')::boolean,
           'needs_review', a.level = 'suggest'
                           or (a.level in ('auto_review', 'auto')
                               and (nl.agent_paused(a.agent) ->> 'paused')::boolean),
           'hidden', a.level = 'shadow')
  from nl.agent_autonomy a
  where a.agent = p_agent and a.work_kind = p_work_kind
$$;

-- The one change of level that is not a person's: an agent at 'auto' whose
-- sampled reviews have gone bad drops back to auto_review, where a person gets
-- an undo window again. It is a rule rather than a judgement, so it is written
-- down and it runs on its own; the nightly job and the /agents page both call
-- it, and it is idempotent, so calling it twice changes nothing twice.
create function nl.demote_agents_on_sample(
  p_min_reviewed int,
  p_min_pass_rate numeric,
  p_request_id   text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_row    record;
  v_done   jsonb := '[]'::jsonb;
  v_min    int     := coalesce(p_min_reviewed, 20);
  v_rate   numeric := coalesce(p_min_pass_rate, 0.900);
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'demote_agents_on_sample');
  if v_replay is not null then
    return v_replay;
  end if;

  for v_row in
    select b.agent, b.work_kind, b.level, s.sample_reviewed, s.sample_bad, s.sample_pass_rate
    from nl.agent_autonomy_board b
    join nl.agent_sample_scores s on s.agent = b.agent and s.work_kind = b.work_kind
    where b.level = 'auto'
      and s.sample_reviewed >= v_min
      and coalesce(s.sample_pass_rate, 1) < v_rate
    order by b.agent, b.work_kind
  loop
    update nl.agent_autonomy a
       set level = 'auto_review', undo_window_minutes = 60, sample_rate = 0,
           set_by = null, set_at = now(),
           note = 'Dropped back automatically: ' || v_row.sample_bad
                  || ' of ' || v_row.sample_reviewed || ' sampled actions were marked bad.'
     where a.agent = v_row.agent and a.work_kind = v_row.work_kind;

    insert into nl.agent_autonomy_changes
      (agent, work_kind, from_level, to_level, changed_via, changed_by, reason, metrics, request_id)
    values (v_row.agent, v_row.work_kind, 'auto', 'auto_review', 'rule', null,
            'Sampled review pass rate ' || round(100 * coalesce(v_row.sample_pass_rate, 0), 1)
            || '%, and the rule asks for ' || round(100 * v_rate, 1) || '%.',
            jsonb_build_object('sample_reviewed', v_row.sample_reviewed,
                               'sample_bad', v_row.sample_bad,
                               'sample_pass_rate', v_row.sample_pass_rate),
            p_request_id || ':' || v_row.agent || ':' || v_row.work_kind);

    -- Nobody decided this, so the audit row names nobody and says it was the
    -- nightly rule.
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (null, 'nightly', 'demote_agent', 'agent_autonomy',
            v_row.agent || ':' || v_row.work_kind, p_request_id,
            jsonb_build_object('from', 'auto', 'to', 'auto_review',
                               'sample_reviewed', v_row.sample_reviewed,
                               'sample_pass_rate', v_row.sample_pass_rate));

    v_done := v_done || jsonb_build_object('agent', v_row.agent, 'work_kind', v_row.work_kind,
                                           'sample_pass_rate', v_row.sample_pass_rate);
  end loop;

  v_result := jsonb_build_object('demoted', v_done, 'min_reviewed', v_min, 'min_pass_rate', v_rate);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.agent_work_kinds enable row level security;
alter table nl.agent_autonomy enable row level security;
alter table nl.agent_autonomy_changes enable row level security;
alter table nl.agent_promotion_rules enable row level security;
alter table nl.agent_events enable row level security;
alter table nl.agent_pauses enable row level security;
alter table nl.agent_actions enable row level security;
alter table nl.agent_artifacts enable row level security;

-- What an agent may do, and what the rule for promoting it is, is the team's
-- business: everyone reads it, nobody writes it except through the functions
-- above, which are security definer and check who is asking.
create policy agent_work_kinds_read on nl.agent_work_kinds for select to nl_app using (true);
create policy agent_autonomy_read on nl.agent_autonomy for select to nl_app using (true);
create policy agent_autonomy_changes_read on nl.agent_autonomy_changes for select to nl_app using (true);
create policy agent_promotion_rules_read on nl.agent_promotion_rules for select to nl_app using (true);
create policy agent_events_read on nl.agent_events for select to nl_app using (true);
create policy agent_pauses_read on nl.agent_pauses for select to nl_app using (true);
create policy agent_actions_read on nl.agent_actions for select to nl_app using (true);
create policy agent_artifacts_read on nl.agent_artifacts for select to nl_app using (true);

grant select on nl.agent_work_kinds, nl.agent_autonomy, nl.agent_autonomy_changes,
                nl.agent_promotion_rules, nl.agent_events, nl.agent_pauses,
                nl.agent_actions, nl.agent_artifacts to nl_app;
grant select on nl.agent_runs, nl.agent_run_log, nl.agent_metrics,
                nl.agent_recent_refusals, nl.agent_autonomy_board,
                nl.agent_sample_scores, nl.agent_edit_sizes to nl_app;
-- nl_readonly gets the reference data only. Everything else here names the
-- person who reviewed a run, paused an agent or changed a level.
grant select on nl.agent_work_kinds, nl.agent_promotion_rules to nl_readonly;

grant execute on function
  nl.agent_level_ordinal(text),
  nl.agent_runs_fragment(text),
  nl.agent_runs_sources(),
  nl.agent_autonomy_for(text, text),
  nl.agent_paused(text),
  nl.agent_sampled(text, numeric),
  nl.record_agent_event(text, text, text, text, text, text, text, text),
  nl.record_agent_action(text, text, text, text, text, text, text, int, jsonb, text),
  nl.record_agent_artifact(text, text, text, text, text, int, text, text),
  nl.claim_agent_undo(bigint, text, text),
  nl.finish_agent_undo(bigint, boolean, text, boolean, text),
  nl.review_sampled_action(bigint, text, text, text),
  nl.set_agent_pause(text, boolean, text, text),
  nl.set_agent_autonomy(text, text, text, text, text),
  nl.demote_agents_on_sample(int, numeric, text)
to nl_app;
-- nl.rebuild_agent_runs() is not granted: it is DDL, for the schema's owner.
