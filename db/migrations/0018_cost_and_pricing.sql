-- 0018 Cost, freight and price agreements: the three numbers that decide
-- whether a line of business is worth having.
--
-- Until now cost was one number on the item card, freight was whatever the
-- ledger happened to say, and the price a customer paid came from one tier
-- discount. None of those hold still in a real parts business, so none of
-- them could be reported on honestly. This migration gives each one a
-- history and one rule that reads it:
--
--   nl.item_costs          what a part cost, from when, and who said so
--   nl.item_cost_on()      the cost that applied on a date
--   nl.item_cost_timeline  the same rows with an end date and the step size
--   nl.item_margin_history margin by part and month, from the ledger's own cost
--   nl.customer_margin     margin by account and year
--
--   nl.freight_periods     the freight tariff, revised now and then
--   nl.freight_rates       the rate for each subtotal band of a tariff
--   nl.fuel_surcharge      the fuel surcharge percent, by month
--   nl.freight_for()       what freight a shipment of that size costs that day
--   nl.freight_by_month    billed against the tariff, so recovery is visible
--
--   nl.customer_prices     agreed net prices, with a window and who agreed
--   nl.min_margin()        the floor below which a price is flagged
--   nl.price_for()         one rule, four sources, in a fixed order
--
-- Two rules shaped the design:
--   * The invoice ledger stays the record of what happened. A line carries
--     the cost that applied on its day, so nl.item_margin_history and
--     nl.customer_margin read the line, never the timeline. The timeline is
--     for pricing work going forward (a floor, a what-if, a cost trend).
--   * Nothing here is stored twice. Every figure a screen shows is derived
--     in a view or in a function, so it cannot go stale.
--
-- Nothing in this file is written by the app: the seed and the imports fill
-- these tables, and everyone else reads them.

-- ---------------------------------------------------------------------------
-- The margin floor
-- ---------------------------------------------------------------------------

-- The gross margin a price must clear before the app stops arguing with it.
-- Gross margin here is the usual (price - cost) / price, so the lowest price
-- that clears the floor is cost / (1 - 0.20) = cost x 1.25.
--
-- Why 0.20: the book's own blended gross margin runs in the high forties,
-- and the thinnest product group (raw tube and sheet sold to fab shops)
-- carries about a third. Below a fifth, a line stops paying for the order
-- desk, the pick, the pack and the freight it rides on, so a price under it
-- is a decision someone should make on purpose rather than by accident. It
-- is a flag, never a block: an agreed price below the floor still prices,
-- and still says it is below the floor.
create function nl.min_margin() returns numeric
language sql immutable
set search_path = ''
as $$ select 0.20::numeric $$;

-- ---------------------------------------------------------------------------
-- Cost that moves
-- ---------------------------------------------------------------------------

-- One row per cost revision. A bought part's revision comes from a vendor
-- quote or from what the last receipt actually landed at; a part we make is
-- revised when the standard cost is rolled up again, and carries no vendor.
create table nl.item_costs (
  item_no        text not null references nl.items (item_no) on delete cascade,
  vendor_no      text references nl.vendors (vendor_no),
  effective_from date not null,
  unit_cost      numeric(12, 2) not null check (unit_cost >= 0),
  source         text not null check (source in ('vendor quote', 'purchase receipt', 'standard revision')),
  note           text not null default '',
  primary key (item_no, effective_from)
);

comment on table nl.item_costs is
  'Cost history per part. The newest row matches nl.items.unit_cost, which is the current cost.';

-- The lookup nl.item_cost_on() makes: this part, the last revision on or
-- before a date. The primary key answers it already; this one also carries
-- the columns read, so the answer never visits the table.
create index item_costs_lookup_idx
  on nl.item_costs (item_no, effective_from desc)
  include (unit_cost, vendor_no, source);

-- "What has this vendor done to our costs lately", for the vendor page.
create index item_costs_vendor_idx on nl.item_costs (vendor_no, effective_from desc);

