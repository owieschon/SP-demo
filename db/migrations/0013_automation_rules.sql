-- 0013 Automation rules: "when this happens, and these conditions hold, do
-- this", set up by the people who use the app, not by engineers.
--
-- A rule is data: a trigger (one of a fixed list of reviewed queries), a list
-- of conditions on that trigger's fields, and an action. The app turns the
-- conditions into a parameterized WHERE clause over the trigger's query; a
-- rule never contains SQL. It runs as its owner, so row-level security
-- applies to what it can see and do.
--
-- Guarantees enforced here, whatever the app does:
--   * A rule fires at most once per subject (a commitment, an account that
--     went quiet on a given day): nl.automation_firings is unique on
--     (rule_id, subject_key).
--   * Actions only ever add things (a next step, a note). Changing or
--     removing data stays a person's decision.
--   * Every firing is recorded with its run, and in the audit log as
--     via 'automation'.

-- ---------------------------------------------------------------------------
-- 'automation' becomes a recognized source of writes
-- ---------------------------------------------------------------------------

alter table nl.audit_log drop constraint audit_log_via_check;
alter table nl.audit_log add constraint audit_log_via_check
  check (via in ('ui', 'assistant', 'nightly', 'import', 'seed', 'automation'));

alter table nl.activities drop constraint activities_via_check;
alter table nl.activities add constraint activities_via_check
  check (via in ('ui', 'assistant', 'seed', 'automation'));

-- ---------------------------------------------------------------------------
-- Rules, runs, firings
-- ---------------------------------------------------------------------------

create table nl.automation_rules (
  id          bigint generated always as identity (start with 101) primary key,
  name        text not null check (length(name) between 3 and 80),
  description text not null default '',
  -- Keys of the triggers and actions in app/src/lib/automation/catalog.ts.
  trigger     text not null check (trigger in
                ('window_closed_short', 'commitment_behind_pace', 'account_gone_quiet', 'order_line_at_risk')),
  conditions  jsonb not null default '[]' check (jsonb_typeof(conditions) = 'array'),
  action      jsonb not null check (action ->> 'kind' in ('next_step', 'note')),
  enabled     boolean not null default false,
  owner_id    int not null references nl.users (id),
  created_by  int not null references nl.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default nl.now_ms()
);

comment on table nl.automation_rules is
  'Rules people set up: a trigger, conditions on its fields, and an additive action. Never SQL.';

create index automation_rules_owner_idx on nl.automation_rules (owner_id);
create index automation_rules_created_by_idx on nl.automation_rules (created_by);

create trigger automation_rules_touch before update on nl.automation_rules
  for each row execute function nl.touch_updated_at();

