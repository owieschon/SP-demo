-- 0039 The executive overview: one fast roll-up of the ledger, and the three
-- named money leaks behind it.
--
-- Everything on /overview has to be a link, and the page has to arrive in a
-- few hundred milliseconds, so this migration does two separate jobs.
--
-- 1. THE LEDGER BY MONTH, KEPT CURRENT. Revenue and margin for a period
--    against the same period last year is a group-by over the whole invoice
--    ledger, and nl.invoice_lines has no index on posted_on at all, so it was
--    a sequential scan of 450,000 rows. This follows the pattern migration
--    0008 set for the delivered figure: add the index the measurement needs,
--    store the figure per month, keep it current with statement-level
--    triggers over transition tables, and prove it with a drift check and a
--    repair function. Nothing is derived twice: the page reads the stored
--    month rows and nl.ledger_month_drift() recounts the ledger to check them.
--
-- 2. THE THREE LEAKS, AS VIEWS. Each one names the customers and parts behind
--    it and reaches the invoice lines that prove it. None is stored: each one
--    reads a small table (agreements, cost revisions) or one year of invoice
--    headers, so they group once per question and do not grow with history.
--
--    nl.invoice_freight          freight billed against the tariff of the day
--    nl.overview_price_exceptions  agreements that outlived the cost they were
--                                  priced against
--    nl.overview_cost_passthrough  a cost rise the selling price never followed
--
-- The margin definition here is the one nl.item_margin_history and
-- nl.customer_margin already use: revenue is sum(amount) and cost of goods is
-- sum(quantity * unit_cost) from the line, so a cost revision today cannot
-- rewrite last year. Credit memo lines are in, with their negative signs, for
-- the same reason those views include them.

-- ---------------------------------------------------------------------------
-- 1. The ledger by month
-- ---------------------------------------------------------------------------

-- The lookup the measurement makes: a range of posting dates, carrying
-- everything the sums need so the scan never visits the table. 0005 did the
-- same thing for the delivery lookup.
create index invoice_lines_posted_idx
  on nl.invoice_lines (posted_on)
  include (quantity, amount, unit_cost);

create table nl.ledger_month (
  month         date primary key,
  lines         bigint not null,
  units         bigint not null,
  revenue       numeric(16, 2) not null,
  cost_of_goods numeric(16, 2) not null,
  measured_at   timestamptz not null default now(),
  constraint ledger_month_is_a_month check (month = date_trunc('month', month)::date)
);

comment on table nl.ledger_month is
  'Revenue, cost of goods and line count per calendar month, kept current by triggers (migration 0039). Nobody writes it directly.';

alter table nl.ledger_month enable row level security;

-- The ledger itself is readable by everyone signed in (migration 0002), so a
-- roll-up of it is too. It names no person.
create policy ledger_month_read on nl.ledger_month
  for select to nl_app, nl_readonly using (true);
grant select on nl.ledger_month to nl_app, nl_readonly;

-- Re-measure the given months and store the result.
--
-- The months arrive as an array and are joined to the ledger one at a time, so
-- each one is its own range scan on the new index rather than one scan of
-- everything between the earliest and the latest.
--
-- SECURITY DEFINER: the triggers below fire inside a signed-in person's write
-- and have to update a table no person may write. Nobody is granted EXECUTE.
create function nl.measure_ledger_months(p_months date[]) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_months is null or cardinality(p_months) = 0 then
    return 0;
  end if;

  with want as (
    select m.month,
           count(il.invoice_no)::bigint                  as lines,
           coalesce(sum(il.quantity), 0)::bigint         as units,
           coalesce(sum(il.amount), 0)                   as revenue,
           coalesce(sum(il.quantity * il.unit_cost), 0)  as cost_of_goods
    from unnest(p_months) as m (month)
    left join nl.invoice_lines il
      on il.posted_on >= m.month
     and il.posted_on < (m.month + interval '1 month')::date
    group by m.month
  ),
  -- A month whose last line was deleted has no row, rather than a row of
  -- zeros: the drift check below compares against a group-by of the ledger,
  -- which produces no row for an empty month either.
  emptied as (
    delete from nl.ledger_month d
    using want w
    where d.month = w.month and w.lines = 0
    returning d.month
  )
  insert into nl.ledger_month (month, lines, units, revenue, cost_of_goods, measured_at)
  select w.month, w.lines, w.units, w.revenue, w.cost_of_goods, now()
  from want w
  where w.lines > 0
  on conflict (month) do update
    set lines         = excluded.lines,
        units         = excluded.units,
        revenue       = excluded.revenue,
        cost_of_goods = excluded.cost_of_goods,
        measured_at   = excluded.measured_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Which months a set of changed lines can touch. An update is the union of
