-- 0027 Roles: who a person is, said as three separate things.
--
-- Before this migration there was one column, nl.users.role, with three
-- values, and it gated exactly one thing: nl.is_admin(). Everything else was
-- shown to everybody, which is how a screen ends up holding every row in the
-- company and helping nobody.
--
-- A role is not one fact. It is three, and they answer different questions:
--
--   scope       which slice of the world is mine. My accounts, my warehouse,
--               my suppliers, the part families I plan. It is the default
--               filter on a list, and it decides what I may ACT on.
--   authority   what I may decide, and up to what amount. Approve a quote to
--               $25,000. Release a purchase order to $50,000. Change a
--               policy. Raise an agent's autonomy.
--   disclosure  what I may be shown at all. The desk agent already had this
--               vocabulary for its outgoing drafts (see
--               app/src/lib/server/desk/policy.ts and migration 0021), so
--               this migration reuses the same three levels and the same
--               fact kinds rather than inventing a second set of words.
--
-- Two design choices worth knowing before reading on.
--
-- 1. SCOPE NARROWS ACTIONS, NOT READS. A salesperson may read another rep's
--    account: that is how cover works, how a question gets answered when
--    somebody is out, and how search stays useful. So scope is NOT an RLS
--    read wall on the business tables. It narrows what a person may change
--    (nl.may_act_on), it is the default filter every list starts from, and it
--    is what nl.work_waiting_for searches. The only thing that genuinely
--    hides a value from a reader is disclosure, and that is enforced on the
--    payload a page or a tool assembles, by fact kind.
--
-- 2. AN AGENT IS A PRINCIPAL IN THESE SAME TABLES. nl.users grows a `kind`
--    column, 'person' or 'agent', and the desk agents become rows in it.
--    They were going to need an identity in this schema anyway: nl.audit_log
--    and every created_by column point at nl.users, so a separate principals
--    table would have meant a nullable second foreign key on every one of
--    them and a polymorphic key on all three tables below. With one table,
--    an agent's mailbox is a scope row, its autonomy level is an authority
--    grant, its disclosure level is a disclosure row, and one sentence is
--    literally true: raising an agent's autonomy is the same write as
--    raising a person's approval limit. Both call nl.grant_authority.
--    The cost of the choice is that "a user" no longer means "a person", so
--    anything that lists people has to say `kind = 'person'`. The sign-in
--    picker and nl.find_active_user's caller do (see app/src/lib/server/
--    users.ts): an agent has no password and no session and must not be
--    signable-in.
--
-- Depends on 0001 (users, audit log, request ids, nl.today, nl.now_ms),
-- 0002 (customers, items, vendors), 0003 (commitments, quotes),
-- 0010 (export snapshots), 0016 (open line projection), 0018 (item costs),
-- 0019 (locations, shipments, transfers, counts), 0021 (mailboxes),
-- 0023 (nl.agent_queue). Each of those later sources is optional to
-- nl.work_waiting_for only in the sense that the migration order guarantees
-- them; nothing here feature-detects them.

-- ---------------------------------------------------------------------------
-- The named presets
-- ---------------------------------------------------------------------------

-- nl.users.role stays. It is now read as the name of a PRESET: a starting set
-- of scope, authority and disclosure rows, seeded in db/seed.d/90_roles.sql.
-- Nothing resolves a permission from the preset name at request time, so
-- moving somebody between presets changes nothing on its own. The three
-- tables below are the truth.
--
-- The three original values are still in the list on purpose. nl.is_admin()
-- reads role = 'admin' and always has; the account managers who were never
-- given a finer preset keep 'account_manager'. Widening the list breaks
-- nothing because nothing else ever branched on it.
create function nl.role_presets() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- The five roles whose home page this migration exists to make small.
    'inside_sales',
    'buyer',
    'planner',
    'warehouse',
    'ops_manager',
    -- The original three.
    'account_manager',
    'operations',
    'admin',
    -- Not a person.
    'agent'
  ]
$$;

alter table nl.users
  add column kind text not null default 'person'
    check (kind in ('person', 'agent')),
  -- One line saying what this principal is responsible for, shown on the
  -- sign-in picker and on /people. It used to be a map in the picker's
  -- markup, keyed on the role, so it could not say anything about a
  -- particular person and could not be edited.
  add column responsibility text not null default '';

comment on column nl.users.kind is
  'person or agent. An agent is a principal with scope, authority and disclosure, and no sign-in (migration 0027).';
comment on column nl.users.responsibility is
  'One line: what this person or agent is answerable for. Editable on /people (migration 0027).';

-- Widen the role check to the preset list. The constraint was written inline
-- in 0001 as check (role in (...)), which Postgres named users_role_check,
-- but find the name rather than trust that.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'nl.users'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%role%';
  if v_name is not null then
    execute format('alter table nl.users drop constraint %I', v_name);
  end if;
end $$;

alter table nl.users
  add constraint users_role_is_a_preset check (role = any (nl.role_presets()));

-- ---------------------------------------------------------------------------
-- Axis 1: scope. Which slice of the world is mine.
-- ---------------------------------------------------------------------------

-- The dimensions a slice can be cut along. One row per assignment rather than
-- one column per dimension, because the list grows: a fifth dimension is a
-- value in this array and a seed row, not a migration that alters a table
-- everything else selects from.
create function nl.scope_dimensions() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'account',      -- nl.customers.customer_no
    'warehouse',    -- nl.locations.code
    'vendor',       -- nl.vendors.vendor_no
    'part_family',  -- nl.items.family
    'mailbox'       -- nl.mailboxes.id, as text
  ]
$$;

create table nl.user_scope (
  id         bigint generated always as identity (start with 1001) primary key,
  user_id    int not null references nl.users (id) on delete cascade,
  dimension  text not null,
  -- The one value in this dimension that is mine, or NULL meaning every
  -- value in it, now and in future. "All" has to be a row and not a missing
  -- row, because a missing row is how "nobody has told us yet" looks, and
  -- those two must not be the same thing.
  value      text,
  granted_by int references nl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default nl.now_ms(),
  constraint user_scope_known_dimension check (dimension = any (nl.scope_dimensions())),
  constraint user_scope_value_not_blank check (value is null or length(value) between 1 and 60)
);

