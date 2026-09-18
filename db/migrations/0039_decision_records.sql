-- 0039 Decision records joined to outcomes.
--
-- Every ERP records transactions. Almost nothing records what was decided, on
-- what information, against what alternatives, and what happened next. That
-- record cannot be backfilled: a system that overwrites state destroys the
-- ability to ever ask "was that a good decision given what we knew then?"
--
-- The sentence this migration exists to make literally true:
--
--   "My promises on this vendor's parts have been wrong 30% of the time, so I
--    am quoting the ninetieth percentile."
--
-- Four things, in the order they depend on each other:
--
--   1. nl.promises            every stated date or price, with the basis it
--                             was made on and a confidence. A promise with no
--                             recorded basis cannot be written.
--   2. nl.promise_outcomes    what actually happened, its own table keyed to
--                             the promise, and nl.promise_record joins the two
--                             as a view rather than a nightly copy.
--   3. the calibration        per vendor, part family, kind and basis: how
--                             often we were right, how wrong we were when we
--                             were not, and whether the basis over or under
--                             promises. Then it is USED: nl.promise_lead_days
--                             adds the measured correction and says it did.
--   4. nl.decision_alternatives  what was considered and not chosen, and why,
--                             attached to a harness run (0028).
--
-- The rules that shape it:
--
--   * BUILD ON 0032, DO NOT RECOMPUTE IT. 0032 already observes lead time
--     percentiles per vendor and part from receipts, and nl.promise_lead_days
--     already decides which basis a date rests on. This migration does not
--     repeat any of that. It renames 0032's rule to
--     nl.promise_lead_days_uncalibrated and puts a thin calibration layer over
--     it under the old name, so every existing caller
--     (nl.item_lead_days, nl.lead_time_for, nl.customer_parts, nl.answer_for,
--     the forecast in 0016, the coverage screens in 0022) gets the calibrated
--     figure without being edited. There is one copy of the promise rule and
--     it is still the one written in 0032.
--   * THE CALIBRATION IS ABOUT OUR PROMISES, NOT THE VENDOR'S RECEIPTS. 0032
--     measures what a vendor does. This measures whether the date WE gave was
--     right. The correction is therefore the percentile of our own miss, which
--     is zero for a basis that is already honest and needs no arbitrary cap.
--   * ONE ROLL-UP, KEPT BY TRIGGERS, CHECKED FOR DRIFT. The correction is read
--     once per part on pages that list hundreds of parts, so it cannot group
--     the whole promise history on every call. nl.promise_calibration_rollup
--     is maintained by statement-level triggers over transition tables, with a
--     drift check and a repair function: the pattern 0008 set for
--     nl.commitment_delivery.
--   * DISCLOSURE IS ENFORCED ON THE PAYLOAD. An alternative can carry a cost
--     figure. nl.also_considered() assembles the payload and drops any figure
--     the reader's disclosure level does not allow, through nl.may_see (0031).
--     Nothing is hidden in markup.
--
-- Depends on 0001 (users, audit log, request ids), 0028 (the harness run
-- record), 0029 (purchase requests), 0031 (disclosure), 0032 (the promise
-- rule, vendors and receipts) and 0033 (quote revisions and their outcomes).
-- See docs/decision-records.md.

-- ---------------------------------------------------------------------------
-- Policy: what counts as on time, and how much history a correction needs
-- ---------------------------------------------------------------------------

-- How many days late a date promise may be and still count as kept. Three,
-- because a buyer plans a week and a truck that arrives Wednesday instead of
-- Monday did not break anything. Zero would make every promise a coin toss on
-- carrier scheduling and would stop measuring the thing worth measuring.
create function nl.promise_tolerance_days() returns int
language sql stable
set search_path = ''
as $$
  select coalesce(
    -- A policy engine, if this database has one, decides it instead. Feature
    -- detected rather than depended on, because it is on another branch.
    (select nullif(current_setting('nl.promise_tolerance_days', true), '')::int),
    3)
$$;

-- How many settled promises a vendor and basis need before the measured
-- correction is trusted over no correction at all. Eight: enough that a
-- ninetieth percentile is not one unlucky delivery, small enough that a vendor
-- we buy from monthly earns a record inside a year.
create function nl.calibration_min_promises() returns int
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select nullif(current_setting('nl.calibration_min_promises', true), '')::int),
    8)
$$;

-- ---------------------------------------------------------------------------
-- The vocabulary a promise may be made on
-- ---------------------------------------------------------------------------

-- Every word this schema already uses for "where a number came from", in one
-- list, so a promise cannot be recorded against a basis nobody can look up.
-- IMMUTABLE because a check constraint calls it, the same way
-- nl.loss_reasons() is used in 0033.
--
--   date bases     nl.promise_lead_days() in 0032, plus 'exception' from
--                  nl.lead_time_for() and 'calibrated' from this migration
--   price bases    nl.price_quote_for() in 0032
--   coverage bases the buy rule in 0029
create function nl.promise_bases() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- when
    'observed', 'quoted', 'item card', 'vendor default', 'default',
    'exception', 'calibrated', 'rolled',
    -- how much
    'agreement', 'held sheet', 'last paid', 'sheet', 'group discount', 'list',
    -- how many
    'cover target', 'reorder point', 'judgement']
$$;

-- Where the confidence figure itself came from. 'measured' is the only one
-- that is evidence; the rest are stated defaults, and saying so is the point.
create function nl.confidence_bases() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['measured', 'policy', 'vendor word', 'house default', 'person']
$$;

-- The confidence a promise carries when nothing has been measured yet. These
-- are stated defaults, not evidence, which is why a promise records
-- confidence_basis next to the number: 'house default' is a different claim
-- from 'measured' and a reader must be able to tell them apart.
--
-- 'observed' gets the promise percentile itself, because promising the
-- ninetieth percentile of the observed spread is a claim to be right nine
-- times in ten. Everything below it is a guess about somebody else's guess and
-- is priced accordingly.
create function nl.default_confidence(p_basis text) returns numeric
language sql stable
set search_path = ''
as $$
  select case p_basis
    when 'observed'       then nl.promise_percentile()
    when 'calibrated'     then nl.promise_percentile()
    when 'exception'      then 0.70::numeric   -- a person published it, with a reason
    when 'quoted'         then 0.60::numeric   -- the vendor's word, unverified
    when 'agreement'      then 0.95::numeric   -- a signed net price
    when 'held sheet'     then 0.90::numeric
    when 'sheet'          then 0.85::numeric
    when 'last paid'      then 0.75::numeric
    when 'group discount' then 0.70::numeric
    when 'list'           then 0.60::numeric
    when 'item card'      then 0.50::numeric
    when 'vendor default' then 0.40::numeric   -- a default for every part they supply
    when 'rolled'         then 0.60::numeric
    when 'cover target'   then 0.60::numeric
    when 'reorder point'  then 0.55::numeric
    when 'judgement'      then 0.50::numeric
    else 0.30::numeric                          -- 'default', and anything new
  end
$$;

-- ---------------------------------------------------------------------------
-- 1. A confidence on every promise
-- ---------------------------------------------------------------------------