-- both sides, because a corrected posting date moves a line between months.
create function nl.remeasure_ledger_months() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_months date[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct date_trunc('month', posted_on)::date) into v_months from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct date_trunc('month', posted_on)::date) into v_months from old_rows;
  else
    select array_agg(distinct date_trunc('month', posted_on)::date) into v_months
    from (select posted_on from new_rows union select posted_on from old_rows) s;
  end if;
  perform nl.measure_ledger_months(v_months);
  return null;
end $$;

-- Statement-level, so an import of a thousand lines re-measures each month
-- once. The world generator inserts a year of lines in one statement and the
-- cost restamp (db/seed.d/55) updates every line in one statement, and both
-- cost one pass each rather than one per row.
create trigger invoice_lines_ledger_month_insert
  after insert on nl.invoice_lines
  referencing new table as new_rows
  for each statement execute function nl.remeasure_ledger_months();
create trigger invoice_lines_ledger_month_update
  after update on nl.invoice_lines
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_ledger_months();
create trigger invoice_lines_ledger_month_delete
  after delete on nl.invoice_lines
  referencing old table as old_rows
  for each statement execute function nl.remeasure_ledger_months();

-- Months whose stored figures differ from a fresh count of the ledger. Should
-- always be empty. A full join, so a month stored that should not exist and a
-- month missing that should both show up.
create function nl.ledger_month_drift()
returns table (
  month            date,
  stored_lines     bigint,
  measured_lines   bigint,
  stored_revenue   numeric,
  measured_revenue numeric,
  stored_cost      numeric,
  measured_cost    numeric
)
language sql stable
set search_path = ''
as $$
  with measured as (
    select date_trunc('month', il.posted_on)::date        as month,
           count(*)::bigint                              as lines,
           sum(il.amount)                                as revenue,
           sum(il.quantity * il.unit_cost)               as cost_of_goods
    from nl.invoice_lines il
    group by 1
  )
  select coalesce(s.month, m.month),
         s.lines, m.lines,
         s.revenue, m.revenue,
         s.cost_of_goods, m.cost_of_goods
  from nl.ledger_month s
  full join measured m on m.month = s.month
  where (s.lines, s.revenue, s.cost_of_goods)
        is distinct from (m.lines, m.revenue, m.cost_of_goods)
$$;

-- For the nightly job, beside nl.repair_delivery(): fix any drift and say
-- what there was. Nothing is expected; it is here so a bug shows up in the
-- job log instead of on the front page.
create function nl.repair_ledger_month() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_months date[];
begin
  select array_agg(month order by month) into v_months from nl.ledger_month_drift();
  perform nl.measure_ledger_months(v_months);
  return jsonb_build_object('repaired', coalesce(to_jsonb(v_months), '[]'::jsonb));
end $$;

revoke execute on function
  nl.measure_ledger_months(date[]),
  nl.remeasure_ledger_months(),
  nl.ledger_month_drift(),
  nl.repair_ledger_month()
from public;

-- Measure whatever is already in the ledger. At migration time there is
-- nothing; the triggers take it from there.
select nl.measure_ledger_months(
  array(select distinct date_trunc('month', posted_on)::date from nl.invoice_lines));

-- ---------------------------------------------------------------------------
-- 2a. Freight, per invoice
-- ---------------------------------------------------------------------------