comment on table nl.user_scope is
  'Which accounts, warehouses, vendors, part families and mailboxes are a principal''s own. A row with a null value means every value in that dimension (migration 0027).';

-- One row per (principal, dimension, value). coalesce puts the "all" row in
-- the same index, so asking for it is the same probe as asking for one value.
create unique index user_scope_one_per_value
  on nl.user_scope (user_id, dimension, coalesce(value, '*'));
create index user_scope_by_value on nl.user_scope (dimension, value);

create trigger user_scope_touch before update on nl.user_scope
  for each row execute function nl.touch_updated_at();

-- Is this value mine? True when I hold the "all" row for the dimension, or
-- the exact value. One index probe, so it is cheap enough to call per row.
create function nl.in_scope(p_user_id int, p_dimension text, p_value text) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from nl.user_scope s
    where s.user_id = p_user_id
      and s.dimension = p_dimension
      and (s.value is null or s.value = p_value))
$$;

-- Do I hold the whole dimension? This is what makes a list say "you are
-- seeing everything" instead of showing a Mine / All switch that does nothing.
create function nl.scope_is_all(p_user_id int, p_dimension text) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from nl.user_scope s
    where s.user_id = p_user_id and s.dimension = p_dimension and s.value is null)
$$;

-- The same question about the signed-in person, for use in a policy or a view.
create function nl.my_scope(p_dimension text, p_value text) returns boolean
language sql stable
set search_path = ''
as $$ select nl.in_scope(nl.current_user_id(), p_dimension, p_value) $$;

-- May the signed-in person CHANGE this thing? Scope, or admin. This is the
-- action side of scope, and the only side that belongs in a policy: reading
-- is not gated by scope (see the header).
create function nl.may_act_on(p_dimension text, p_value text) returns boolean
language sql stable
set search_path = ''
as $$ select nl.is_admin() or nl.my_scope(p_dimension, p_value) $$;

-- ---------------------------------------------------------------------------
-- Axis 2: authority. What I may decide, and up to what amount.
-- ---------------------------------------------------------------------------

create function nl.authority_kinds() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'approve_quote',           -- amount: send a quote out at this value
    'approve_reply',           -- yes/no: send an agent's drafted reply
    'approve_agent_proposal',  -- yes/no: run what the assistant proposed
    'answer_commitment',       -- yes/no: answer a window that closed short
    'release_purchase_order',  -- amount: commit this much to a supplier
    'accept_price_increase',   -- amount: accept a new cost up to this figure
    'resolve_shortage',        -- yes/no: decide what a short line does
    'confirm_pick',            -- yes/no: say a shipment is picked
    'receive_stock',           -- yes/no: receive a transfer in
    'count_stock',             -- yes/no: post a cycle count
    'override_margin_floor',   -- yes/no: price below the floor
    'review_exception',        -- yes/no: handle what an agent could not
    'change_policy',           -- yes/no: edit these three tables
    'run_import',              -- yes/no: stage and apply an ERP export
    'agent_autonomy'           -- amount: an agent's autonomy LEVEL, 0 to 3
  ]
$$;

-- An authority is either a ceiling or a plain yes. Keeping the two apart in a
-- function rather than in prose means the table can refuse a nonsense row:
-- a dollar limit on "may change a policy" would be meaningless.
--
-- agent_autonomy is in the amount list and that is the whole point. An
-- autonomy level is a limit like any other, so raising it is nl.grant_authority
-- with a bigger number, exactly as it is for a person's approval ceiling.
-- The levels: 0 watch only, 1 draft for a person, 2 send routine replies,
-- 3 send everything its disclosure level allows.
create function nl.authority_is_amount(p_authority text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_authority in (
    'approve_quote', 'release_purchase_order', 'accept_price_increase', 'agent_autonomy')
$$;

create table nl.authority_grants (
  id           bigint generated always as identity (start with 1001) primary key,
  user_id      int not null references nl.users (id) on delete cascade,
  authority    text not null,
  -- The ceiling, in dollars, or the level for agent_autonomy. NULL on a
  -- yes/no authority, where it is simply unused. NULL on an amount authority
  -- means no ceiling; only the ops manager preset is seeded that way.
  limit_amount numeric(14, 2),
  -- Effective dating, both ends inclusive. A grant that starts tomorrow does
  -- not apply today, which is the point: a limit can be raised for a covering
  -- week and end by itself.
  starts_on    date not null default nl.today(),
  ends_on      date,
  note         text not null default '',
  granted_by   int references nl.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default nl.now_ms(),
  constraint authority_known check (authority = any (nl.authority_kinds())),
  constraint authority_window check (ends_on is null or ends_on >= starts_on),
  constraint authority_limit_shape check (
    nl.authority_is_amount(authority) or limit_amount is null),
  constraint authority_limit_sign check (limit_amount is null or limit_amount >= 0),
  constraint authority_note_short check (length(note) <= 300)
);

comment on table nl.authority_grants is
  'What each principal may decide and up to what amount, effective-dated. Raising a person''s ceiling and raising an agent''s autonomy are the same row and the same write (migration 0027).';

create index authority_grants_lookup
  on nl.authority_grants (user_id, authority, starts_on desc);

-- One grant of an authority per principal per start date. Two rows starting
-- the same day would make "what is my limit today" a question about which row
-- won, and nl.grant_authority already supersedes rather than stacks.
create unique index authority_grants_one_per_day
  on nl.authority_grants (user_id, authority, starts_on);

create trigger authority_grants_touch before update on nl.authority_grants
  for each row execute function nl.touch_updated_at();

-- A seam for the policy engine. When branch policy-engine lands, limits for
-- these authorities belong in nl.resolve_policy and this table keeps only the
-- grant. The DO block below feature-detects that function by name AND by
-- argument types: a wrapper built against a guessed signature would create
-- fine (a plpgsql body is not resolved until it runs) and then fail at
-- request time, which is worse than not having it.
--
-- Until then this returns null, meaning "the policy engine has nothing to say
-- about this one", and nl.authority_limit falls back to the table.
create function nl.authority_limit_override(p_user_id int, p_authority text, p_on date)
returns numeric
language sql stable
set search_path = ''
as $$ select null::numeric $$;

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'nl'
      and p.proname = 'resolve_policy'
      and pg_get_function_identity_arguments(p.oid) = 'text, jsonb')
  then
    execute $body$
      create or replace function nl.authority_limit_override(p_user_id int, p_authority text, p_on date)
      returns numeric
      language sql stable
      set search_path = ''
      as $inner$
        select (nl.resolve_policy(
          p_authority,
          jsonb_build_object('user_id', p_user_id, 'on', p_on)) #>> '{limit}')::numeric
      $inner$
    $body$;
    raise notice 'roles: the policy engine is present, limits resolve through nl.resolve_policy';
  end if;
end $$;

-- Every grant of this authority that is in force on this date. This one is
-- for reading and for /people, not for a WHERE clause: a set-returning
-- function called once per row is what made the first version of
-- nl.work_waiting_for take most of a second. The three functions below it
-- each ask the table directly for that reason.
create function nl.authority_grants_on(p_user_id int, p_authority text, p_on date)
returns setof nl.authority_grants
language sql stable
set search_path = ''
as $$
  select * from nl.authority_grants g
  where g.user_id = p_user_id
    and g.authority = p_authority
    and p_on >= g.starts_on
    and (g.ends_on is null or p_on <= g.ends_on)
$$;

-- Do I hold this authority at all today (or on a given date)?
create function nl.has_authority(p_user_id int, p_authority text, p_on date default null)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from nl.authority_grants g
    where g.user_id = p_user_id
      and g.authority = p_authority
      and coalesce(p_on, nl.today()) >= g.starts_on
      and (g.ends_on is null or coalesce(p_on, nl.today()) <= g.ends_on))