create table nl.automation_runs (
  id          bigint generated always as identity primary key,
  rule_id     bigint not null references nl.automation_rules (id) on delete cascade,
  run_by      int not null references nl.users (id),
  via         text not null check (via in ('ui', 'schedule')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  matched     int,
  fired       int,
  skipped     int,
  error       text
);

create index automation_runs_rule_idx on nl.automation_runs (rule_id, started_at desc);
create index automation_runs_run_by_idx on nl.automation_runs (run_by);

create table nl.automation_firings (
  id          bigint generated always as identity primary key,
  rule_id     bigint not null references nl.automation_rules (id) on delete cascade,
  run_id      bigint not null references nl.automation_runs (id) on delete cascade,
  subject_key text not null,
  fired_at    timestamptz not null default now(),
  result      jsonb not null,
  -- Once per subject, per rule.
  unique (rule_id, subject_key)
);

create index automation_firings_run_idx on nl.automation_firings (run_id);

-- ---------------------------------------------------------------------------
-- A trigger's source: how often each account usually orders
-- ---------------------------------------------------------------------------

-- One row per account with at least three invoices in the last two years:
-- its typical gap between orders (the median), how long it has been quiet,
-- and the longest gap it has ever had in that time. "Quiet" is measured
-- against the account's own rhythm, not a fixed number of days.
create view nl.account_cadence with (security_invoker = true) as
with clock as (
  select nl.today() as today
),
orders as (
  select distinct i.customer_no, i.posted_on
  from nl.invoices i, clock
  where i.doc_type = 'invoice'
    and i.posted_on > clock.today - 730
    and i.posted_on <= clock.today
),
gaps as (
  select customer_no, posted_on,
         posted_on - lag(posted_on) over (partition by customer_no order by posted_on) as gap
  from orders
),
per_account as (
  select customer_no,
         count(*) as orders_2y,
         max(posted_on) as last_order_on,
         percentile_cont(0.5) within group (order by gap) filter (where gap is not null) as typical_gap,
         max(gap) as longest_gap
  from gaps
  group by customer_no
  having count(*) >= 3
)
select
  p.customer_no,
  p.orders_2y,
  p.last_order_on,
  round(p.typical_gap)::int as typical_gap_days,
  p.longest_gap as longest_gap_days,
  clock.today - p.last_order_on as days_quiet,
  round((clock.today - p.last_order_on) / greatest(p.typical_gap, 1)::numeric, 2) as quiet_ratio
from per_account p, clock;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Create or change a rule. The app validates the conditions and action
-- against the catalog first; the table's checks are the backstop.
create function nl.save_automation_rule(
  p_rule_id             bigint,   -- null to create
  p_name                text,
  p_description         text,
  p_trigger             text,
  p_conditions          jsonb,
  p_action              jsonb,
  p_enabled             boolean,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_rule   nl.automation_rules;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'save_automation_rule');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if p_rule_id is null then
    insert into nl.automation_rules (name, description, trigger, conditions, action, enabled, owner_id, created_by)
    values (p_name, coalesce(p_description, ''), p_trigger, p_conditions, p_action, coalesce(p_enabled, false),
            v_actor.id, v_actor.id)
    returning * into v_rule;
  else
    select * into v_rule from nl.automation_rules where id = p_rule_id;
    if not found then
      raise exception 'Rule % does not exist.', p_rule_id using errcode = 'NL404';
    end if;
    if v_rule.owner_id <> v_actor.id and v_actor.role <> 'admin' then
      raise exception 'Only the owner of rule % or an admin can change it.', p_rule_id using errcode = 'NL403';
    end if;
    update nl.automation_rules
       set name = p_name,
           description = coalesce(p_description, ''),
           trigger = p_trigger,
           conditions = p_conditions,
           action = p_action,
           enabled = coalesce(p_enabled, false)
     where id = p_rule_id
       and updated_at = p_expected_updated_at
    returning * into v_rule;
    if not found then
      raise exception 'Rule % changed since it was loaded. Reload it and try again.', p_rule_id
        using errcode = 'NL409';
    end if;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', case when p_rule_id is null then 'create_rule' else 'update_rule' end,
          'automation_rule', v_rule.id::text, p_request_id,
          jsonb_build_object('name', v_rule.name, 'trigger', v_rule.trigger, 'enabled', v_rule.enabled,
                             'conditions', v_rule.conditions, 'action', v_rule.action));

  v_result := jsonb_build_object('rule_id', v_rule.id, 'updated_at', v_rule.updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Start a run of a rule. Only its owner (or an admin) may run it, and a
-- scheduled run only happens for an enabled rule.
create function nl.start_automation_run(p_rule_id bigint, p_via text) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_actor nl.users;
  v_rule  nl.automation_rules;
  v_run   bigint;
begin
  v_actor := nl.require_active_user();
  select * into v_rule from nl.automation_rules where id = p_rule_id;
  if not found then
    raise exception 'Rule % does not exist.', p_rule_id using errcode = 'NL404';
  end if;
  if v_rule.owner_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the owner of rule % or an admin can run it.', p_rule_id using errcode = 'NL403';
  end if;
  if p_via = 'schedule' and not v_rule.enabled then
    raise exception 'Rule % is switched off.', p_rule_id using errcode = 'NL422';
  end if;
  insert into nl.automation_runs (rule_id, run_by, via)
  values (p_rule_id, v_actor.id, p_via)
  returning id into v_run;
  return v_run;
end $$;

-- Fire the rule's action for one subject. The action's kind comes from the
-- stored rule, not from the caller. Returns 'fired', or 'skipped' when this
-- rule already fired for this subject.
create function nl.fire_automation(
  p_run_id        bigint,
  p_subject_key   text,
  p_customer_no   text,
  p_commitment_id bigint,
  p_assignee_id   int,
  p_text          text,
  p_due_on        date
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_actor  nl.users;
  v_run    nl.automation_runs;
  v_rule   nl.automation_rules;
  v_firing bigint;
  v_made   bigint;
  v_kind   text;
begin
  v_actor := nl.require_active_user();
  select * into v_run from nl.automation_runs where id = p_run_id;
  if not found or v_run.run_by <> v_actor.id or v_run.finished_at is not null then
    raise exception 'Run % is not an open run of yours.', p_run_id using errcode = 'NL403';
  end if;
  select * into v_rule from nl.automation_rules where id = v_run.rule_id;
  v_kind := v_rule.action ->> 'kind';

  if p_text is null or length(btrim(p_text)) = 0 or length(p_text) > 500 then
    raise exception 'An automation writes 1 to 500 characters.' using errcode = 'NL422';
  end if;
  if p_customer_no is null or not exists (select 1 from nl.customers where customer_no = p_customer_no) then
    raise exception 'Customer % does not exist.', coalesce(p_customer_no, 'empty') using errcode = 'NL422';
  end if;

  -- Claim the subject first: a second firing for it stops here.
  insert into nl.automation_firings (rule_id, run_id, subject_key, result)
  values (v_rule.id, p_run_id, p_subject_key, '{}')
  on conflict (rule_id, subject_key) do nothing
  returning id into v_firing;
  if v_firing is null then
    return 'skipped';
  end if;

  if v_kind = 'next_step' then
    if not exists (select 1 from nl.users u where u.id = p_assignee_id and u.active) then
      raise exception 'A next step goes to an active user.' using errcode = 'NL422';
    end if;
    insert into nl.next_steps (customer_no, commitment_id, title, due_on, owner_id, created_by)
    values (p_customer_no, p_commitment_id, p_text, p_due_on, p_assignee_id, v_actor.id)
    returning id into v_made;
  else
    insert into nl.activities (customer_no, commitment_id, kind, body, author_id, via)
    values (p_customer_no, p_commitment_id, 'note', p_text, v_actor.id, 'automation')
    returning id into v_made;
  end if;

  update nl.automation_firings
     set result = jsonb_build_object('kind', v_kind, 'id', v_made)
   where id = v_firing;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, detail)
  values (v_actor.id, 'automation', 'fire_' || v_kind, 'automation_rule', v_rule.id::text,
          jsonb_build_object('run_id', p_run_id, 'subject', p_subject_key, 'created_id', v_made,
                             'customer_no', p_customer_no, 'commitment_id', p_commitment_id));
  return 'fired';
end $$;

create function nl.finish_automation_run(
  p_run_id  bigint,
  p_matched int,
  p_fired   int,
  p_skipped int,
  p_error   text
) returns void
language plpgsql
set search_path = ''
as $$
begin
  update nl.automation_runs
     set finished_at = now(), matched = p_matched, fired = p_fired, skipped = p_skipped, error = p_error
   where id = p_run_id
     and run_by = nl.current_user_id()
     and finished_at is null;
  if not found then
    raise exception 'Run % is not an open run of yours.', p_run_id using errcode = 'NL403';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.automation_rules enable row level security;
alter table nl.automation_runs enable row level security;
alter table nl.automation_firings enable row level security;

-- The whole team can see what is automated and what it did.
create policy automation_rules_read on nl.automation_rules for select to nl_app using (true);
create policy automation_runs_read on nl.automation_runs for select to nl_app using (true);
create policy automation_firings_read on nl.automation_firings for select to nl_app using (true);

create policy automation_rules_insert on nl.automation_rules for insert to nl_app
  with check (owner_id = (select nl.current_user_id()) and created_by = (select nl.current_user_id()));
create policy automation_rules_update on nl.automation_rules for update to nl_app
  using (owner_id = (select nl.current_user_id()) or (select nl.is_admin()))
  with check (exists (select 1 from nl.users u where u.id = owner_id and u.active));
create policy automation_runs_insert on nl.automation_runs for insert to nl_app
  with check (run_by = (select nl.current_user_id()));
create policy automation_runs_update on nl.automation_runs for update to nl_app
  using (run_by = (select nl.current_user_id()));
create policy automation_firings_insert on nl.automation_firings for insert to nl_app
  with check (exists (
    select 1 from nl.automation_runs r
    where r.id = run_id and r.run_by = (select nl.current_user_id())));
create policy automation_firings_update on nl.automation_firings for update to nl_app
  using (exists (
    select 1 from nl.automation_runs r
    where r.id = run_id and r.run_by = (select nl.current_user_id())));

grant select, insert on nl.automation_rules, nl.automation_runs, nl.automation_firings to nl_app;
grant update (name, description, trigger, conditions, action, enabled, updated_at) on nl.automation_rules to nl_app;
grant update (finished_at, matched, fired, skipped, error) on nl.automation_runs to nl_app;
grant update (result) on nl.automation_firings to nl_app;
grant select on nl.account_cadence to nl_app, nl_readonly;

grant execute on function
  nl.save_automation_rule(bigint, text, text, text, jsonb, jsonb, boolean, timestamptz, text),
  nl.start_automation_run(bigint, text),
  nl.fire_automation(bigint, text, text, bigint, int, text, date),
  nl.finish_automation_run(bigint, int, int, int, text)
to nl_app;
