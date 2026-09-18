-- 0031 The policy engine and the data dictionary: one home for the business
-- rules that were scattered through the migrations as literals, and one
-- machine-readable description of every field a person or an agent reads.
--
-- Why this exists. By migration 0030 the same kind of decision was written in
-- six different ways: 0.95 inside nl.kept_ratio(), 0.40 and 14 inside 0010,
-- 3 inside 0016, 0.20 inside nl.min_margin(), a free freight threshold on a
-- period table, and "30" pasted into the RFQ approval path. Each was correct
-- and none could be changed without a deploy, or set differently for one
-- account, or explained to the person looking at the number. A parts business
-- is mostly exceptions: this account ships on its own carrier account, that
-- family never goes below a third, this buyer gets a fortnight on a quote.
-- Writing each exception into the code that reads it is how a system fills up
-- with special cases.
--
-- What a policy is. A policy is a VALUE that something reads while it works:
-- who pays the freight here, what is the margin floor for this part, how long
-- does this account's quote hold. It is not a trigger and it does not make
-- anything happen. Migration 0013 already has the thing that makes something
-- happen: an automation rule. The two compose, because a rule's threshold can
-- itself be a policy. docs/policy-engine.md says this at more length.
--
-- What is in here:
--
--   nl.policy_types        which policies exist, their shape, unit, scopes,
--                          default, and who may change them
--   nl.policies            the rows people set: a value at a scope, with a
--                          window, a priority and a note saying why
--   nl.resolve_policy()    the value AND the explanation
--   nl.resolve_policies()  many types in one call, for a screen or an agent
--   nl.policy_trace()      every candidate and why each one lost
--   nl.set_policy()        the write, validated against the type's shape
--   nl.end_policy()        stop an override without losing the history
--
--   nl.data_dictionary     every field, what it means, its unit, where it
--                          comes from, and whether it may leave the building
--   nl.describe_data()     the same, as structured data, for the assistant
--                          and the MCP server
--   nl.data_dictionary_gaps  a column nobody documented, or a documented
--                          field that is not a column any more
--
-- Four rules move here in this migration (freight terms and the free freight
-- threshold, the margin floor, quote validity, allocation priority). Each
-- keeps its old function as a thin wrapper that resolves with a global
-- context, so every existing caller gets the same answer it got yesterday.
-- A wrapper is a migration step, not the destination; docs/policy-engine.md
-- lists the call sites still to move.
--
-- Depends on 0001 (users, audit log, request ids, nl.today, nl.now_ms),
-- 0002 (customers, items, price groups), 0010 (open order lines, the
-- allocation view), 0011 (the RFQ approval path) and 0018 (freight and the
-- margin floor).

-- ---------------------------------------------------------------------------
-- Scopes: the dimensions a policy can be set at, most specific first
-- ---------------------------------------------------------------------------

-- The fixed list. A scope kind that is not in it cannot be stored.
create function nl.policy_scope_kinds() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'global',
    'customer_segment',
    'customer',
    'vendor',
    'item',
    'item_family',
    'location',
    'mailbox',
    'order',
    'order_line'
  ]
$$;

-- How specific each scope is. A lower number wins: a rule about one line of
-- one order beats a rule about the order, which beats a rule about the part,
-- and anything named at all beats the company default.
--
-- The order across dimensions is a choice, not a law. A policy set on a part
-- beats one set on an account, because a part rule is usually physical (this
-- casting is sold in tens) while an account rule is usually commercial, and
-- the physical one has to hold. Where that is the wrong way round for one
-- policy, `priority` on the row settles it, which is what priority is for.
create function nl.policy_scope_rank(p_kind text) returns int
language sql immutable
set search_path = ''
as $$
  select case p_kind
    when 'order_line'       then 10
    when 'order'            then 20
    when 'item'             then 30
    when 'item_family'      then 40
    when 'customer'         then 50
    when 'customer_segment' then 60
    when 'vendor'           then 70
    when 'mailbox'          then 80
    when 'location'         then 90
    when 'global'           then 999
  end
$$;