-- One row per figure the system stated as a promise: a date it would arrive, a
-- price it would hold, a quantity that would cover demand.
--
-- The three things that make this a decision record rather than a log:
--
--   basis         which rule produced the figure, in the vocabulary the rest
--                 of the schema already uses. NOT NULL and checked against
--                 nl.promise_bases(), so a promise whose provenance nobody
--                 can look up cannot be stored.
--   confidence    how sure we were, at the time, in the figure. Stored, never
--                 recomputed: a rule that changes tomorrow must not rewrite
--                 how sure we were today. This is the whole reason a promise
--                 can be scored later and an ERP's promise cannot.
--   as_of         the day the figure was worked out, so the basis can be
--                 re-derived against the information that existed then.
--
-- subject and subject_id name the thing promised rather than pointing at one
-- table, because the same shape has to cover a purchase line, a quote
-- revision line and a coverage decision. There is no foreign key for that
-- reason, and no cascade: a promise outlives the row that caused it, which is
-- exactly what makes the history worth keeping.
create table nl.promises (
  id            bigint generated always as identity (start with 6001) primary key,
  kind          text not null check (kind in ('date', 'price', 'coverage')),
  subject       text not null check (length(subject) between 3 and 40),
  subject_id    text not null check (length(subject_id) between 1 and 60),
  -- What it was about. Every one of these is nullable because a coverage
  -- promise has no customer and a price promise has no vendor.
  item_no       text references nl.items (item_no),
  customer_no   text references nl.customers (customer_no),
  vendor_no     text references nl.vendors (vendor_no),
  -- The figure. A date promise carries a date, the other two carry a number.
  promised_date date,
  promised_value numeric(14, 2),
  -- The basis, always.
  basis         text not null check (basis = any (nl.promise_bases())),
  basis_detail  text not null default '',
  -- How sure, and where that came from.
  confidence    numeric(4, 3) not null check (confidence > 0 and confidence <= 1),
  confidence_basis text not null check (confidence_basis = any (nl.confidence_bases())),
  as_of         date not null,
  -- Who stated it. An agent is a row in nl.users (0031), so this column names
  -- a person or an agent with no second table and no second rule.
  made_by       int not null references nl.users (id),
  made_at       timestamptz not null default now(),
  -- The harness run that produced it, when an agent did (0028). Null when a
  -- person stated it from a screen.
  run_key       text check (run_key ~ '^[a-z_]+:[0-9]+$'),
  request_id    text not null check (length(request_id) between 8 and 100),
  -- The same promise, from a retried wake, is one row.
  unique (kind, subject, subject_id, request_id),
  -- A promise has to say what it promised.
  constraint promises_date_has_a_date
    check (kind <> 'date' or promised_date is not null),
  constraint promises_number_has_a_number
    check (kind = 'date' or promised_value is not null),
  -- A basis of an empty string passes the array test only if the array holds
  -- one, which it does not; this says so out loud anyway, because it is the
  -- rule the whole migration rests on.
  constraint promises_basis_is_named
    check (length(btrim(basis)) > 0)
);

comment on table nl.promises is
  'Every date or price the system stated, with the basis it rested on and how sure it was at the time. A promise with no basis cannot be written (migration 0039).';

-- "What did we promise this vendor's parts", which is what the calibration
-- groups and what a vendor page reads.
create index promises_vendor_idx on nl.promises (vendor_no, kind, basis, as_of desc)
  where vendor_no is not null;
create index promises_item_idx on nl.promises (item_no, kind, as_of desc);
create index promises_maker_idx on nl.promises (made_by, kind, as_of desc);
create index promises_run_idx on nl.promises (run_key) where run_key is not null;
create index promises_subject_idx on nl.promises (subject, subject_id);
create index promises_customer_idx on nl.promises (customer_no) where customer_no is not null;

-- ---------------------------------------------------------------------------
-- 2. The outcome join
-- ---------------------------------------------------------------------------

-- What happened to the promise. Its own table, keyed to the promise, one row
-- per promise: a promise is settled once and stays settled.
--
-- outcome means the same thing for all three kinds, which is what lets one
-- calibration count all three:
--
--   kept    a date arrived inside the tolerance, a quoted price was accepted,
--           a coverage decision held
--   missed  it did not
--   void    nothing was ever decided and never will be: the quote was
--           superseded, the order was cancelled. Void rows are recorded and
--           then excluded from every rate, because counting them as misses
--           would make a tidy-up look like a failure.
create table nl.promise_outcomes (
  promise_id  bigint primary key references nl.promises (id) on delete cascade,
  outcome     text not null check (outcome in ('kept', 'missed', 'void')),
  -- What actually happened, in the same shape as the promise.
  actual_date date,
  actual_value numeric(14, 2),
  settled_on  date not null,
  -- Where the answer came from, so a figure can be traced without guessing:
  -- 'receipt', 'quote revision', 'stock', 'person'.
  source      text not null check (length(source) between 3 and 40),
  detail      text not null default '',
  settled_by  int references nl.users (id),
  settled_at  timestamptz not null default now(),
  request_id  text not null check (length(request_id) between 8 and 100),
  -- A settled promise says what settled it.
  constraint promise_outcomes_void_is_empty
    check (outcome <> 'void' or (actual_date is null and actual_value is null))
);

comment on table nl.promise_outcomes is
  'What happened to each promise: kept, missed or void, with the actual figure and where it came from (migration 0039).';

create index promise_outcomes_settled_idx on nl.promise_outcomes (settled_on desc);
create index promise_outcomes_outcome_idx on nl.promise_outcomes (outcome);

-- The join, as a view. Not a nightly copy: the promise side is one table, the
-- outcome side is a primary key lookup, and the two lookups that widen it
-- (the part's family, the maker's name) are primary keys too. Nothing here
-- touches nl.invoice_lines, which is why it stays flat as the ledger grows.
-- docs/decision-records.md has the measured plan.
--
-- days_out is signed: positive is late, negative is early. value_out is
-- signed the same way for a price or a quantity.
create view nl.promise_record with (security_invoker = true) as
select
  p.id,
  p.kind,
  p.subject,
  p.subject_id,
  p.item_no,
  i.family,
  i.product_group,
  p.customer_no,
  p.vendor_no,
  p.promised_date,
  p.promised_value,
  p.basis,
  p.basis_detail,
  p.confidence,
  p.confidence_basis,
  p.as_of,
  p.made_by,
  u.full_name                      as maker_name,
  u.kind                           as maker_kind,
  p.run_key,
  p.made_at,
  o.outcome,
  o.actual_date,
  o.actual_value,
  o.settled_on,
  o.source                         as outcome_source,
  o.detail                         as outcome_detail,
  -- 'open' is not an outcome anybody recorded; it is the absence of one, and
  -- the view says so rather than leaving a null for a caller to interpret.
  coalesce(o.outcome, 'open')      as status,
  (o.actual_date - p.promised_date)::int as days_out,
  case when p.promised_value is not null and o.actual_value is not null
       then o.actual_value - p.promised_value
  end                              as value_out,
  -- Was the promise right? Null while it is open or void, because a rate over
  -- an unanswered promise is a made-up number.
  case
    when o.outcome is null or o.outcome = 'void' then null
    when p.kind = 'date' then (o.actual_date - p.promised_date) <= nl.promise_tolerance_days()
    else o.outcome = 'kept'
  end                              as on_time,
  -- Counted rather than open or void: the denominator of every rate below.
  (o.outcome in ('kept', 'missed')) as counted
from nl.promises p
left join nl.promise_outcomes o on o.promise_id = p.id
left join nl.items i on i.item_no = p.item_no
left join nl.users u on u.id = p.made_by;

comment on view nl.promise_record is
  'Each promise joined forward to what happened: days out, value out, and whether it was right. A view, not a copy (migration 0039).';

-- ---------------------------------------------------------------------------
-- 3. The calibration
-- ---------------------------------------------------------------------------