-- nl.freight_by_month (migration 0018) answers "did freight pay for itself
-- this month". It cannot say who did not pay, and the overview has to name
-- the accounts. This is the same rule at invoice grain.
--
-- The four CTEs are lifted from nl.freight_by_month on purpose, including the
-- rule that an invoice older than the freight history is priced at the oldest
-- tariff. Calling nl.freight_for() once per invoice would be correct and slow:
-- every function in this schema pins its search_path, which stops Postgres
-- inlining it, so a call per row stays a call per row. The tariff tables hold
-- a few dozen rows between them, so turning them into date and subtotal
-- ranges and joining once costs one pass. Because the rule now exists twice,
-- a test aggregates this view by month and requires it to equal
-- nl.freight_by_month exactly.
create view nl.invoice_freight with (security_invoker = true) as
with tariff as (
  select
    p.effective_from,
    coalesce(lead(p.effective_from) over (order by p.effective_from), date '9999-12-31') as until,
    p.free_over
  from nl.freight_periods p
),
bands as (
  select
    r.effective_from,
    r.min_subtotal,
    coalesce(lead(r.min_subtotal) over (partition by r.effective_from order by r.min_subtotal),
             999999999::numeric) as max_subtotal,
    r.rate
  from nl.freight_rates r
),
surcharge as (
  select g.month::date as month, f.percent
  from (
    select
      s.month,
      coalesce(lead(s.month) over (order by s.month),
               (date_trunc('month', nl.today()) + interval '1 year')::date) as until,
      s.percent
    from nl.fuel_surcharge s
  ) f
  cross join generate_series(f.month, f.until - interval '1 month', interval '1 month') as g (month)
),
first_period as (
  select min(effective_from) as effective_from from nl.freight_periods
),
priced as (
  select
    i.invoice_no,
    i.customer_no,
    i.posted_on,
    date_trunc('month', i.posted_on)::date as month,
    i.subtotal,
    i.freight as freight_billed,
    t.free_over,
    case when i.subtotal >= t.free_over then 0::numeric
         else round(b.rate * (1 + coalesce(s.percent, 0) / 100), 2)
    end as freight_at_rate
  from nl.invoices i
  cross join first_period fp
  join tariff t
    on greatest(i.posted_on, fp.effective_from) >= t.effective_from
   and greatest(i.posted_on, fp.effective_from) < t.until
  join bands b
    on b.effective_from = t.effective_from
   and greatest(i.subtotal, 0) >= b.min_subtotal
   and greatest(i.subtotal, 0) < b.max_subtotal
  left join surcharge s
    on s.month = date_trunc('month', greatest(i.posted_on, fp.effective_from))::date
  where i.doc_type = 'invoice'
)
select
  p.invoice_no,
  p.customer_no,
  c.name        as customer_name,
  c.owner_id,
  -- The only freight term this business records on the sales side: an account
  -- that ships on its own carrier account was never meant to be billed, so it
  -- is not a leak. The overview leaves these out and says so.
  c.ships_own_carrier,
  p.posted_on,
  p.month,
  p.subtotal,
  p.freight_billed,
  p.freight_at_rate,
  p.free_over,
  p.subtotal >= p.free_over                              as shipped_free_by_policy,
  greatest(p.freight_at_rate - p.freight_billed, 0)      as shortfall
from priced p
join nl.customers c on c.customer_no = p.customer_no;

comment on view nl.invoice_freight is
  'Freight billed on each invoice against the tariff of the day, with the shortfall (migration 0039). The same rule as nl.freight_by_month, at invoice grain.';

grant select on nl.invoice_freight to nl_app, nl_readonly;

-- ---------------------------------------------------------------------------
-- 2b. Price agreements that outlived the cost they were priced against
-- ---------------------------------------------------------------------------