-- The cost that applied on a date, in three steps:
--   the newest revision on or before the date,
--   else the oldest revision there is (a date before the history starts),
--   else the item card, for a part with no history at all.
-- A null date means today.
create function nl.item_cost_on(p_item_no text, p_on_date date) returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select c.unit_cost
     from nl.item_costs c
     where c.item_no = p_item_no
       and c.effective_from <= coalesce(p_on_date, nl.today())
     order by c.effective_from desc
     limit 1),
    (select c.unit_cost
     from nl.item_costs c
     where c.item_no = p_item_no
     order by c.effective_from
     limit 1),
    (select i.unit_cost from nl.items i where i.item_no = p_item_no))
$$;

-- The same rows, ready for a screen: each revision with the day before the
-- next one as its end date, whether it is the one in force now, and how big
-- the step was.
create view nl.item_cost_timeline with (security_invoker = true) as
select
  c.item_no,
  c.vendor_no,
  c.effective_from,
  (lead(c.effective_from) over w - 1) as effective_to,   -- null while this is the current cost
  lead(c.effective_from) over w is null as is_current,
  c.unit_cost,
  c.source,
  c.note,
  (c.unit_cost - lag(c.unit_cost) over w) as change,
  case when lag(c.unit_cost) over w > 0
       then round((c.unit_cost - lag(c.unit_cost) over w) / lag(c.unit_cost) over w, 4)
  end as change_pct
from nl.item_costs c
window w as (partition by c.item_no order by c.effective_from);

-- ---------------------------------------------------------------------------
-- Margin, from the ledger's own cost
-- ---------------------------------------------------------------------------

-- Margin by part and month. The cost comes from the invoice line, which
-- carries the cost that applied on the day it was posted, so a cost revision
-- today cannot rewrite last year's margin.
--
-- Credit memo lines are in: a return takes its units, revenue and cost back
-- off, and a price correction (quantity 0, amount negative) takes revenue off
-- without touching cost, which is exactly what it did to the margin.
create view nl.item_margin_history with (security_invoker = true) as
select
  il.item_no,
  date_trunc('month', il.posted_on)::date as month,
  count(*)::int                           as lines,
  sum(il.quantity)::int                   as units,
  sum(il.amount)                          as revenue,
  sum(il.quantity * il.unit_cost)         as cost_of_goods,
  sum(il.amount) - sum(il.quantity * il.unit_cost) as gross_margin,
  case when sum(il.amount) <> 0
       then round((sum(il.amount) - sum(il.quantity * il.unit_cost)) / sum(il.amount), 4)
  end as margin_pct
from nl.invoice_lines il
group by il.item_no, date_trunc('month', il.posted_on);

-- Margin by account and year, the same way. Freight is not in here: it sits
-- on the invoice header, not on the lines, and it has its own view below.
create view nl.customer_margin with (security_invoker = true) as
select
  il.customer_no,
  extract(year from il.posted_on)::int    as year,
  count(*)::int                           as lines,
  count(distinct il.item_no)::int         as items,
  sum(il.quantity)::int                   as units,
  sum(il.amount)                          as revenue,
  sum(il.quantity * il.unit_cost)         as cost_of_goods,
  sum(il.amount) - sum(il.quantity * il.unit_cost) as gross_margin,
  case when sum(il.amount) <> 0
       then round((sum(il.amount) - sum(il.quantity * il.unit_cost)) / sum(il.amount), 4)
  end as margin_pct
from nl.invoice_lines il
group by il.customer_no, extract(year from il.posted_on);

-- One account's margin reads its own lines by date and needs the cost and
-- the quantity, which the delivery index (0005) does not carry. With this
-- one the account page answers from the index alone.
create index invoice_lines_customer_cost_idx
  on nl.invoice_lines (customer_no, posted_on)
  include (item_no, quantity, amount, unit_cost);

-- ---------------------------------------------------------------------------
-- Freight that moves
-- ---------------------------------------------------------------------------