-- The live computation. This is the truth the roll-up below is checked
-- against, and it is what a report reads when it wants every cut at once.
--
-- Grouped by vendor, family, kind and basis, because "is this basis over or
-- under promising" is a question about a basis and not about a vendor: the
-- same vendor can be honest where we promise off their receipts and badly
-- optimistic where we promise off their quote. A correction applied without
-- the basis in the key would average those two together and be wrong for both.
create view nl.promise_calibration_live with (security_invoker = true) as
select
  r.vendor_no,
  coalesce(r.family, '')                                     as family,
  r.kind,
  r.basis,
  count(*)::int                                              as settled,
  count(*) filter (where r.on_time)::int                     as on_time,
  round(count(*) filter (where r.on_time)::numeric / count(*), 4) as on_time_share,
  round(percentile_cont(0.5) within group (order by r.days_out)::numeric, 1) as median_days_out,
  -- The percentile a promise is made at, of our own miss. If we promise the
  -- ninetieth and land inside it nine times in ten, this is zero or negative
  -- and nothing needs correcting.
  round(percentile_cont(nl.promise_percentile())
        within group (order by r.days_out)::numeric, 1)       as p90_days_out,
  max(r.days_out)::int                                       as worst_days_out,
  round(avg(r.days_out)::numeric, 1)                         as bias_days,
  max(r.settled_on)                                          as last_settled_on
from nl.promise_record r
where r.counted
  and r.vendor_no is not null
  and r.kind = 'date'
group by r.vendor_no, coalesce(r.family, ''), r.kind, r.basis;

comment on view nl.promise_calibration_live is
  'How right our date promises were, per vendor, part family and basis, computed fresh. nl.promise_calibration_rollup stores the same numbers (migration 0039).';

-- The stored roll-up, read once per part by nl.promise_lead_days.
--
-- Two levels live in one table. A row with family = '' is the vendor-wide
-- record for that basis; a row with a family is that family alone. The
-- correction prefers the family row when it has enough history and falls back
-- to the vendor row, which is how a vendor who is fine on clamps and hopeless
-- on bent pipe gets told apart without needing two tables.
--
-- Nobody writes this directly. The triggers below keep it, nl.calibration_drift()
-- checks it and nl.repair_calibration() fixes it, exactly as 0008 does for
-- nl.commitment_delivery.
create table nl.promise_calibration_rollup (
  vendor_no       text not null references nl.vendors (vendor_no) on delete cascade,
  family          text not null,          -- '' is every family for this vendor
  kind            text not null,
  basis           text not null,
  settled         int not null,
  on_time         int not null,
  on_time_share   numeric(6, 4),
  median_days_out numeric(6, 1),
  p90_days_out    numeric(6, 1),
  worst_days_out  int,
  bias_days       numeric(6, 1),
  last_settled_on date,
  -- The correction this record implies, in days, already rounded up and
  -- floored at zero. Stored so a page and the promise rule read one number.
  pad_days        int not null default 0 check (pad_days >= 0),
  -- Whether there is enough history for the correction to be applied at all.
  enough          boolean not null default false,
  measured_at     timestamptz not null default now(),
  primary key (vendor_no, family, kind, basis)
);