-- An agreed price beats every other rule, even below the margin floor, on
-- purpose (see nl.price_for). Nothing in the schema ever revisits it:
-- valid_to null means the agreement runs forever. Cost does not.
--
-- So the exception that outlived its reason is an open-ended agreement whose
-- price has not moved since the day it was signed while the cost it was
-- priced against has gone up. The money is what that cost us on what was
-- actually billed: the rise in cost, times the units this account bought of
-- this part in the last year. Nothing is modelled and nothing is assumed
-- about what the price should have been; the rise is two rows of
-- nl.item_costs and the units are invoice lines.
--
-- below_floor_now is carried as well, because an agreement under the floor is
-- the version of this a person has to answer today rather than at renewal. It
-- is a flag on the row, not the filter: in a healthy book almost nothing is
-- under the floor and the erosion is still real.
--
-- This leak and nl.overview_cost_passthrough can count the same dollar, from
-- the account's side and the part's side. They are never added together.
create view nl.overview_price_exceptions with (security_invoker = true) as
with clock as (select nl.today() as today)
select
  cp.customer_no,
  c.name                                        as customer_name,
  c.owner_id,
  cp.item_no,
  i.description,
  cp.net_price,
  cp.valid_from,
  cp.note,
  cp.agreed_by,
  k.today - cp.valid_from                       as days_in_force,
  cost.cost_when_agreed,
  cost.cost_today,
  cost.cost_today - cost.cost_when_agreed       as cost_rise,
  cost.floor_today,
  cp.net_price < cost.floor_today               as below_floor_now,
  case when cp.net_price > 0
       then round((cp.net_price - cost.cost_when_agreed) / cp.net_price, 4)
  end                                           as margin_when_agreed,
  case when cp.net_price > 0
       then round((cp.net_price - cost.cost_today) / cp.net_price, 4)
  end                                           as margin_now,
  billed.lines,
  billed.units,
  billed.revenue,
  -- The cost increase the frozen price absorbed, on what was billed.
  round((cost.cost_today - cost.cost_when_agreed) * billed.units, 2) as absorbed
from nl.customer_prices cp
cross join clock k
join nl.customers c on c.customer_no = cp.customer_no
join nl.items i on i.item_no = cp.item_no
-- Two lookups per agreement, not three: nl.item_cost_on pins its search_path
-- and so cannot be inlined, which makes every call a real call. The floor is
-- derived from the cost this subquery already has.
cross join lateral (
  select nl.item_cost_on(cp.item_no, cp.valid_from) as cost_when_agreed,
         nl.item_cost_on(cp.item_no, k.today)       as cost_today
) costs
cross join lateral (
  select costs.cost_when_agreed,
         costs.cost_today,
         round(costs.cost_today / (1 - nl.min_margin()), 2) as floor_today
) cost
cross join lateral (
  -- Credit memo lines are left out: a return does not give a price back, and
  -- its negative quantity would quietly reduce the figure.
  select count(*)::int                    as lines,
         coalesce(sum(il.quantity), 0)::int as units,
         coalesce(sum(il.amount), 0)        as revenue
  from nl.invoice_lines il
  where il.customer_no = cp.customer_no
    and il.item_no = cp.item_no
    and il.quantity > 0
    and il.posted_on > k.today - 365
    and il.posted_on <= k.today
) billed
where cp.valid_to is null
  and cost.cost_today > cost.cost_when_agreed
  and billed.units > 0;

comment on view nl.overview_price_exceptions is
  'Open-ended price agreements the cost has risen underneath, with the cost increase the frozen price absorbed on the last year of invoice lines (migration 0039).';

grant select on nl.overview_price_exceptions to nl_app, nl_readonly;

-- ---------------------------------------------------------------------------
-- 2c. A cost rise the selling price never followed
-- ---------------------------------------------------------------------------