$$;

-- My ceiling for it: the highest of my grants in force, where "no ceiling"
-- wins over any number. Only meaningful when nl.has_authority is true; a
-- null here reads as "no ceiling" and as "no grant", so ask both.
create function nl.authority_limit(p_user_id int, p_authority text, p_on date default null)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce(
    nl.authority_limit_override(p_user_id, p_authority, coalesce(p_on, nl.today())),
    (select case when bool_or(g.limit_amount is null) then null else max(g.limit_amount) end
     from nl.authority_grants g
     where g.user_id = p_user_id
       and g.authority = p_authority
       and coalesce(p_on, nl.today()) >= g.starts_on
       and (g.ends_on is null or coalesce(p_on, nl.today()) <= g.ends_on)))
$$;

-- The ceiling as a number a comparison can always use: no grant is 0, and
-- no ceiling is infinity. nl.work_waiting_for reads this once per branch
-- rather than asking nl.may_approve per row.
create function nl.authority_ceiling(p_user_id int, p_authority text, p_on date default null)
returns numeric
language sql stable
set search_path = ''
as $$
  select case
    when not nl.has_authority(p_user_id, p_authority, p_on) then 0::numeric
    when not nl.authority_is_amount(p_authority) then 'infinity'::numeric
    else coalesce(nl.authority_limit(p_user_id, p_authority, p_on), 'infinity'::numeric)
  end
$$;

-- May I decide this particular thing, at this amount? A yes/no authority
-- ignores the amount. An amount authority needs a ceiling at or above it,
-- and a grant with no ceiling clears everything.
create function nl.may_approve(p_user_id int, p_authority text, p_amount numeric, p_on date default null)
returns boolean
language sql stable
set search_path = ''
as $$
  select nl.has_authority(p_user_id, p_authority, p_on)
     and coalesce(p_amount, 0) <= nl.authority_ceiling(p_user_id, p_authority, p_on)
$$;

-- The signed-in person's own version, for a policy or a view.
create function nl.i_have_authority(p_authority text) returns boolean
language sql stable
set search_path = ''
as $$ select nl.has_authority(nl.current_user_id(), p_authority) $$;

-- ---------------------------------------------------------------------------
-- Axis 3: disclosure. What I may be shown at all.
-- ---------------------------------------------------------------------------

-- The three levels and the fact kinds each allows are the desk agent's, kept
-- in one place so a person's screen and an agent's outgoing draft cannot
-- disagree about whether unit cost may be shown. The arrays below are the
-- same lists as DISCLOSURE_ALLOWS in app/src/lib/server/desk/policy.ts; a
-- test compares the two so neither can drift.
--
-- Machine hour rates and capex amortization are named in the brief and are
-- not here, because this database has no such figures yet. When the
-- manufacturing model adds them they are new fact kinds in this same list,
-- allowed at 'internal' only. That is the reason for reusing this vocabulary
-- rather than starting a second one.
create function nl.disclosure_allows(p_level text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_level
    when 'customer' then array[
      'account_identity', 'part_description', 'own_price', 'quantity_break',
      'own_past_price', 'own_agreement', 'availability', 'lead_time',
      'own_open_order', 'own_quote', 'own_commitment', 'own_rep', 'freight']
    when 'vendor' then array[
      'part_description', 'vendor_supply', 'vendor_lead_time', 'lead_time']
    when 'internal' then array[
      'account_identity', 'part_description', 'own_price', 'quantity_break',
      'own_past_price', 'own_agreement', 'availability', 'lead_time',
      'own_open_order', 'own_quote', 'own_commitment', 'own_rep', 'freight',
      'vendor_supply', 'vendor_lead_time', 'stock_quantity', 'unit_cost',
      'margin', 'floor_price', 'other_customer', 'internal_note',
      'colleague_name']
    else array[]::text[]
  end
$$;

create table nl.disclosure_grants (
  user_id    int primary key references nl.users (id) on delete cascade,
  level      text not null check (level in ('customer', 'vendor', 'internal')),
  note       text not null default '',
  granted_by int references nl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default nl.now_ms(),
  constraint disclosure_note_short check (length(note) <= 300)
);

comment on table nl.disclosure_grants is
  'What each principal may be shown, in the desk agent''s own three levels. An agent''s row matches its mailbox (migration 0027).';

create trigger disclosure_grants_touch before update on nl.disclosure_grants
  for each row execute function nl.touch_updated_at();

-- A principal with no row is shown the least: 'customer'. A missing row must
-- never be the most permissive answer.
create function nl.disclosure_for(p_user_id int) returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select level from nl.disclosure_grants where user_id = p_user_id), 'customer')
$$;