-- A tariff period. Freight is quoted off the order subtotal, because that is
-- the only size the sales ledger knows: there is no weight on an invoice
-- line. Above free_over the order ships free, which is how the freight
-- policy is written on the price sheet.
create table nl.freight_periods (
  effective_from date primary key,
  free_over      numeric(12, 2) not null check (free_over > 0),
  note           text not null default ''
);

-- The rate for each subtotal band of one tariff period. min_subtotal is the
-- bottom of the band; the band runs up to the next one, and the top band
-- runs up to free_over.
create table nl.freight_rates (
  effective_from date not null references nl.freight_periods (effective_from) on delete cascade,
  min_subtotal   numeric(12, 2) not null check (min_subtotal >= 0),
  rate           numeric(12, 2) not null check (rate >= 0),
  primary key (effective_from, min_subtotal)
);

-- The fuel surcharge, one row per month, as a percent added to the rate.
-- Carriers publish it monthly and it moves far more than the base rates do.
create table nl.fuel_surcharge (
  month   date primary key check (month = date_trunc('month', month)::date),
  percent numeric(5, 2) not null check (percent >= 0 and percent <= 60),
  note    text not null default ''
);

-- What freight a shipment of this subtotal costs on this date:
--   the band rate of the tariff in force, plus that month's fuel surcharge,
--   or nothing at all once the subtotal reaches the free freight threshold.
-- A date before the freight history is priced at the oldest tariff, so a
-- caller never gets an empty answer for an old invoice.
create function nl.freight_for(p_subtotal numeric, p_on_date date)
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
  select
    case when a.subtotal >= p.free_over then 0::numeric
         else round(b.rate * (1 + s.percent / 100), 2)
    end,
    b.rate,
    s.percent,
    p.free_over,
    b.min_subtotal
  from (
    select
      greatest(coalesce(p_subtotal, 0), 0) as subtotal,
      greatest(coalesce(p_on_date, nl.today()),
               (select min(fp.effective_from) from nl.freight_periods fp)) as on_date
  ) a
  cross join lateral (
    select fp.effective_from, fp.free_over
    from nl.freight_periods fp
    where fp.effective_from <= a.on_date
    order by fp.effective_from desc
    limit 1
  ) p
  cross join lateral (
    select fr.min_subtotal, fr.rate
    from nl.freight_rates fr
    where fr.effective_from = p.effective_from
      and fr.min_subtotal <= a.subtotal
    order by fr.min_subtotal desc
    limit 1
  ) b
  cross join lateral (
    select coalesce((
      select fs.percent
      from nl.fuel_surcharge fs
      where fs.month <= date_trunc('month', a.on_date)::date
      order by fs.month desc
      limit 1), 0) as percent
  ) s
$$;