-- nl.item_cost_timeline already differences the cost history. This takes each
-- part's most recent rise inside the last year and asks whether the price
-- moved with it: the volume-weighted price paid in the year before the rise
-- against the price paid since. What the price did not pick up, times the
-- units sold since, is the money.
--
-- Only parts with at least three invoice lines on each side are in, because
-- an average of one line is not a price level. The two windows are index
-- lookups on invoice_lines_item_posted_idx (migration 0015), which carries
-- quantity and amount, so neither visits the table.
create view nl.overview_cost_passthrough with (security_invoker = true) as
with clock as (select nl.today() as today),
rises as (
  select
    t.item_no,
    t.effective_from                     as rose_on,
    t.unit_cost                          as cost_after,
    t.unit_cost - t.change               as cost_before,
    t.change                             as cost_step,
    t.change_pct                         as cost_step_pct,
    t.source,
    t.note,
    row_number() over (partition by t.item_no order by t.effective_from desc) as rn
  from nl.item_cost_timeline t
  cross join clock k
  where t.change > 0
    and t.effective_from > k.today - 365
    and t.effective_from <= k.today
),
latest as (select * from rises where rn = 1)
select
  r.item_no,
  i.description,
  i.family,
  i.product_group,
  r.rose_on,
  r.cost_before,
  r.cost_after,
  r.cost_step,
  r.cost_step_pct,
  r.source,
  r.note,
  was.lines                                            as lines_before,
  was.avg_price                                        as price_before,
  now_.lines                                           as lines_since,
  now_.units                                           as units_since,
  now_.revenue                                         as revenue_since,
  now_.avg_price                                       as price_since,
  round(now_.avg_price - was.avg_price, 2)             as passed_through,
  round(greatest(r.cost_step - (now_.avg_price - was.avg_price), 0), 2)
                                                       as not_recovered,
  round(greatest(r.cost_step - (now_.avg_price - was.avg_price), 0) * now_.units, 2)
                                                       as shortfall
from latest r
cross join clock k
join nl.items i on i.item_no = r.item_no
cross join lateral (
  select count(*)::int as lines,
         case when sum(il.quantity) > 0 then round(sum(il.amount) / sum(il.quantity), 2) end as avg_price
  from nl.invoice_lines il
  where il.item_no = r.item_no
    and il.quantity > 0
    and il.posted_on >= r.rose_on - 365
    and il.posted_on < r.rose_on
) was
cross join lateral (
  select count(*)::int as lines,
         coalesce(sum(il.quantity), 0)::int as units,
         coalesce(sum(il.amount), 0) as revenue,
         case when sum(il.quantity) > 0 then round(sum(il.amount) / sum(il.quantity), 2) end as avg_price
  from nl.invoice_lines il
  where il.item_no = r.item_no
    and il.quantity > 0
    and il.posted_on >= r.rose_on
    and il.posted_on <= k.today
) now_
where was.lines >= 3
  and now_.lines >= 3
  and was.avg_price is not null
  and now_.avg_price is not null
  and r.cost_step > (now_.avg_price - was.avg_price);

comment on view nl.overview_cost_passthrough is
  'Parts whose cost rose in the last year by more than the selling price did, with the units sold since (migration 0039).';

grant select on nl.overview_cost_passthrough to nl_app, nl_readonly;

-- ---------------------------------------------------------------------------
-- 3. Coverage of responsibility
-- ---------------------------------------------------------------------------