-- May this principal be shown a value of this kind?
create function nl.may_see(p_user_id int, p_fact_kind text) returns boolean
language sql stable
set search_path = ''
as $$ select p_fact_kind = any (nl.disclosure_allows(nl.disclosure_for(p_user_id))) $$;

-- ---------------------------------------------------------------------------
-- The one legacy gate, said the new way
-- ---------------------------------------------------------------------------

-- 0010 wrote this as role in ('operations', 'admin') and a dozen row-level
-- security policies in 0010, 0015 and 0016 call it. That is the one place in
-- the old schema where a coarse role decided something real, so it becomes an
-- authority grant: db/seed.d/90_roles.sql gives run_import to exactly the
-- people the old check let through, so behaviour is unchanged and the rule is
-- now data somebody can edit on /people.
create or replace function nl.can_run_imports() returns boolean
language sql stable
set search_path = ''
as $$ select nl.i_have_authority('run_import') $$;

-- ---------------------------------------------------------------------------
-- Writes. All four take the same shape as every other write in this schema.
-- ---------------------------------------------------------------------------

-- Who may edit these three tables: an admin, or somebody holding
-- change_policy. Granting change_policy itself needs admin (see
-- nl.grant_authority), so the authority cannot be used to widen itself.
create function nl.may_change_roles() returns boolean
language sql stable
set search_path = ''
as $$ select nl.is_admin() or nl.i_have_authority('change_policy') $$;

create function nl.require_role_authority() returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if not nl.may_change_roles() then
    raise exception 'Changing what somebody is responsible for needs the change_policy authority.'
      using errcode = 'NL403';
  end if;
end $$;

-- Move somebody onto a preset and say what they are responsible for. The
-- preset name is a label: it does not resolve to a permission anywhere, so
-- this write changes nothing except the label and the line of text.
create function nl.set_user_preset(
  p_user_id        int,
  p_role           text,
  p_responsibility text,
  p_request_id     text,
  p_via            text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_before nl.users;
  v_after  nl.users;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_user_preset');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  perform nl.require_role_authority();

  if p_role is null or not (p_role = any (nl.role_presets())) then
    raise exception '% is not one of the presets.', coalesce(p_role, 'empty') using errcode = 'NL422';
  end if;
  if length(coalesce(p_responsibility, '')) > 200 then
    raise exception 'The responsibility line is at most 200 characters.' using errcode = 'NL422';
  end if;

  select * into v_before from nl.users where id = p_user_id;
  if not found then
    raise exception 'There is nobody with id %.', p_user_id using errcode = 'NL404';
  end if;
  -- An agent is never moved onto a person's preset, or the other way round:
  -- the preset is what seeds its scope, and the two sets do not overlap.
  if (v_before.kind = 'agent') <> (p_role = 'agent') then
    raise exception 'A % cannot be put on the % preset.', v_before.kind, p_role using errcode = 'NL422';
  end if;

  update nl.users
  set role = p_role, responsibility = trim(coalesce(p_responsibility, ''))
  where id = p_user_id
  returning * into v_after;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'set_user_preset', 'user', p_user_id::text, p_request_id,
          jsonb_build_object('from', v_before.role, 'to', v_after.role,
                             'responsibility', v_after.responsibility));

  v_result := jsonb_build_object('user_id', p_user_id, 'role', v_after.role);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Replace one dimension of somebody's scope. p_all true stores the single
-- "everything" row; otherwise p_values are stored one row each. Passing an
-- empty array with p_all false takes the dimension away, which is how a rail
-- entry disappears for somebody who has no business in it.
create function nl.set_user_scope(
  p_user_id    int,
  p_dimension  text,
  p_all        boolean,
  p_values     text[],
  p_request_id text,
  p_via        text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_target nl.users;
  v_clean  text[];
  v_before int;
  v_after  int;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_user_scope');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  perform nl.require_role_authority();

  if p_dimension is null or not (p_dimension = any (nl.scope_dimensions())) then
    raise exception '% is not a scope dimension.', coalesce(p_dimension, 'empty') using errcode = 'NL422';
  end if;
  select * into v_target from nl.users where id = p_user_id;
  if not found then
    raise exception 'There is nobody with id %.', p_user_id using errcode = 'NL404';
  end if;

  -- Distinct, trimmed, nothing blank. Values are ids in other tables and are
  -- deliberately not foreign keys: a scope row may name a warehouse or a part
  -- family that has not been loaded yet, and losing the assignment when a
  -- customer is closed would silently widen somebody's book.
  select coalesce(array_agg(distinct v), array[]::text[]) into v_clean
  from unnest(coalesce(p_values, array[]::text[])) as v
  where length(trim(v)) between 1 and 60;

  select count(*)::int into v_before from nl.user_scope
  where user_id = p_user_id and dimension = p_dimension;

  delete from nl.user_scope where user_id = p_user_id and dimension = p_dimension;

  if coalesce(p_all, false) then
    insert into nl.user_scope (user_id, dimension, value, granted_by)
    values (p_user_id, p_dimension, null, v_actor.id);
  else
    insert into nl.user_scope (user_id, dimension, value, granted_by)
    select p_user_id, p_dimension, trim(v), v_actor.id from unnest(v_clean) as v;
  end if;

  select count(*)::int into v_after from nl.user_scope
  where user_id = p_user_id and dimension = p_dimension;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'set_user_scope', 'user', p_user_id::text, p_request_id,
          jsonb_build_object('dimension', p_dimension, 'all', coalesce(p_all, false),
                             'was', v_before, 'now', v_after));

  v_result := jsonb_build_object(
    'user_id', p_user_id, 'dimension', p_dimension,
    'all', coalesce(p_all, false), 'rows', v_after);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Grant an authority, or raise or lower its ceiling from a date.