-- Freight billed against freight as the tariff of the day would have priced
-- it, by month. The difference is freight recovery: a positive difference
-- means the invoices collected more than the tariff, a negative one means
-- freight was absorbed (an order that shipped free, a rate nobody updated,
-- or a customer who was not charged).
--
-- This works the tariff out with joins instead of calling nl.freight_for()
-- once per invoice. The function has to pin its search_path, which stops
-- Postgres inlining it, so a call per row stays a call per row: on the small
-- world that shape took 285 ms for 769 invoices, and the full world has
-- about 114,000. The three tariff tables hold a few dozen rows between them,
-- so turning them into date and subtotal ranges and joining once costs one
-- pass over the invoices. The rule is the same rule, and a test holds the
-- view and the function to the same answer.
create view nl.freight_by_month with (security_invoker = true) as
with tariff as (
  -- Each period, with the day the next one starts as its end.
  select
    p.effective_from,
    coalesce(lead(p.effective_from) over (order by p.effective_from), date '9999-12-31') as until,
    p.free_over
  from nl.freight_periods p
),
bands as (
  -- Each band, with the bottom of the next band as its top.
  select
    r.effective_from,
    r.min_subtotal,
    coalesce(lead(r.min_subtotal) over (partition by r.effective_from order by r.min_subtotal),
             999999999::numeric) as max_subtotal,
    r.rate
  from nl.freight_rates r
),
-- The surcharge, one row per month, with any gap filled by the last month
-- published before it (the same rule nl.freight_for() follows) so the join
-- below is a plain equality on the month.
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
  cross join generate_series(f.month, f.until - interval '1 month', interval '1 month') as g(month)
),
-- An invoice older than the freight history is priced at the oldest tariff,
-- the same way nl.freight_for() does it.
first_period as (
  select min(effective_from) as effective_from from nl.freight_periods
),
priced as (
  select
    date_trunc('month', i.posted_on)::date as month,
    i.subtotal,
    i.freight,
    case when i.subtotal >= t.free_over then 0::numeric
         else round(b.rate * (1 + coalesce(s.percent, 0) / 100), 2)
    end as at_rate
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
  month,
  count(*)::int                              as invoices,
  count(*) filter (where freight > 0)::int   as invoices_with_freight,
  sum(subtotal)                              as subtotal,
  sum(freight)                               as freight_billed,
  sum(at_rate)                               as freight_at_rate,
  sum(freight) - sum(at_rate)                as difference,
  case when sum(at_rate) > 0
       then round(sum(freight) / sum(at_rate), 4)
  end as recovery_ratio
from priced
group by month;

-- ---------------------------------------------------------------------------
-- Customer price agreements
-- ---------------------------------------------------------------------------

-- An agreed net price for one account and one part, for a window. valid_to
-- null means the agreement is open ended and still in force.
create table nl.customer_prices (
  customer_no text not null references nl.customers (customer_no) on delete cascade,
  item_no     text not null references nl.items (item_no),
  net_price   numeric(12, 2) not null check (net_price > 0),
  valid_from  date not null,
  valid_to    date,
  agreed_by   int references nl.users (id),      -- null on rows an import brought in
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default nl.now_ms(),
  primary key (customer_no, item_no, valid_from),
  constraint customer_prices_window check (valid_to is null or valid_to >= valid_from)
);

comment on table nl.customer_prices is
  'Agreed net prices per account and part. The first rule nl.price_for() tries.';

create index customer_prices_item_idx on nl.customer_prices (item_no);
create index customer_prices_agreed_by_idx on nl.customer_prices (agreed_by);

-- One open agreement per account and part. Two agreements that both run
-- forever would make "the price" a question with two answers.
create unique index customer_prices_one_open_idx
  on nl.customer_prices (customer_no, item_no) where valid_to is null;

create trigger customer_prices_touch before update on nl.customer_prices
  for each row execute function nl.touch_updated_at();

-- The price this account pays for this part on this day, and which rule said
-- so, in this order:
--
--   1. agreement       an agreed price whose window covers the day
--   2. last paid       what they last paid inside the last twelve months,
--                      but only if it still clears the margin floor
--   3. group discount  list price less their price group's discount
--   4. list            list price, for an account we do not know
--
-- The row also carries the cost that applied that day, the floor price and
-- the margin, so a screen can show why a price is a bad idea without asking
-- a second question. below_floor is a flag, not a veto: an agreed price
-- below the floor is still the agreed price.
--
-- "Last paid" is the account's own history, not its billing family's: a
-- branch that has never bought the part prices off its group discount, which
-- is what the order desk does today.
--
-- No row comes back for a part that is not in the catalog. An account we
-- have never heard of prices at list.
create function nl.price_for(p_customer_no text, p_item_no text, p_on_date date)
returns table (
  customer_no text,
  item_no     text,
  on_date     date,
  price       numeric,
  rule        text,
  detail      text,
  list_price  numeric,
  discount    numeric,
  unit_cost   numeric,
  floor_price numeric,
  margin_pct  numeric,
  below_floor boolean
)
language sql stable
set search_path = ''
as $$
  select
    a.customer_no,
    i.item_no,
    a.on_date,
    r.price,
    pick.rule,
    r.detail,
    i.list_price,
    b.discount,
    c.unit_cost,
    c.floor_price,
    case when r.price > 0 then round((r.price - c.unit_cost) / r.price, 4) end as margin_pct,
    r.price < c.floor_price as below_floor
  from (
    select p_customer_no as customer_no, p_item_no as item_no,
           coalesce(p_on_date, nl.today()) as on_date
  ) a
  join nl.items i on i.item_no = a.item_no
  -- The account and its tier discount. Both are left joins: an unknown
  -- account still gets a price, at list.
  left join nl.customers cu on cu.customer_no = a.customer_no
  left join nl.price_groups pg on pg.code = cu.price_group
  cross join lateral (select coalesce(pg.discount, 0) as discount) b
  cross join lateral (
    select
      nl.item_cost_on(i.item_no, a.on_date) as unit_cost,
      round(nl.item_cost_on(i.item_no, a.on_date) / (1 - nl.min_margin()), 2) as floor_price
  ) c
  -- 1. an agreement whose window covers the day
  left join lateral (
    select cp.net_price, cp.valid_from, cp.valid_to
    from nl.customer_prices cp
    where cp.customer_no = a.customer_no
      and cp.item_no = i.item_no
      and cp.valid_from <= a.on_date
      and (cp.valid_to is null or cp.valid_to >= a.on_date)
    order by cp.valid_from desc
    limit 1
  ) ag on true
  -- 2. the last price they actually paid, inside the last twelve months
  left join lateral (
    select il.unit_price, il.posted_on
    from nl.invoice_lines il
    where il.customer_no = a.customer_no
      and il.item_no = i.item_no
      and il.quantity > 0
      and il.posted_on <= a.on_date
      and il.posted_on > a.on_date - 365
    order by il.posted_on desc, il.invoice_no desc, il.line_no desc
    limit 1
  ) lp on true
  -- Which rule wins, then what it says. Splitting the two keeps the
  -- precedence in one place instead of repeating it in every column.
  cross join lateral (
    select case
      when ag.net_price is not null then 'agreement'
      when lp.unit_price is not null and lp.unit_price >= c.floor_price then 'last paid'
      when cu.customer_no is not null then 'group discount'
      else 'list'
    end as rule
  ) pick
  cross join lateral (
    select
      case pick.rule
        when 'agreement'      then ag.net_price
        when 'last paid'      then lp.unit_price
        when 'group discount' then round(i.list_price * (1 - b.discount), 2)
        else i.list_price
      end as price,
      case pick.rule
        when 'agreement' then 'Agreed price in force since ' || ag.valid_from
          || case when ag.valid_to is null then ', open ended' else ', to ' || ag.valid_to end
        when 'last paid' then 'The price they last paid, on ' || lp.posted_on
        when 'group discount' then 'List less the ' || round(b.discount * 100)
          || '% ' || coalesce(cu.price_group, '') || ' discount'
        else 'List price'
      end as detail
  ) r
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.item_costs enable row level security;
alter table nl.freight_periods enable row level security;
alter table nl.freight_rates enable row level security;
alter table nl.fuel_surcharge enable row level security;
alter table nl.customer_prices enable row level security;

-- All five are about parts, money and policy, not about people, so the
-- read-only role the assistant uses may read them too. Nobody writes them
-- from the app: the seed and the imports fill them.
create policy item_costs_read on nl.item_costs for select to nl_app, nl_readonly using (true);
create policy freight_periods_read on nl.freight_periods for select to nl_app, nl_readonly using (true);
create policy freight_rates_read on nl.freight_rates for select to nl_app, nl_readonly using (true);
create policy fuel_surcharge_read on nl.fuel_surcharge for select to nl_app, nl_readonly using (true);
create policy customer_prices_read on nl.customer_prices for select to nl_app, nl_readonly using (true);

grant select on nl.item_costs, nl.freight_periods, nl.freight_rates, nl.fuel_surcharge,
  nl.customer_prices to nl_app, nl_readonly;

grant select on nl.item_cost_timeline, nl.item_margin_history, nl.customer_margin,
  nl.freight_by_month to nl_app, nl_readonly;

grant execute on function
  nl.min_margin(),
  nl.item_cost_on(text, date),
  nl.freight_for(numeric, date),
  nl.price_for(text, text, date)
to nl_app, nl_readonly;