comment on table nl.promise_calibration_rollup is
  'The calibration per vendor, family, kind and basis, kept current by triggers. family = '''' is the vendor-wide row (migration 0039).';

alter table nl.promise_calibration_rollup enable row level security;
create policy calibration_rollup_read on nl.promise_calibration_rollup
  for select to nl_app, nl_readonly using (true);
grant select on nl.promise_calibration_rollup to nl_app, nl_readonly;

-- Recompute the given keys from nl.promise_record and store them. A key whose
-- promises have all gone is deleted rather than left at zero, because a row
-- saying "nought of nought" reads as a measurement and is not one.
--
-- SECURITY DEFINER for the same reason as nl.measure_commitments in 0008: a
-- trigger fired by a signed-in user's write has to update a table no user may
-- write. Nobody is granted EXECUTE.
create function nl.measure_calibration(
  p_vendors text[],
  p_families text[],
  p_kinds text[],
  p_bases text[]
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int := 0;
begin
  if p_vendors is null or cardinality(p_vendors) = 0 then
    return 0;
  end if;

  -- Every key that has to be looked at again: the family rows the change
  -- touched, plus the vendor-wide row for each of them.
  create temporary table if not exists pg_temp_calibration_keys (
    vendor_no text, family text, kind text, basis text
  ) on commit drop;
  delete from pg_temp_calibration_keys;

  insert into pg_temp_calibration_keys (vendor_no, family, kind, basis)
  select distinct k.vendor_no, f.family, k.kind, k.basis
  from unnest(p_vendors, p_families, p_kinds, p_bases)
         as k (vendor_no, family, kind, basis)
  cross join lateral (values (coalesce(k.family, '')), ('')) as f (family)
  where k.vendor_no is not null;

  -- Recount. The family = '' rows aggregate every family, so they are counted
  -- with a filter that ignores the family column rather than by summing the
  -- family rows, which would get the percentiles wrong.
  insert into nl.promise_calibration_rollup as t
    (vendor_no, family, kind, basis, settled, on_time, on_time_share,
     median_days_out, p90_days_out, worst_days_out, bias_days, last_settled_on,
     pad_days, enough, measured_at)
  select
    k.vendor_no, k.family, k.kind, k.basis,
    m.settled, m.on_time, m.on_time_share,
    m.median_days_out, m.p90_days_out, m.worst_days_out, m.bias_days, m.last_settled_on,
    -- The correction: how many days short the promise ran at the percentile it
    -- was made at. Rounded up, because a correction rounded down is no
    -- correction on the day it matters, and floored at zero, because a basis
    -- that comes in early does not earn a shorter promise. Only applied where
    -- there is enough history to mean anything.
    case when m.settled >= nl.calibration_min_promises()
         then greatest(0, ceil(coalesce(m.p90_days_out, 0))::int)
         else 0 end,
    m.settled >= nl.calibration_min_promises(),
    now()
  from pg_temp_calibration_keys k
  cross join lateral (
    select
      count(*)::int                                              as settled,
      count(*) filter (where r.on_time)::int                     as on_time,
      case when count(*) > 0
           then round(count(*) filter (where r.on_time)::numeric / count(*), 4) end
                                                                 as on_time_share,
      round(percentile_cont(0.5) within group (order by r.days_out)::numeric, 1)
                                                                 as median_days_out,
      round(percentile_cont(nl.promise_percentile())
            within group (order by r.days_out)::numeric, 1)       as p90_days_out,
      max(r.days_out)::int                                       as worst_days_out,
      round(avg(r.days_out)::numeric, 1)                         as bias_days,
      max(r.settled_on)                                          as last_settled_on
    from nl.promise_record r
    where r.counted
      and r.vendor_no = k.vendor_no
      and r.kind = k.kind
      and r.basis = k.basis
      and (k.family = '' or coalesce(r.family, '') = k.family)
  ) m
  where m.settled > 0
  on conflict (vendor_no, family, kind, basis) do update
    set settled         = excluded.settled,
        on_time         = excluded.on_time,
        on_time_share   = excluded.on_time_share,
        median_days_out = excluded.median_days_out,
        p90_days_out    = excluded.p90_days_out,
        worst_days_out  = excluded.worst_days_out,
        bias_days       = excluded.bias_days,
        last_settled_on = excluded.last_settled_on,
        pad_days        = excluded.pad_days,
        enough          = excluded.enough,
        measured_at     = excluded.measured_at;
  get diagnostics v_count = row_count;

  -- A key with nothing left to count loses its row.
  delete from nl.promise_calibration_rollup r
  using pg_temp_calibration_keys k
  where r.vendor_no = k.vendor_no and r.family = k.family
    and r.kind = k.kind and r.basis = k.basis
    and not exists (
      select 1 from nl.promise_record pr
      where pr.counted and pr.vendor_no = k.vendor_no and pr.kind = k.kind
        and pr.basis = k.basis
        and (k.family = '' or coalesce(pr.family, '') = k.family));

  return v_count;
end $$;

-- The keys a set of promise ids belongs to. Both triggers use it, so the
-- definition of "which roll-up rows can this change touch" is written once.
create function nl.calibration_keys_for(p_promise_ids bigint[])
returns table (vendor_no text, family text, kind text, basis text)
language sql stable
set search_path = ''
as $$
  select distinct p.vendor_no, coalesce(i.family, ''), p.kind, p.basis
  from nl.promises p
  left join nl.items i on i.item_no = p.item_no
  where p.id = any (p_promise_ids)
    and p.vendor_no is not null
$$;

-- An outcome landing, changing or going away re-measures the keys it belongs
-- to. Statement-level over a transition table, so seeding thousands of
-- outcomes measures each key once instead of once per row.
create function nl.remeasure_after_outcome_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
  v_vendors  text[];
  v_families text[];
  v_kinds    text[];
  v_bases    text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct promise_id) into v_ids from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct promise_id) into v_ids from old_rows;
  else
    select array_agg(distinct promise_id) into v_ids
    from (select promise_id from new_rows union all select promise_id from old_rows) s;
  end if;

  select array_agg(k.vendor_no), array_agg(k.family), array_agg(k.kind), array_agg(k.basis)
    into v_vendors, v_families, v_kinds, v_bases
  from nl.calibration_keys_for(v_ids) k;

  perform nl.measure_calibration(v_vendors, v_families, v_kinds, v_bases);
  return null;
end $$;

-- A promise changing its basis, its vendor or its part moves it between keys,
-- so both the key it left and the key it joined are re-measured. A promise
-- being deleted takes its outcome with it by cascade, and the cascade does not
-- fire this trigger's DELETE branch on nl.promise_outcomes in a useful order,
-- so the promise's own delete handles it.
create function nl.remeasure_after_promise_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendors  text[];
  v_families text[];
  v_kinds    text[];
  v_bases    text[];
begin
  -- The keys as they are now and as they were, from the rows themselves
  -- rather than from nl.promises, because a deleted row is no longer there.
  if tg_op = 'INSERT' then
    select array_agg(r.vendor_no), array_agg(r.family), array_agg(r.kind), array_agg(r.basis)
      into v_vendors, v_families, v_kinds, v_bases
    from (select distinct n.vendor_no, coalesce(i.family, '') as family, n.kind, n.basis
          from new_rows n left join nl.items i on i.item_no = n.item_no
          where n.vendor_no is not null) r;
  elsif tg_op = 'DELETE' then
    select array_agg(r.vendor_no), array_agg(r.family), array_agg(r.kind), array_agg(r.basis)
      into v_vendors, v_families, v_kinds, v_bases
    from (select distinct o.vendor_no, coalesce(i.family, '') as family, o.kind, o.basis
          from old_rows o left join nl.items i on i.item_no = o.item_no
          where o.vendor_no is not null) r;
  else
    select array_agg(r.vendor_no), array_agg(r.family), array_agg(r.kind), array_agg(r.basis)
      into v_vendors, v_families, v_kinds, v_bases
    from (select distinct s.vendor_no, coalesce(i.family, '') as family, s.kind, s.basis
          from (select vendor_no, item_no, kind, basis from new_rows
                union all
                select vendor_no, item_no, kind, basis from old_rows) s
          left join nl.items i on i.item_no = s.item_no
          where s.vendor_no is not null) r;
  end if;

  perform nl.measure_calibration(v_vendors, v_families, v_kinds, v_bases);
  return null;
end $$;

create trigger promise_outcomes_remeasure_insert
  after insert on nl.promise_outcomes
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_outcome_change();
create trigger promise_outcomes_remeasure_update
  after update on nl.promise_outcomes
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_outcome_change();
create trigger promise_outcomes_remeasure_delete
  after delete on nl.promise_outcomes
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_outcome_change();

create trigger promises_remeasure_update
  after update on nl.promises
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_promise_change();
create trigger promises_remeasure_delete
  after delete on nl.promises
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_promise_change();

-- Keys whose stored figures differ from a fresh computation. Should always be
-- empty; a test requires it and the nightly job repairs it.
create function nl.calibration_drift()
returns table (
  vendor_no text, family text, kind text, basis text,
  stored_settled int, live_settled int,
  stored_pad int, live_pad int
)
language sql stable
set search_path = ''
as $$
  with live as (
    -- The family rows straight off the live view, plus a vendor-wide row per
    -- vendor, kind and basis recomputed over every family at once.
    select vendor_no, family, kind, basis, settled, p90_days_out from nl.promise_calibration_live
    union all
    select
      r.vendor_no, '', r.kind, r.basis,
      count(*)::int,
      round(percentile_cont(nl.promise_percentile())
            within group (order by r.days_out)::numeric, 1)
    from nl.promise_record r
    where r.counted and r.vendor_no is not null and r.kind = 'date'
    group by r.vendor_no, r.kind, r.basis
  ),
  scored as (
    select l.*,
           case when l.settled >= nl.calibration_min_promises()
                then greatest(0, ceil(coalesce(l.p90_days_out, 0))::int)
                else 0 end as pad
    from live l
  )
  select
    coalesce(s.vendor_no, t.vendor_no),
    coalesce(s.family, t.family),
    coalesce(s.kind, t.kind),
    coalesce(s.basis, t.basis),
    t.settled, s.settled, t.pad_days, s.pad
  from scored s
  full join nl.promise_calibration_rollup t
    on t.vendor_no = s.vendor_no and t.family = s.family
   and t.kind = s.kind and t.basis = s.basis
  where t.settled is distinct from s.settled
     or t.pad_days is distinct from s.pad
$$;

-- For the nightly job: fix any drift and say how much there was.
create function nl.repair_calibration() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_vendors  text[];
  v_families text[];
  v_kinds    text[];
  v_bases    text[];
  v_found    int;
begin
  select array_agg(d.vendor_no), array_agg(d.family), array_agg(d.kind), array_agg(d.basis)
    into v_vendors, v_families, v_kinds, v_bases
  from nl.calibration_drift() d;

  v_found := coalesce(cardinality(v_vendors), 0);
  -- Drop the stale rows first: a key that should no longer exist is not fixed
  -- by recounting it, and nl.measure_calibration only deletes keys it was
  -- handed.
  perform nl.measure_calibration(v_vendors, v_families, v_kinds, v_bases);

  return jsonb_build_object('repaired', v_found);
end $$;

-- The correction to apply to a promise about to be made, and why.
--
-- Precedence, which is the whole rule:
--   1. this vendor, this family, this basis, if it has enough settled promises
--   2. this vendor, this basis, across every family
--   3. nothing: no correction, and 'enough' says so rather than pretending
--
-- level names which of the three answered, so a screen never has to guess how
-- specific the number it is showing is.
create function nl.promise_correction(p_vendor_no text, p_family text, p_basis text)
returns table (
  pad_days       int,
  level          text,
  settled        int,
  on_time        int,
  on_time_share  numeric,
  median_days_out numeric,
  p90_days_out   numeric,
  enough         boolean,
  detail         text
)
language sql stable
set search_path = ''
as $$
  with pick as (
    select r.*, case when r.family = '' then 'vendor' else 'family' end as level
    from nl.promise_calibration_rollup r
    where r.vendor_no = p_vendor_no
      and r.kind = 'date'
      and r.basis = p_basis
      and r.enough
      and r.family in (coalesce(p_family, ''), '')
    -- The family row first: it is the more specific record.
    order by (r.family <> '') desc
    limit 1
  )
  select
    p.pad_days,
    p.level,
    p.settled,
    p.on_time,
    p.on_time_share,
    p.median_days_out,
    p.p90_days_out,
    true,
    -- The sentence this whole migration exists to be able to say.
    'Promises on this vendor'
      || case when p.level = 'family' then '''s ' || p_family || ' parts' else '''s parts' end
      || ' from the ' || p_basis || ' lead time were right on '
      || p.on_time || ' of ' || p.settled
      || ', so this date adds the ' || round(nl.promise_percentile() * 100)
      || 'th percentile of the miss, ' || p.pad_days || ' day'
      || case when p.pad_days = 1 then '' else 's' end || '.'
  from pick p
  where p.pad_days > 0
  union all
  -- No correction: either there is not enough history, or the basis is already
  -- honest. Both are worth saying, and they are different sentences.
  select
    0,
    coalesce((select level from pick), 'none'),
    coalesce((select settled from pick), 0),
    coalesce((select on_time from pick), 0),
    (select on_time_share from pick),
    (select median_days_out from pick),
    (select p90_days_out from pick),
    exists (select 1 from pick),
    case
      when not exists (select 1 from pick)
        then 'There are fewer than ' || nl.calibration_min_promises()
             || ' settled promises on this vendor and basis, so nothing is corrected yet.'
      else 'Promises on this vendor from the ' || p_basis || ' lead time were right on '
           || (select on_time from pick) || ' of ' || (select settled from pick)
           || ', so the basis needs no correction.'
    end
  where not exists (select 1 from pick where pad_days > 0)