--
-- The effective dating is the whole reason this is not an UPDATE. A grant
-- already in force is not edited: it is ENDED the day before the new one
-- starts, and the new one is inserted. So a limit raised "from tomorrow"
-- leaves today's answer alone, and the old figure is still on the record.
-- This is also the write an agent's autonomy raise goes through; there is no
-- second function for agents.
create function nl.grant_authority(
  p_user_id    int,
  p_authority  text,
  p_limit      numeric,
  p_starts_on  date,
  p_ends_on    date,
  p_note       text,
  p_request_id text,
  p_via        text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_target  nl.users;
  v_starts  date;
  v_grant   nl.authority_grants;
  v_ended   int;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'grant_authority');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  perform nl.require_role_authority();

  if p_authority is null or not (p_authority = any (nl.authority_kinds())) then
    raise exception '% is not an authority.', coalesce(p_authority, 'empty') using errcode = 'NL422';
  end if;
  -- change_policy is the authority that lets somebody edit these tables, so
  -- only an admin may hand it out. Otherwise whoever held it could widen it.
  if p_authority = 'change_policy' and not nl.is_admin() then
    raise exception 'Only an admin may grant change_policy.' using errcode = 'NL403';
  end if;
  if not nl.authority_is_amount(p_authority) and p_limit is not null then
    raise exception '% is a yes or no, so it takes no limit.', p_authority using errcode = 'NL422';
  end if;
  if p_limit is not null and p_limit < 0 then
    raise exception 'A limit cannot be negative.' using errcode = 'NL422';
  end if;
  if p_authority = 'agent_autonomy' and p_limit is not null and p_limit > 3 then
    raise exception 'Autonomy runs from 0 to 3.' using errcode = 'NL422';
  end if;

  select * into v_target from nl.users where id = p_user_id;
  if not found then
    raise exception 'There is nobody with id %.', p_user_id using errcode = 'NL404';
  end if;
  if p_authority = 'agent_autonomy' and v_target.kind <> 'agent' then
    raise exception 'Autonomy is an agent''s limit; a person has approval limits instead.'
      using errcode = 'NL422';
  end if;

  v_starts := coalesce(p_starts_on, nl.today());
  if p_ends_on is not null and p_ends_on < v_starts then
    raise exception 'The end of a grant cannot come before its start.' using errcode = 'NL422';
  end if;

  -- End what is already in force the day before this starts. A grant that
  -- began later than that (a future one being replaced) is deleted outright,
  -- because ending it before it started would leave an impossible row.
  delete from nl.authority_grants
  where user_id = p_user_id and authority = p_authority and starts_on >= v_starts;

  update nl.authority_grants
  set ends_on = v_starts - 1
  where user_id = p_user_id
    and authority = p_authority
    and starts_on < v_starts
    and (ends_on is null or ends_on >= v_starts);
  get diagnostics v_ended = row_count;

  insert into nl.authority_grants
    (user_id, authority, limit_amount, starts_on, ends_on, note, granted_by)
  values
    (p_user_id, p_authority, p_limit, v_starts, p_ends_on,
     trim(coalesce(p_note, '')), v_actor.id)
  returning * into v_grant;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'grant_authority', 'user', p_user_id::text, p_request_id,
          jsonb_build_object('authority', p_authority, 'limit', p_limit,
                             'starts_on', v_starts, 'ends_on', p_ends_on,
                             'superseded', v_ended, 'kind', v_target.kind));

  v_result := jsonb_build_object(
    'grant_id', v_grant.id, 'user_id', p_user_id, 'authority', p_authority,
    'limit', p_limit, 'starts_on', v_starts, 'superseded', v_ended,
    'in_force_today', nl.has_authority(p_user_id, p_authority));
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Take an authority away from today. Yesterday's end date, so the grant is
-- out of force for the rest of today rather than from tomorrow: a limit is
-- withdrawn because somebody should not be using it now.
create function nl.revoke_authority(
  p_user_id    int,
  p_authority  text,
  p_request_id text,
  p_via        text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_gone   int;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'revoke_authority');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  perform nl.require_role_authority();

  if p_authority is null or not (p_authority = any (nl.authority_kinds())) then
    raise exception '% is not an authority.', coalesce(p_authority, 'empty') using errcode = 'NL422';
  end if;
  if p_authority = 'change_policy' and not nl.is_admin() then
    raise exception 'Only an admin may change who holds change_policy.' using errcode = 'NL403';
  end if;

  delete from nl.authority_grants
  where user_id = p_user_id and authority = p_authority and starts_on > nl.today();

  update nl.authority_grants
  set ends_on = nl.today() - 1
  where user_id = p_user_id
    and authority = p_authority
    and starts_on <= nl.today()
    and (ends_on is null or ends_on >= nl.today());
  get diagnostics v_gone = row_count;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'revoke_authority', 'user', p_user_id::text, p_request_id,
          jsonb_build_object('authority', p_authority, 'ended', v_gone));

  v_result := jsonb_build_object('user_id', p_user_id, 'authority', p_authority, 'ended', v_gone);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