-- What nobody is answerable for.
--
-- This is the question an executive asks that no dashboard answers, and it is
-- not the same question as scope. Scope says who MAY see or touch a thing, and
-- the chief executive holds every dimension, so by scope nothing is
-- uncovered. Accountability is narrower: it is somebody named against that
-- particular account, part family or mailbox. A principal holding the whole
-- dimension (a nl.user_scope row with a null value) is oversight, not
-- accountability, so it does not cover anything on its own. That distinction
-- is the whole view, and it is said on the page as well as here.
--
-- Three kinds, one shape:
--
--   account       a live account with no owner and nobody holding it by name
--   part_family   a family of parts with nobody named against it
--   mailbox       a live inbox whose reviewer is gone, or who does not hold it
--
-- The money on each row is the last year of invoice lines, so the list sorts
-- by what is actually at stake rather than by row count. Agents are excluded
-- from "somebody": an inbox whose only holder is the agent that drafts from it
-- has nobody answering for it, which is exactly the gap.
create view nl.responsibility_gaps with (security_invoker = true) as
with accountable as (
  -- One row per (dimension, value) that a named, active person holds.
  select s.dimension, s.value
  from nl.user_scope s
  join nl.users u on u.id = s.user_id
  where s.value is not null
    and u.active
    and u.kind = 'person'
  group by s.dimension, s.value
),
year as (select nl.today() - 365 as since, nl.today() as until),
accounts as (
  select
    'account'::text                           as kind,
    c.customer_no                             as ref,
    c.name                                    as subject,
    case when c.owner_id is null
         then 'No account owner, and nobody holds this account by name.'
         else 'The owner is no longer an active person, and nobody holds this account by name.'
    end                                       as why,
    coalesce(rev.amount, 0)                   as amount,
    coalesce(rev.lines, 0)                    as lines
  from nl.customers c
  cross join year y
  left join lateral (
    select sum(il.amount) as amount, count(*)::int as lines
    from nl.invoice_lines il
    where il.customer_no = c.customer_no
      and il.posted_on > y.since and il.posted_on <= y.until
  ) rev on true
  where not c.closed
    and not exists (
      select 1 from nl.users o where o.id = c.owner_id and o.active and o.kind = 'person')
    and not exists (
      select 1 from accountable a where a.dimension = 'account' and a.value = c.customer_no)
),
families as (
  select
    'part_family'::text                       as kind,
    f.family                                  as ref,
    f.family                                  as subject,
    'No planner or buyer is named against this part family.'::text as why,
    coalesce(rev.amount, 0)                   as amount,
    f.parts                                   as lines
  from (
    select i.family, count(*)::int as parts
    from nl.items i
    where not i.blocked
    group by i.family
  ) f
  cross join year y
  left join lateral (
    select sum(il.amount) as amount
    from nl.invoice_lines il
    join nl.items i2 on i2.item_no = il.item_no
    where i2.family = f.family
      and il.posted_on > y.since and il.posted_on <= y.until
  ) rev on true
  where not exists (
    select 1 from accountable a where a.dimension = 'part_family' and a.value = f.family)
),
mailboxes as (
  select
    'mailbox'::text                           as kind,
    m.id::text                                as ref,
    m.label                                   as subject,
    case when r.id is null
         then 'The reviewer on this inbox is not an active person.'
         else 'Its reviewer does not hold this inbox in scope, so nobody is named against it.'
    end                                       as why,
    0::numeric                                as amount,
    coalesce(waiting.drafts, 0)               as lines
  from nl.mailboxes m
  left join nl.users r on r.id = m.reviewer_id and r.active and r.kind = 'person'
  left join lateral (
    select count(*)::int as drafts
    from nl.mail_drafts d
    where d.mailbox_id = m.id and d.status = 'draft'
  ) waiting on true
  where m.active
    and not exists (
      select 1 from accountable a where a.dimension = 'mailbox' and a.value = m.id::text)
)
select * from accounts
union all select * from families
union all select * from mailboxes;

comment on view nl.responsibility_gaps is
  'Accounts, part families and mailboxes nobody is answerable for, with the last year of invoice lines behind each (migration 0039). Holding a whole scope dimension is oversight, not accountability.';

grant select on nl.responsibility_gaps to nl_app, nl_readonly;

-- The highest live ceiling for an amount authority, across every active
-- person. A decision above this one is a decision nobody in the building can
-- make, which is the fourth coverage gap and the only one that is about
-- authority rather than scope.
--
-- "No ceiling" wins over any number, the same way nl.authority_limit reads it,
-- so this returns null when somebody holds the authority without a limit.
create function nl.highest_ceiling(p_authority text) returns numeric
language sql stable
set search_path = ''
as $$
  select case
    when bool_or(g.limit_amount is null) then null
    else max(g.limit_amount)
  end
  from nl.authority_grants g
  join nl.users u on u.id = g.user_id
  where g.authority = p_authority
    and u.active
    and u.kind = 'person'
    and nl.today() >= g.starts_on
    and (g.ends_on is null or nl.today() <= g.ends_on)
$$;

comment on function nl.highest_ceiling(text) is
  'The largest amount anybody active can approve for this authority today, or null when somebody holds it with no ceiling (migration 0039).';

grant execute on function nl.highest_ceiling(text) to nl_app, nl_readonly;