$$;

-- ---------------------------------------------------------------------------
-- Using it: the promise rule now prefers the calibrated basis
-- ---------------------------------------------------------------------------

-- 0032's rule keeps its body and moves aside under a name that says what it
-- is: the figure before any correction. This is a rename and not a copy, so
-- there is still exactly one place the promise precedence is written.
--
-- nl.vendor_part_lead_times was compiled against the old name and is
-- recreated below so it reads the calibrated figure like everything else.
-- Everything that calls the rule from a text function body
-- (nl.item_lead_days, nl.lead_time_for, nl.customer_parts, nl.answer_for)
-- resolves the name again on its next call and picks up the wrapper with no
-- edit at all.
alter function nl.promise_lead_days(text) rename to promise_lead_days_uncalibrated;

comment on function nl.promise_lead_days_uncalibrated(text) is
  'The promise precedence from 0032, before any measured correction. nl.promise_lead_days() wraps it (migration 0039).';

-- The same nineteen columns 0032 published, with the measured correction
-- applied and named.
--
-- The correction is additive and the basis becomes 'calibrated' only when it
-- actually moved the number, because a word that appears whether or not
-- anything changed stops being information. basis_detail then carries both
-- sentences: what the calibration did, and what it corrected.
create function nl.promise_lead_days(p_item_no text)
returns table (
  item_no             text,
  lead_days           int,
  basis               text,
  detail              text,
  can_promise         boolean,
  vendor_no           text,
  is_primary          boolean,
  receipts            int,
  median_days         numeric,
  p90_days            numeric,
  worst_days          int,
  late_share          numeric,
  quoted_lead_days    int,
  quoted_on           date,
  quote_reference     text,
  vendor_status       text,
  status_note         text,
  replacement_item_no text,
  min_order_qty       int,
  order_multiple      int
)
language sql stable
set search_path = ''
as $$
  select
    b.item_no,
    b.lead_days + coalesce(c.pad_days, 0),
    case when coalesce(c.pad_days, 0) > 0 then 'calibrated' else b.basis end,
    case when coalesce(c.pad_days, 0) > 0
         then c.detail || ' Before the correction it was ' || b.lead_days
              || ' days: ' || b.detail
         else b.detail end,
    b.can_promise,
    b.vendor_no,
    b.is_primary,
    b.receipts,
    b.median_days,
    b.p90_days,
    b.worst_days,
    b.late_share,
    b.quoted_lead_days,
    b.quoted_on,
    b.quote_reference,
    b.vendor_status,
    b.status_note,
    b.replacement_item_no,
    b.min_order_qty,
    b.order_multiple
  from nl.promise_lead_days_uncalibrated(p_item_no) b
  left join nl.items i on i.item_no = b.item_no
  -- One primary key lookup on the roll-up, not a group over the promise
  -- history: this runs once per part on a page that lists hundreds.
  left join lateral nl.promise_correction(b.vendor_no, i.family, b.basis) c
    on b.vendor_no is not null
$$;

comment on function nl.promise_lead_days(text) is
  'The lead time to promise with, and why: 0032''s precedence plus the measured correction from this vendor''s own record (migration 0039).';

-- Recreated so it binds to the wrapper rather than to the renamed function.
-- Same columns, same order, same text: only the name it resolves has moved.
create or replace view nl.vendor_part_lead_times with (security_invoker = true) as
select
  vi.vendor_no,
  vi.item_no,
  i.description,
  i.family,
  vi.is_primary,
  vi.status,
  vi.status_note,
  vi.replacement_item_no,
  vi.min_order_qty,
  vi.order_multiple,
  vi.unit_cost,
  vi.quoted_lead_days,
  vi.quoted_on,
  vi.quote_reference,
  lt.receipts,
  lt.median_days,
  lt.p90_days,
  lt.worst_days,
  lt.late_receipts,
  lt.late_share,
  lt.worst_days_late,
  lt.last_received,
  case when lt.p90_days is not null and vi.quoted_lead_days is not null
       then (lt.p90_days - vi.quoted_lead_days)
  end as tail_days,
  pl.lead_days   as promise_days,
  pl.basis       as promise_basis,
  pl.detail      as promise_detail,
  pl.can_promise,
  coalesce(lt.receipts, 0) >= nl.promise_min_receipts() as history_is_enough
from nl.vendor_items vi
join nl.items i on i.item_no = vi.item_no
left join nl.vendor_item_lead_times lt
  on lt.vendor_no = vi.vendor_no and lt.item_no = vi.item_no
cross join lateral nl.promise_lead_days(vi.item_no) pl;

-- The date to promise for a part, with the basis and the confidence already
-- attached. This is what makes a promise with no basis impossible to make: a
-- caller cannot get a date out of this schema without the two facts that make
-- it scoreable coming with it.
--
-- confidence is measured wherever there is enough history and a stated default
-- otherwise, and confidence_basis says which of the two it is.
create function nl.date_promise_for(p_item_no text, p_from_date date)
returns table (
  item_no          text,
  promised_date    date,
  lead_days        int,
  basis            text,
  basis_detail     text,
  confidence       numeric,
  confidence_basis text,
  can_promise      boolean,
  vendor_no        text,
  correction_days  int,
  correction_level text
)
language sql stable
set search_path = ''
as $$
  select
    l.item_no,
    coalesce(p_from_date, nl.today()) + l.days,
    l.days,
    l.basis,
    l.basis_detail,
    -- The measured share where the record is long enough, else the stated
    -- default for the basis.
    case when c.enough and c.on_time_share is not null
         then greatest(0.01::numeric, least(1::numeric, c.on_time_share))
         else nl.default_confidence(l.basis) end,
    case when c.enough and c.on_time_share is not null then 'measured' else 'policy' end,
    l.can_promise,
    l.vendor_no,
    coalesce(c.pad_days, 0),
    coalesce(c.level, 'none')
  from nl.lead_time_for(p_item_no, p_from_date) l
  left join nl.items i on i.item_no = l.item_no
  left join lateral nl.promise_correction(l.vendor_no, i.family, l.basis) c
    on l.vendor_no is not null