create function nl.set_disclosure(
  p_user_id    int,
  p_level      text,
  p_note       text,
  p_request_id text,
  p_via        text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_before text;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_disclosure');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  perform nl.require_role_authority();

  if p_level is null or p_level not in ('customer', 'vendor', 'internal') then
    raise exception '% is not a disclosure level.', coalesce(p_level, 'empty') using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.users where id = p_user_id) then
    raise exception 'There is nobody with id %.', p_user_id using errcode = 'NL404';
  end if;

  v_before := nl.disclosure_for(p_user_id);

  insert into nl.disclosure_grants (user_id, level, note, granted_by)
  values (p_user_id, p_level, trim(coalesce(p_note, '')), v_actor.id)
  on conflict (user_id) do update
    set level = excluded.level, note = excluded.note, granted_by = excluded.granted_by;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'set_disclosure', 'user', p_user_id::text, p_request_id,
          jsonb_build_object('from', v_before, 'to', p_level));

  v_result := jsonb_build_object('user_id', p_user_id, 'level', p_level, 'was', v_before);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- The home page: what is waiting on THIS principal's authority
-- ---------------------------------------------------------------------------

-- One row per item that is (a) inside this principal's scope and (b) waiting
-- on an authority they actually hold. The second half is what keeps a home
-- page short: a shipment nobody asked this person to pick is not their
-- problem, and a quote above their ceiling is somebody else's decision.
--
-- The shape. `kind` says which queue it came from and `ref` is the record's
-- own key in that queue. The link is built from those two in
-- app/src/lib/server/roles/work.ts, through the route registry in
-- app/src/lib/routes.ts, so a person and an agent are handed the same URL for
-- the same record. Building a path in SQL would have been a second copy of
-- that registry, and the registry exists because there used to be nineteen
-- copies.
--
-- Why this is plpgsql and not one SQL statement. It was one statement first:
-- thirteen branches unioned together, each opening with
-- (select nl.has_authority(...)) so Postgres skipped the ones a person cannot
-- answer. The skipping worked (every unreachable branch reads "never
-- executed" in the plan) and it was still slow, because PLANNING all thirteen
-- cost more than running three. nl.open_line_projection alone plans into a
-- couple of hundred nodes. Written as plpgsql, each `return query` is a
-- separate statement that plpgsql prepares the first time it actually runs,
-- so a warehouse lead's call never plans the coverage branches at all. The
-- measured difference is in docs/roles.md.
--
-- The ordering is deliberate: oldest first, so the thing that has been
-- waiting longest is at the top. The caller does not sort it again.
create function nl.work_waiting_for(p_user_id int)
returns table (
  kind          text,
  ref           text,
  subject       text,
  amount        numeric,
  waiting_since timestamptz,
  age_days      int,
  why           text
)
language plpgsql stable
set search_path = ''
as $$
declare
  v_today   date := nl.today();
  v_ceiling numeric;
  -- Whether this principal holds a whole dimension, read once. Without this
  -- the "is it mine" test was a function call per candidate row, which on the
  -- demo world was most of the time this function took.
  v_all_accounts  boolean := nl.scope_is_all(p_user_id, 'account');
  v_all_vendors   boolean := nl.scope_is_all(p_user_id, 'vendor');
  v_all_families  boolean := nl.scope_is_all(p_user_id, 'part_family');
  v_all_stores    boolean := nl.scope_is_all(p_user_id, 'warehouse');
  v_all_mailboxes boolean := nl.scope_is_all(p_user_id, 'mailbox');
begin
  -- 1. An agent's drafted reply, waiting to be sent.
  if nl.has_authority(p_user_id, 'approve_reply') then
    return query
    select 'mail_draft'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'A drafted reply is waiting for you to send it.'::text
    from nl.agent_queue q
    join nl.mail_drafts d on d.id = q.source_id
    where q.source = 'mail'
      and q.status = 'waiting'
      and (v_all_mailboxes or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'mailbox'
              and sc.value = d.mailbox_id::text));
  end if;

  -- 2. What the desk could not finish: a draft its own disclosure policy
  --    refused, or a message it would not guess at. These are the exceptions
  --    that escaped, and they belong to whoever reviews exceptions.
  if nl.has_authority(p_user_id, 'review_exception') then
    return query
    select 'mail_exception'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'The agent stopped and asked for a person.'::text
    from nl.agent_queue q
    join nl.mail_drafts d on d.id = q.source_id
    where q.source = 'mail'
      and q.status = 'needs_review'
      and (v_all_mailboxes or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'mailbox'
              and sc.value = d.mailbox_id::text));

    return query
    select 'mail_unanswered'::text,
           m.id::text,
           m.subject,
           null::numeric,
           m.received_at,
           (v_today - m.received_at::date)::int,
           'This message needs a person to answer it.'::text
    from nl.mail_messages m
    where m.status = 'needs_person'
      and (v_all_mailboxes or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'mailbox'
              and sc.value = m.mailbox_id::text));
  end if;

  -- 3. A quote read out of a customer's email, waiting to go out, and a quote
  --    already sent that is about to run out. Both need the same authority,
  --    and the ceiling is read once here rather than per row.
  if nl.has_authority(p_user_id, 'approve_quote') then
    v_ceiling := nl.authority_ceiling(p_user_id, 'approve_quote');

    return query
    select 'quote_request'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'A quote is drafted and waiting for your approval.'::text
    from nl.agent_queue q
    where q.source = 'rfq'
      and q.status in ('waiting', 'needs_review')
      and q.reviewer_id = p_user_id
      and coalesce(q.value, 0) <= v_ceiling;

    -- Nothing is technically waiting on a decision here, which is the point:
    -- it is the item a rep finds out about too late.
    return query
    select 'quote_expiring'::text,
           q.id::text,
           q.customer_name || ': quote ' || q.id::text,
           q.subtotal,
           q.valid_until::timestamptz,
           (q.valid_until - v_today)::int,
           'This quote runs out within a fortnight.'::text
    from nl.quote_document q
    where q.valid_until is not null
      and q.valid_until >= v_today
      and q.valid_until <= v_today + 14
      and (v_all_accounts or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'account'
              and sc.value = q.customer_no));
  end if;

  -- 4. Something the assistant proposed and will not run on its own.
  if nl.has_authority(p_user_id, 'approve_agent_proposal') then
    return query
    select 'agent_proposal'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'The assistant proposed this and is waiting for your decision.'::text
    from nl.agent_queue q
    where q.source = 'assistant'
      and q.status in ('waiting', 'retry')
      and q.reviewer_id = p_user_id;
  end if;

  -- 5. A commitment window that closed short and has not been answered.
  if nl.has_authority(p_user_id, 'answer_commitment') then
    return query
    select 'commitment_answer'::text,
           p.id::text,
           p.title,
           p.committed_value,
           p.ends_on::timestamptz,
           coalesce(p.days_since_close, 0)::int,
           'The window closed short and nobody has said what happened.'::text
    from nl.commitment_progress p
    where p.needs_outcome
      and (v_all_accounts or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'account'
              and sc.value = p.customer_no));
  end if;

  -- 6. A short line whose supply would be a purchase order: the buyer's.
  --    Inside the month only. A line that ships in eight weeks is not waiting
  --    on anybody today, and putting it on a home page is how a home page
  --    stops being read.
  if nl.has_authority(p_user_id, 'release_purchase_order') then
    v_ceiling := nl.authority_ceiling(p_user_id, 'release_purchase_order');

    return query
    select 'coverage_purchase'::text,
           l.document_no || '/' || l.line_no::text,
           l.item_no || ' for ' || l.customer_no || ', ' || l.status,
           l.open_value,
           l.ship_date::timestamptz,
           coalesce(l.days_late, 0)::int,
           'This line has no supply and the part is bought in.'::text
    from nl.open_line_projection l
    join nl.items i on i.item_no = l.item_no
    where l.status in ('past_due', 'no_supply')
      and l.ship_date <= v_today + 30
      and i.replenishment = 'Purchase'
      and i.vendor_no is not null
      and (v_all_vendors or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'vendor'
              and sc.value = i.vendor_no))
      and coalesce(l.open_value, 0) <= v_ceiling;
  end if;

  -- 7. The same shortage when the part is made here: the planner's.
  if nl.has_authority(p_user_id, 'resolve_shortage') then
    return query
    select 'coverage_production'::text,
           l.document_no || '/' || l.line_no::text,
           l.item_no || ' for ' || l.customer_no || ', ' || l.status,
           l.open_value,
           l.ship_date::timestamptz,
           coalesce(l.days_late, 0)::int,
           'This line has no supply and the part is made here.'::text
    from nl.open_line_projection l
    join nl.items i on i.item_no = l.item_no
    where l.status in ('past_due', 'no_supply')
      and l.ship_date <= v_today + 30
      and i.replenishment in ('Prod. Order', 'Assembly')
      and (v_all_families or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'part_family'
              and sc.value = i.family));
  end if;

  -- 8. A supplier's new cost above the one before it. A material rise in the
  --    last fortnight: rounding noise on a cost revision is not a decision.
  if nl.has_authority(p_user_id, 'accept_price_increase') then
    v_ceiling := nl.authority_ceiling(p_user_id, 'accept_price_increase');

    return query
    select 'price_increase'::text,
           c.item_no || '@' || c.effective_from::text,
           c.item_no || ': cost up to ' || c.unit_cost::text,
           c.unit_cost,
           c.effective_from::timestamptz,
           (v_today - c.effective_from)::int,
           'A supplier has raised a cost and nobody has accepted it.'::text
    from nl.item_cost_timeline c
    where c.is_current
      and c.source = 'vendor quote'
      and c.change_pct >= 0.02
      and c.effective_from >= v_today - 14
      and c.vendor_no is not null
      and (v_all_vendors or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'vendor'
              and sc.value = c.vendor_no))
      and c.unit_cost <= v_ceiling;
  end if;

  -- 9. A shipment on the floor waiting to be picked.
  if nl.has_authority(p_user_id, 'confirm_pick') then
    return query
    select 'pick'::text,
           s.shipment_no,
           s.shipment_no || ' for ' || s.customer_no,
           null::numeric,
           s.created_at,
           (v_today - s.created_at::date)::int,
           'This shipment is still being picked.'::text
    from nl.shipments s
    where s.status = 'picking'
      and (v_all_stores or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'warehouse'
              and sc.value = s.location_code));
  end if;

  -- 10. A transfer due in that has not been received.
  if nl.has_authority(p_user_id, 'receive_stock') then
    return query
    select 'receipt'::text,
           t.transfer_no,
           t.transfer_no || ' from ' || t.from_location,
           null::numeric,
           t.expected_on::timestamptz,
           (v_today - t.expected_on)::int,
           'This transfer was due in and has not been received.'::text
    from nl.transfers t
    where t.status = 'in transit'
      and t.expected_on <= v_today
      and (v_all_stores or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'warehouse'
              and sc.value = t.to_location));
  end if;

  -- 11. A cycle count that is due.
  if nl.has_authority(p_user_id, 'count_stock') then
    return query
    select 'count'::text,
           c.session_no,
           c.session_no || ', zone ' || c.zone,
           null::numeric,
           c.due_on::timestamptz,
           (v_today - c.due_on)::int,
           'This count is due and not posted.'::text
    from nl.count_sessions c
    where c.status = 'open'
      and c.due_on <= v_today
      and (v_all_stores or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'warehouse'
              and sc.value = c.location_code));
  end if;

  -- 12. A daily ERP export staged or held, waiting to be applied. No scope
  --     dimension: there is one company and one load.
  if nl.has_authority(p_user_id, 'run_import') then
    return query
    select 'import_decision'::text,
           s.id::text,
           s.kind || ': ' || s.file_name,
           s.total_value,
           s.staged_at,
           (v_today - s.staged_at::date)::int,
           case when s.status = 'held'
                then 'This load is held and needs a decision.'
                else 'This load is staged and waiting to be applied.' end::text
    from nl.export_snapshots s
    where s.status in ('staged', 'held');
  end if;