-- What a scope kind is called in a sentence, for a row that is not about the
-- context being explained ("set for an account, not this one").
create function nl.policy_scope_kind_words(p_kind text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_kind
    when 'global'           then 'the company'
    when 'customer'         then 'an account'
    when 'customer_segment' then 'a price group'
    when 'vendor'           then 'a supplier'
    when 'item'             then 'a part'
    when 'item_family'      then 'a part family'
    when 'location'         then 'a location'
    when 'mailbox'          then 'a mailbox'
    when 'order'            then 'an order'
    when 'order_line'       then 'an order line'
    else coalesce(p_kind, 'something')
  end
$$;

-- ---------------------------------------------------------------------------
-- Value shapes
-- ---------------------------------------------------------------------------

/*
 * Is this value the shape its policy type asks for? Returns null when it is
 * fine, and one plain sentence when it is not, which is what the person
 * typing it reads.
 *
 * Seven shapes cover everything so far, and each is a word a non-engineer
 * recognizes: number, integer, boolean, text, enum (one of a fixed list),
 * text_list (several of a fixed list), object (a small set of named numbers,
 * for something like a lead time per replenishment method). `p_schema` for an
 * object is {"key": "number"}: every key it names must be there with that
 * type, and nothing else may be.
 */
create function nl.policy_shape_problem(
  p_value_type text,
  p_allowed    text[],
  p_min        numeric,
  p_max        numeric,
  p_schema     jsonb,
  p_value      jsonb
) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_kind text;
  v_num  numeric;
  v_bad  text;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    return 'a policy needs a value';
  end if;
  v_kind := pg_catalog.jsonb_typeof(p_value);

  if p_value_type in ('number', 'integer') then
    if v_kind <> 'number' then
      return pg_catalog.format('%s is not a number', p_value::text);
    end if;
    v_num := (p_value #>> '{}')::numeric;
    if p_value_type = 'integer' and v_num <> pg_catalog.trunc(v_num) then
      return pg_catalog.format('%s is not a whole number', v_num);
    end if;
    if p_min is not null and v_num < p_min then
      return pg_catalog.format('%s is below the lowest value allowed, %s', v_num, p_min);
    end if;
    if p_max is not null and v_num > p_max then
      return pg_catalog.format('%s is above the highest value allowed, %s', v_num, p_max);
    end if;
    return null;
  end if;

  if p_value_type = 'boolean' then
    if v_kind <> 'boolean' then return 'this policy is yes or no'; end if;
    return null;
  end if;

  if p_value_type = 'text' then
    if v_kind <> 'string' then return 'this policy is a piece of text'; end if;
    if pg_catalog.length(p_value #>> '{}') = 0 then return 'the text is empty'; end if;
    return null;
  end if;

  if p_value_type = 'enum' then
    if v_kind <> 'string' then return 'this policy is one of a fixed list of words'; end if;
    if not ((p_value #>> '{}') = any (p_allowed)) then
      return pg_catalog.format('%s is not one of: %s',
        p_value #>> '{}', pg_catalog.array_to_string(p_allowed, ', '));
    end if;
    return null;
  end if;

  if p_value_type = 'text_list' then
    if v_kind <> 'array' then return 'this policy is a list'; end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_value) e
      where pg_catalog.jsonb_typeof(e.value) <> 'string'
    ) then
      return 'every entry in the list is a piece of text';
    end if;
    if pg_catalog.cardinality(p_allowed) > 0 then
      select pg_catalog.string_agg(e.value #>> '{}', ', ') into v_bad
      from pg_catalog.jsonb_array_elements(p_value) e
      where not ((e.value #>> '{}') = any (p_allowed));
      if v_bad is not null then
        return pg_catalog.format('%s is not one of: %s', v_bad, pg_catalog.array_to_string(p_allowed, ', '));
      end if;
    end if;
    return null;
  end if;

  if p_value_type = 'object' then
    if v_kind <> 'object' then return 'this policy is a small set of named values'; end if;
    select pg_catalog.string_agg(k.key, ', ') into v_bad
    from pg_catalog.jsonb_object_keys(p_schema) as k(key)
    where pg_catalog.jsonb_typeof(p_value -> k.key) is distinct from (p_schema ->> k.key);
    if v_bad is not null then
      return pg_catalog.format('%s is missing, or is not the kind of value it should be', v_bad);
    end if;
    select pg_catalog.string_agg(k.key, ', ') into v_bad
    from pg_catalog.jsonb_object_keys(p_value) as k(key)
    where not (p_schema ? k.key);
    if v_bad is not null then
      return pg_catalog.format('%s is not part of this policy', v_bad);
    end if;
    return null;
  end if;

  return pg_catalog.format('%s is not a value shape this engine knows', p_value_type);
end $$;

-- A number with thousands separators, and decimals only when it has any.
create function nl.policy_number_words(p_value numeric) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_value = pg_catalog.trunc(p_value)
      then pg_catalog.btrim(pg_catalog.to_char(p_value, 'FM999,999,999,990'))
    else pg_catalog.btrim(pg_catalog.to_char(pg_catalog.round(p_value, 4), 'FM999,999,999,990.9999'))
  end
$$;

-- A value in words, for the sentence a screen shows. The unit decides how a
-- number reads: a ratio becomes a percentage, USD gets a dollar sign, days
-- say "days".
create function nl.policy_words(p_value_type text, p_unit text, p_value jsonb) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then 'nothing'
    when pg_catalog.jsonb_typeof(p_value) = 'boolean' then
      case when (p_value #>> '{}')::boolean then 'yes' else 'no' end
    when pg_catalog.jsonb_typeof(p_value) = 'array' then
      coalesce(nullif((
        select pg_catalog.string_agg(e.value #>> '{}', ', ')
        from pg_catalog.jsonb_array_elements(p_value) e), ''), 'nothing')
    when pg_catalog.jsonb_typeof(p_value) = 'object' then p_value::text
    when pg_catalog.jsonb_typeof(p_value) <> 'number' then p_value #>> '{}'
    when p_unit = 'ratio' then nl.policy_number_words((p_value #>> '{}')::numeric * 100) || '%'
    when p_unit = 'USD' then '$' || nl.policy_number_words((p_value #>> '{}')::numeric)
    when p_unit = 'days' then nl.policy_number_words((p_value #>> '{}')::numeric) || ' days'
    when p_unit = 'pieces' then nl.policy_number_words((p_value #>> '{}')::numeric) || ' pieces'
    else nl.policy_number_words((p_value #>> '{}')::numeric)
  end
$$;

-- ---------------------------------------------------------------------------
-- Which policies exist
-- ---------------------------------------------------------------------------

create table nl.policy_types (
  key           text primary key check (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  -- Which part of the business this belongs to, for the page's grouping.
  group_key     text not null check (group_key in
                  ('freight', 'commercial', 'fulfilment', 'quality', 'operations', 'agents')),
  name          text not null check (length(name) between 3 and 80),
  description   text not null,
  value_type    text not null check (value_type in
                  ('number', 'integer', 'boolean', 'text', 'enum', 'text_list', 'object')),
  -- The fixed list, for enum and for a text_list drawn from a fixed list.
  allowed       text[] not null default '{}',
  min_value     numeric,
  max_value     numeric,
  -- {"key": "number"} for an object policy, empty otherwise.
  value_schema  jsonb not null default '{}',
  -- 'ratio', 'USD', 'days', 'pieces', 'rank', or empty where a value has no unit.
  unit          text not null default '',
  -- The scope kinds this policy may be set at. Always includes 'global'.
  scopes        text[] not null,
  default_value jsonb not null,
  -- What reads this policy today, in plain words, or empty when nothing does
  -- yet. Being honest about this is the whole difference between a policy
  -- engine and a page of settings that quietly do nothing.
  read_by       text not null default '',
  -- May a person change this from /policies at all? A policy whose old
  -- hard-coded reader has not been moved yet is shown and not editable,
  -- because editing it would change a number on screen and nothing else.
  editable      boolean not null default true,
  -- The role that may change it. An admin may change anything editable.
  edit_role     text not null default 'admin'
                  check (edit_role in ('admin', 'operations', 'account_manager')),
  created_at    timestamptz not null default now(),
  constraint policy_types_scopes_known check (scopes <@ nl.policy_scope_kinds()),
  constraint policy_types_scopes_global check (scopes @> array['global']),
  constraint policy_types_enum_has_list check (value_type <> 'enum' or cardinality(allowed) > 0),
  constraint policy_types_object_has_schema
    check (value_type <> 'object' or value_schema <> '{}'::jsonb),
  constraint policy_types_default_shape check (
    nl.policy_shape_problem(value_type, allowed, min_value, max_value, value_schema, default_value) is null)
);

comment on table nl.policy_types is
  'Which policies exist: shape, unit, the scopes each may be set at, its default, and who may change it (migration 0031).';

-- ---------------------------------------------------------------------------
-- The policies people set
-- ---------------------------------------------------------------------------

create table nl.policies (
  id           bigint generated always as identity (start with 4001) primary key,
  policy_type  text not null references nl.policy_types (key) on delete cascade,
  scope_kind   text not null check (scope_kind = any (nl.policy_scope_kinds())),
  -- The customer number, price group code, item number, family, vendor
  -- number, location code, mailbox id, order number or order number and line.
  -- Empty for a global policy, and only for a global policy.
  scope_id     text not null default '' check (length(scope_id) <= 60),
  value        jsonb not null,
  effective_from date not null,
  -- Null means open ended. A closed window is history, not a mistake: an
  -- expired row stays so the trace can say what used to be true.
  effective_to date,
  -- Breaks a tie between two rows at the same scope. Higher wins.
  priority     int not null default 0 check (priority between -100 and 100),
  -- Why. Required by convention rather than by the database, because a policy
  -- nobody can explain is the thing this engine exists to prevent.
  note         text not null default '' check (length(note) <= 300),
  -- Null on a row the seed or an import made.
  set_by       int references nl.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default nl.now_ms(),
  constraint policies_window check (effective_to is null or effective_to >= effective_from),
  constraint policies_global_scope check ((scope_kind = 'global') = (scope_id = ''))
);

comment on table nl.policies is
  'One policy value at one scope for one window. nl.resolve_policy() decides which of them wins (migration 0031).';

-- The lookup nl.resolve_policy() makes, in the order it makes it: the type,
-- then each candidate scope, newest window first. The included columns mean
-- the answer never visits the table.
create index policies_resolve_idx
  on nl.policies (policy_type, scope_kind, scope_id, effective_from desc)
  include (value, effective_to, priority);

-- "What is set for this account", for the editor and the account page.
create index policies_scope_idx on nl.policies (scope_kind, scope_id);
create index policies_set_by_idx on nl.policies (set_by);

create trigger policies_touch before update on nl.policies
  for each row execute function nl.touch_updated_at();

-- The value has to match its type's shape, and the scope has to be one the
-- type allows. The write function checks the person; this checks the data,
-- whoever writes it, including the seed.
create function nl.policies_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_type    nl.policy_types;
  v_problem text;
begin
  select * into v_type from nl.policy_types where key = new.policy_type;
  if not found then
    raise exception 'There is no policy type called %.', new.policy_type using errcode = 'NL422';
  end if;
  if not (new.scope_kind = any (v_type.scopes)) then
    raise exception '% cannot be set at % scope. It may be set at: %.',
      v_type.name, new.scope_kind, array_to_string(v_type.scopes, ', ') using errcode = 'NL422';
  end if;
  v_problem := nl.policy_shape_problem(
    v_type.value_type, v_type.allowed, v_type.min_value, v_type.max_value, v_type.value_schema, new.value);
  if v_problem is not null then
    raise exception 'That is not a value % can take: %.', v_type.name, v_problem using errcode = 'NL422';
  end if;
  return new;
end $$;

create trigger policies_check before insert or update on nl.policies
  for each row execute function nl.policies_check();

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

/*
 * The scopes one context could match, most specific first.
 *
 * A context is a small jsonb object naming what is being decided:
 *   {"customer_no": "1218", "item_no": "EL-4525", "on_date": "2026-09-17"}
 * Two scopes are worked out rather than given, because a caller holding a
 * customer number should not have to look them up: the account's price group
 * and the part's family. A caller may name either directly instead.
 */
create function nl.policy_candidates(p_context jsonb)
returns table (scope_kind text, scope_id text, rank int, scope_words text)
language sql stable
-- Ten scope kinds means at most ten candidates, ever. Without this the
-- planner assumes a thousand rows come out of here, hashes the whole of
-- nl.policies to meet them, and resolution goes from two milliseconds to
-- sixty once the table has a few thousand rows in it. Measured, not guessed.
rows 10
set search_path = ''
as $$
  with ctx as (select coalesce(p_context, '{}'::jsonb) as c),
  named as (
    select
      nullif(ctx.c ->> 'customer_no', '')   as customer_no,
      nullif(ctx.c ->> 'item_no', '')       as item_no,
      nullif(ctx.c ->> 'vendor_no', '')     as vendor_no,
      nullif(ctx.c ->> 'location_code', '') as location_code,
      nullif(ctx.c ->> 'mailbox_id', '')    as mailbox_id,
      nullif(ctx.c ->> 'document_no', '')   as document_no,
      nullif(ctx.c ->> 'line_no', '')       as line_no,
      nullif(ctx.c ->> 'customer_segment', '') as given_segment,
      nullif(ctx.c ->> 'item_family', '')      as given_family
    from ctx
  ),
  derived as (
    select
      n.*,
      coalesce(n.given_segment,
        (select cu.price_group from nl.customers cu where cu.customer_no = n.customer_no)) as segment,
      coalesce(n.given_family,
        (select i.family from nl.items i where i.item_no = n.item_no)) as family
    from named n
  )
  select v.kind, v.id, nl.policy_scope_rank(v.kind), v.words
  from derived d
  cross join lateral (values
    ('order_line',
     case when d.document_no is not null and d.line_no is not null
          then d.document_no || ':' || d.line_no end,
     'this order line'),
    ('order', d.document_no, 'this order'),
    ('item', d.item_no, 'this part'),
    ('item_family', d.family, 'the ' || coalesce(d.family, '') || ' family'),
    ('customer', d.customer_no, 'this account'),
    ('customer_segment', d.segment, 'the ' || coalesce(d.segment, '') || ' price group'),
    ('vendor', d.vendor_no, 'this supplier'),
    ('mailbox', d.mailbox_id, 'this mailbox'),
    ('location', d.location_code, 'this location'),
    ('global', '', 'the company default')
  ) as v(kind, id, words)
  where v.id is not null
$$;

/*
 * Every policy row that could answer one of these types for this context, in
 * the order that decides which one wins, numbered from 1.
 *
 * This is the only place the order of resolution is written down:
 *   the most specific scope, then the higher priority, then the newest
 *   effective date, then the row written last.
 * Everything else in the engine reads it from here, which is why a trace can
 * never disagree with the value a quote used.
 *
 * It takes a list of types rather than one, so a screen or an agent that
 * needs eight answers pays for the context once.
 */
create function nl.policy_matches(p_types text[], p_context jsonb)
returns table (
  policy_type    text,
  seat           int,
  policy_id      bigint,
  scope_kind     text,
  scope_id       text,
  scope_words    text,
  rank           int,
  value          jsonb,
  effective_from date,
  effective_to   date,
  priority       int,
  note           text
)
language sql stable
set search_path = ''
as $$
  with c as materialized (
    -- Materialized so the two lookups inside nl.policy_candidates() happen
    -- once per call rather than once per policy row considered.
    select * from nl.policy_candidates(p_context)
  ),
  clock as (
    select coalesce(nullif(p_context ->> 'on_date', '')::date, nl.today()) as on_date
  )
  select
    p.policy_type,
    (row_number() over (
      partition by p.policy_type
      order by c.rank, p.priority desc, p.effective_from desc, p.id desc))::int,
    p.id,
    p.scope_kind,
    p.scope_id,
    c.scope_words,
    c.rank,
    p.value,
    p.effective_from,
    p.effective_to,
    p.priority,
    p.note
  from c
  cross join clock
  -- Lateral rather than a plain join, so the plan is one index probe per
  -- candidate scope (ten at the most) instead of a hash of every row of this
  -- policy type. policies_resolve_idx is exactly this lookup, in this order.
  cross join lateral (
    select pol.id, pol.policy_type, pol.scope_kind, pol.scope_id, pol.value,
           pol.effective_from, pol.effective_to, pol.priority, pol.note
    from nl.policies pol
    where pol.policy_type = any (coalesce(p_types, '{}'::text[]))
      and pol.scope_kind = c.scope_kind
      and pol.scope_id = c.scope_id
      and pol.effective_from <= clock.on_date
      and (pol.effective_to is null or pol.effective_to >= clock.on_date)
  ) p
$$;

/*
 * The answer, built from the matches. Separated from the lookup so that one
 * type and eight types share every word of the explanation, and so this part
 * touches no table except the type itself.
 *
 * `p_matches` is what nl.policy_matches() returned for this type, as a jsonb
 * array in seat order. An empty array means nothing matched, and the type's
 * own default is the answer.
 */
create function nl.policy_answer(p_type text, p_on_date date, p_matches jsonb) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_type  nl.policy_types;
  v_won   jsonb;
  v_words text;
  v_said  text;
  v_beat  jsonb;
  v_from  date;
  v_to    date;
begin
  select * into v_type from nl.policy_types where key = p_type;
  if not found then
    raise exception 'There is no policy type called %.', coalesce(p_type, '(none)')
      using errcode = 'NL404';
  end if;

  v_won := coalesce(p_matches, '[]'::jsonb) -> 0;

  -- Nothing set for this context: the type's own default, said plainly.
  if v_won is null then
    v_words := nl.policy_words(v_type.value_type, v_type.unit, v_type.default_value);
    return jsonb_build_object(
      'type', v_type.key,
      'name', v_type.name,
      'unit', v_type.unit,
      'value', v_type.default_value,
      'value_words', v_words,
      'on_date', p_on_date,
      'source', 'default',
      'policy_id', null,
      'scope_kind', 'default',
      'scope_id', '',
      'scope_words', 'the built-in default',
      'effective_from', null,
      'effective_to', null,
      'priority', null,
      'note', v_type.description,
      'explanation', format('%s, the built-in default, because nothing else is set', v_words),
      'beat', '[]'::jsonb);
  end if;

  v_words := nl.policy_words(v_type.value_type, v_type.unit, v_won -> 'value');
  v_from  := (v_won ->> 'effective_from')::date;
  v_to    := (v_won ->> 'effective_to')::date;

  -- The sentence. A company-wide row reads differently from a scoped one:
  -- nobody said so about the company default, it simply is the default.
  if (v_won ->> 'scope_kind') = 'global' then
    v_said := format('%s, the company-wide setting since %s',
      v_words, to_char(v_from, 'FMDD FMMonth YYYY'));
  else
    v_said := format('%s, because %s has said so since %s',
      v_words, v_won ->> 'scope_words', to_char(v_from, 'FMDD FMMonth YYYY'));
  end if;
  if v_to is not null then
    v_said := v_said || format(' until %s', to_char(v_to, 'FMDD FMMonth YYYY'));
  end if;

  -- What it beat: the rows behind it, each with the reason it lost. Most
  -- answers have nothing behind them, and skipping the query in that case is
  -- worth having when a screen asks for eight policies at once.
  if jsonb_array_length(coalesce(p_matches, '[]'::jsonb)) <= 1 then
    v_beat := '[]'::jsonb;
  else
  select coalesce(jsonb_agg(jsonb_build_object(
           'policy_id', e.value -> 'policy_id',
           'scope_kind', e.value -> 'scope_kind',
           'scope_id', e.value -> 'scope_id',
           'scope_words', e.value -> 'scope_words',
           'value', e.value -> 'value',
           'value_words', nl.policy_words(v_type.value_type, v_type.unit, e.value -> 'value'),
           'reason', case
             when (e.value ->> 'rank')::int > (v_won ->> 'rank')::int then 'a less specific scope'
             when (e.value ->> 'priority')::int < (v_won ->> 'priority')::int then 'a lower priority'
             else 'an older effective date'
           end) order by (e.value ->> 'seat')::int), '[]'::jsonb)
    into v_beat
  from jsonb_array_elements(p_matches) e
  where (e.value ->> 'seat')::int > 1;
  end if;

  return jsonb_build_object(
    'type', v_type.key,
    'name', v_type.name,
    'unit', v_type.unit,
    'value', v_won -> 'value',
    'value_words', v_words,
    'on_date', p_on_date,
    'source', 'policy',
    'policy_id', v_won -> 'policy_id',
    'scope_kind', v_won ->> 'scope_kind',
    'scope_id', v_won ->> 'scope_id',
    'scope_words', v_won ->> 'scope_words',
    'effective_from', v_from,
    'effective_to', v_to,
    'priority', v_won -> 'priority',
    'note', v_won ->> 'note',
    'explanation', v_said,
    'beat', v_beat);
end $$;

/*
 * The value, and why it is the value.
 *
 * The explanation is the point: a quote can say "collect, because this
 * account has said so since 1 March 2026" instead of printing a word nobody
 * can account for.
 *
 * Returns one jsonb object:
 *   type, name, unit, value, value_words, on_date
 *   source           'policy' when a row won, 'default' when nothing matched
 *   policy_id, scope_kind, scope_id, scope_words, effective_from,
 *   effective_to, priority, note
 *   explanation      one sentence
 *   beat             the runners up, each with the reason it lost
 */
create function nl.resolve_policy(p_type text, p_context jsonb) returns jsonb
language sql stable
set search_path = ''
as $$
  select nl.policy_answer(
    p_type,
    coalesce(nullif(p_context ->> 'on_date', '')::date, nl.today()),
    coalesce((
      select jsonb_agg(to_jsonb(m) order by m.seat)
      from nl.policy_matches(array[p_type], p_context) m
      where m.seat <= 4), '[]'::jsonb))
$$;

/*
 * Several policies for one context in one call, keyed by type. A quoting
 * screen needs five or six at once and an agent should not have to ask six
 * times, so the context is worked out once and the policies table is read
 * once for all of them.
 */
create function nl.resolve_policies(p_types text[], p_context jsonb) returns jsonb
language sql stable
set search_path = ''
as $$
  with clock as (
    select coalesce(nullif(p_context ->> 'on_date', '')::date, nl.today()) as on_date
  ),
  matched as (
    select m.policy_type, jsonb_agg(to_jsonb(m) order by m.seat) as matches
    from nl.policy_matches(p_types, p_context) m
    where m.seat <= 4
    group by m.policy_type
  )
  select coalesce(jsonb_object_agg(
           t.key,
           nl.policy_answer(t.key, clock.on_date, coalesce(matched.matches, '[]'::jsonb))
         ), '{}'::jsonb)
  from unnest(coalesce(p_types, '{}'::text[])) as t(key)
  cross join clock
  left join matched on matched.policy_type = t.key
$$;


-- Every candidate for one type and one context, and why each one lost. The
-- built-in default is always the last row, whether it won or not.
create function nl.policy_trace(p_type text, p_context jsonb)
returns table (
  policy_id      bigint,
  scope_kind     text,
  scope_id       text,
  scope_words    text,
  value          jsonb,
  value_words    text,
  effective_from date,
  effective_to   date,
  priority       int,
  note           text,
  is_winner      boolean,
  verdict        text,
  reason         text
)
language plpgsql stable
set search_path = ''
as $$
declare
  v_type         nl.policy_types;
  v_on_date      date;
  v_result       jsonb;
  v_win_id       bigint;
  v_win_rank     int;
  v_win_priority int;
  v_win_words    text;
begin
  select * into v_type from nl.policy_types where key = p_type;
  if not found then
    raise exception 'There is no policy type called %.', coalesce(p_type, '(none)')
      using errcode = 'NL404';
  end if;
  v_on_date := coalesce(nullif(p_context ->> 'on_date', '')::date, nl.today());

  -- The winner is decided by the same function everything else calls, so a
  -- trace can never disagree with the value in use.
  v_result       := nl.resolve_policy(p_type, p_context);
  v_win_id       := (v_result ->> 'policy_id')::bigint;
  v_win_rank     := nl.policy_scope_rank(v_result ->> 'scope_kind');
  v_win_priority := (v_result ->> 'priority')::int;
  v_win_words    := nl.policy_scope_kind_words(v_result ->> 'scope_kind');

  return query
  with cand as (select * from nl.policy_candidates(p_context)),
  judged as (
    select
      p.id, p.scope_kind, p.scope_id,
      coalesce(c.scope_words, nl.policy_scope_kind_words(p.scope_kind)) as scope_words,
      p.value, p.effective_from, p.effective_to, p.priority, p.note, c.rank
    from nl.policies p
    left join cand c on c.scope_kind = p.scope_kind and c.scope_id = p.scope_id
    where p.policy_type = p_type
  )
  select
    j.id,
    j.scope_kind,
    j.scope_id,
    j.scope_words,
    j.value,
    nl.policy_words(v_type.value_type, v_type.unit, j.value),
    j.effective_from,
    j.effective_to,
    j.priority,
    j.note,
    j.id is not distinct from v_win_id,
    case when j.id is not distinct from v_win_id then 'won' else 'lost' end,
    case
      when j.id is not distinct from v_win_id then 'the most specific policy in effect on this date'
      when j.rank is null then
        format('set for %s, not this one', nl.policy_scope_kind_words(j.scope_kind))
      when j.effective_from > v_on_date then
        format('does not start until %s', to_char(j.effective_from, 'FMDD FMMonth YYYY'))
      when j.effective_to is not null and j.effective_to < v_on_date then
        format('expired on %s', to_char(j.effective_to, 'FMDD FMMonth YYYY'))
      when v_win_rank < j.rank then format('%s is more specific', v_win_words)
      when j.priority < v_win_priority then 'a row at the same scope has a higher priority'
      else 'a row at the same scope is newer'
    end
  from judged j
  order by (j.id is not distinct from v_win_id) desc, j.rank nulls last,
           j.priority desc, j.effective_from desc, j.id desc;

  return query
  select
    null::bigint,
    'default'::text,
    ''::text,
    'the built-in default'::text,
    v_type.default_value,
    nl.policy_words(v_type.value_type, v_type.unit, v_type.default_value),
    null::date,
    null::date,
    null::int,
    v_type.description,
    (v_result ->> 'source') = 'default',
    case when (v_result ->> 'source') = 'default' then 'won' else 'lost' end,
    case when (v_result ->> 'source') = 'default'
         then 'nothing is set for this context'
         else 'only used when nothing is set' end;
end $$;

-- ---------------------------------------------------------------------------
-- Short accessors, so a call site reads like the rule it is asking about
-- ---------------------------------------------------------------------------

create function nl.policy_number(p_type text, p_context jsonb) returns numeric
language sql stable
set search_path = ''
as $$ select (nl.resolve_policy(p_type, p_context) ->> 'value')::numeric $$;

create function nl.policy_int(p_type text, p_context jsonb) returns int
language sql stable
set search_path = ''
-- Through numeric on the way, so a value stored as 30.0 still reads as 30.
as $$ select (nl.resolve_policy(p_type, p_context) ->> 'value')::numeric::int $$;

create function nl.policy_text(p_type text, p_context jsonb) returns text
language sql stable
set search_path = ''
as $$ select nl.resolve_policy(p_type, p_context) ->> 'value' $$;

create function nl.policy_bool(p_type text, p_context jsonb) returns boolean
language sql stable
set search_path = ''
as $$ select (nl.resolve_policy(p_type, p_context) ->> 'value')::boolean $$;

-- A value in words without holding the type's row, for a screen listing rows.
create function nl.policy_value_words(p_type text, p_value jsonb) returns text
language sql stable
set search_path = ''
as $$
  select nl.policy_words(t.value_type, t.unit, p_value)
  from nl.policy_types t where t.key = p_type
$$;

-- What a scope id is called, for the editor: the account's name, the price
-- group's label, the part's description, and so on. Falls back to the id.
create function nl.policy_scope_label(p_scope_kind text, p_scope_id text) returns text
language sql stable
set search_path = ''
as $$
  select case p_scope_kind
    when 'global' then 'Everyone'
    when 'customer' then coalesce(
      (select cu.name || ' (' || cu.customer_no || ')' from nl.customers cu
       where cu.customer_no = p_scope_id), p_scope_id)
    when 'customer_segment' then coalesce(
      (select pg.label || ' (' || pg.code || ')' from nl.price_groups pg
       where pg.code = p_scope_id), p_scope_id)
    when 'item' then coalesce(
      (select i.item_no || ' ' || i.description from nl.items i
       where i.item_no = p_scope_id), p_scope_id)
    when 'vendor' then coalesce(
      (select v.name || ' (' || v.vendor_no || ')' from nl.vendors v
       where v.vendor_no = p_scope_id), p_scope_id)
    when 'location' then coalesce(
      (select l.name || ' (' || l.code || ')' from nl.locations l
       where l.code = p_scope_id), p_scope_id)
    else p_scope_id
  end
$$;

-- Is this scope id something that exists? Returns null when it is fine and a
-- sentence when it is not, so a typed customer number cannot quietly become a
-- policy nothing will ever match. The mailbox check is guarded by
-- to_regclass, because the desk's tables arrived in a later migration than
-- this engine may be applied against.
create function nl.policy_scope_problem(p_scope_kind text, p_scope_id text) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if p_scope_kind = 'global' then
    return case when coalesce(p_scope_id, '') = '' then null
                else 'a company-wide policy has no scope' end;
  end if;
  if coalesce(p_scope_id, '') = '' then
    return format('name the %s this is for', replace(p_scope_kind, '_', ' '));
  end if;

  if p_scope_kind = 'customer' then
    select exists (select 1 from nl.customers c where c.customer_no = p_scope_id) into v_ok;
    return case when v_ok then null else format('there is no account %s', p_scope_id) end;
  elsif p_scope_kind = 'customer_segment' then
    select exists (select 1 from nl.price_groups g where g.code = p_scope_id) into v_ok;
    return case when v_ok then null else format('there is no price group %s', p_scope_id) end;
  elsif p_scope_kind = 'item' then
    select exists (select 1 from nl.items i where i.item_no = p_scope_id) into v_ok;
    return case when v_ok then null else format('there is no part %s', p_scope_id) end;
  elsif p_scope_kind = 'item_family' then
    select exists (select 1 from nl.items i where i.family = p_scope_id) into v_ok;
    return case when v_ok then null else format('there is no part family called %s', p_scope_id) end;
  elsif p_scope_kind = 'vendor' then
    select exists (select 1 from nl.vendors v where v.vendor_no = p_scope_id) into v_ok;
    return case when v_ok then null else format('there is no supplier %s', p_scope_id) end;
  elsif p_scope_kind = 'location' then
    select exists (select 1 from nl.locations l where l.code = p_scope_id) into v_ok;
    return case when v_ok then null else format('there is no location %s', p_scope_id) end;
  elsif p_scope_kind = 'mailbox' then
    if to_regclass('nl.mailboxes') is null then return null; end if;
    execute 'select exists (select 1 from nl.mailboxes m where m.id::text = $1)'
      into v_ok using p_scope_id;
    return case when v_ok then null else format('there is no mailbox %s', p_scope_id) end;
  end if;

  -- An order or one of its lines is only in the app while the export that
  -- brought it in is current, so those are taken as typed.
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Who may change what. An admin may change anything that is editable at all;
-- anyone else must hold exactly the role the type names. Kept as a function
-- so the rule is in one place and a test can read it.
create function nl.policy_role_allows(p_edit_role text, p_actor_role text) returns boolean
language sql immutable
set search_path = ''
as $$ select p_actor_role = 'admin' or p_actor_role = p_edit_role $$;

-- Set a policy, or change one that is already there.
create function nl.set_policy(
  p_policy_id           bigint,   -- null to create
  p_policy_type         text,
  p_scope_kind          text,
  p_scope_id            text,
  p_value               jsonb,
  p_effective_from      date,
  p_effective_to        date,
  p_priority            int,
  p_note                text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_type    nl.policy_types;
  v_policy  nl.policies;
  v_problem text;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_policy');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  select * into v_type from nl.policy_types where key = p_policy_type;
  if not found then
    raise exception 'There is no policy type called %.', coalesce(p_policy_type, '(none)')
      using errcode = 'NL404';
  end if;
  if not v_type.editable then
    raise exception '% is not something the app can change yet.', v_type.name
      using errcode = 'NL422';
  end if;
  if not nl.policy_role_allows(v_type.edit_role, v_actor.role) then
    raise exception '%', case when v_type.edit_role = 'admin'
        then format('Changing %s is for admins.', v_type.name)
        else format('Changing %s is for %s and admins.', v_type.name,
                    replace(v_type.edit_role, '_', ' ')) end
      using errcode = 'NL403';
  end if;

  v_problem := nl.policy_scope_problem(p_scope_kind, coalesce(p_scope_id, ''));
  if v_problem is not null then
    raise exception 'That scope does not work: %.', v_problem using errcode = 'NL422';
  end if;

  if p_policy_id is null then
    insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                             effective_to, priority, note, set_by)
    values (p_policy_type, p_scope_kind, coalesce(p_scope_id, ''), p_value,
            coalesce(p_effective_from, nl.today()), p_effective_to,
            coalesce(p_priority, 0), left(coalesce(p_note, ''), 300), v_actor.id)
    returning * into v_policy;
  else
    update nl.policies
       set value          = p_value,
           scope_kind     = p_scope_kind,
           scope_id       = coalesce(p_scope_id, ''),
           effective_from = coalesce(p_effective_from, nl.today()),
           effective_to   = p_effective_to,
           priority       = coalesce(p_priority, 0),
           note           = left(coalesce(p_note, ''), 300),
           set_by         = v_actor.id
     where id = p_policy_id
       and policy_type = p_policy_type
       and updated_at = p_expected_updated_at
    returning * into v_policy;
    if not found then
      if not exists (select 1 from nl.policies where id = p_policy_id) then
        raise exception 'Policy % does not exist.', p_policy_id using errcode = 'NL404';
      end if;
      raise exception 'Policy % changed since it was loaded. Reload it and try again.', p_policy_id
        using errcode = 'NL409';
    end if;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', case when p_policy_id is null then 'set_policy' else 'update_policy' end,
          'policy', v_policy.id::text, p_request_id,
          jsonb_build_object(
            'policy_type', v_policy.policy_type,
            'scope_kind', v_policy.scope_kind,
            'scope_id', v_policy.scope_id,
            'value', v_policy.value,
            'effective_from', v_policy.effective_from,
            'effective_to', v_policy.effective_to,
            'priority', v_policy.priority,
            'note', v_policy.note));

  v_result := jsonb_build_object('policy_id', v_policy.id, 'updated_at', v_policy.updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Stop a policy applying, without losing what it used to say. Nothing is
-- deleted here on purpose: an expired row is how the trace explains a price
-- somebody was quoted last spring.
create function nl.end_policy(
  p_policy_id           bigint,
  p_effective_to        date,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_type   nl.policy_types;
  v_policy nl.policies;
  v_ends   date;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'end_policy');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  select * into v_policy from nl.policies where id = p_policy_id;
  if not found then
    raise exception 'Policy % does not exist.', p_policy_id using errcode = 'NL404';
  end if;
  select * into v_type from nl.policy_types where key = v_policy.policy_type;
  if not v_type.editable or not nl.policy_role_allows(v_type.edit_role, v_actor.role) then
    raise exception '%', case when v_type.edit_role = 'admin'
        then format('Changing %s is for admins.', v_type.name)
        else format('Changing %s is for %s and admins.', v_type.name,
                    replace(v_type.edit_role, '_', ' ')) end
      using errcode = 'NL403';
  end if;

  -- Ending it today means "it applied through today". A window cannot end
  -- before it began, so a policy that has not started yet ends on its start.
  v_ends := greatest(coalesce(p_effective_to, nl.today()), v_policy.effective_from);

  update nl.policies
     set effective_to = v_ends,
         set_by = v_actor.id
   where id = p_policy_id
     and updated_at = p_expected_updated_at
  returning * into v_policy;
  if not found then
    raise exception 'Policy % changed since it was loaded. Reload it and try again.', p_policy_id
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'end_policy', 'policy', v_policy.id::text, p_request_id,
          jsonb_build_object('policy_type', v_policy.policy_type, 'effective_to', v_ends));

  v_result := jsonb_build_object('policy_id', v_policy.id, 'effective_to', v_ends,
                                 'updated_at', v_policy.updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- What the editor lists
-- ---------------------------------------------------------------------------

-- Every policy row with its type, its scope in words, its value in words and
-- whether it is in force today. It names the person who set it, so
-- nl_readonly is not granted it.
create view nl.policy_list with (security_invoker = true) as
select
  p.id,
  p.policy_type,
  t.name as type_name,
  t.group_key,
  t.unit,
  t.value_type,
  p.scope_kind,
  p.scope_id,
  nl.policy_scope_label(p.scope_kind, p.scope_id) as scope_label,
  p.value,
  nl.policy_words(t.value_type, t.unit, p.value) as value_words,
  p.effective_from,
  p.effective_to,
  p.priority,
  p.note,
  p.set_by,
  u.full_name as set_by_name,
  case
    when p.effective_from > nl.today() then 'upcoming'
    when p.effective_to is not null and p.effective_to < nl.today() then 'expired'
    else 'in_force'
  end as status,
  p.updated_at
from nl.policies p
join nl.policy_types t on t.key = p.policy_type
left join nl.users u on u.id = p.set_by;

comment on view nl.policy_list is
  'Policies with their type, scope label, value in words and whether they are in force today (migration 0031).';

-- ---------------------------------------------------------------------------
-- Moved rule 1 of 4: the margin floor
-- ---------------------------------------------------------------------------

-- Was: a literal 0.20 inside nl.min_margin() (migration 0018).
-- Now: the policy commercial.min_margin, resolved with a global context, so
-- every existing caller keeps its answer. It is stable rather than immutable
-- now, because it reads a table.
create or replace function nl.min_margin() returns numeric
language sql stable
set search_path = ''
as $$ select nl.policy_number('commercial.min_margin', '{}'::jsonb) $$;

comment on function nl.min_margin() is
  'The company-wide margin floor. A thin wrapper over the commercial.min_margin policy; use nl.min_margin_for() where the account and the part are known (migration 0031).';

-- The floor for one account and one part, which is the version a quoting
-- screen wants: a family that never goes below a third, or an account with an
-- agreed floor of its own, is exactly what the old function could not say.
create function nl.min_margin_for(p_customer_no text, p_item_no text, p_on_date date)
returns numeric
language sql stable
set search_path = ''
as $$
  select nl.policy_number('commercial.min_margin', jsonb_strip_nulls(jsonb_build_object(
    'customer_no', p_customer_no, 'item_no', p_item_no, 'on_date', p_on_date)))
$$;

-- ---------------------------------------------------------------------------
-- Moved rule 2 of 4: freight terms and the free freight threshold
-- ---------------------------------------------------------------------------

/*
 * Was: free_over on nl.freight_periods (migration 0018), one number per
 * tariff period and the same for everybody, and no field anywhere for who
 * pays the freight at all.
 *
 * Now: the tariff still owns the rate bands and the fuel surcharge, because
 * those are a carrier's numbers and not a policy anybody sets. The threshold
 * and the terms are policies, so an account that ships on its own carrier
 * account says "collect" and an account that negotiated free freight at a
 * thousand says so on its own row, with a note and a date.
 *
 * A date before the freight history is priced at the oldest tariff, exactly
 * as nl.freight_for() has always done, and the same clamped date is what the
 * threshold is resolved on, so old invoices keep their answers.
 */
create function nl.freight_quote(p_customer_no text, p_subtotal numeric, p_on_date date)
returns table (
  freight               numeric,
  base_rate             numeric,
  surcharge_pct         numeric,
  free_over             numeric,
  band_min              numeric,
  terms                 text,
  terms_explanation     text,
  free_over_explanation text
)
language sql stable
set search_path = ''
as $$
  with asked as (
    select
      greatest(coalesce(p_subtotal, 0), 0) as subtotal,
      -- greatest() ignores nulls, so a world with no freight history leaves
      -- the date alone and the period lookup below returns nothing, which is
      -- what the old function did too.
      greatest(coalesce(p_on_date, nl.today()),
               (select min(fp.effective_from) from nl.freight_periods fp)) as on_date
  ),
  -- Materialized on purpose. Without it this CTE is inlined, and because the
  -- select below reads three fields out of each answer, each resolve_policy()
  -- call is made three or four times instead of once: 33 ms a quote rather
  -- than 8. Measured on the small world with a few thousand policy rows.
  resolved as materialized (
    select
      a.*,
      nl.resolve_policy('freight.free_over', ctx.c) as free_over,
      nl.resolve_policy('freight.terms', ctx.c) as terms
    from asked a
    cross join lateral (
      select jsonb_strip_nulls(jsonb_build_object(
        'customer_no', p_customer_no, 'on_date', a.on_date)) as c
    ) ctx
  )
  select
    case when r.subtotal >= threshold.free_over then 0::numeric
         else round(b.rate * (1 + s.percent / 100), 2)
    end,
    b.rate,
    s.percent,
    threshold.free_over,
    b.min_subtotal,
    r.terms ->> 'value',
    r.terms ->> 'explanation',
    threshold.said
  from resolved r
  -- The tariff period in force, for its rate bands and for the threshold it
  -- came with before this engine existed.
  cross join lateral (
    select fp.effective_from, fp.free_over
    from nl.freight_periods fp
    where fp.effective_from <= r.on_date
    order by fp.effective_from desc
    limit 1
  ) p
  -- A policy wins when there is one. When there is not, the tariff period is
  -- the answer, which is what this was before 0031, so a database with no
  -- policy rows in it at all behaves exactly as it used to.
  cross join lateral (
    select
      case when (r.free_over ->> 'source') = 'policy'
           then (r.free_over ->> 'value')::numeric
           else p.free_over
      end as free_over,
      case when (r.free_over ->> 'source') = 'policy'
           then r.free_over ->> 'explanation'
           else format('$%s, the freight tariff in force since %s',
                       nl.policy_number_words(p.free_over),
                       to_char(p.effective_from, 'FMDD FMMonth YYYY'))
      end as said
  ) threshold
  cross join lateral (
    select fr.min_subtotal, fr.rate
    from nl.freight_rates fr
    where fr.effective_from = p.effective_from
      and fr.min_subtotal <= r.subtotal
    order by fr.min_subtotal desc
    limit 1
  ) b
  cross join lateral (
    select coalesce((
      select fs.percent
      from nl.fuel_surcharge fs
      where fs.month <= date_trunc('month', r.on_date)::date
      order by fs.month desc
      limit 1), 0) as percent
  ) s
$$;

-- The old signature, unchanged, as a thin wrapper with no account in the
-- context. Every caller in the app still gets the company-wide answer.
create or replace function nl.freight_for(p_subtotal numeric, p_on_date date)
returns table (
  freight       numeric,
  base_rate     numeric,
  surcharge_pct numeric,
  free_over     numeric,
  band_min      numeric
)
language sql stable
set search_path = ''
as $$
  select q.freight, q.base_rate, q.surcharge_pct, q.free_over, q.band_min
  from nl.freight_quote(null, p_subtotal, p_on_date) q
$$;

comment on function nl.freight_for(numeric, date) is
  'Freight for a shipment of this size on this date, company-wide. A thin wrapper over nl.freight_quote(); pass the account to that one to get its own terms and threshold (migration 0031).';

-- ---------------------------------------------------------------------------
-- Moved rule 3 of 4: how long a quote holds
-- ---------------------------------------------------------------------------

-- Was: v_today + 30 inside nl.approve_rfq_draft() (migration 0011), and the
-- same 30 written again in two TypeScript files.
create function nl.quote_valid_days(p_customer_no text) returns int
language sql stable
set search_path = ''
as $$
  select nl.policy_int('commercial.quote_valid_days',
    jsonb_strip_nulls(jsonb_build_object('customer_no', p_customer_no)))
$$;

-- ---------------------------------------------------------------------------
-- Moved rule 4 of 4: allocation priority
-- ---------------------------------------------------------------------------

-- Was: nothing. nl.open_line_allocation (migration 0010) gives stock to the
-- oldest ship date first, per part, which is fair and is not what a parts
-- business does when a line down at a fleet customer is waiting.
create function nl.allocation_priority(p_customer_no text) returns int
language sql stable
set search_path = ''
as $$
  select nl.policy_int('fulfilment.allocation_priority',
    jsonb_strip_nulls(jsonb_build_object('customer_no', p_customer_no)))
$$;

/*
 * The same allocation as nl.open_line_allocation, with the priority list
 * applied first: higher priority takes stock before an earlier ship date.
 * Everything else is identical, column for column, so a screen can read this
 * one instead and nothing else changes.
 *
 * The priority is resolved once per account with an open line, not once per
 * line, and it carries the explanation with it, so the page can say why one
 * order went first.
 *
 * nl.open_line_allocation is left exactly as it was. Nine other places read
 * it, including the stored allocation each export snapshot keeps, and moving
 * them all is somebody else's migration, not a side effect of this one.
 */
create view nl.allocation_plan with (security_invoker = true) as
with params as materialized (
  select nl.today() as today, nl.at_risk_days() as horizon
),
ranked as (
  select
    a.customer_no,
    (r.answer ->> 'value')::numeric::int as priority_rank,
    r.answer ->> 'explanation' as priority_reason
  from (select distinct l.customer_no from nl.open_order_lines l) a
  cross join lateral (
    select nl.resolve_policy('fulfilment.allocation_priority',
      jsonb_build_object('customer_no', a.customer_no)) as answer
  ) r
),
claimed as (
  select
    l.*,
    k.priority_rank,
    k.priority_reason,
    coalesce(sum(l.quantity) over (
      partition by l.item_no
      order by k.priority_rank desc, l.ship_date, l.document_no, l.line_no
      rows between unbounded preceding and 1 preceding
    ), 0)::int as claimed_before
  from nl.open_order_lines l
  join ranked k on k.customer_no = l.customer_no
),
allocated as (
  select
    c.*,
    coalesce(s.on_hand, 0) as on_hand,
    least(c.quantity, greatest(coalesce(s.on_hand, 0) - c.claimed_before, 0)) as allocated,
    p.today,
    p.horizon
  from claimed c
  cross join params p
  left join nl.stock s on s.item_no = c.item_no
)
select
  a.document_no,
  a.line_no,
  a.customer_no,
  a.item_no,
  a.description,
  a.ship_date,
  a.quantity,
  a.unit_price,
  round(a.quantity * a.unit_price, 2) as open_value,
  a.first_seen_on,
  a.last_snapshot_id,
  a.on_hand,
  a.claimed_before,
  a.allocated,
  a.quantity - a.allocated as short,
  case
    when a.ship_date < a.today then 'past_due'
    when a.ship_date <= a.today + a.horizon and a.allocated < a.quantity then 'at_risk'
    when a.ship_date <= a.today + a.horizon then 'on_pace'
    else 'later'
  end as bucket,
  a.priority_rank,
  a.priority_reason
from allocated a;

comment on view nl.allocation_plan is
  'Open lines with stock allocated by the fulfilment.allocation_priority policy first and ship date second (migration 0031).';

-- What the priority list actually changes: only the lines that got a
-- different quantity than ship-date order would have given them. This is the
-- screen for the policy, and it is empty when nobody has a priority.
create view nl.allocation_priority_effect with (security_invoker = true) as
select
  p.item_no,
  p.description,
  p.document_no,
  p.line_no,
  p.customer_no,
  p.ship_date,
  p.quantity,
  p.on_hand,
  p.priority_rank,
  p.priority_reason,
  o.allocated as allocated_by_date,
  p.allocated as allocated_by_priority,
  p.allocated - o.allocated as change,
  o.bucket as bucket_by_date,
  p.bucket as bucket_by_priority
from nl.allocation_plan p
join nl.open_line_allocation o
  on o.document_no = p.document_no and o.line_no = p.line_no
where p.allocated <> o.allocated;

comment on view nl.allocation_priority_effect is
  'The lines the allocation priority policy moves, against plain ship-date order (migration 0031).';

-- ---------------------------------------------------------------------------
-- What a policy would have done: backtesting the margin floor
-- ---------------------------------------------------------------------------

/*
 * The question somebody always asks before they change a number: what would
 * this have done to us? The margin floor is the one where the answer is
 * already in the ledger, because every invoice line carries the cost that
 * applied on the day it was posted (migration 0018), so the margin on every
 * line ever sold is a fact rather than a model.
 *
 * For a proposed floor and a window, one row per account:
 *   what was sold, what it made, and how much of it was priced under that
 *   floor; what those lines would have billed at the floor instead, and what
 *   that would have added.
 *
 * Two bounds, and they are deliberately both reported, because the truth is
 * between them and nobody knows where:
 *   margin_gained    every under-floor line repriced, every customer still buys
 *   revenue_below    every under-floor line refused, every one of them walks
 *
 * What it leaves out, on purpose:
 *   credit memos and price corrections (quantity or amount at or below zero),
 *   because a return is not a pricing decision;
 *   freight, which sits on the invoice header and never on a line;
 *   and whether the customer would actually have paid the higher price, which
 *   is not in any table here and is the whole of the risk.
 */
create function nl.margin_floor_backtest(p_floor numeric, p_from date, p_to date)
returns table (
  customer_no    text,
  customer_name  text,
  lines          int,
  units          int,
  revenue        numeric,
  cost_of_goods  numeric,
  margin         numeric,
  margin_pct     numeric,
  lines_below    int,
  revenue_below  numeric,
  margin_below   numeric,
  floor_revenue  numeric,
  margin_gained  numeric,
  worst_margin_pct numeric
)
language sql stable
set search_path = ''
as $$
  with window_lines as (
    select
      il.customer_no,
      il.quantity,
      il.amount,
      il.unit_price,
      il.unit_cost,
      il.quantity * il.unit_cost as line_cost,
      -- The lowest price that clears the proposed floor, the same arithmetic
      -- nl.price_for() uses: cost / (1 - floor).
      round(il.unit_cost / (1 - p_floor), 2) as floor_price
    from nl.invoice_lines il
    where il.posted_on >= p_from
      and il.posted_on <= p_to
      and il.quantity > 0
      and il.amount > 0
  ),
  judged as (
    select
      w.*,
      w.unit_price < w.floor_price as below,
      -- What the line would have billed if it had been held to the floor.
      w.quantity * greatest(w.unit_price, w.floor_price) as at_floor,
      case when w.amount <> 0 then round((w.amount - w.line_cost) / w.amount, 4) end as line_margin_pct
    from window_lines w
  )
  select
    j.customer_no,
    c.name,
    count(*)::int,
    sum(j.quantity)::int,
    sum(j.amount),
    sum(j.line_cost),
    sum(j.amount) - sum(j.line_cost),
    case when sum(j.amount) <> 0
         then round((sum(j.amount) - sum(j.line_cost)) / sum(j.amount), 4) end,
    count(*) filter (where j.below)::int,
    coalesce(sum(j.amount) filter (where j.below), 0),
    coalesce(sum(j.amount - j.line_cost) filter (where j.below), 0),
    coalesce(sum(j.at_floor) filter (where j.below), 0),
    coalesce(sum(j.at_floor - j.amount) filter (where j.below), 0),
    min(j.line_margin_pct)
  from judged j
  join nl.customers c on c.customer_no = j.customer_no
  group by j.customer_no, c.name
$$;

comment on function nl.margin_floor_backtest(numeric, date, date) is
  'What a proposed margin floor would have done to a window of the ledger, per account: what was under it, and what holding to it would have added (migration 0031).';

-- ---------------------------------------------------------------------------
-- The data dictionary
-- ---------------------------------------------------------------------------

create table nl.data_dictionary (
  -- Schema-qualified, because nl.describe_data() looks the relation up.
  entity     text not null check (entity ~ '^nl\.[a-z][a-z0-9_]*$'),
  field      text not null check (field ~ '^[a-z][a-z0-9_]*$'),
  label      text not null,
  -- One sentence. Not a type, not a restatement of the name.
  meaning    text not null check (length(meaning) between 10 and 400),
  unit       text not null default '',
  source     text not null check (source in ('erp export', 'app', 'derived', 'policy engine')),
  -- How it is worked out, in words, where it is derived.
  derivation text not null default '',
  example    text not null default '',
  -- May an agent put this in something that leaves the building? This is the
  -- same question app/src/lib/server/desk/policy.ts asks about a fact it is
  -- about to cite, asked one level down, about the field itself.
  shareable  boolean not null default false,
  primary key (entity, field)
);

comment on table nl.data_dictionary is
  'Every field a person or an agent reads: what it means, its unit, where it comes from, and whether it may leave the building (migration 0031).';

create index data_dictionary_entity_idx on nl.data_dictionary (entity);

-- The dictionary as structured data, for the assistant, the MCP server and
-- the /dictionary page. Fields come back in the order the columns are in,
-- which is the order somebody reading the table would see them.
create function nl.describe_data(p_entity text default null)
returns table (
  entity     text,
  field      text,
  label      text,
  meaning    text,
  unit       text,
  source     text,
  derivation text,
  example    text,
  shareable  boolean,
  ordinal    int
)
language sql stable
set search_path = ''
as $$
  select
    d.entity, d.field, d.label, d.meaning, d.unit, d.source, d.derivation, d.example, d.shareable,
    coalesce(a.attnum, 999)::int as ordinal
  from nl.data_dictionary d
  left join pg_catalog.pg_attribute a
    on a.attrelid = pg_catalog.to_regclass(d.entity)
   and a.attname = d.field
   and a.attnum > 0
   and not a.attisdropped
  where p_entity is null
     or d.entity = p_entity
     or d.entity = 'nl.' || p_entity
  order by d.entity, ordinal, d.field
$$;

comment on function nl.describe_data(text) is
  'The data dictionary as rows: every documented field of every documented table, in column order (migration 0031).';

/*
 * Where the dictionary and the schema disagree. Three ways they can:
 *   entity missing         the dictionary describes a table that is gone
 *   column not documented  a column exists and nobody wrote it down
 *   field is not a column  the dictionary describes something that was
 *                          renamed or removed
 *
 * The tests require this to be empty, which is the point: a column added
 * next month fails a test instead of quietly becoming a number nobody can
 * explain. Only tables the dictionary already claims are checked, so nothing
 * forces a new feature to document itself before it is ready.
 */
create view nl.data_dictionary_gaps with (security_invoker = true) as
with claimed as (
  select distinct d.entity from nl.data_dictionary d
),
present as (
  select c.entity, pg_catalog.to_regclass(c.entity) as oid from claimed c
),
columns as (
  select p.entity, a.attname as field
  from present p
  join pg_catalog.pg_attribute a
    on a.attrelid = p.oid and a.attnum > 0 and not a.attisdropped
)
select p.entity, ''::text as field, 'entity missing'::text as problem
from present p where p.oid is null
union all
select c.entity, c.field, 'column not documented'
from columns c
where not exists (
  select 1 from nl.data_dictionary d where d.entity = c.entity and d.field = c.field)
union all
select d.entity, d.field, 'field is not a column'
from nl.data_dictionary d
join present p on p.entity = d.entity and p.oid is not null
where not exists (
  select 1 from columns c where c.entity = d.entity and c.field = d.field);

comment on view nl.data_dictionary_gaps is
  'Columns nobody documented, and documented fields that are not columns any more. The tests require it to be empty (migration 0031).';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.policy_types enable row level security;
alter table nl.policies enable row level security;
alter table nl.data_dictionary enable row level security;

-- The catalog, the dictionary and the policies are about how the business
-- works, not about people, so the read-only role the assistant and the MCP
-- server use may read them as well.
create policy policy_types_read on nl.policy_types for select to nl_app, nl_readonly using (true);
create policy data_dictionary_read on nl.data_dictionary for select to nl_app, nl_readonly using (true);
create policy policies_read on nl.policies for select to nl_app, nl_readonly using (true);

-- Writes go through nl.set_policy() and nl.end_policy(), which check the
-- type's own role rule. The policies here are deliberately not a second,
-- different rule: row-level security says a write must be in the writer's
-- own name, and the function says whether this person may write at all.
create policy policies_insert on nl.policies for insert to nl_app
  with check (set_by = (select nl.current_user_id()));
create policy policies_update on nl.policies for update to nl_app
  using (true)
  with check (set_by = (select nl.current_user_id()));

grant select on nl.policy_types, nl.data_dictionary to nl_app, nl_readonly;
-- Everything except set_by, which names a person.
grant select (id, policy_type, scope_kind, scope_id, value, effective_from, effective_to,
              priority, note, created_at, updated_at) on nl.policies to nl_readonly;

grant select, insert on nl.policies to nl_app;
grant update (policy_type, scope_kind, scope_id, value, effective_from, effective_to,
              priority, note, set_by, updated_at) on nl.policies to nl_app;

grant select on nl.policy_list to nl_app;
grant select on nl.allocation_plan, nl.allocation_priority_effect to nl_app;
grant select on nl.allocation_priority_effect to nl_readonly;
grant select on nl.data_dictionary_gaps to nl_app, nl_readonly;

grant execute on function
  nl.policy_scope_kinds(),
  nl.policy_scope_rank(text),
  nl.policy_scope_kind_words(text),
  nl.policy_shape_problem(text, text[], numeric, numeric, jsonb, jsonb),
  nl.policy_words(text, text, jsonb),
  nl.policy_number_words(numeric),
  nl.policy_candidates(jsonb),
  nl.policy_matches(text[], jsonb),
  nl.policy_answer(text, date, jsonb),
  nl.resolve_policy(text, jsonb),
  nl.resolve_policies(text[], jsonb),
  nl.policy_trace(text, jsonb),
  nl.policy_number(text, jsonb),
  nl.policy_int(text, jsonb),
  nl.policy_text(text, jsonb),
  nl.policy_bool(text, jsonb),
  nl.policy_value_words(text, jsonb),
  nl.policy_scope_label(text, text),
  nl.min_margin_for(text, text, date),
  nl.freight_quote(text, numeric, date),
  nl.quote_valid_days(text),
  nl.allocation_priority(text),
  nl.margin_floor_backtest(numeric, date, date),
  nl.describe_data(text)
to nl_app, nl_readonly;

grant execute on function
  nl.policy_scope_problem(text, text),
  nl.policy_role_allows(text, text),
  nl.set_policy(bigint, text, text, text, jsonb, date, date, int, text, timestamptz, text),
  nl.end_policy(bigint, date, timestamptz, text)
to nl_app;

-- ---------------------------------------------------------------------------
-- Moved rule 3 of 4, the call site: the RFQ approval path
-- ---------------------------------------------------------------------------

/*
 * The same function as migration 0011, with one line changed: the quote now
 * holds for nl.quote_valid_days(the account) instead of a pasted 30, and the
 * audit row records how many days it was and why. Everything else, including
 * every check and every message, is 0011 word for word.
 *
 * The whole body is repeated because that is how Postgres replaces a
 * function: there is no patch, only a new definition. Diff it against 0011
 * before changing anything here.
 */
create or replace function nl.approve_rfq_draft(
  p_draft_id            bigint,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay        jsonb;
  v_actor         nl.users;
  v_draft         nl.rfq_drafts;
  v_validation    jsonb;
  v_customer      nl.customers;
  v_discount      numeric;
  v_contact_id    bigint;
  v_needed_by     date;
  v_today         date := nl.today();
  v_line          jsonb;
  v_item          nl.items;
  v_qty           int;
  v_price         numeric(12, 2);
  v_shown         numeric(12, 2);
  v_total         numeric(12, 2) := 0;
  v_items         text[] := '{}';
  v_qtys          int[] := '{}';
  v_prices        numeric(12, 2)[] := '{}';
  v_quote_id      bigint;
  v_commitment_id bigint;
  v_valid_days    int;
  v_valid_why     jsonb;
  v_at            timestamptz;
  v_result        jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'approve_rfq_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  -- Lock the draft row so two approvals cannot interleave.
  select * into v_draft from nl.rfq_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft R-% does not exist.', p_draft_id using errcode = 'NL404';
  end if;
  -- The select policy already limits this to the creator or an admin; the
  -- check here makes the rule explicit.
  if v_draft.created_by <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the person who made draft R-% or an admin can approve it.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'Draft R-% is already %; it cannot be approved.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;
  if v_draft.updated_at <> p_expected_updated_at then
    raise exception 'Draft R-% changed since it was loaded. Reload it and decide again.', p_draft_id
      using errcode = 'NL409';
  end if;

  v_validation := v_draft.validation;

  -- Field rule: nothing may still need a person. Checked on the counter and
  -- on every status in the stored validation.
  if v_draft.needs_review > 0
     or coalesce((v_validation ->> 'needs_review')::int, 1) > 0
     or jsonb_path_exists(v_validation, 'lax $.** ? (@.status == "needs_review")') then
    raise exception 'Draft R-% still has fields that need review.', p_draft_id using errcode = 'NL422';
  end if;

  -- The customer: must exist, be open, and not be blocked.
  select * into v_customer from nl.customers where customer_no = v_validation #>> '{customer,customer_no}';
  if not found then
    raise exception 'Draft R-% has no customer.', p_draft_id using errcode = 'NL422';
  end if;
  if v_customer.blocked or v_customer.closed then
    raise exception 'Customer % is blocked or closed.', v_customer.customer_no using errcode = 'NL422';
  end if;
  select discount into v_discount from nl.price_groups where code = v_customer.price_group;

  -- The buyer, only if the contact really belongs to this customer.
  select id into v_contact_id
  from nl.contacts
  where id = (v_validation #>> '{customer,contact_id}')::bigint
    and customer_no = v_customer.customer_no;

  v_needed_by := (v_validation #>> '{needed_by,date}')::date;
  if v_needed_by is not null and v_needed_by < v_today then
    raise exception 'The needed-by date % has passed.', v_needed_by using errcode = 'NL422';
  end if;

  -- First pass: check every line against the catalog and price it. Nothing
  -- is written until every line has passed.
  for v_line in
    select value from jsonb_array_elements(coalesce(v_validation -> 'lines', '[]'::jsonb))
  loop
    -- A line a person removed is not quoted.
    continue when coalesce((v_line ->> 'removed')::boolean, false);

    select * into v_item from nl.items where item_no = v_line ->> 'item_no';
    if not found then
      raise exception 'Item % is not in the catalog.', coalesce(v_line ->> 'item_no', '(none)')
        using errcode = 'NL422';
    end if;
    if v_item.blocked then
      raise exception 'Item % is blocked.', v_item.item_no using errcode = 'NL422';
    end if;

    v_qty := (v_line ->> 'quantity')::int;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Item % needs a quantity above zero.', v_item.item_no using errcode = 'NL422';
    end if;

    -- Today's price for this customer, and the price the person was shown.
    v_price := round(v_item.list_price * (1 - coalesce(v_discount, 0)), 2);
    v_shown := (v_line ->> 'unit_price')::numeric;
    if v_shown is distinct from v_price then
      raise exception 'The price of % changed from % to % since the draft was checked. Reload it and decide again.',
        v_item.item_no, v_shown, v_price
        using errcode = 'NL409';
    end if;

    v_items  := v_items || v_item.item_no;
    v_qtys   := v_qtys || v_qty;
    v_prices := v_prices || v_price;
    v_total  := v_total + v_qty * v_price;
  end loop;

  if cardinality(v_items) = 0 then
    raise exception 'Draft R-% has no lines to quote.', p_draft_id using errcode = 'NL422';
  end if;
  if v_total <= 0 then
    raise exception 'The quote for draft R-% totals nothing.', p_draft_id using errcode = 'NL422';
  end if;

  -- How long the quote holds, and why. This was 30, pasted here; it is now
  -- the commercial.quote_valid_days policy, which an account can change.
  v_valid_why  := nl.resolve_policy('commercial.quote_valid_days',
                    jsonb_build_object('customer_no', v_customer.customer_no));
  v_valid_days := (v_valid_why ->> 'value')::numeric::int;

  -- Second pass: write. The commitment comes first so the quote can be
  -- created already linked to it.
  insert into nl.commitments (title, customer_no, buyer_contact_id, owner_id, committed_value,
                              starts_on, ends_on, confidence, notes, created_by)
  values (
    format('Emailed request R-%s', p_draft_id),
    v_customer.customer_no,
    v_contact_id,
    v_actor.id,
    v_total,
    v_today,
    coalesce(v_needed_by, v_today + 90),
    50,
    format('Created from emailed request R-%s.', p_draft_id),
    v_actor.id)
  returning id into v_commitment_id;

  insert into nl.quotes (customer_no, contact_id, commitment_id, quoted_on, valid_until, source, created_by)
  values (v_customer.customer_no, v_contact_id, v_commitment_id, v_today, v_today + v_valid_days,
          'rfq', v_actor.id)
  returning id into v_quote_id;

  insert into nl.quote_lines (quote_id, line_no, item_no, quantity, unit_price)
  select v_quote_id, l.line_no, l.item_no, l.quantity, l.unit_price
  from unnest(v_items, v_qtys, v_prices) with ordinality as l(item_no, quantity, unit_price, line_no);

  -- One scope row per part, with the total quantity asked for.
  insert into nl.commitment_items (commitment_id, item_no, quantity)
  select v_commitment_id, l.item_no, sum(l.quantity)
  from unnest(v_items, v_qtys) as l(item_no, quantity)
  group by l.item_no;

  update nl.rfq_drafts
     set status        = 'approved',
         decided_by    = v_actor.id,
         decided_at    = now(),
         quote_id      = v_quote_id,
         commitment_id = v_commitment_id
   where id = p_draft_id
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'approve_rfq_draft', 'rfq_draft', p_draft_id::text, p_request_id,
          jsonb_build_object(
            'quote_id', v_quote_id,
            'commitment_id', v_commitment_id,
            'customer_no', v_customer.customer_no,
            'lines', cardinality(v_items),
            'total', v_total,
            'needed_by', v_needed_by,
            'valid_days', v_valid_days,
            'valid_days_why', v_valid_why ->> 'explanation'));

  v_result := jsonb_build_object(
    'draft_id', p_draft_id,
    'status', 'approved',
    'quote_id', v_quote_id,
    'commitment_id', v_commitment_id,
    'total', v_total,
    'valid_days', v_valid_days,
    'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- The catalog: which policies exist, and what every field means
-- ---------------------------------------------------------------------------

/*
 * Both catalogs are loaded by a function rather than written as plain inserts
 * for one reason: nl.reset() truncates every table in schema nl, and the
 * nightly job calls it. Reference data written once by a migration would be
 * gone the next morning. So the rows live here, in the migration that owns
 * the schema, and db/seed.d/90_policies.sql calls the same loader after each
 * rebuild before adding the invented exceptions on top.
 *
 * Both are idempotent: run them again and the text is brought up to date
 * without touching anything a person set.
 */
create function nl.load_policy_types() returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  insert into nl.policy_types as t (
    key, group_key, name, description, value_type, allowed, min_value, max_value,
    value_schema, unit, scopes, default_value, read_by, editable, edit_role)
  values
  -- Freight ------------------------------------------------------------------
  ('freight.terms', 'freight', 'Who pays the freight',
   'Whether freight is prepaid by us, prepaid and added to the invoice, collected by the carrier from the customer, or billed to a third party account.',
   'enum', array['prepaid', 'prepaid and add', 'collect', 'third party']::text[],
   null::numeric, null::numeric, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'order']::text[],
   '"prepaid and add"'::jsonb,
   'nl.freight_quote(), and the freight terms a quote states', true, 'operations'),

  ('freight.free_over', 'freight', 'Free freight above',
   'The order subtotal at or above which a shipment travels at no freight charge. With nothing set, the freight tariff period in force supplies it.',
   'number', array[]::text[], 0, 100000, '{}'::jsonb, 'USD',
   array['global', 'customer_segment', 'customer']::text[],
   '2000'::jsonb,
   'nl.freight_quote() and nl.freight_for(), so every freight figure in the app', true, 'operations'),

  ('freight.carrier', 'freight', 'Preferred carrier',
   'Which kind of carrier a shipment should go on when nobody says otherwise.',
   'enum', array['least cost', 'national ltl', 'regional ltl', 'parcel', 'customer pickup']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'location']::text[],
   '"least cost"'::jsonb,
   '', true, 'operations'),

  ('freight.service_level', 'freight', 'Service level',
   'The transit service a shipment goes out on: ordinary ground, expedited, or a guaranteed delivery day.',
   'enum', array['standard', 'expedite', 'guaranteed']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'order']::text[],
   '"standard"'::jsonb,
   '', true, 'operations'),

  ('freight.accessorials', 'freight', 'Freight extras to assume',
   'The carrier extras a shipment to this account or location normally needs, so a freight quote includes them from the start.',
   'text_list',
   array['liftgate', 'inside delivery', 'appointment', 'residential', 'limited access']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'location']::text[],
   '[]'::jsonb,
   '', true, 'operations'),

  -- Commercial ---------------------------------------------------------------
  ('commercial.payment_terms', 'commercial', 'Payment terms',
   'When an invoice falls due, and any discount for paying early.',
   'enum', array['net 30', 'net 45', 'net 60', '2 percent 10 net 30', 'prepaid', 'credit card']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer']::text[],
   '"net 30"'::jsonb,
   '', true, 'admin'),

  ('commercial.quote_valid_days', 'commercial', 'How long a quote holds',
   'The number of days a quote stays good for, counted from the day it was made.',
   'integer', array[]::text[], 1, 365, '{}'::jsonb, 'days',
   array['global', 'customer_segment', 'customer']::text[],
   '30'::jsonb,
   'nl.approve_rfq_draft(), through nl.quote_valid_days()', true, 'account_manager'),

  ('commercial.min_margin', 'commercial', 'Margin floor',
   'The gross margin a price has to clear before the app says it is below the floor. It is a flag, never a block.',
   'number', array[]::text[], 0, 0.9, '{}'::jsonb, 'ratio',
   array['global', 'customer_segment', 'customer', 'item', 'item_family']::text[],
   '0.20'::jsonb,
   'nl.min_margin(), and nl.price_for() through it, so every price on every screen', true, 'admin'),

  ('commercial.stack_quantity_break', 'commercial', 'Quantity breaks stack on an agreement',
   'Whether a quantity break may come off a price that is already an agreed price, or only off the tier price.',
   'boolean', array[]::text[], null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer']::text[],
   'false'::jsonb,
   '', true, 'admin'),

  ('commercial.rounding', 'commercial', 'Price rounding',
   'What a worked-out price is rounded to before it is shown or quoted.',
   'enum', array['cent', 'nickel', 'dime', 'dollar', 'none']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer']::text[],
   '"cent"'::jsonb,
   '', true, 'admin'),

  -- Fulfilment ---------------------------------------------------------------
  ('fulfilment.allocation_priority', 'fulfilment', 'Allocation priority',
   'Who gets stock first when there is not enough to go round. Higher goes first; zero means the ship date decides, which is the usual way.',
   'integer', array[]::text[], 0, 100, '{}'::jsonb, 'rank',
   array['global', 'customer_segment', 'customer', 'order']::text[],
   '0'::jsonb,
   'nl.allocation_plan and nl.allocation_priority_effect', true, 'operations'),

  ('fulfilment.split_shipments', 'fulfilment', 'Split shipments allowed',
   'Whether part of an order may ship as soon as it is ready, leaving the rest to follow.',
   'boolean', array[]::text[], null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'order']::text[],
   'true'::jsonb,
   '', true, 'operations'),

  ('fulfilment.backorder', 'fulfilment', 'What happens to what is short',
   'Whether a quantity we cannot ship stays on order, is cancelled, or holds the whole order until everything is there.',
   'enum', array['backorder', 'cancel remainder', 'hold whole order']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer']::text[],
   '"backorder"'::jsonb,
   '', true, 'operations'),

  ('fulfilment.min_order_value', 'fulfilment', 'Smallest order we take',
   'The order value below which the order desk asks the customer to add to the order or pay a handling charge.',
   'number', array[]::text[], 0, 100000, '{}'::jsonb, 'USD',
   array['global', 'customer_segment', 'customer']::text[],
   '250'::jsonb,
   '', true, 'operations'),

  ('fulfilment.order_multiple', 'fulfilment', 'Order multiple',
   'The number of pieces a part is sold in, so a quantity is rounded up to a whole box or bundle.',
   'integer', array[]::text[], 1, 10000, '{}'::jsonb, 'pieces',
   array['global', 'item', 'item_family']::text[],
   '1'::jsonb,
   '', true, 'operations'),

  ('fulfilment.expedite_rule', 'fulfilment', 'Expedited shipping',
   'Whether an order or one line of it may be moved up the queue, and whether that needs somebody to approve it.',
   'enum', array['never', 'with approval', 'always allowed']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'order', 'order_line']::text[],
   '"with approval"'::jsonb,
   '', true, 'operations'),

  -- Quality ------------------------------------------------------------------
  ('quality.required_documents', 'quality', 'Documents that ship with the order',
   'The paperwork a shipment of this part or to this account has to carry, from a packing list to a material test report.',
   'text_list',
   array['packing list', 'certificate of conformance', 'material test report',
         'domestic melt', 'first article report']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer_segment', 'customer', 'item', 'item_family']::text[],
   '["packing list"]'::jsonb,
   '', true, 'operations'),

  ('quality.inspection_level', 'quality', 'Inspection level',
   'How much of a batch is inspected before it ships, from a sample now and then to every piece.',
   'enum', array['skip lot', 'normal', 'tightened', '100 percent']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'customer', 'item', 'item_family']::text[],
   '"normal"'::jsonb,
   '', true, 'operations'),

  -- Operations ---------------------------------------------------------------
  ('operations.at_risk_days', 'operations', 'How far ahead due soon looks',
   'The number of days ahead an open line counts as due soon, which is what puts it in the at risk or on pace bucket.',
   'integer', array[]::text[], 1, 120, '{}'::jsonb, 'days',
   array['global', 'location', 'item_family']::text[],
   '14'::jsonb,
   'nothing yet: nl.at_risk_days() still has 14 written in', false, 'operations'),

  ('operations.overdue_supply_days', 'operations', 'How late supply is assumed to land',
   'A purchase or production order whose due date has passed is treated as arriving this many days from today rather than on its due date.',
   'integer', array[]::text[], 0, 60, '{}'::jsonb, 'days',
   array['global', 'vendor', 'item']::text[],
   '3'::jsonb,
   'nothing yet: nl.overdue_supply_days() still has 3 written in', false, 'operations'),

  ('operations.target_days_of_cover', 'operations', 'Target days of cover',
   'How many days of demand the shelf should hold for a part before more is ordered.',
   'integer', array[]::text[], 0, 365, '{}'::jsonb, 'days',
   array['global', 'item', 'item_family', 'location']::text[],
   '30'::jsonb,
   '', true, 'operations'),

  ('operations.partial_export_hold_ratio', 'operations', 'Hold an export smaller than this share',
   'An ERP export with fewer lines than this share of the one already loaded is held for a person instead of applied.',
   'number', array[]::text[], 0, 1, '{}'::jsonb, 'ratio',
   array['global']::text[],
   '0.40'::jsonb,
   'nothing yet: nl.partial_export_ratio() still has 0.40 written in', false, 'operations'),

  ('operations.kept_ratio', 'operations', 'Delivered enough to count as kept',
   'The share of a commitment that has to be delivered before it counts as kept rather than short.',
   'number', array[]::text[], 0.5, 1, '{}'::jsonb, 'ratio',
   array['global', 'customer_segment', 'customer']::text[],
   '0.95'::jsonb,
   'nothing yet: nl.kept_ratio() still has 0.95 written in', false, 'admin'),

  ('operations.default_lead_days', 'operations', 'Lead time when nobody says',
   'What to assume it takes to get a part when neither the item card nor its vendor names a lead time, by how the part is replenished.',
   'object', array[]::text[], null, null,
   '{"purchase": "number", "assembly": "number", "other": "number"}'::jsonb, 'days',
   array['global', 'vendor']::text[],
   '{"purchase": 28, "assembly": 7, "other": 14}'::jsonb,
   'nothing yet: nl.default_lead_days() still has these written in', false, 'operations'),

  -- Agents -------------------------------------------------------------------
  ('agents.disclosure_level', 'agents', 'How far a desk may go',
   'The furthest a draft from a mail desk may go: what a customer may hear, what a supplier may hear, or anything at all inside the company.',
   'enum', array['customer', 'vendor', 'internal']::text[],
   null, null, '{}'::jsonb, '',
   array['global', 'mailbox']::text[],
   '"customer"'::jsonb,
   'nothing yet: the desk reads nl.mailboxes.disclosure', false, 'admin'),

  ('agents.send_allowlist', 'agents', 'Addresses a desk may write to',
   'The only addresses a desk is allowed to send to, checked again on the server at send time.',
   'text_list', array[]::text[], null, null, '{}'::jsonb, '',
   array['global', 'mailbox']::text[],
   '[]'::jsonb,
   'nothing yet: the list lives in the mail_allowlist setting', false, 'admin'),

  ('agents.approval_threshold', 'agents', 'Value an agent may act on alone',
   'The value up to which an agent may act without a person. Zero means a person sees everything, whatever it is worth.',
   'number', array[]::text[], 0, 1000000, '{}'::jsonb, 'USD',
   array['global', 'mailbox', 'customer']::text[],
   '0'::jsonb,
   'nothing yet: how far an agent may go is decided by nl.agent_autonomy, per agent and kind of work', false, 'admin'),

  ('agents.daily_cap', 'agents', 'Messages one desk may send in a day',
   'How many messages a single desk may send in one day, so a loop cannot turn into a mailing.',
   'integer', array[]::text[], 0, 500, '{}'::jsonb, '',
   array['global', 'mailbox']::text[],
   '20'::jsonb,
   'nothing yet: the caps live in the settings and in the agent harness', false, 'admin')

  on conflict (key) do update set
    group_key     = excluded.group_key,
    name          = excluded.name,
    description   = excluded.description,
    value_type    = excluded.value_type,
    allowed       = excluded.allowed,
    min_value     = excluded.min_value,
    max_value     = excluded.max_value,
    value_schema  = excluded.value_schema,
    unit          = excluded.unit,
    scopes        = excluded.scopes,
    default_value = excluded.default_value,
    read_by       = excluded.read_by,
    editable      = excluded.editable,
    edit_role     = excluded.edit_role;

  select count(*) into v_count from nl.policy_types;
  return v_count;
end $$;

/*
 * The data dictionary.
 *
 * One row per field of the tables and views a person or an agent actually
 * reads. `shareable` is the same question the desk asks about a fact it is
 * about to put in an email (app/src/lib/server/desk/policy.ts), asked one
 * level down, about the field itself: cost, margin, the floor price, stock
 * quantities, internal ids and colleagues stay inside.
 *
 * Three views carry most of their columns through from the table underneath.
 * Those are copied at the end rather than typed twice, filtered by what the
 * view really has, so the wording cannot drift and a column the view drops
 * does not leave a dictionary row pointing at nothing.
 */
create function nl.load_data_dictionary() returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  insert into nl.data_dictionary as d (
    entity, field, label, meaning, unit, source, derivation, example, shareable)
  values
  -- Parts --------------------------------------------------------------------
  ('nl.items', 'item_no', 'Part number',
   'The part number exactly as the ERP writes it, and the key every other table points at.',
   '', 'erp export', '', 'EL-4525', true),
  ('nl.items', 'description', 'Description',
   'The part description that goes on a quote, an invoice and a packing list.',
   '', 'erp export', '', '4 inch chrome elbow, 45 degree', true),
  ('nl.items', 'category', 'ERP category',
   'The item category code the ERP groups parts by, kept verbatim so a report here matches a report there.',
   '', 'erp export', '', 'ELBOWS', false),
  ('nl.items', 'family', 'Family',
   'The plain word for what kind of part this is, which is what people and policies group parts by.',
   '', 'app', 'Read once from the category and the description when the part was first loaded.',
   'elbow', true),
  ('nl.items', 'product_group', 'Product group',
   'The reporting group the part rolls up to in the ERP, one level above the category.',
   '', 'erp export', '', 'EXHAUST', false),
  ('nl.items', 'unit_cost', 'Current cost',
   'What one piece costs us today, which is the newest row on the cost timeline.',
   'USD', 'erp export', '', '41.20', false),
  ('nl.items', 'list_price', 'List price',
   'The published price of one piece, before any tier discount or agreement.',
   'USD', 'erp export', '', '96.00', true),
  ('nl.items', 'replenishment', 'Replenishment method',
   'How the part is obtained, in the words the ERP uses: Purchase, Prod. Order or Assembly.',
   '', 'erp export', '', 'Purchase', false),
  ('nl.items', 'work_center', 'Work center',
   'Where the part is made, for a part we make rather than buy. Empty for a bought part.',
   '', 'erp export', '', 'WELD-2', false),
  ('nl.items', 'vendor_no', 'Supplier',
   'The supplier the part is normally bought from. Empty for a part we make ourselves.',
   '', 'erp export', '', 'V-1042', false),
  ('nl.items', 'lead_time', 'Lead time formula',
   'How long the part takes to get, as the ERP date formula: 3W is three weeks, 10D is ten days.',
   '', 'erp export', '', '3W', false),
  ('nl.items', 'made_to_order', 'Made to order',
   'Whether the part is only made once somebody orders it, so there is never stock waiting on a shelf.',
   '', 'erp export', '', 'false', true),
  ('nl.items', 'proprietary', 'Proprietary',
   'Whether the part is a design of ours rather than something any supplier can make.',
   '', 'erp export', '', 'false', false),
  ('nl.items', 'blocked', 'Blocked',
   'Whether the part may be sold at all. A blocked part cannot be quoted or ordered.',
   '', 'erp export', '', 'false', true),
  ('nl.items', 'reorder_point', 'Reorder point',
   'The quantity on hand at which the part should be ordered or scheduled again.',
   'pieces', 'erp export', '', '40', false),
  ('nl.items', 'safety_stock', 'Safety stock',
   'The buffer quantity meant to stay on the shelf underneath the reorder point.',
   'pieces', 'erp export', '', '15', false),

  -- Accounts -----------------------------------------------------------------
  ('nl.customers', 'customer_no', 'Account number',
   'The account number the ERP uses, and the key invoices, orders and commitments point at.',
   '', 'erp export', '', '1218', true),
  ('nl.customers', 'name', 'Account name',
   'The name of the business, as the ERP holds it.',
   '', 'erp export', '', 'Yellowstone Heavy Duty Parts', true),
  ('nl.customers', 'bill_to_no', 'Billed to',
   'The account this one is billed to, so a branch points at its head office. Empty when it pays for itself.',
   '', 'erp export', '', '1200', false),
  ('nl.customers', 'city', 'City', 'The city the account is in.',
   '', 'erp export', '', 'Bozeman', true),
  ('nl.customers', 'state', 'State', 'The state or province the account is in.',
   '', 'erp export', '', 'MT', true),
  ('nl.customers', 'country', 'Country', 'The country the account is in.',
   '', 'erp export', '', 'US', true),
  ('nl.customers', 'email_domain', 'Mail domain',
   'The mail domain used to match an emailed request to this account.',
   '', 'app', '', 'yellowstonehd.example', false),
  ('nl.customers', 'price_group', 'Price group',
   'The tier this account buys on, which sets the standard discount off list.',
   '', 'erp export', '', 'ELITE', false),
  ('nl.customers', 'ships_own_carrier', 'Ships on own carrier account',
   'Whether the account collects shipments on a carrier account of its own instead of paying our freight.',
   '', 'erp export', '', 'true', true),
  ('nl.customers', 'blocked', 'Blocked',
   'Whether the account may buy at all today, usually a credit decision.',
   '', 'erp export', '', 'false', false),
  ('nl.customers', 'closed', 'Closed',
   'Whether the account is finished with, rather than merely quiet for a while.',
   '', 'erp export', '', 'false', false),
  ('nl.customers', 'owner_id', 'Account manager',
   'The person here who is accountable for the account.',
   '', 'app', '', '2', false),
  ('nl.customers', 'agency_id', 'Agency',
   'The outside sales agency covering the account, where one does.',
   '', 'app', '', '3', false),
  ('nl.customers', 'customer_since', 'Customer since',
   'The day of the first order we have a record of for this account.',
   '', 'derived', 'The earliest posting date in the invoice ledger for the account.',
   '2019-04-11', true),
  ('nl.customers', 'updated_at', 'Row version',
   'When the row last changed, to the millisecond. A save sends it back, so two people cannot quietly overwrite each other.',
   '', 'app', '', '', false),

  -- Invoices -----------------------------------------------------------------
  ('nl.invoices', 'invoice_no', 'Document number',
   'The invoice or credit memo number from the ERP.',
   '', 'erp export', '', 'INV-104882', true),
  ('nl.invoices', 'doc_type', 'Document type',
   'Whether this document is an invoice or a credit memo.',
   '', 'erp export', '', 'invoice', true),
  ('nl.invoices', 'customer_no', 'Sold to',
   'The account that bought the goods.',
   '', 'erp export', '', '1218', true),
  ('nl.invoices', 'bill_to_no', 'Billed to',
   'The account the document was billed to, which can be the head office of the one that bought.',
   '', 'erp export', '', '1200', false),
  ('nl.invoices', 'posted_on', 'Posted',
   'The day the document was posted, which is the date every revenue figure counts it in.',
   '', 'erp export', '', '2026-08-14', true),
  ('nl.invoices', 'order_no', 'Order number',
   'The sales order the invoice came from, where the export carries one. Often empty.',
   '', 'erp export', '', '', false),
  ('nl.invoices', 'customer_po', 'Customer order number',
   'The number the customer put on their own order, which is how they will refer to it.',
   '', 'erp export', '', 'PO-99213', true),
  ('nl.invoices', 'freight', 'Freight billed',
   'The freight charged on this document. It sits on the header and never on a line, which is why line-level revenue is short of invoiced revenue.',
   'USD', 'erp export', '', '24.50', true),
  ('nl.invoices', 'applies_to', 'Applies to',
   'For a credit memo, the invoice it corrects. Empty on an invoice.',
   '', 'erp export', '', '', true),
  ('nl.invoices', 'subtotal', 'Subtotal',
   'The goods value of the document before freight, which is what freight is quoted off.',
   'USD', 'erp export', '', '1842.00', true),

  ('nl.invoice_lines', 'invoice_no', 'Document number',
   'The invoice or credit memo this line belongs to.',
   '', 'erp export', '', 'INV-104882', true),
  ('nl.invoice_lines', 'line_no', 'Line number',
   'Where the line sits on the document.',
   '', 'erp export', '', '3', true),
  ('nl.invoice_lines', 'customer_no', 'Sold to',
   'The account that bought, repeated from the header so a line can be read on its own.',
   '', 'erp export',
   'Held to the header by a composite key, so a line and its header can never disagree.',
   '1218', true),
  ('nl.invoice_lines', 'posted_on', 'Posted',
   'The posting date, repeated from the header for the same reason, and what delivery measurement filters on.',
   '', 'erp export', '', '2026-08-14', true),
  ('nl.invoice_lines', 'item_no', 'Part',
   'The part that was sold on this line.',
   '', 'erp export', '', 'EL-4525', true),
  ('nl.invoice_lines', 'quantity', 'Quantity',
   'Pieces sold. Negative on a return, and zero on a price correction that takes money off without goods coming back.',
   'pieces', 'erp export', '', '12', true),
  ('nl.invoice_lines', 'unit_price', 'Unit price',
   'What one piece was actually invoiced at, after whatever discount applied that day.',
   'USD', 'erp export', '', '52.80', true),
  ('nl.invoice_lines', 'amount', 'Line amount',
   'What the line came to, which is the figure every revenue report adds up.',
   'USD', 'erp export', '', '633.60', true),
  ('nl.invoice_lines', 'unit_cost', 'Unit cost then',
   'What one piece cost us on the day the line was posted, so a cost revision today cannot rewrite last year margin.',
   'USD', 'erp export', '', '41.20', false),

  -- Commitments --------------------------------------------------------------
  ('nl.commitments', 'id', 'Commitment number',
   'The number this commitment is known by, shown as C-3001.',
   '', 'app', '', '3001', false),
  ('nl.commitments', 'title', 'Title',
   'What the commitment is, in the words of the person who took it.',
   '', 'app', '', 'Spring chrome stack program', false),
  ('nl.commitments', 'customer_no', 'Account',
   'The account that made the commitment.',
   '', 'app', '', '1218', true),
  ('nl.commitments', 'buyer_contact_id', 'Buyer',
   'The named person at the account who said they would buy. A commitment without one is a hope.',
   '', 'app', '', '412', false),
  ('nl.commitments', 'owner_id', 'Owner',
   'The person here who is accountable for it, and who answers when the window closes short.',
   '', 'app', '', '2', false),
  ('nl.commitments', 'committed_value', 'Committed value',
   'What the buyer said they would buy, in money, over the whole window.',
   'USD', 'app', '', '48000.00', true),
  ('nl.commitments', 'starts_on', 'Window opens',
   'The first day deliveries count towards this commitment.',
   '', 'app', '', '2026-04-01', true),
  ('nl.commitments', 'ends_on', 'Window closes',
   'The last day deliveries count. After it, the commitment is settled and late deliveries belong to the next one.',
   '', 'app', '', '2026-09-30', true),
  ('nl.commitments', 'confidence', 'Confidence',
   'How likely the owner thinks it is, as a percentage, which is what weights the expected value.',
   'percent', 'app', '', '60', false),
  ('nl.commitments', 'notes', 'Notes',
   'Whatever the owner wrote down about it. Internal.',
   '', 'app', '', '', false),
  ('nl.commitments', 'created_by', 'Created by',
   'The person who first wrote the commitment down.',
   '', 'app', '', '2', false),
  ('nl.commitments', 'created_at', 'Created',
   'When the commitment was first written down.',
   '', 'app', '', '', false),
  ('nl.commitments', 'updated_at', 'Row version',
   'When the row last changed, to the millisecond, for optimistic locking.',
   '', 'app', '', '', false),

  -- Commitment progress, the measured part --------------------------------
  ('nl.commitment_progress', 'delivered', 'Delivered',
   'What has actually been delivered against this commitment, in money.',
   'USD', 'derived',
   'Invoice lines for the account and its billing family, whose part is in the commitment scope, posted inside the window. Stored on nl.commitment_delivery and kept exact by triggers.',
   '31200.00', true),
  ('nl.commitment_progress', 'remaining', 'Remaining',
   'The committed value less what has been delivered, never below zero.',
   'USD', 'derived', 'committed_value less delivered.', '16800.00', true),
  ('nl.commitment_progress', 'delivered_ratio', 'Delivered share',
   'How much of the commitment has landed, as a share of its value.',
   'ratio', 'derived', 'delivered divided by committed_value.', '0.65', true),
  ('nl.commitment_progress', 'matched_lines', 'Matching lines',
   'How many invoice lines have been counted towards this commitment.',
   '', 'derived', 'A count of the lines behind delivered.', '41', false),
  ('nl.commitment_progress', 'last_delivery_on', 'Last delivery',
   'The posting date of the most recent line counted towards it.',
   '', 'derived', 'The newest posting date behind delivered.', '2026-09-02', true),
  ('nl.commitment_progress', 'quote_count', 'Quotes',
   'How many quotes are linked to this commitment.',
   '', 'derived', 'A count of nl.quotes rows pointing at it.', '2', false),
  ('nl.commitment_progress', 'last_quoted_on', 'Last quoted',
   'When the most recent linked quote was made.',
   '', 'derived', 'The newest quoted_on among the linked quotes.', '2026-05-14', true),
  ('nl.commitment_progress', 'status', 'Status',
   'Where the commitment stands: promised, quoted, delivering, kept, pushed or broken. Never stored, always worked out.',
   '', 'derived',
   'An answer from a person wins; otherwise delivered at or above the kept ratio is kept, any delivery is delivering, a linked quote is quoted, and nothing yet is promised.',
   'delivering', false),
  ('nl.commitment_progress', 'is_settled', 'Settled',
   'Whether the commitment is finished with, so nothing further can change its status.',
   '', 'derived', 'True for kept, pushed and broken.', 'false', false),
  ('nl.commitment_progress', 'kept_by_measure', 'Kept by measure',
   'Whether enough has been delivered to count as kept, whatever anybody has answered.',
   '', 'derived', 'delivered at or above committed_value times the kept ratio policy.', 'false', false),
  ('nl.commitment_progress', 'outcome', 'Answer',
   'What the owner answered when the window closed short: kept, pushed or broken.',
   '', 'app', 'The newest row in nl.commitment_outcomes.', 'pushed', false),
  ('nl.commitment_progress', 'outcome_source', 'Answered by what',
   'Whether the answer came from a person or from the nightly job, which may only ever answer pushed.',
   '', 'app', '', 'person', false),
  ('nl.commitment_progress', 'answered_by', 'Answered by',
   'The person who answered the closed-short question.',
   '', 'app', '', '2', false),
  ('nl.commitment_progress', 'answered_at', 'Answered',
   'When that answer was given.',
   '', 'app', '', '', false),
  ('nl.commitment_progress', 'outcome_note', 'Answer note',
   'What the owner wrote alongside the answer. Internal.',
   '', 'app', '', '', false),
  ('nl.commitment_progress', 'needs_outcome', 'Needs an answer',
   'Whether the window has closed short and nobody has said what happened.',
   '', 'derived', 'The window has passed, delivery is under the kept ratio, and there is no answer.',
   'true', false),
  ('nl.commitment_progress', 'days_since_close', 'Days since it closed',
   'How long ago the window closed, for a commitment whose window has passed.',
   'days', 'derived', 'Today less ends_on.', '9', false),
  ('nl.commitment_progress', 'window_elapsed_ratio', 'Window elapsed',
   'How much of the window has gone by, which is what delivery is compared against to say whether it is behind pace.',
   'ratio', 'derived', 'Days elapsed divided by the length of the window.', '0.78', false),
  ('nl.commitment_progress', 'expected_value', 'Expected value',
   'What this commitment is worth on the forecast: everything delivered, plus the part still coming weighted by confidence.',
   'USD', 'derived',
   'delivered plus confidence times remaining while it is open, and delivered alone once it is settled.',
   '41280.00', false),

  -- Open orders --------------------------------------------------------------
  ('nl.open_order_lines', 'document_no', 'Order number',
   'The sales order this open line belongs to, as the ERP export names it.',
   '', 'erp export', '', 'SO-20418', true),
  ('nl.open_order_lines', 'line_no', 'Line number',
   'Where the line sits on the order.',
   '', 'erp export', '', '2', true),
  ('nl.open_order_lines', 'customer_no', 'Account',
   'The account that placed the order.',
   '', 'erp export', '', '1218', true),
  ('nl.open_order_lines', 'item_no', 'Part',
   'The part that is on order and has not shipped yet.',
   '', 'erp export', '', 'EL-4525', true),
  ('nl.open_order_lines', 'description', 'Description',
   'The description as the order carries it, which can differ from the item card if the order is old.',
   '', 'erp export', '', '4 inch chrome elbow, 45 degree', true),
  ('nl.open_order_lines', 'ship_date', 'Promised ship date',
   'The day the line is meant to ship, which is the date everything about lateness is measured from.',
   '', 'erp export', '', '2026-09-24', true),
  ('nl.open_order_lines', 'quantity', 'Quantity open',
   'Pieces still to ship on this line.',
   'pieces', 'erp export', '', '24', true),
  ('nl.open_order_lines', 'unit_price', 'Unit price',
   'The price one piece will be invoiced at when it ships.',
   'USD', 'erp export', '', '52.80', true),
  ('nl.open_order_lines', 'line_amount', 'Line amount',
   'What the open line is worth at that price.',
   'USD', 'erp export', '', '1267.20', true),
  ('nl.open_order_lines', 'location_code', 'Location',
   'The warehouse the line is meant to ship from.',
   '', 'erp export', '', 'MAIN', false),
  ('nl.open_order_lines', 'first_seen_on', 'First seen',
   'The day this line first appeared in an applied export, which never moves once it is set.',
   '', 'app', '', '2026-08-30', false),
  ('nl.open_order_lines', 'last_snapshot_id', 'Last snapshot',
   'The export snapshot that last carried this line, so a row can be traced back to the file it came from.',
   '', 'app', '', '184', false),

  ('nl.open_line_allocation', 'open_value', 'Open value',
   'What the line is worth, worked out here rather than taken from the export.',
   'USD', 'derived', 'quantity times unit_price, rounded to the cent.', '1267.20', true),
  ('nl.open_line_allocation', 'on_hand', 'On hand',
   'How many of the part the item master says are on the shelf.',
   'pieces', 'erp export', '', '38', false),
  ('nl.open_line_allocation', 'claimed_before', 'Claimed by earlier lines',
   'How many pieces of this part lines ahead of this one have already asked for.',
   'pieces', 'derived',
   'A running total of quantity over the part, in ship date order, stopping one line short of this one.',
   '18', false),
  ('nl.open_line_allocation', 'allocated', 'Allocated',
   'How many pieces stock can cover for this line, once earlier lines have taken theirs.',
   'pieces', 'derived', 'The lower of quantity and what is left of on hand after claimed_before.',
   '20', false),
  ('nl.open_line_allocation', 'short', 'Short',
   'How many pieces of this line stock cannot cover today.',
   'pieces', 'derived', 'quantity less allocated.', '4', true),
  ('nl.open_line_allocation', 'bucket', 'Bucket',
   'Which of the four states the line is in: past due, at risk, on pace or later.',
   '', 'derived',
   'Past due once the ship date has gone by; inside the at-risk horizon it is at risk when short and on pace when covered; anything further out is later.',
   'at_risk', false),

  ('nl.open_line_projection', 'customer_owner_id', 'Account manager',
   'The person here accountable for the account on this line.',
   '', 'app', '', '2', false),
  ('nl.open_line_projection', 'open_value', 'Open value',
   'What the line is worth at its own price.',
   'USD', 'derived', 'quantity times unit_price.', '1267.20', true),
  ('nl.open_line_projection', 'demand_through', 'Demand through this line',
   'The running total of demand for the part up to and including this line, which is what supply is matched against.',
   'pieces', 'derived', 'A running total of quantity over the part in ship date order.', '42', false),
  ('nl.open_line_projection', 'availability_date', 'Available on',
   'The day the pieces this line needs are expected to exist, whether from stock or from an order coming in.',
   '', 'derived',
   'The day the first supply whose running total reaches this line lands. Empty when nothing covers it.',
   '2026-10-02', true),
  ('nl.open_line_projection', 'earliest_if_ordered_today', 'Earliest if ordered today',
   'The soonest the part could be here if it were ordered or scheduled this morning.',
   '', 'derived', 'Today plus the lead time from the item card, its vendor, or the default.',
   '2026-10-15', true),
  ('nl.open_line_projection', 'projected_ship_date', 'Projected ship date',
   'When the line is really expected to ship, which is the later of its promised date and the day the pieces exist.',
   '', 'derived', 'The later of ship_date and availability_date.', '2026-10-02', true),
  ('nl.open_line_projection', 'days_late', 'Days late',
   'How far past its promise the line is expected to ship.',
   'days', 'derived', 'projected_ship_date less ship_date, zero when it is not late.', '8', true),
  ('nl.open_line_projection', 'status', 'Status',
   'What kind of trouble the line is in, from covered now through to waiting on supply that lands too late.',
   '', 'derived',
   'Worked out from whether stock covers it today, whether any supply covers it at all, and whether that supply is itself past due.',
   'late_waiting_supply', false),
  ('nl.open_line_projection', 'covered_now', 'Covered now',
   'Whether the pieces for this line are already here.',
   '', 'derived', 'True when the covering supply is stock, or landed on or before today.', 'false', true),
  ('nl.open_line_projection', 'supply_source', 'Supply source',
   'Where the pieces are coming from: the shelf, a purchase order or a production order.',
   '', 'derived',
   'Named after whichever supply the projection matched to this line, and empty when nothing covers it.',
   'purchase', false),
  ('nl.open_line_projection', 'supply_document', 'Supply document',
   'The purchase or production order that covers this line.',
   '', 'erp export', '', 'PO-8871', false),
  ('nl.open_line_projection', 'supply_vendor_no', 'Supply vendor',
   'The supplier bringing the pieces in, for a purchase order.',
   '', 'erp export', '', 'V-1042', false),
  ('nl.open_line_projection', 'supply_work_center', 'Supply work center',
   'Where the pieces are being made, for a production order.',
   '', 'erp export', '', 'WELD-2', false),
  ('nl.open_line_projection', 'supply_due_date', 'Supply due',
   'The day the covering supply order is due in.',
   '', 'erp export', '', '2026-09-29', false),
  ('nl.open_line_projection', 'supply_overdue', 'Supply is late',
   'Whether the supply order meant to cover this line is itself past its due date.',
   '', 'derived', 'The supply due date has gone by and it has not been received.', 'true', false),
  ('nl.open_line_projection', 'today', 'As of',
   'The day the projection was worked out for, so a figure can be read months later and still make sense.',
   '', 'derived', 'nl.today(), asked once per query.', '2026-09-17', true),

  -- Stock --------------------------------------------------------------------
  ('nl.stock', 'item_no', 'Part',
   'The part this shelf figure is for.',
   '', 'erp export', '', 'EL-4525', true),
  ('nl.stock', 'on_hand', 'On hand',
   'How many pieces the item master says are on the shelf across the whole company.',
   'pieces', 'erp export', '', '38', false),
  ('nl.stock', 'on_production_order', 'On production order',
   'How many pieces are on production orders that have not been finished.',
   'pieces', 'erp export', '', '120', false),
  ('nl.stock', 'on_purchase_order', 'On purchase order',
   'How many pieces are on purchase orders that have not arrived.',
   'pieces', 'erp export', '', '200', false),
  ('nl.stock', 'shelf', 'Shelf',
   'Where the part lives, as the ERP writes it.',
   '', 'erp export', '', 'A-12', false),
  ('nl.stock', 'bin', 'Bin',
   'The bin within that shelf, where the ERP records one.',
   '', 'erp export', '', '04', false),
  ('nl.stock', 'as_of', 'As of',
   'The day this shelf figure came from, because it is only ever as fresh as the last export.',
   '', 'erp export', '', '2026-09-17', false),

  ('nl.stock_moves', 'id', 'Movement number',
   'The number of this movement in the ledger. Movements are only ever added.',
   '', 'app', '', '8821', false),
  ('nl.stock_moves', 'item_no', 'Part',
   'The part whose quantity this movement changed.',
   '', 'app', '', 'EL-4525', false),
  ('nl.stock_moves', 'location_code', 'Location',
   'The building whose books the movement is on. Stock in a truck stays on the sending location books until it is received.',
   '', 'app', '', 'MAIN', false),
  ('nl.stock_moves', 'moved_at', 'Moved',
   'When the movement happened.',
   '', 'app', '', '', false),
  ('nl.stock_moves', 'kind', 'Kind',
   'What kind of movement it was: a receipt, a pick, a count adjustment, a transfer out or a transfer in.',
   '', 'app', '', 'pick', false),
  ('nl.stock_moves', 'quantity', 'Quantity',
   'Pieces moved, positive onto the shelf and negative off it.',
   'pieces', 'app', '', '-24', false),
  ('nl.stock_moves', 'reference', 'Reference',
   'The shipment, count or transfer the movement belongs to.',
   '', 'app', '', 'SH-2201', false),
  ('nl.stock_moves', 'reason', 'Reason',
   'Why it moved, for a movement that is not simply a receipt or a pick.',
   '', 'app', '', 'count adjustment', false),
  ('nl.stock_moves', 'actor', 'Moved by',
   'The person who made the movement.',
   '', 'app', '', '5', false),
  ('nl.stock_moves', 'note', 'Note',
   'Anything written alongside the movement. Internal.',
   '', 'app', '', '', false),

  -- Quotes -------------------------------------------------------------------
  ('nl.quotes', 'id', 'Quote number',
   'The number this quote is known by, shown as Q-501.',
   '', 'app', '', '501', true),
  ('nl.quotes', 'customer_no', 'Account',
   'The account the quote is for.',
   '', 'app', '', '1218', true),
  ('nl.quotes', 'contact_id', 'Contact',
   'The person at the account the quote went to.',
   '', 'app', '', '412', false),
  ('nl.quotes', 'commitment_id', 'Commitment',
   'The commitment this quote belongs to, where there is one.',
   '', 'app', '', '3001', false),
  ('nl.quotes', 'quoted_on', 'Quoted',
   'The day the quote was made.',
   '', 'app', '', '2026-09-10', true),
  ('nl.quotes', 'valid_until', 'Holds until',
   'The last day the prices on the quote are good for.',
   '', 'app',
   'The day it was quoted plus the commercial.quote_valid_days policy for the account.',
   '2026-10-10', true),
  ('nl.quotes', 'source', 'Source',
   'How the quote came about: somebody typed it, or it came out of an emailed request.',
   '', 'app', '', 'rfq', false),
  ('nl.quotes', 'created_by', 'Created by',
   'The person who made the quote.',
   '', 'app', '', '2', false),
  ('nl.quotes', 'created_at', 'Created',
   'When the quote was written.',
   '', 'app', '', '', false),

  ('nl.quote_lines', 'quote_id', 'Quote number',
   'The quote this line belongs to.',
   '', 'app', '', '501', true),
  ('nl.quote_lines', 'line_no', 'Line number',
   'Where the line sits on the quote.',
   '', 'app', '', '1', true),
  ('nl.quote_lines', 'item_no', 'Part',
   'The part being quoted on this line.',
   '', 'app', '', 'EL-4525', true),
  ('nl.quote_lines', 'quantity', 'Quantity',
   'Pieces quoted at this price.',
   'pieces', 'app', '', '24', true),
  ('nl.quote_lines', 'unit_price', 'Unit price',
   'The price quoted for one piece.',
   'USD', 'app', 'Worked out by nl.price_for() when the quote was made.', '52.80', true),

  -- Agreed prices and cost ---------------------------------------------------
  ('nl.customer_prices', 'customer_no', 'Account',
   'The account the agreed price is for.',
   '', 'app', '', '1218', true),
  ('nl.customer_prices', 'item_no', 'Part',
   'The part the agreed price is for.',
   '', 'app', '', 'EL-4525', true),
  ('nl.customer_prices', 'net_price', 'Agreed price',
   'The net price one piece is agreed at, which beats every other pricing rule while it is in force.',
   'USD', 'app', '', '49.50', true),
  ('nl.customer_prices', 'valid_from', 'In force from',
   'The first day the agreed price applies.',
   '', 'app', '', '2026-01-01', true),
  ('nl.customer_prices', 'valid_to', 'In force to',
   'The last day it applies. Empty means it is open ended, and there can only be one of those per account and part.',
   '', 'app', '', '', true),
  ('nl.customer_prices', 'agreed_by', 'Agreed by',
   'The person here who agreed it. Empty on a row an import brought in.',
   '', 'app', '', '2', false),
  ('nl.customer_prices', 'note', 'Note',
   'Why the price was agreed. Internal.',
   '', 'app', '', '', false),
  ('nl.customer_prices', 'created_at', 'Created',
   'When the agreement was written down.',
   '', 'app', '', '', false),
  ('nl.customer_prices', 'updated_at', 'Row version',
   'When the row last changed, to the millisecond, for optimistic locking.',
   '', 'app', '', '', false),

  ('nl.item_costs', 'item_no', 'Part',
   'The part this cost revision is for.',
   '', 'app', '', 'EL-4525', false),
  ('nl.item_costs', 'vendor_no', 'Supplier',
   'The supplier whose quote or receipt set this cost. Empty for a part we make.',
   '', 'app', '', 'V-1042', false),
  ('nl.item_costs', 'effective_from', 'From',
   'The first day this cost applied. The newest row on or before a date is the cost that applied then.',
   '', 'app', '', '2026-06-01', false),
  ('nl.item_costs', 'unit_cost', 'Unit cost',
   'What one piece cost us from that day on.',
   'USD', 'app', '', '41.20', false),
  ('nl.item_costs', 'source', 'Source',
   'What set the cost: a vendor quote, what a receipt actually landed at, or a standard cost roll up.',
   '', 'app', '', 'purchase receipt', false),
  ('nl.item_costs', 'note', 'Note',
   'What was said about the revision at the time. Internal.',
   '', 'app', '', '', false),

  -- The policy engine itself -------------------------------------------------
  ('nl.policies', 'id', 'Policy number',
   'The number this policy row is known by.',
   '', 'policy engine', '', '4012', false),
  ('nl.policies', 'policy_type', 'Policy',
   'Which policy this is a value for, from nl.policy_types.',
   '', 'policy engine', '', 'freight.terms', true),
  ('nl.policies', 'scope_kind', 'Scope',
   'What the value is about: the whole company, a price group, one account, one part, a family, a supplier, a location, a mailbox, an order or one order line.',
   '', 'policy engine', '', 'customer', true),
  ('nl.policies', 'scope_id', 'Scope id',
   'Which one: the account number, price group code, part number, family, supplier number, location code, mailbox id or order number. Empty for a company-wide policy.',
   '', 'policy engine', '', '1218', true),
  ('nl.policies', 'value', 'Value',
   'The value itself, held as JSON so a policy can be a number, a word, a yes or no, a list or a small set of named numbers.',
   '', 'policy engine', '', '"collect"', true),
  ('nl.policies', 'effective_from', 'From',
   'The first day this policy applies.',
   '', 'policy engine', '', '2026-03-01', true),
  ('nl.policies', 'effective_to', 'To',
   'The last day it applies. Empty means open ended. An expired row is kept, so the trace can still explain a figure from last spring.',
   '', 'policy engine', '', '', true),
  ('nl.policies', 'priority', 'Priority',
   'Breaks a tie between two rows at the same scope. Higher wins.',
   '', 'policy engine', '', '10', false),
  ('nl.policies', 'note', 'Why',
   'Why this policy was set, in the words of the person who set it.',
   '', 'policy engine', '', 'They collect on their own carrier account.', false),
  ('nl.policies', 'set_by', 'Set by',
   'The person who set it. Empty on a row the seed or an import made. The read-only role is not granted this column.',
   '', 'policy engine', '', '1', false),
  ('nl.policies', 'created_at', 'Created',
   'When the policy row was first written.',
   '', 'policy engine', '', '', false),
  ('nl.policies', 'updated_at', 'Row version',
   'When the row last changed, to the millisecond, for optimistic locking.',
   '', 'policy engine', '', '', false),

  ('nl.policy_types', 'key', 'Policy key',
   'The name a caller asks for, as group and name: freight.free_over, commercial.min_margin.',
   '', 'policy engine', '', 'commercial.min_margin', true),
  ('nl.policy_types', 'group_key', 'Group',
   'Which part of the business the policy belongs to, for grouping on the page.',
   '', 'policy engine', '', 'commercial', true),
  ('nl.policy_types', 'name', 'Name',
   'What the policy is called in plain words.',
   '', 'policy engine', '', 'Margin floor', true),
  ('nl.policy_types', 'description', 'Description',
   'One or two sentences saying what the policy decides.',
   '', 'policy engine', '', '', true),
  ('nl.policy_types', 'value_type', 'Value shape',
   'What kind of value this policy takes: a number, a whole number, a yes or no, text, one of a fixed list, a list, or a small set of named numbers.',
   '', 'policy engine', '', 'number', true),
  ('nl.policy_types', 'allowed', 'Allowed values',
   'The fixed list a value has to come from, for a policy that is one of a list.',
   '', 'policy engine', '', 'prepaid, collect', true),
  ('nl.policy_types', 'min_value', 'Lowest allowed',
   'The lowest number the policy will take, where it has a floor.',
   '', 'policy engine', '', '0', true),
  ('nl.policy_types', 'max_value', 'Highest allowed',
   'The highest number the policy will take, where it has a ceiling.',
   '', 'policy engine', '', '0.9', true),
  ('nl.policy_types', 'value_schema', 'Shape',
   'For a policy whose value is a set of named numbers, the names it has to carry and what kind each one is.',
   '', 'policy engine', '', '{"purchase": "number"}', false),
  ('nl.policy_types', 'unit', 'Unit',
   'What the number is measured in: dollars, days, pieces, a ratio, or a rank.',
   '', 'policy engine', '', 'ratio', true),
  ('nl.policy_types', 'scopes', 'Can be set at',
   'The scopes this policy may be set at. Always includes the whole company.',
   '', 'policy engine', '', 'global, customer, item', true),
  ('nl.policy_types', 'default_value', 'Built-in default',
   'What the answer is when nobody has set anything for the thing being asked about.',
   '', 'policy engine', '', '0.20', true),
  ('nl.policy_types', 'read_by', 'Read by',
   'What in the app reads this policy today, or a plain statement that nothing does yet.',
   '', 'policy engine', '', 'nl.min_margin()', false),
  ('nl.policy_types', 'editable', 'Editable',
   'Whether a person may change it from the policies page. A policy whose old hard-coded reader has not moved yet is shown and not editable.',
   '', 'policy engine', '', 'true', false),
  ('nl.policy_types', 'edit_role', 'Who may change it',
   'The role that may change this policy. An admin may change anything editable.',
   '', 'policy engine', '', 'operations', false),
  ('nl.policy_types', 'created_at', 'Created',
   'When this policy type was first loaded.',
   '', 'policy engine', '', '', false),

  ('nl.data_dictionary', 'entity', 'Table or view',
   'The table or view the field belongs to, schema and all.',
   '', 'policy engine', '', 'nl.items', true),
  ('nl.data_dictionary', 'field', 'Field',
   'The column name, exactly as the database has it.',
   '', 'policy engine', '', 'list_price', true),
  ('nl.data_dictionary', 'label', 'Label',
   'What the field is called on screen and in a sentence.',
   '', 'policy engine', '', 'List price', true),
  ('nl.data_dictionary', 'meaning', 'Meaning',
   'One sentence saying what the field actually means, which is the whole point of the dictionary.',
   '', 'policy engine', '', '', true),
  ('nl.data_dictionary', 'unit', 'Unit',
   'What the value is measured in, where it is measured in anything.',
   '', 'policy engine', '', 'USD', true),
  ('nl.data_dictionary', 'source', 'Source',
   'Where the value comes from: an ERP export, something a person did in the app, a figure worked out from others, or the policy engine.',
   '', 'policy engine', '', 'erp export', true),
  ('nl.data_dictionary', 'derivation', 'How it is worked out',
   'For a derived field, how it is worked out, in words rather than in SQL.',
   '', 'policy engine', '', '', true),
  ('nl.data_dictionary', 'example', 'Example',
   'A value of the shape this field holds, so a reader knows what to expect.',
   '', 'policy engine', '', '96.00', true),
  ('nl.data_dictionary', 'shareable', 'May leave the building',
   'Whether an agent may put this field in something that goes outside the company.',
   '', 'policy engine', '', 'true', true)

  on conflict (entity, field) do update set
    label      = excluded.label,
    meaning    = excluded.meaning,
    unit       = excluded.unit,
    source     = excluded.source,
    derivation = excluded.derivation,
    example    = excluded.example,
    shareable  = excluded.shareable;

  -- The three views that carry columns through from the table underneath.
  -- Each documented column of the source is copied to the view, but only if
  -- the view really has a column of that name, which is what the join on
  -- pg_attribute is doing. One wording, two places, and nothing to keep in
  -- step by hand.
  insert into nl.data_dictionary as d (
    entity, field, label, meaning, unit, source, derivation, example, shareable)
  select
    v.entity, s.field, s.label, s.meaning, s.unit, s.source,
    case when s.derivation = '' then 'The column of the same name on ' || v.source_entity || '.'
         else s.derivation end,
    s.example, s.shareable
  from (values
    ('nl.commitment_progress', 'nl.commitments'),
    ('nl.open_line_allocation', 'nl.open_order_lines'),
    ('nl.open_line_projection', 'nl.open_order_lines')
  ) as v(entity, source_entity)
  join nl.data_dictionary s on s.entity = v.source_entity
  join pg_catalog.pg_attribute a
    on a.attrelid = pg_catalog.to_regclass(v.entity)
   and a.attname = s.field
   and a.attnum > 0
   and not a.attisdropped
  on conflict (entity, field) do update set
    label      = excluded.label,
    meaning    = excluded.meaning,
    unit       = excluded.unit,
    source     = excluded.source,
    derivation = excluded.derivation,
    example    = excluded.example,
    shareable  = excluded.shareable;

  select count(*) into v_count from nl.data_dictionary;
  return v_count;
end $$;

-- Both catalogs, in one call. The seed calls this after every rebuild.
create function nl.load_policy_catalog() returns jsonb
language sql
set search_path = ''
as $$
  select jsonb_build_object(
    'policy_types', nl.load_policy_types(),
    'dictionary_fields', nl.load_data_dictionary())
$$;

do $$
begin
  perform nl.load_policy_catalog();
end $$;