$$;

comment on function nl.date_promise_for(text, date) is
  'The date to promise for a part, with the basis and a confidence already attached, so a promise cannot be made without them (migration 0039).';

-- ---------------------------------------------------------------------------
-- The reading views a screen uses
-- ---------------------------------------------------------------------------

-- One sentence per vendor and basis, the line a vendor page prints. The
-- vendor-wide rows only: a page needs the vendor's record, and the family
-- breakdown is a drill-down.
create view nl.vendor_promise_record with (security_invoker = true) as
select
  r.vendor_no,
  v.name                as vendor_name,
  r.basis,
  r.settled,
  r.on_time,
  r.on_time_share,
  r.median_days_out,
  r.p90_days_out,
  r.worst_days_out,
  r.bias_days,
  r.pad_days,
  r.enough,
  r.last_settled_on,
  -- Over or under promising, in one word, from the middle of the spread
  -- rather than the tail: a basis whose median lands late is optimistic
  -- whatever its worst case did.
  case
    when not r.enough then 'not enough yet'
    when r.median_days_out > nl.promise_tolerance_days() then 'over promising'
    when r.median_days_out < -nl.promise_tolerance_days() then 'under promising'
    else 'about right'
  end                   as verdict,
  'Promised within ' || nl.promise_tolerance_days() || ' days on '
    || r.on_time || ' of ' || r.settled || ' settled '
    || case when r.settled = 1 then 'promise' else 'promises' end
    || ' from the ' || r.basis || ' lead time'
    || case when r.pad_days > 0
            then '; this vendor''s dates now add ' || r.pad_days || ' day'
                 || case when r.pad_days = 1 then '' else 's' end
            else '' end
    || '.'                as line
from nl.promise_calibration_rollup r
join nl.vendors v on v.vendor_no = r.vendor_no
where r.family = '' and r.kind = 'date';

comment on view nl.vendor_promise_record is
  'The calibration line a vendor page prints: how often our dates on this vendor were right, and what the correction is now (migration 0039).';

-- The same thing for one part: the vendor and family record behind the date
-- this part would be promised on today.
create view nl.part_promise_record with (security_invoker = true) as
select
  i.item_no,
  i.family,
  pl.vendor_no,
  pl.basis            as promise_basis,
  pl.lead_days        as promise_days,
  c.pad_days,
  c.level             as correction_level,
  c.settled,
  c.on_time,
  c.on_time_share,
  c.median_days_out,
  c.p90_days_out,
  c.enough,
  c.detail            as correction_detail
from nl.items i
cross join lateral nl.promise_lead_days_uncalibrated(i.item_no) pl
left join lateral nl.promise_correction(pl.vendor_no, i.family, pl.basis) c
  on pl.vendor_no is not null;

comment on view nl.part_promise_record is
  'Per part: the basis its date rests on and the record of our promises on that vendor and basis (migration 0039).';

-- Per maker, which because an agent is a row in nl.users (0031) covers people
-- and agents in one view and one vocabulary. Kept separate from the vendor
-- roll-up because it answers a different question: not "is this vendor
-- reliable" but "is this desk's promising honest".
create view nl.maker_promise_record with (security_invoker = true) as
select
  r.made_by,
  r.maker_name,
  r.maker_kind,
  r.kind,
  r.basis,
  count(*)::int                                              as settled,
  count(*) filter (where r.on_time)::int                     as on_time,
  round(count(*) filter (where r.on_time)::numeric / count(*), 4) as on_time_share,
  round(avg(r.confidence)::numeric, 3)                       as stated_confidence,
  -- The only number that matters about a stated confidence: did it hold. A
  -- desk claiming 90% and landing 60% is miscalibrated whatever its dates did.
  round(count(*) filter (where r.on_time)::numeric / count(*), 3)
    - round(avg(r.confidence)::numeric, 3)                   as confidence_gap,
  round(percentile_cont(0.5) within group (order by r.days_out)::numeric, 1) as median_days_out,
  max(r.settled_on)                                          as last_settled_on
from nl.promise_record r
where r.counted
group by r.made_by, r.maker_name, r.maker_kind, r.kind, r.basis;

comment on view nl.maker_promise_record is
  'Per person or agent: how often their promises held, and whether the confidence they stated held with them (migration 0039).';

-- ---------------------------------------------------------------------------
-- 4. Alternatives, so causal questions stay answerable
-- ---------------------------------------------------------------------------

-- What was considered and not chosen, and why. One row per option, attached to
-- a harness run by its run_key, exactly the key nl.agent_runs carries (0028),
-- so this joins to the run record without a second id.
--
-- Small and structured on purpose. Prose about a rejected vendor cannot be
-- counted, cannot be compared and cannot be shown next to the one that was
-- picked. A row with a value and a reason can.
--
-- fact_kind names what value_num IS, in the disclosure vocabulary from 0031
-- ('unit_cost', 'vendor_lead_time', 'own_price', ...). nl.also_considered()
-- reads it and drops the figure for a reader who may not see that kind of
-- fact. The row keeps the number; the payload does not carry it.
create table nl.decision_alternatives (
  id          bigint generated always as identity (start with 5001) primary key,
  run_key     text not null check (run_key ~ '^[a-z_]+:[0-9]+$'),
  agent       text not null check (length(agent) between 3 and 30),
  work_kind   text not null default '',
  -- What the choice was between: 'vendor', 'price', 'quantity', 'date'.
  choice      text not null check (length(choice) between 3 and 30),
  -- Which option this row is. option_ref is the thing's own id where it has
  -- one (a vendor number, a sheet id), so a reader can go and look at it.
  option_ref  text not null default '',
  label       text not null check (length(label) between 1 and 120),
  value_num   numeric(14, 4),
  value_date  date,
  -- What kind of fact value_num is, for disclosure. Empty when there is no
  -- figure to disclose.
  fact_kind   text not null default '',
  chosen      boolean not null default false,
  -- Why this one was picked, or why it was not. Never optional: an option with
  -- no reason is a list, and a list answers nothing later.
  reason      text not null check (length(btrim(reason)) between 3 and 400),
  rank        int not null default 0,
  at          timestamptz not null default now(),
  request_id  text not null check (length(request_id) between 8 and 100),
  -- The same option, from a retried wake, is one row.
  unique (run_key, choice, option_ref, request_id)
);

comment on table nl.decision_alternatives is
  'What an agent considered and did not choose, with the reason, keyed to its harness run (migration 0039).';

create index decision_alternatives_run_idx on nl.decision_alternatives (run_key, choice, rank);
create index decision_alternatives_chosen_idx on nl.decision_alternatives (run_key) where chosen;