end $$;

comment on function nl.work_waiting_for(int) is
  'Everything inside a principal''s scope that is waiting on an authority they hold. The home page (migration 0027).';

-- ---------------------------------------------------------------------------
-- The policy surface: one row per principal, for /people
-- ---------------------------------------------------------------------------

create view nl.people_policy with (security_invoker = true) as
select u.id,
       u.email,
       u.full_name,
       u.title,
       u.role,
       u.kind,
       u.responsibility,
       u.active,
       nl.disclosure_for(u.id) as disclosure,
       -- Scope as one object per dimension: {"account": {"all": false, "count": 41}}
       (select coalesce(
          jsonb_object_agg(d.dimension, jsonb_build_object(
            'all', d.is_all,
            'count', case when d.is_all then null else d.n end)), '{}'::jsonb)
        from (
          select s.dimension,
                 bool_or(s.value is null) as is_all,
                 count(*) filter (where s.value is not null)::int as n
          from nl.user_scope s
          where s.user_id = u.id
          group by s.dimension) d) as scope,
       -- Every authority in force today, with its ceiling.
       (select coalesce(
          jsonb_object_agg(g.authority, jsonb_build_object(
            'limit', g.limit_amount,
            'unlimited', g.limit_amount is null and nl.authority_is_amount(g.authority),
            'starts_on', g.starts_on,
            'ends_on', g.ends_on)), '{}'::jsonb)
        from nl.authority_grants g
        where g.user_id = u.id
          and g.starts_on <= nl.today()
          and (g.ends_on is null or g.ends_on >= nl.today())) as authority,
       -- Grants that have not started yet, so a raise dated forward is
       -- visible rather than a surprise on the day.
       (select coalesce(
          jsonb_agg(jsonb_build_object(
            'authority', g.authority, 'limit', g.limit_amount, 'starts_on', g.starts_on)
          order by g.starts_on), '[]'::jsonb)
        from nl.authority_grants g
        where g.user_id = u.id and g.starts_on > nl.today()) as authority_ahead
from nl.users u;

comment on view nl.people_policy is
  'Who exists, what they are responsible for, what they may decide and what they may see. The read side of /people (migration 0027).';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

-- All three tables read wide open to nl_app, on purpose. Who may approve what
-- is not a secret inside a company: it is the thing people need to see to
-- know who to ask, and /people is built on exactly this read. Writing is
-- another matter, and goes through the functions above.
--
-- Reading wide also keeps these policies out of a loop. A policy that called
-- nl.has_authority would have to read nl.authority_grants, whose policy would
-- call it again.

alter table nl.user_scope enable row level security;
create policy user_scope_read on nl.user_scope for select to nl_app using (true);
-- The write policies are the only place scope narrows an action rather than a
-- read: somebody with change_policy may hand out account 12345 only if that
-- account is in their own scope, and an admin is not held to that. This is
-- what stops a regional manager widening their own region.
create policy user_scope_write on nl.user_scope for insert to nl_app
  with check ((select nl.may_change_roles())
              and (value is null or (select nl.may_act_on(dimension, value))));
create policy user_scope_change on nl.user_scope for update to nl_app
  using ((select nl.may_change_roles()))
  with check ((select nl.may_change_roles())
              and (value is null or (select nl.may_act_on(dimension, value))));
create policy user_scope_remove on nl.user_scope for delete to nl_app
  using ((select nl.may_change_roles()));
grant select, insert, update, delete on nl.user_scope to nl_app;

alter table nl.authority_grants enable row level security;
create policy authority_read on nl.authority_grants for select to nl_app using (true);
create policy authority_write on nl.authority_grants for insert to nl_app
  with check ((select nl.may_change_roles()));
create policy authority_change on nl.authority_grants for update to nl_app
  using ((select nl.may_change_roles()))
  with check ((select nl.may_change_roles()));
create policy authority_remove on nl.authority_grants for delete to nl_app
  using ((select nl.may_change_roles()));
grant select, insert, update, delete on nl.authority_grants to nl_app;

alter table nl.disclosure_grants enable row level security;
create policy disclosure_read on nl.disclosure_grants for select to nl_app using (true);
create policy disclosure_write on nl.disclosure_grants for insert to nl_app
  with check ((select nl.may_change_roles()));
create policy disclosure_change on nl.disclosure_grants for update to nl_app
  using ((select nl.may_change_roles()))
  with check ((select nl.may_change_roles()));
grant select, insert, update, delete on nl.disclosure_grants to nl_app;

-- The preset and the responsibility line live on nl.users, which had no
-- update grant at all. Two columns, and only those two.
create policy users_change_preset on nl.users for update to nl_app
  using ((select nl.may_change_roles()))
  with check ((select nl.may_change_roles()));
grant update (role, responsibility) on nl.users to nl_app;

grant select on nl.people_policy to nl_app;

-- nl_readonly, the assistant's SQL tool, is granted nothing here. These three
-- tables are about people, and that role has never had a grant on one.

grant execute on function
  nl.role_presets(),
  nl.scope_dimensions(),
  nl.in_scope(int, text, text),
  nl.scope_is_all(int, text),
  nl.my_scope(text, text),
  nl.may_act_on(text, text),
  nl.authority_kinds(),
  nl.authority_is_amount(text),
  nl.authority_limit_override(int, text, date),
  nl.authority_grants_on(int, text, date),
  nl.has_authority(int, text, date),
  nl.authority_limit(int, text, date),
  nl.authority_ceiling(int, text, date),
  nl.may_approve(int, text, numeric, date),
  nl.i_have_authority(text),
  nl.disclosure_allows(text),
  nl.disclosure_for(int),
  nl.may_see(int, text),
  nl.may_change_roles(),
  nl.require_role_authority(),
  nl.work_waiting_for(int),
  nl.set_user_preset(int, text, text, text, text),
  nl.set_user_scope(int, text, boolean, text[], text, text),
  nl.grant_authority(int, text, numeric, date, date, text, text, text),
  nl.revoke_authority(int, text, text, text),
  nl.set_disclosure(int, text, text, text, text)
to nl_app;