-- Record a whole set of options in one call, because a set is the unit that
-- means anything: one option is not an alternative and a set with nothing
-- chosen is not a decision. Both are refused.
--
-- p_options is a JSON array of objects:
--   { "ref": "V1042", "label": "Brightwater Forge", "value": 18.40,
--     "fact_kind": "unit_cost", "value_date": "2026-10-02",
--     "chosen": true, "reason": "Primary source, 34 day record" }
create function nl.record_alternatives(
  p_run_key    text,
  p_agent      text,
  p_work_kind  text,
  p_choice     text,
  p_options    jsonb,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_count   int;
  v_chosen  int;
  v_written int;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_alternatives');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_run_key is null or p_run_key !~ '^[a-z_]+:[0-9]+$' then
    raise exception 'A run key reads like procurement_desk:412, not %.',
      coalesce(p_run_key, 'empty') using errcode = 'NL422';
  end if;
  if p_choice is null or length(btrim(p_choice)) < 3 then
    raise exception 'An alternative set says what the choice was between.' using errcode = 'NL422';
  end if;
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    raise exception 'The options are a JSON array.' using errcode = 'NL422';
  end if;

  v_count := jsonb_array_length(p_options);
  if v_count < 2 then
    raise exception 'A set of one is not an alternative. Record what was not chosen as well.'
      using errcode = 'NL422';
  end if;

  select count(*) into v_chosen
  from jsonb_array_elements(p_options) as o
  where coalesce((o.value ->> 'chosen')::boolean, false);
  if v_chosen <> 1 then
    raise exception 'Exactly one option is the one that was chosen, not %.', v_chosen
      using errcode = 'NL422';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_options) as o
    where length(btrim(coalesce(o.value ->> 'reason', ''))) < 3
  ) then
    raise exception 'Every option carries the reason it was chosen or passed over.'
      using errcode = 'NL422';
  end if;

  insert into nl.decision_alternatives
    (run_key, agent, work_kind, choice, option_ref, label, value_num, value_date,
     fact_kind, chosen, reason, rank, request_id)
  select
    p_run_key,
    p_agent,
    left(coalesce(p_work_kind, ''), 30),
    btrim(p_choice),
    left(coalesce(o.value ->> 'ref', ''), 60),
    left(btrim(o.value ->> 'label'), 120),
    (o.value ->> 'value')::numeric,
    (o.value ->> 'value_date')::date,
    left(coalesce(o.value ->> 'fact_kind', ''), 40),
    coalesce((o.value ->> 'chosen')::boolean, false),
    left(btrim(o.value ->> 'reason'), 400),
    -- The order they were considered in, which is itself a fact about the
    -- decision: the chosen one is not always first.
    (o.ordinality - 1)::int,
    p_request_id
  from jsonb_array_elements(p_options) with ordinality as o (value, ordinality)
  on conflict (run_key, choice, option_ref, request_id) do nothing;
  get diagnostics v_written = row_count;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'record_alternatives', 'agent_run', p_run_key, p_request_id,
          jsonb_build_object('choice', btrim(p_choice), 'options', v_count, 'written', v_written));

  v_result := jsonb_build_object('run_key', p_run_key, 'choice', btrim(p_choice),
                                 'options', v_count, 'recorded', v_written);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- The "also considered" payload for one run, assembled with disclosure
-- applied. A figure whose fact kind the reader may not see is left out of the
-- payload entirely rather than nulled in place, so nothing downstream can
-- print a zero where a cost used to be.
--
-- Disclosure is checked here, on the assembled value, and not in any template:
-- docs/roles.md, and the same rule 0032's answer payload follows.
create function nl.also_considered(p_run_key text) returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(c.entry order by c.choice),
    '[]'::jsonb)
  from (
    select
      a.choice,
      jsonb_build_object(
        'choice', a.choice,
        'agent', min(a.agent),
        'work_kind', min(a.work_kind),
        'options', jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'ref', nullif(a.option_ref, ''),
            'label', a.label,
            -- The figure, only where this reader may be shown that kind of
            -- fact. A blank fact kind is a figure nobody classified, and an
            -- unclassified figure is withheld rather than guessed at.
            'value', case
              when a.value_num is null then null
              when a.fact_kind <> '' and nl.may_see((select nl.current_user_id()), a.fact_kind)
                then a.value_num
            end,
            'value_withheld', case
              when a.value_num is not null
                and not (a.fact_kind <> ''
                         and nl.may_see((select nl.current_user_id()), a.fact_kind))
              then true
            end,
            'fact_kind', nullif(a.fact_kind, ''),
            'value_date', a.value_date,
            'chosen', a.chosen,
            'reason', a.reason))
          order by a.rank, a.id)
      ) as entry
    from nl.decision_alternatives a
    where a.run_key = p_run_key
    group by a.choice
  ) c
$$;

comment on function nl.also_considered(text) is
  'The alternatives recorded on one run, as a payload with disclosure already applied through nl.may_see (migration 0039).';

-- ---------------------------------------------------------------------------
-- Writes: recording a promise and settling it
-- ---------------------------------------------------------------------------

-- Record one promise. Follows the repository's write rules: it claims the
-- request id, requires an active user, checks its fields with NL4xx codes.
--
-- The refusal that matters: no basis, no promise. Not a default, not a
-- placeholder, not 'unknown'. A promise whose provenance nobody can look up
-- cannot be scored later, and a promise that cannot be scored is exactly the
-- thing this table exists to stop the system making.
create function nl.record_promise(
  p_kind             text,
  p_subject          text,
  p_subject_id       text,
  p_item_no          text,
  p_customer_no      text,
  p_vendor_no        text,
  p_promised_date    date,
  p_promised_value   numeric,
  p_basis            text,
  p_basis_detail     text,
  p_confidence       numeric,
  p_confidence_basis text,
  p_as_of            date,
  p_run_key          text,
  p_request_id       text
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
  v_replay := nl.claim_request(p_request_id, 'record_promise');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_kind is null or p_kind not in ('date', 'price', 'coverage') then
    raise exception 'A promise is a date, a price or a coverage figure, not %.',
      coalesce(p_kind, 'empty') using errcode = 'NL422';
  end if;
  if p_subject is null or length(btrim(p_subject)) < 3 then
    raise exception 'A promise names what it was about.' using errcode = 'NL422';
  end if;
  if p_subject_id is null or length(btrim(p_subject_id)) = 0 then
    raise exception 'A promise names which % it was about.', btrim(p_subject)
      using errcode = 'NL422';
  end if;

  -- The rule of this whole migration.
  if p_basis is null or length(btrim(p_basis)) = 0 then
    -- RAISE takes a literal, not an expression, so this message is one string.
    raise exception 'A promise records the basis it was made on. Without one it cannot be scored later, which is the only reason to record it at all.'
      using errcode = 'NL422';
  end if;
  if btrim(p_basis) <> all (nl.promise_bases()) then
    raise exception '% is not a basis this schema knows. Use one of: %.',
      btrim(p_basis), array_to_string(nl.promise_bases(), ', ') using errcode = 'NL422';
  end if;
  if p_confidence is null then
    raise exception 'A promise records how sure it was. Use nl.default_confidence(%) if nothing has been measured yet.', quote_literal(btrim(p_basis))
      using errcode = 'NL422';
  end if;
  if p_confidence <= 0 or p_confidence > 1 then
    raise exception 'A confidence is a share between 0 and 1, not %.', p_confidence
      using errcode = 'NL422';
  end if;
  if p_confidence_basis is null or btrim(p_confidence_basis) <> all (nl.confidence_bases()) then
    raise exception 'A confidence says where it came from: one of %.',
      array_to_string(nl.confidence_bases(), ', ') using errcode = 'NL422';
  end if;

  if p_kind = 'date' and p_promised_date is null then
    raise exception 'A date promise has a date on it.' using errcode = 'NL422';
  end if;
  if p_kind <> 'date' and p_promised_value is null then
    raise exception 'A % promise has a figure on it.', p_kind using errcode = 'NL422';
  end if;
  if p_run_key is not null and p_run_key !~ '^[a-z_]+:[0-9]+$' then
    raise exception 'A run key reads like procurement_desk:412, not %.', p_run_key
      using errcode = 'NL422';
  end if;

  insert into nl.promises
    (kind, subject, subject_id, item_no, customer_no, vendor_no, promised_date, promised_value,
     basis, basis_detail, confidence, confidence_basis, as_of, made_by, run_key, request_id)
  values
    (p_kind, btrim(p_subject), btrim(p_subject_id), p_item_no, p_customer_no, p_vendor_no,
     p_promised_date, p_promised_value, btrim(p_basis), left(coalesce(p_basis_detail, ''), 1000),
     p_confidence, btrim(p_confidence_basis), coalesce(p_as_of, nl.today()),
     v_actor.id, p_run_key, p_request_id)
  on conflict (kind, subject, subject_id, request_id) do nothing
  returning id into v_id;

  if v_id is null then
    select p.id into v_id from nl.promises p
    where p.kind = p_kind and p.subject = btrim(p_subject)
      and p.subject_id = btrim(p_subject_id) and p.request_id = p_request_id;
    v_result := jsonb_build_object('promise_id', v_id, 'recorded', false);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  v_result := jsonb_build_object('promise_id', v_id, 'basis', btrim(p_basis),
                                 'confidence', p_confidence, 'recorded', true);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Make a date promise from the rule, in one call, so the basis and the
-- confidence cannot be left off by a caller who was in a hurry. This is the
-- function a feature should use; nl.record_promise is for the cases the rule
-- does not cover.
create function nl.promise_a_date(
  p_subject     text,
  p_subject_id  text,
  p_item_no     text,
  p_customer_no text,
  p_from_date   date,
  p_run_key     text,
  p_request_id  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p record;
begin
  select * into v_p from nl.date_promise_for(p_item_no, p_from_date);
  if not found then
    raise exception 'Part % is not in the catalog, so there is no date to promise.',
      coalesce(p_item_no, 'empty') using errcode = 'NL404';
  end if;
  if not v_p.can_promise then
    raise exception 'Part % should not be given a date: %.', p_item_no, v_p.basis_detail
      using errcode = 'NL422';
  end if;

  return nl.record_promise(
    'date', p_subject, p_subject_id, p_item_no, p_customer_no, v_p.vendor_no,
    v_p.promised_date, null, v_p.basis, v_p.basis_detail,
    v_p.confidence, v_p.confidence_basis, coalesce(p_from_date, nl.today()),
    p_run_key, p_request_id);
end $$;

-- Settle a promise against what happened. One row per promise: a settled
-- promise is not settled again, and a second call replays rather than
-- rewriting history.
create function nl.settle_promise(
  p_promise_id   bigint,
  p_outcome      text,
  p_actual_date  date,
  p_actual_value numeric,
  p_source       text,
  p_detail       text,
  p_request_id   text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_promise nl.promises;
  v_result  jsonb;
  v_written boolean := true;
begin
  v_replay := nl.claim_request(p_request_id, 'settle_promise');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_promise from nl.promises where id = p_promise_id;
  if not found then
    raise exception 'Promise % does not exist.', coalesce(p_promise_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  if p_outcome is null or p_outcome not in ('kept', 'missed', 'void') then
    raise exception 'An outcome is kept, missed or void, not %.', coalesce(p_outcome, 'empty')
      using errcode = 'NL422';
  end if;
  if p_source is null or length(btrim(p_source)) < 3 then
    raise exception 'An outcome says where the answer came from.' using errcode = 'NL422';
  end if;
  if p_outcome <> 'void' and v_promise.kind = 'date' and p_actual_date is null then
    raise exception 'Settling a date promise needs the date it actually happened.'
      using errcode = 'NL422';
  end if;
  -- A price or coverage promise that was kept has a figure; one that was
  -- missed often does not. When a customer buys elsewhere we do not learn
  -- what they paid, and inventing a number there would be worse than leaving
  -- it null: the outcome is what is known, and the outcome is 'missed'.
  if p_outcome = 'kept' and v_promise.kind <> 'date' and p_actual_value is null then
    raise exception 'A kept % promise records the figure it actually came to.', v_promise.kind
      using errcode = 'NL422';
  end if;

  insert into nl.promise_outcomes
    (promise_id, outcome, actual_date, actual_value, settled_on, source, detail,
     settled_by, request_id)
  values
    (p_promise_id, p_outcome,
     case when p_outcome = 'void' then null else p_actual_date end,
     case when p_outcome = 'void' then null else p_actual_value end,
     nl.today(), btrim(p_source), left(coalesce(p_detail, ''), 1000),
     v_actor.id, p_request_id)
  on conflict (promise_id) do nothing;
  if not found then
    v_written := false;
  end if;

  v_result := jsonb_build_object('promise_id', p_promise_id, 'outcome', p_outcome,
                                 'recorded', v_written);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.promises enable row level security;
alter table nl.promise_outcomes enable row level security;
alter table nl.decision_alternatives enable row level security;

-- A promise and what happened to it is the team's record, not a private one.
-- Everybody reads it; nobody writes it except through the checked functions
-- above, which are security definer and name who asked.
create policy promises_read on nl.promises for select to nl_app, nl_readonly using (true);
create policy promise_outcomes_read on nl.promise_outcomes
  for select to nl_app, nl_readonly using (true);
create policy decision_alternatives_read on nl.decision_alternatives
  for select to nl_app, nl_readonly using (true);

grant select on nl.promises, nl.promise_outcomes, nl.decision_alternatives
  to nl_app, nl_readonly;
grant select on nl.promise_record, nl.promise_calibration_live,
                nl.vendor_promise_record, nl.part_promise_record
  to nl_app, nl_readonly;
-- nl.maker_promise_record names people. nl_readonly reads reference data, not
-- who was wrong last quarter.
grant select on nl.maker_promise_record to nl_app;

grant execute on function
  nl.promise_tolerance_days(),
  nl.calibration_min_promises(),
  nl.promise_bases(),
  nl.confidence_bases(),
  nl.default_confidence(text),
  nl.promise_correction(text, text, text),
  nl.promise_lead_days(text),
  nl.promise_lead_days_uncalibrated(text),
  nl.date_promise_for(text, date),
  nl.also_considered(text),
  nl.record_promise(text, text, text, text, text, text, date, numeric, text, text,
                    numeric, text, date, text, text),
  nl.promise_a_date(text, text, text, text, date, text, text),
  nl.settle_promise(bigint, text, date, numeric, text, text, text),
  nl.record_alternatives(text, text, text, text, jsonb, text)
to nl_app;

grant execute on function
  nl.promise_tolerance_days(),
  nl.calibration_min_promises(),
  nl.promise_bases(),
  nl.confidence_bases(),
  nl.default_confidence(text),
  nl.promise_correction(text, text, text),
  nl.promise_lead_days(text),
  nl.promise_lead_days_uncalibrated(text),
  nl.date_promise_for(text, date)
to nl_readonly;

-- The roll-up's own machinery belongs to the triggers and the nightly job.
revoke execute on function
  nl.measure_calibration(text[], text[], text[], text[]),
  nl.calibration_keys_for(bigint[]),
  nl.remeasure_after_outcome_change(),
  nl.remeasure_after_promise_change(),
  nl.calibration_drift(),
  nl.repair_calibration()
from public;
