-- 0022 The procurement desk: what to buy, how much, from whom, and by when.
--
-- Everything on this page is arithmetic over things the business already
-- knows. Nothing here is a number a person has to keep in their head:
--
--   usage        how fast a part sells, from the invoice ledger, over two
--                windows (90 and 365 days) so a seasonal part is not misread
--   lead time    the ERP date formula on the item, the vendor's as a fallback
--   projection   stock on hand, minus what open sales lines already promise
--                inside the lead time, plus supply due inside it
--   suggestion   how many to buy to cover a target number of days, minus
--                what is already on order, rounded to a pack, with the
--                reason written out in words
--
-- Two things in this file are deliberately defensive.
--
-- 1. The supply forecast (migration 0016) and the mail queue (0021) are being
--    built at the same time as this. So nothing here depends on them at
--    creation time: nl.incoming_supply() and nl.procurement_sources() look
--    for those objects at RUN time with to_regclass and to_regprocedure, and
--    fall back to what 0010 and 0015 already give (nl.open_order_lines,
--    nl.stock.on_purchase_order, nl.stock.on_production_order). When 0016
--    lands, the same views start reading it with no change here.
--
-- 2. Approval writes the purchase order into this file's own tables
--    (nl.procurement_orders), and mirrors it into 0016's table when that
--    exists and has the columns we expect. The desk's own table is the
--    record either way, so an approval is never lost because another
--    migration has not landed yet.
--
-- Signals follow the discipline the automations set in 0013: a signal fires
-- at most once per subject, enforced by a unique key on (signal, subject),
-- not by the sweep's memory.

-- ---------------------------------------------------------------------------
-- The numbers a buyer would argue about, each in its own named function
-- ---------------------------------------------------------------------------

-- How many days of cover a suggested order buys, on top of the lead time.
-- Thirty days is one ordering cycle for this book: the desk works a weekly
-- list, and a month of cover means a part that sells steadily comes back
-- round about once a month rather than every week.
create function nl.target_cover_days() returns int
language sql immutable
set search_path = ''
as $$ select 30 $$;

-- How far back a cost revision or a new order line still counts as news.
create function nl.signal_window_days() returns int
language sql immutable
set search_path = ''
as $$ select 30 $$;

-- A cost revision smaller than this is rounding, not news. Five per cent is
-- about what a buyer would re-quote over: below it the desk would be told
-- about a third of the catalog every month and would stop reading. Measured
-- on the demo world (2,716 parts), 3% raised 100 signals in thirty days and
-- 5% raises a readable handful.
create function nl.cost_move_threshold() returns numeric
language sql immutable
set search_path = ''
as $$ select 0.05::numeric $$;

-- Buying belongs to operations and admins. Account managers can look at the
-- desk but not press anything, the same split as the imports in 0010.
create function nl.can_buy() returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from nl.users
    where id = nl.current_user_id() and role in ('operations', 'admin') and active)
$$;

-- ---------------------------------------------------------------------------
-- Lead time: the ERP's date formula, in days
-- ---------------------------------------------------------------------------

-- An ERP date formula is an offset from today: '3W' is three weeks, '10D' is
-- ten days, '2M' is two months, '1Y' a year. A plain number means days.
-- Anything else, including a blank card, free text and null, reads as null:
-- "the formula does not say", which is a different answer from "the formula
-- says zero". Callers then fall back to the vendor's formula and finally to
-- nl.default_lead_days().
--
-- One term only. A compound formula like '1W+3D' is not something this ERP's
-- item card produces, and guessing at half of it would be worse than saying
-- nothing.
--
-- MIGRATION 0016 (the supply forecast) OWNS THIS FUNCTION AND
-- nl.default_lead_days. It lands first when both are applied, so what is
-- below is a shim: it creates them only when they are not already there, so
-- this migration can also be applied to a database that has no supply
-- forecast yet. The bodies are 0016's, to the character. A lead time that
-- came out differently depending on which migrations were applied would be
-- worse than no lead time at all, so if 0016's rule changes, this changes
-- with it and neither is the place to have a new idea.
do $do$
begin
  if to_regprocedure('nl.lead_time_days(text)') is null then
    execute $fn$
      create function nl.lead_time_days(p_formula text) returns int
      language sql immutable
      set search_path = ''
      as $body$
        select case
          when p_formula is null then null
          when btrim(p_formula) ~ '^[0-9]+$' then btrim(p_formula)::int
          when btrim(upper(p_formula)) ~ '^[0-9]+ *D$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int
          when btrim(upper(p_formula)) ~ '^[0-9]+ *W$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int * 7
          when btrim(upper(p_formula)) ~ '^[0-9]+ *M$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int * 30
          when btrim(upper(p_formula)) ~ '^[0-9]+ *Y$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int * 365
          else null
        end
      $body$;
    $fn$;
  end if;

  -- What to assume when neither the item nor its vendor names a lead time.
  -- Bought parts take longest, an assembly is quickest.
  if to_regprocedure('nl.default_lead_days(text)') is null then
    execute $fn$
      create function nl.default_lead_days(p_replenishment text) returns int
      language sql immutable
      set search_path = ''
      as $body$
        select case p_replenishment when 'Purchase' then 28 when 'Assembly' then 7 else 14 end
      $body$;
    $fn$;
  end if;
end $do$;

-- The lead time to plan this part on: its own formula, then its vendor's,
-- then the default for how it is replenished. nl.part_replenishment works the
-- same three steps out inline (it has the vendor row joined already); this is
-- for everything else that has only an item number.
--
-- 0016 has nl.item_lead_days, which is the same three steps. The two names
-- coexist rather than one calling the other, because this one has to work on
-- a database without 0016.
create function nl.item_lead_time_days(p_item_no text) returns int
language sql stable
set search_path = ''
as $$
  select coalesce(
    nl.lead_time_days(i.lead_time),
    nl.lead_time_days(v.lead_time),
    nl.default_lead_days(i.replenishment))
  from nl.items i
  left join nl.vendors v on v.vendor_no = i.vendor_no
  where i.item_no = p_item_no
$$;

-- ---------------------------------------------------------------------------
-- Pack sizes and freight thresholds
-- ---------------------------------------------------------------------------

-- Nobody orders 37 clamps. Parts come in a pack, and the pack depends on how
-- the part is handled: small hardware by the box, fabricated parts in small
-- multiples, anything expensive one at a time.
--
-- It takes the family and the cost rather than an item number so it stays a
-- pure function with no lookup, which is what lets nl.part_replenishment
-- call it for every part in the catalog without a round trip each.
create function nl.pack_size(p_family text, p_unit_cost numeric) returns int
language sql immutable
set search_path = ''
as $$
  select case
    -- Over $250 a piece nobody buys a case to round a number up.
    when coalesce(p_unit_cost, 0) > 250 then 1
    when p_family = 'clamp' then 25
    when p_family in ('bracket', 'raw') then 10
    when p_family in ('flex', 'shield', 'pipe') then 5
    when p_family in ('elbow', 'stack', 'muffler') then 2
    else 1
  end
$$;

-- Round a quantity up to the next whole pack.
create function nl.round_to_pack(p_quantity numeric, p_pack int) returns int
language sql immutable
set search_path = ''
as $$
  select case
    when coalesce(p_quantity, 0) <= 0 then 0
    else ceil(p_quantity / greatest(coalesce(p_pack, 1), 1))::int * greatest(coalesce(p_pack, 1), 1)
  end
$$;

-- Vendors write their freight rule as prose on the vendor card: 'Prepaid',
-- 'FOB origin', 'Prepaid over $1,500'. Only the last kind has a number worth
-- chasing, so this pulls it out and returns null for the others.
create function nl.free_freight_threshold(p_freight_terms text) returns numeric
language sql immutable
set search_path = ''
as $$
  select replace((regexp_match(coalesce(p_freight_terms, ''),
                               '\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)'))[1], ',', '')::numeric
$$;

-- ---------------------------------------------------------------------------
-- Which neighbouring migrations are here yet
-- ---------------------------------------------------------------------------

-- Feature detection, in one place, so a page can say which numbers it is
-- working from and a test can prove both paths.
create function nl.procurement_sources() returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'open_purchase_lines',  to_regclass('nl.open_purchase_lines') is not null,
    'production_orders',    to_regclass('nl.open_production_orders') is not null,
    'available_to_promise', to_regprocedure('nl.available_to_promise(text,int,date)') is not null,
    'mail_drafts',          to_regclass('nl.mail_drafts') is not null)
$$;

-- The first of these column names that the named table in schema nl actually
-- has, or null. Used to read a table another migration owns without assuming
-- one exact spelling of its columns.
create function nl.first_column(p_table text, p_candidates text[]) returns text
language sql stable
set search_path = ''
as $$
  select c.name
  from unnest(p_candidates) with ordinality as c(name, ord)
  where exists (
    select 1 from information_schema.columns ic
    where ic.table_schema = 'nl'
      and ic.table_name = p_table
      and ic.column_name = c.name)
  order by c.ord
  limit 1
$$;

-- The date term to paste into the dynamic SQL in nl.incoming_supply(), given
-- the one or two date columns nl.first_column found. Two columns coalesce
-- (the promise, then the due date), one is used on its own, and none reads as
-- "no date on it".
--
-- Both names have already been looked up in information_schema by the time
-- they reach here, so they exist; quote_ident on top of that is belt and
-- braces against a column called something surprising.
create function nl.date_expression(p_first text, p_second text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_first is not null and p_second is not null
      then format('coalesce(%I, %I)::date', p_first, p_second)
    when coalesce(p_first, p_second) is not null
      then format('%I::date', coalesce(p_first, p_second))
    else 'null::date'
  end
$$;

-- ---------------------------------------------------------------------------
-- The desk's own purchase orders
-- ---------------------------------------------------------------------------

-- Declared before nl.incoming_supply(), which reads them.
--
-- When 0016 lands, its tables become the forecast this desk plans against,
-- and approval mirrors each line into them (nl.approve_purchase_request).
-- These rows stay as the desk's own record of what it sent.
create sequence nl.procurement_order_no_seq start with 8001;

create table nl.procurement_orders (
  id            bigint generated always as identity primary key,
  order_no      text not null unique default ('PD-' || nextval('nl.procurement_order_no_seq')),
  vendor_no     text not null references nl.vendors (vendor_no),
  request_id    bigint,                              -- the draft it came from (foreign key added below)
  status        text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  ordered_on    date not null default nl.today(),
  terms         text not null default '',
  freight_terms text not null default '',
  subtotal      numeric(14, 2) not null default 0,
  -- True when the lines were also written into 0016's purchase order table,
  -- which is what stops nl.incoming_supply() counting them twice.
  mirrored      boolean not null default false,
  created_by    int not null references nl.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default nl.now_ms()
);

comment on table nl.procurement_orders is
  'Purchase orders this desk raised. The supply forecast (0016) owns the ERP''s own purchase orders.';

create index procurement_orders_vendor_idx on nl.procurement_orders (vendor_no);
create index procurement_orders_created_by_idx on nl.procurement_orders (created_by);
create index procurement_orders_request_idx on nl.procurement_orders (request_id);

create trigger procurement_orders_touch before update on nl.procurement_orders
  for each row execute function nl.touch_updated_at();

create table nl.procurement_order_lines (
  id                   bigint generated always as identity primary key,
  order_id             bigint not null references nl.procurement_orders (id) on delete cascade,
  line_no              int not null,
  item_no              text not null references nl.items (item_no),
  quantity             int not null check (quantity > 0),
  received_qty         int not null default 0 check (received_qty >= 0),
  unit_cost            numeric(12, 2) not null check (unit_cost >= 0),
  -- The date first asked for, kept so a slip is visible without a history table.
  original_promised_on date not null,
  promised_on          date not null,
  unique (order_id, line_no)
);

-- The lookup nl.incoming_supply() makes: what is still coming, per part.
create index procurement_order_lines_item_idx
  on nl.procurement_order_lines (item_no, promised_on)
  include (quantity, received_qty);

-- ---------------------------------------------------------------------------
-- Incoming supply, from whichever source exists
-- ---------------------------------------------------------------------------

-- Everything on its way in, one row per source line:
--
--   'desk'        an order this desk raised and the vendor has not shipped yet
--   'purchase'    nl.open_purchase_lines, once migration 0016 has landed
--   'production'  nl.open_production_orders, likewise
--   'stock'       the item master's own on_purchase_order and
--                 on_production_order figures, which is all there is before
--                 0016
--
-- due_on is null when the source has no date on it. A dateless row still
-- counts as incoming inside the planning horizon: it is already bought, and
-- pretending otherwise would have the desk order the same part twice.
--
-- Why the column names are looked up instead of written down: migration 0016
-- owns those two tables and was being written at the same time as this. The
-- candidate lists below put 0016's real column names first, checked against
-- it, and keep a few other plausible spellings behind them, so a rename there
-- costs the dates rather than the whole projection. nl.first_column does the
-- looking, and nl.date_expression builds the date term.
--
-- Plan note: this is a set-returning function and not a view, because a
-- view's body has to name tables that exist when the view is created. The
-- planner therefore treats it as a black box of about 500 rows and cannot
-- push a single-part filter into it, so nl.part_replenishment materializes
-- the whole result once and joins to it rather than calling it per part.
create function nl.incoming_supply()
returns table (source text, document_no text, line_no int, item_no text, quantity int, due_on date)
language plpgsql stable rows 500
set search_path = ''
as $$
declare
  v_item   text;
  v_qty    text;
  v_due    text;
  v_due2   text;
  v_doc    text;
  v_line   text;
  v_bought boolean := false;   -- did the ERP's purchase orders answer?
  v_made   boolean := false;   -- did the ERP's production orders answer?
begin
  -- What this desk has ordered and not yet received.
  return query
    select 'desk'::text, o.order_no, l.line_no, l.item_no,
           (l.quantity - l.received_qty)::int, l.promised_on
    from nl.procurement_order_lines l
    join nl.procurement_orders o on o.id = l.order_id
    where o.status = 'open'
      and l.quantity > l.received_qty
      -- A mirrored order is already counted by the 'purchase' branch below.
      and not o.mirrored;

  -- Purchase orders the ERP knows about.
  if to_regclass('nl.open_purchase_lines') is not null then
    v_item := nl.first_column('open_purchase_lines', array['item_no']);
    v_qty  := nl.first_column('open_purchase_lines',
                array['quantity', 'quantity_outstanding', 'outstanding_quantity', 'open_quantity', 'qty']);
    -- The vendor's own promise first, the order's due date behind it, and
    -- both together, because 0016 lets the promise be null.
    v_due  := nl.first_column('open_purchase_lines',
                array['promised_date', 'promised_on', 'projected_receipt_date', 'expected_on']);
    v_due2 := nl.first_column('open_purchase_lines', array['due_date', 'due_on']);
    v_doc  := nl.first_column('open_purchase_lines', array['document_no', 'order_no', 'purchase_order_no']);
    v_line := nl.first_column('open_purchase_lines', array['line_no']);

    if v_item is not null and v_qty is not null then
      return query execute format(
        'select %L::text, %s, %s, %I::text, %I::int, %s from nl.open_purchase_lines',
        'purchase',
        case when v_doc is null then quote_literal('') || '::text' else format('%I::text', v_doc) end,
        case when v_line is null then '0' else format('%I::int', v_line) end,
        v_item, v_qty,
        nl.date_expression(v_due, v_due2));
      v_bought := true;
    end if;
  end if;

  -- Production orders, the same way. 0016 keys these on the order number
  -- alone, so there is no line number to carry.
  if to_regclass('nl.open_production_orders') is not null then
    v_item := nl.first_column('open_production_orders', array['item_no']);
    v_qty  := nl.first_column('open_production_orders',
                array['quantity', 'quantity_outstanding', 'outstanding_quantity', 'open_quantity', 'qty']);
    v_due  := nl.first_column('open_production_orders',
                array['due_date', 'due_on', 'promised_date', 'ends_on']);
    v_due2 := null;
    v_doc  := nl.first_column('open_production_orders', array['order_no', 'document_no']);
    v_line := nl.first_column('open_production_orders', array['line_no']);

    if v_item is not null and v_qty is not null then
      return query execute format(
        'select %L::text, %s, %s, %I::text, %I::int, %s from nl.open_production_orders',
        'production',
        case when v_doc is null then quote_literal('') || '::text' else format('%I::text', v_doc) end,
        case when v_line is null then '0' else format('%I::int', v_line) end,
        v_item, v_qty,
        nl.date_expression(v_due, v_due2));
      v_made := true;
    end if;
  end if;

  -- Whatever the ERP's own tables could not answer for, the item master still
  -- has a figure for, with no date on it.
  if not v_bought then
    return query
      select 'stock'::text, ''::text, 0, s.item_no, s.on_purchase_order, null::date
      from nl.stock s
      where s.on_purchase_order > 0;
  end if;
  if not v_made then
    return query
      select 'stock'::text, ''::text, 0, s.item_no, s.on_production_order, null::date
      from nl.stock s
      where s.on_production_order > 0;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Usage: how fast each part actually sells
-- ---------------------------------------------------------------------------

-- One row per part with two rates and a shape.
--
-- Two windows, because one window is always wrong for something. Ninety days
-- catches a part that has just started moving; a year catches a part whose
-- season is not now. The rate the desk plans on is the HIGHER of the two:
-- ordering to the faster of a part's two recent rates costs a month of
-- carrying cost, ordering to the slower one costs a line the plant cannot
-- ship.
--
-- Shape is the coefficient of variation of the last twelve monthly totals,
-- with the empty months counted as zeroes (leaving them out would make a part
-- that sells once a quarter look perfectly steady):
--
--   steady   below 0.6    a rate worth planning on
--   lumpy    below 1.2    plan on it, expect to be wrong sometimes
--   erratic  above that   the rate is an average of nothing
--
-- Credit memo lines are in, with their negative quantities, so a part that
-- was sold and then returned has not been used.
--
-- Plan shape: ONE grouped pass over the year's invoice lines for the whole
-- catalog, not a lateral subquery per part. The first version did it per
-- part, with a generate_series of twelve months to supply the empty ones, and
-- cost 1.3 s for 2,716 parts because it ran 5,432 little queries. The spread
-- needs no rows for the empty months at all: with twelve as a fixed divisor,
-- the population standard deviation falls straight out of two sums,
--
--   sd = sqrt(mean of the squares - square of the mean)
--
-- and a month that sold nothing adds nothing to either sum.
--
-- The trade-off is that a query for ONE part now reads the year's lines for
-- every part. Nothing asks it that: nl.part_replenishment joins it for the
-- whole catalog, and so does everything else here. A single-part caller
-- should read nl.part_summary (0015), which is built the other way round.
create view nl.part_usage with (security_invoker = true) as
with clock as materialized (
  select nl.today() as today,
         (nl.today() - 90)::date as d90,
         (nl.today() - 365)::date as d365,
         (date_trunc('month', nl.today()::timestamp) - interval '11 months') as first_month
),
monthly as (
  select
    il.item_no,
    date_trunc('month', il.posted_on)                    as month,
    sum(il.quantity)::numeric                            as units,
    sum(il.quantity) filter (where il.posted_on > c.d90) as units_90d,
    sum(il.amount) filter (where il.posted_on > c.d90)   as revenue_90d,
    max(il.posted_on) filter (where il.quantity > 0)     as last_sold_on
  from nl.invoice_lines il
  cross join clock c
  where il.posted_on > c.d365
    and il.posted_on <= c.today
  group by il.item_no, date_trunc('month', il.posted_on)
),
per_item as (
  select
    m.item_no,
    sum(m.units)::int                       as units_365d,
    coalesce(sum(m.units_90d), 0)::int      as units_90d,
    coalesce(sum(m.revenue_90d), 0)         as revenue_90d,
    count(*)::int                           as months_with_demand,
    max(m.last_sold_on)                     as last_sold_on,
    -- The twelve calendar months up to this one, for the spread.
    coalesce(sum(m.units) filter (where m.month >= c.first_month), 0)               as sum_12,
    coalesce(sum(m.units * m.units) filter (where m.month >= c.first_month), 0)     as sumsq_12
  from monthly m
  cross join clock c
  -- clock has exactly one row, so grouping by it changes nothing; it is here
  -- because a column used inside FILTER has to be grouped.
  group by m.item_no, c.first_month
),
figures as (
  select
    i.item_no,
    coalesce(p.units_90d, 0)  as units_90d,
    coalesce(p.units_365d, 0) as units_365d,
    coalesce(p.revenue_90d, 0) as revenue_90d,
    coalesce(p.months_with_demand, 0) as months_with_demand,
    p.last_sold_on,
    round(greatest(coalesce(p.units_90d, 0), 0) / 90.0, 4)   as per_day_90,
    round(greatest(coalesce(p.units_365d, 0), 0) / 365.0, 4) as per_day_365,
    coalesce(p.sum_12, 0) / 12.0 as mean_12,
    sqrt(greatest(coalesce(p.sumsq_12, 0) / 12.0
                  - (coalesce(p.sum_12, 0) / 12.0) ^ 2, 0)) as sd_12
  from nl.items i
  left join per_item p on p.item_no = i.item_no
)
select
  f.item_no,
  f.units_90d::int,
  f.units_365d::int,
  f.per_day_90,
  f.per_day_365,
  greatest(f.per_day_90, f.per_day_365) as per_day,
  round(greatest(f.per_day_90, f.per_day_365) * 7, 2) as per_week,
  f.months_with_demand::int,
  -- What the part has sold in 90 days, in dollars. This is what a stock-out
  -- puts at risk, and it is a different figure from the value of open lines
  -- that already cannot ship (nl.part_replenishment.value_at_risk).
  f.revenue_90d,
  f.last_sold_on,
  case when f.mean_12 > 0 then round(f.sd_12 / f.mean_12, 3) end as demand_cv,
  case
    when f.units_365d <= 0 then 'none'
    when f.mean_12 <= 0 then 'erratic'
    when f.sd_12 / f.mean_12 < 0.6 then 'steady'
    when f.sd_12 / f.mean_12 < 1.2 then 'lumpy'
    else 'erratic'
  end as demand_shape
from figures f;

comment on view nl.part_usage is
  'Per part: units sold over 90 and 365 days, the rate to plan on, and how erratic the demand is.';

-- ---------------------------------------------------------------------------
-- The reason, in words
-- ---------------------------------------------------------------------------

-- The sentence the desk reads instead of six columns:
--
--   '18 on hand, 2.1 a week, 21 day lead time, 9 already promised,
--    30 day cover'
--
-- Parts that would say nothing are left out, so a part with nothing promised
-- and nothing on order gets a short sentence rather than two zeroes.
create function nl.replenishment_reason(
  p_on_hand    int,
  p_per_week   numeric,
  p_lead_days  int,
  p_promised   int,
  p_on_order   int,
  p_cover_days int
) returns text
language sql immutable
set search_path = ''
as $$
  select concat_ws(', ',
    coalesce(p_on_hand, 0) || ' on hand',
    case when coalesce(p_per_week, 0) > 0
         then trim(to_char(p_per_week, 'FM9999990.0')) || ' a week'
         else 'no sales in a year' end,
    coalesce(p_lead_days, 0) || ' day lead time',
    case when coalesce(p_promised, 0) > 0 then p_promised || ' already promised' end,
    case when coalesce(p_on_order, 0) > 0 then p_on_order || ' already on order' end,
    coalesce(p_cover_days, 0) || ' day cover')
$$;

-- ---------------------------------------------------------------------------
-- The projection and the suggestion
-- ---------------------------------------------------------------------------

-- One row per part in the catalog: where its stock is heading, whether that
-- is below the policy on the item card, and what to buy if it is.
--
-- The horizon is the part's own lead time. That is the only horizon that
-- means anything for a buying decision: an order placed today lands on
-- today + lead time, so what matters is the stock position on that day.
--
--   promised_before_horizon   open sales lines (0010) shipping on or before
--                             the horizon
--   incoming_before_horizon   supply due on or before it, plus everything
--                             already on order with no date (see
--                             nl.incoming_supply)
--   projected_available       on_hand + incoming_before_horizon
--                             - promised_before_horizon
--
-- The suggestion covers the lead time plus nl.target_cover_days() of usage,
-- keeps safety stock underneath it, never asks for less than the level the
-- item card sets, and then takes off supply landing AFTER the horizon. Supply
-- landing INSIDE the horizon is already inside projected_available, so every
-- unit on order is subtracted exactly once:
--
--   target      = greatest(policy_level,
--                          safety_stock + per_day x (lead_time + cover))
--   raw_need    = target - projected_available - on_order_later
--   suggested   = raw_need rounded up to the pack
--
-- Plan shape: the two things that cannot be worked out until the lead time is
-- known (promises and supply inside the horizon) are grouped joins over the
-- whole catalog, not correlated subqueries per part, and the supply function
-- is materialized so it runs once.
create view nl.part_replenishment with (security_invoker = true) as
with clock as materialized (
  select nl.today() as today, nl.target_cover_days() as cover
),
-- Runs once, whatever the query asks for (see nl.incoming_supply).
supply as materialized (
  select s.item_no, s.quantity, s.due_on from nl.incoming_supply() s
),
-- The dollars we cannot ship today: open lines that go short once stock is
-- handed out oldest ship date first (nl.open_line_allocation, 0010).
at_risk as (
  select a.item_no, sum(round(a.short * a.unit_price, 2)) as value_at_risk
  from nl.open_line_allocation a
  where a.short > 0
  group by a.item_no
),
-- Catalog, stock, vendor, cost, rate and lead time. Everything except the
-- two figures that need the horizon.
base as (
  select
    i.item_no,
    i.description,
    i.family,
    i.product_group,
    i.replenishment,
    i.made_to_order,
    i.blocked,
    i.vendor_no,
    v.name          as vendor_name,
    v.terms         as vendor_terms,
    v.freight_terms as vendor_freight_terms,
    v.min_order     as vendor_min_order,
    nl.free_freight_threshold(v.freight_terms) as vendor_free_freight_at,
    i.reorder_point,
    i.safety_stock,
    coalesce(i.reorder_point, i.safety_stock) as policy_level,
    i.lead_time as lead_time_formula,
    -- The item's formula, then the vendor's, then the house default.
    coalesce(nl.lead_time_days(i.lead_time),
             nl.lead_time_days(v.lead_time),
             nl.default_lead_days(i.replenishment)) as lead_time_days,
    (c.today + coalesce(nl.lead_time_days(i.lead_time),
                        nl.lead_time_days(v.lead_time),
                        nl.default_lead_days(i.replenishment)))::date as horizon_on,
    coalesce(st.on_hand, 0) as on_hand,
    -- The cost in force today, from the cost timeline (0018). The item card's
    -- own figure is the fallback for a part with no cost history at all.
    coalesce(cost.unit_cost, i.unit_cost) as unit_cost,
    cost.effective_from as cost_from,
    nl.pack_size(i.family, coalesce(cost.unit_cost, i.unit_cost)) as pack,
    pu.per_day,
    pu.per_week,
    pu.units_90d,
    pu.units_365d,
    pu.demand_shape,
    pu.demand_cv,
    pu.revenue_90d,
    pu.last_sold_on,
    coalesce(ar.value_at_risk, 0) as value_at_risk,
    c.today,
    c.cover
  from nl.items i
  cross join clock c
  left join nl.vendors v on v.vendor_no = i.vendor_no
  left join nl.stock st on st.item_no = i.item_no
  join nl.part_usage pu on pu.item_no = i.item_no
  left join at_risk ar on ar.item_no = i.item_no
  -- The newest cost revision on or before today, from
  -- item_costs_lookup_idx, which carries unit_cost so this never visits the
  -- table itself.
  left join lateral (
    select ic.unit_cost, ic.effective_from
    from nl.item_costs ic
    where ic.item_no = i.item_no
      and ic.effective_from <= c.today
    order by ic.effective_from desc
    limit 1
  ) cost on true
),
-- Open sales lines, split at each part's own horizon. One grouped join over
-- the open line table rather than a subquery per part.
promised as (
  select
    b.item_no,
    coalesce(sum(l.quantity), 0)::int                                        as promised_total,
    coalesce(sum(l.quantity) filter (where l.ship_date <= b.horizon_on), 0)::int as promised_before_horizon,
    coalesce(sum(l.quantity) filter (where l.ship_date < b.today), 0)::int   as promised_past_due,
    min(l.ship_date)                                                         as next_ship_date
  from base b
  left join nl.open_order_lines l on l.item_no = b.item_no
  group by b.item_no, b.horizon_on, b.today
),
-- Incoming supply, split the same way.
incoming as (
  select
    b.item_no,
    coalesce(sum(s.quantity), 0)::int as on_order_total,
    coalesce(sum(s.quantity) filter (where s.due_on is null or s.due_on <= b.horizon_on), 0)::int
      as incoming_before_horizon
  from base b
  left join supply s on s.item_no = b.item_no
  group by b.item_no, b.horizon_on
),
figured as (
  select
    b.*,
    p.promised_total,
    p.promised_before_horizon,
    p.promised_past_due,
    p.next_ship_date,
    n.on_order_total,
    n.incoming_before_horizon,
    (b.on_hand + n.incoming_before_horizon - p.promised_before_horizon) as projected_available,
    (n.on_order_total - n.incoming_before_horizon)                      as on_order_later,
    -- The stock we want to be holding on the horizon date: enough usage to
    -- get through the lead time and the cover period, on top of safety
    -- stock, but never less than the level the item card asks for.
    --
    -- The floor matters. A reorder point is the level at which you reorder,
    -- not the level you reorder back up to, and a part that has not sold in a
    -- year still has a reorder point of 20 because somebody decided the plant
    -- holds twenty. Without the floor, such a part would show as below its
    -- reorder point with a suggestion of nothing, which reads as a bug.
    greatest(
      coalesce(b.policy_level, 0),
      coalesce(b.safety_stock, 0) + ceil(b.per_day * (b.lead_time_days + b.cover))::int
    ) as target_qty
  from base b
  join promised p on p.item_no = b.item_no
  join incoming n on n.item_no = b.item_no
),
decided as (
  select
    f.*,
    (f.target_qty - f.projected_available - f.on_order_later) as raw_need,
    -- Below the policy the item card sets. A null policy_level means the part
    -- is not stocked to a reorder point at all (made to order, custom, or it
    -- barely sells), so it cannot be below one.
    (f.policy_level is not null and f.projected_available < f.policy_level) as below_policy,
    -- Already promised more than we will have, whatever the policy says.
    (f.projected_available < 0) as oversold,
    -- When the shelf empties at the current rate. Null when nothing sells.
    case when f.per_day > 0 and f.projected_available > 0
         then (f.today + floor(f.projected_available / f.per_day)::int)::date
         when f.per_day > 0 then f.today
    end as runs_out_on
  from figured f
),
sized as (
  select
    d.*,
    nl.round_to_pack(d.raw_need, d.pack) as suggested_qty
  from decided d
)
select
  s.item_no,
  s.description,
  s.family,
  s.product_group,
  s.replenishment,
  s.made_to_order,
  s.blocked,
  s.vendor_no,
  s.vendor_name,
  s.vendor_terms,
  s.vendor_freight_terms,
  s.vendor_min_order,
  s.vendor_free_freight_at,
  s.reorder_point,
  s.safety_stock,
  s.policy_level,
  s.lead_time_formula,
  s.lead_time_days,
  s.horizon_on,
  s.on_hand,
  s.unit_cost,
  s.cost_from,
  s.pack,
  s.per_day,
  s.per_week,
  s.units_90d,
  s.units_365d,
  s.demand_shape,
  s.demand_cv,
  s.revenue_90d,
  s.last_sold_on,
  s.promised_total,
  s.promised_before_horizon,
  s.promised_past_due,
  s.next_ship_date,
  s.incoming_before_horizon,
  s.on_order_total,
  s.on_order_later,
  s.projected_available,
  s.target_qty,
  s.raw_need,
  s.below_policy,
  s.oversold,
  s.value_at_risk,
  s.runs_out_on,
  -- How many days of cover the projection leaves.
  case when s.per_day > 0 then round(s.projected_available / s.per_day, 1) end as days_of_cover,
  -- The day an order had to be placed to land before the shelf empties.
  case when s.runs_out_on is not null then (s.runs_out_on - s.lead_time_days)::date end as order_by_on,
  -- The delivery date to ask for: by the day stock runs out, but never sooner
  -- than the lead time allows and never more than one cover period beyond it.
  --
  -- The ceiling matters. A part with a reorder point of 2, one on the shelf
  -- and almost no sales runs out in a year, and asking a vendor to deliver in
  -- a year is not a purchase order anybody sends. A part that will not empty
  -- inside the window we are buying did not need buying today for demand
  -- reasons; it needed buying because the item card asks for more than is
  -- there, and the card's level should be there inside that window.
  least(
    greatest(coalesce(s.runs_out_on, s.horizon_on), s.horizon_on),
    (s.horizon_on + s.cover)::date
  ) as requested_on,
  s.suggested_qty,
  round(s.suggested_qty * s.unit_cost, 2) as suggested_cost,
  -- A blocked part is not bought, whatever the arithmetic says.
  ((s.below_policy or s.oversold) and not s.blocked and s.suggested_qty > 0) as needs_buying,
  -- A part we MAKE has no vendor and does not need one: it is short of a
  -- production order, not of a purchase order. Keeping that apart from a
  -- bought-in part with an empty vendor field is the difference between a
  -- scheduling job and a data-quality problem, and the desk should not
  -- present them as the same thing.
  (s.replenishment in ('Prod. Order', 'Assembly')) as made_here,
  -- Can this actually be ordered from somebody today?
  (s.vendor_no is not null and s.unit_cost > 0) as buyable,
  -- The item card needs fixing before any of this is worth doing: no cost at
  -- all, or a bought-in part with nobody to buy it from. A part we make with
  -- no vendor is not on this list, because it does not want one.
  (s.unit_cost <= 0
   or (s.replenishment not in ('Prod. Order', 'Assembly') and s.vendor_no is null))
    as item_card_incomplete,
  case
    when s.oversold then 'promised more than we will have'
    when s.below_policy and s.reorder_point is not null then 'below reorder point'
    when s.below_policy then 'below safety stock'
    else 'on pace'
  end as trigger_reason,
  nl.replenishment_reason(s.on_hand, s.per_week, s.lead_time_days,
                          s.promised_before_horizon, s.on_order_total, s.cover) as reason
from sized s;

comment on view nl.part_replenishment is
  'Per part: where stock is heading inside its own lead time, and what to buy if that is below policy.';

-- ---------------------------------------------------------------------------
-- Signals: what woke the desk
-- ---------------------------------------------------------------------------

-- One row the first time the desk is told about something. The unique key on
-- (signal, subject) is the guarantee, the same way nl.automation_firings works
-- in 0013: whoever runs the sweep, however often, a subject is only ever
-- recorded once.
--
-- "Once per subject, ever" is deliberate. This is a log of the first time
-- somebody was told, not a queue that nags. What needs buying TODAY comes
-- from nl.part_replenishment, which is derived on every read and is always
-- current. The sweep sets cleared_at once a signal's condition has passed, so
-- the log says what happened as well as what was noticed.
create table nl.procurement_signals (
  id            bigint generated always as identity (start with 9001) primary key,
  signal        text not null check (signal in (
                  'below_reorder_point',    -- the projection is under the item card's policy
                  'purchase_order_late',    -- a promised date has passed, or moved out
                  'vendor_cost_moved',      -- a new row in the cost timeline
                  'demand_jumped',          -- new demand leaves a part short
                  'no_vendor',              -- a bought part with nobody to buy it from
                  'no_cost',                -- a part with no cost to order against
                  'under_vendor_minimum')), -- a vendor's short parts do not reach its minimum
  -- What the signal is about: an item number, a vendor number, a purchase
  -- order line, or an item and a date for a cost revision.
  subject       text not null,
  item_no       text references nl.items (item_no) on delete cascade,
  vendor_no     text references nl.vendors (vendor_no) on delete cascade,
  headline      text not null check (length(headline) between 3 and 300),
  detail        jsonb not null default '{}',
  -- The dollars this puts at stake: open sales lines that already cannot
  -- ship, or failing that what the part sold in the last 90 days, which is
  -- what a stock-out would threaten.
  value_at_risk numeric(14, 2) not null default 0,
  raised_on     date not null default nl.today(),
  raised_at     timestamptz not null default now(),
  cleared_at    timestamptz,
  unique (signal, subject)
);

comment on table nl.procurement_signals is
  'What woke the procurement desk. At most one row per (signal, subject), ever.';

create index procurement_signals_open_idx on nl.procurement_signals (signal, raised_at desc)
  where cleared_at is null;
create index procurement_signals_item_idx on nl.procurement_signals (item_no);
create index procurement_signals_vendor_idx on nl.procurement_signals (vendor_no);

-- Parts that somebody has newly asked for inside nl.signal_window_days():
-- an open sales line that first appeared, or a commitment that was written
-- and whose window is still open. One row per part per source, earliest
-- first.
--
-- It says nothing about whether the part can cover it. That is
-- nl.part_replenishment's job, and keeping the two apart is what lets the
-- sweep read the expensive view once and join this to it, instead of reading
-- it a second time through here.
create view nl.procurement_new_demand with (security_invoker = true) as
with clock as materialized (
  select nl.today() as today, nl.signal_window_days() as window_days
)
select 'order'::text as source, l.item_no, min(l.first_seen_on) as arrived_on
from nl.open_order_lines l
cross join clock c
where l.first_seen_on > c.today - c.window_days
group by l.item_no
union all
select 'commitment'::text, ci.item_no, min(cm.starts_on)
from nl.commitments cm
join nl.commitment_items ci on ci.commitment_id = cm.id
cross join clock c
where cm.ends_on >= c.today
  and cm.created_at > (c.today - c.window_days)::timestamptz
group by ci.item_no;

-- Purchase order lines whose promised date has passed, or has moved out since
-- it was first given. Reads the desk's own orders and, once 0016 is here,
-- whatever nl.incoming_supply() finds in the ERP's open purchase lines.
create view nl.procurement_late_supply with (security_invoker = true) as
with clock as materialized (
  select nl.today() as today
)
select
  s.source,
  s.document_no,
  s.line_no,
  s.item_no,
  s.quantity,
  s.due_on,
  l.original_promised_on,
  (s.due_on < c.today) as past_due,
  (l.original_promised_on is not null and l.promised_on > l.original_promised_on) as slipped,
  case when s.due_on < c.today then c.today - s.due_on else 0 end as days_late,
  coalesce(l.promised_on - l.original_promised_on, 0) as days_slipped
from nl.incoming_supply() s
cross join clock c
left join nl.procurement_orders o
       on s.source = 'desk' and o.order_no = s.document_no
left join nl.procurement_order_lines l
       on l.order_id = o.id and l.line_no = s.line_no
where s.due_on is not null
  and (s.due_on < c.today
       or (l.original_promised_on is not null and l.promised_on > l.original_promised_on));

-- ---------------------------------------------------------------------------
-- Purchase requests: the draft a person approves
-- ---------------------------------------------------------------------------

create table nl.purchase_requests (
  id              bigint generated always as identity (start with 7001) primary key,
  vendor_no       text not null references nl.vendors (vendor_no),
  status          text not null default 'draft' check (status in ('draft', 'approved', 'dismissed')),
  -- The earliest date any line on it is needed.
  needed_by       date,
  terms           text not null default '',
  freight_note    text not null default '',
  subtotal        numeric(14, 2) not null default 0,
  min_order       numeric(12, 2),
  free_freight_at numeric(12, 2),
  -- False when the draft does not reach the vendor's minimum order. The desk
  -- still sees it: the decision is whether to add parts or wait, not whether
  -- to be told.
  meets_minimum   boolean not null default true,
  note            text not null default '',
  created_by      int not null references nl.users (id),
  created_at      timestamptz not null default now(),
  decided_by      int references nl.users (id),
  decided_at      timestamptz,
  order_id        bigint references nl.procurement_orders (id),
  updated_at      timestamptz not null default nl.now_ms()
);

comment on table nl.purchase_requests is
  'A suggested order per vendor, edited and approved by a person. Approval is what creates a purchase order.';

-- One open draft per vendor at a time, so two sweeps cannot leave the desk
-- looking at the same order twice.
create unique index purchase_requests_one_open_idx on nl.purchase_requests (vendor_no)
  where status = 'draft';
create index purchase_requests_created_by_idx on nl.purchase_requests (created_by);
create index purchase_requests_decided_by_idx on nl.purchase_requests (decided_by);
create index purchase_requests_order_idx on nl.purchase_requests (order_id);

create trigger purchase_requests_touch before update on nl.purchase_requests
  for each row execute function nl.touch_updated_at();

alter table nl.procurement_orders
  add constraint procurement_orders_request_fk
  foreign key (request_id) references nl.purchase_requests (id);

create table nl.purchase_request_lines (
  id            bigint generated always as identity primary key,
  request_id    bigint not null references nl.purchase_requests (id) on delete cascade,
  line_no       int not null,
  item_no       text not null references nl.items (item_no),
  quantity      int not null check (quantity > 0),
  unit_cost     numeric(12, 2) not null check (unit_cost >= 0),
  -- What we ask the vendor to deliver by, worked back from when stock runs out.
  requested_on  date not null,
  -- The sentence from nl.part_replenishment, kept so the draft still explains
  -- itself after the numbers underneath have moved on.
  reason        text not null default '',
  suggested_qty int not null,            -- what the maths said, before anyone edited it
  edited        boolean not null default false,
  unique (request_id, line_no)
);

create index purchase_request_lines_item_idx on nl.purchase_request_lines (item_no);

-- The vendor email, held for a person to send. When 0021's nl.mail_drafts is
-- here, the same draft is mirrored into it and mail_draft_id says where;
-- until then this table IS the review queue. See
-- app/src/lib/server/procurement/outbox.ts.
create table nl.purchase_request_drafts (
  id            bigint generated always as identity primary key,
  request_id    bigint not null references nl.purchase_requests (id) on delete cascade,
  to_email      text not null check (length(to_email) between 5 and 120),
  to_name       text not null default '',
  subject       text not null check (length(subject) between 3 and 200),
  body          text not null check (length(body) between 3 and 20000),
  -- The id of the mirrored row in nl.mail_drafts, when there was one to write.
  mail_draft_id bigint,
  queued_by     int not null references nl.users (id),
  queued_at     timestamptz not null default now(),
  unique (request_id)
);

comment on table nl.purchase_request_drafts is
  'Vendor emails waiting for a person. Nothing here is sent by this app.';

create index purchase_request_drafts_queued_by_idx on nl.purchase_request_drafts (queued_by);

-- ---------------------------------------------------------------------------
-- Write: sweep the signals
-- ---------------------------------------------------------------------------

-- Look at everything the desk should know about, and record anything new.
--
-- There is no row version on this one, because it changes no existing record:
-- it inserts signals that are not there yet and clears ones whose condition
-- has passed. The concurrency control is the unique key on (signal, subject),
-- which is stronger than a version check for "once per subject": two sweeps
-- racing each other cannot both insert, whatever each one read first.
create function nl.sweep_procurement_signals(
  p_request_id text,
  p_via        text default 'automation'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_today   date := nl.today();
  v_raised  jsonb := '{}';
  v_n       int;
  v_total   int := 0;
  v_cleared int;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'sweep_procurement_signals');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if not nl.can_buy() then
    raise exception 'Only operations or an admin can sweep the procurement signals.' using errcode = 'NL403';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant', 'automation') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  -- nl.part_replenishment is the expensive read in this file, and five of the
  -- seven signals want something from it. Read it ONCE into a temp table and
  -- work from that. The first version read the view four times and the sweep
  -- took 8.8 s on the demo world; this reads it once.
  drop table if exists pg_temp.swept;
  create temporary table swept on commit drop as
  select * from nl.part_replenishment;
  create index on pg_temp.swept (item_no);

  -- 1. Below the reorder point (or below safety stock).
  insert into nl.procurement_signals (signal, subject, item_no, vendor_no, headline, detail,
                                      value_at_risk, raised_on)
  select 'below_reorder_point', r.item_no, r.item_no, r.vendor_no,
         left(r.item_no || ' is ' || r.trigger_reason || ': ' || r.reason, 300),
         jsonb_build_object('projected_available', r.projected_available,
                            'policy_level', r.policy_level,
                            'suggested_qty', r.suggested_qty,
                            'lead_time_days', r.lead_time_days),
         greatest(r.value_at_risk, r.revenue_90d), v_today
  from pg_temp.swept r
  where r.needs_buying
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('below_reorder_point', v_n);
  v_total := v_total + v_n;

  -- 2. A purchase order past due, or a promised date that moved out.
  insert into nl.procurement_signals (signal, subject, item_no, headline, detail, raised_on)
  select 'purchase_order_late',
         s.source || ':' || s.document_no || ':' || s.line_no,
         s.item_no,
         left(case when s.past_due
                   then s.item_no || ': ' || s.quantity || ' due ' || s.due_on
                        || ', ' || s.days_late || ' days late'
                   else s.item_no || ': ' || s.quantity || ' slipped ' || s.days_slipped
                        || ' days to ' || s.due_on
              end, 300),
         jsonb_build_object('document_no', s.document_no, 'line_no', s.line_no, 'source', s.source,
                            'due_on', s.due_on, 'past_due', s.past_due, 'slipped', s.slipped,
                            'days_late', s.days_late, 'days_slipped', s.days_slipped),
         v_today
  from nl.procurement_late_supply s
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('purchase_order_late', v_n);
  v_total := v_total + v_n;

  -- 3. A cost revision worth knowing about: recent, bigger than rounding, and
  -- something a VENDOR did. 0018's cost timeline also carries our own standard
  -- rollups ('standard revision'), which are an accounting exercise and not a
  -- price somebody moved on us, so they are left out: this signal is the desk
  -- being told a vendor put its price up.
  insert into nl.procurement_signals (signal, subject, item_no, vendor_no, headline, detail, raised_on)
  select 'vendor_cost_moved',
         t.item_no || ':' || t.effective_from,
         t.item_no, t.vendor_no,
         left(t.item_no || ': cost ' || case when t.change > 0 then 'up' else 'down' end || ' '
              || trim(to_char(abs(t.change_pct) * 100, 'FM990.0')) || '% to $'
              || trim(to_char(t.unit_cost, 'FM9999990.00')) || ' (' || t.source || ')', 300),
         jsonb_build_object('effective_from', t.effective_from, 'unit_cost', t.unit_cost,
                            'change', t.change, 'change_pct', t.change_pct, 'source', t.source),
         v_today
  from nl.item_cost_timeline t
  where t.effective_from > v_today - nl.signal_window_days()
    and t.effective_from <= v_today
    and t.change_pct is not null
    and abs(t.change_pct) >= nl.cost_move_threshold()
    and t.source in ('vendor quote', 'purchase receipt')
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('vendor_cost_moved', v_n);
  v_total := v_total + v_n;

  -- 4. New demand that leaves a part short: somebody has just asked for it
  -- and it cannot cover what is asked of it.
  --
  -- This overlaps 'below_reorder_point' on purpose. Being under the reorder
  -- point is a standing fact about a part; a new order or a new commitment
  -- arriving and finding it short is an event, and the two want different
  -- answers (buy more, versus go and tell the account manager what is
  -- actually possible).
  --
  -- A part can have both a new order and a new commitment behind it, so take
  -- the earlier of the two.
  insert into nl.procurement_signals (signal, subject, item_no, vendor_no, headline, detail,
                                      value_at_risk, raised_on)
  select 'demand_jumped', j.item_no, j.item_no, j.vendor_no,
         left(j.item_no || ': a new ' || j.source || ' leaves it '
              || j.shortfall || ' short', 300),
         jsonb_build_object('projected_available', j.projected_available,
                            'shortfall', j.shortfall,
                            'source', j.source, 'arrived_on', j.arrived_on),
         greatest(j.value_at_risk, j.revenue_90d), v_today
  from (
    select distinct on (r.item_no)
           r.item_no, r.vendor_no, r.projected_available, r.value_at_risk, r.revenue_90d,
           d.source, d.arrived_on,
           -- How far short: below a policy, the gap to it; with no policy,
           -- whatever the projection is under zero by.
           case when r.policy_level is not null and r.projected_available < r.policy_level
                then r.policy_level - r.projected_available
                else greatest(-r.projected_available, 0) end as shortfall
    from pg_temp.swept r
    join nl.procurement_new_demand d on d.item_no = r.item_no
    where r.needs_buying or r.projected_available < 0
    order by r.item_no, d.arrived_on
  ) j
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('demand_jumped', v_n);
  v_total := v_total + v_n;

  -- 5. A bought part with nobody to buy it from.
  insert into nl.procurement_signals (signal, subject, item_no, headline, detail, raised_on)
  select 'no_vendor', r.item_no, r.item_no,
         r.item_no || ' is bought in but has no vendor on its item card',
         jsonb_build_object('replenishment', r.replenishment, 'units_365d', r.units_365d),
         v_today
  from pg_temp.swept r
  where r.vendor_no is null
    and not r.blocked
    and r.replenishment = 'Purchase'
    -- Only parts that matter: something sold, or something is on order for it.
    and (r.units_365d > 0 or r.promised_total > 0)
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('no_vendor', v_n);
  v_total := v_total + v_n;

  -- 6. A part with no cost to order against. An order at zero cost would
  -- price the whole draft wrong and nobody would notice until the invoice.
  -- The cost here is the one the cost timeline resolved (0018), not the raw
  -- item card, so a card of zero with a real cost history does not count.
  insert into nl.procurement_signals (signal, subject, item_no, vendor_no, headline, detail, raised_on)
  select 'no_cost', r.item_no, r.item_no, r.vendor_no,
         r.item_no || ' has no cost on its item card or in the cost history',
         jsonb_build_object('item_cost', r.unit_cost, 'units_365d', r.units_365d),
         v_today
  from pg_temp.swept r
  where not r.blocked
    and coalesce(r.unit_cost, 0) <= 0
    and (r.units_365d > 0 or r.promised_total > 0)
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('no_cost', v_n);
  v_total := v_total + v_n;

  -- 7. A vendor whose short parts do not add up to its minimum order, or to
  -- its free-freight threshold. One signal per vendor and not one per part,
  -- because the answer is to group that vendor's parts into one order.
  insert into nl.procurement_signals (signal, subject, vendor_no, headline, detail,
                                      value_at_risk, raised_on)
  select 'under_vendor_minimum', g.vendor_no, g.vendor_no,
         left(g.vendor_name || ': ' || g.parts || ' parts short, $'
              || trim(to_char(g.subtotal, 'FM9999990.00')) || ' against a '
              || case when g.min_order is not null and g.subtotal < g.min_order
                      then '$' || trim(to_char(g.min_order, 'FM9999990')) || ' minimum order'
                      else '$' || trim(to_char(g.free_freight_at, 'FM9999990'))
                           || ' free-freight threshold'
                 end, 300),
         jsonb_build_object('parts', g.parts, 'subtotal', g.subtotal,
                            'min_order', g.min_order, 'free_freight_at', g.free_freight_at),
         g.value_at_risk, v_today
  from (
    select
      r.vendor_no,
      max(r.vendor_name)            as vendor_name,
      count(*)::int                 as parts,
      sum(r.suggested_cost)         as subtotal,
      sum(greatest(r.value_at_risk, r.revenue_90d)) as value_at_risk,
      max(r.vendor_min_order)       as min_order,
      max(r.vendor_free_freight_at) as free_freight_at
    from pg_temp.swept r
    where r.needs_buying and r.vendor_no is not null
    group by r.vendor_no
  ) g
  where g.subtotal > 0
    and (g.subtotal < g.min_order or g.subtotal < g.free_freight_at)
  on conflict (signal, subject) do nothing;
  get diagnostics v_n = row_count;
  v_raised := v_raised || jsonb_build_object('under_vendor_minimum', v_n);
  v_total := v_total + v_n;

  -- Clear the part signals whose condition has passed, so the log reads as
  -- history and not as a list of things still wrong.
  update nl.procurement_signals s
     set cleared_at = now()
   where s.cleared_at is null
     and s.signal in ('below_reorder_point', 'demand_jumped')
     and not exists (
       select 1 from pg_temp.swept r
       where r.item_no = s.subject
         and (r.needs_buying or r.projected_available < 0));
  get diagnostics v_cleared = row_count;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'sweep_procurement_signals', 'procurement', v_today::text, p_request_id,
          jsonb_build_object('raised', v_raised, 'total', v_total, 'cleared', v_cleared));

  v_result := jsonb_build_object('raised', v_raised, 'total', v_total,
                                 'cleared', v_cleared, 'replayed', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Write: draft the suggested orders
-- ---------------------------------------------------------------------------

-- Turn what needs buying into one draft per vendor, with its lines, prices,
-- requested dates, terms and freight note. A vendor that already has an open
-- draft is skipped, so running this twice does not leave the desk looking at
-- the same order twice (the partial unique index enforces that too).
--
-- Parts with no vendor or no cost are left out and counted in the result:
-- they need a person to fix the item card, and a signal has already said so.
-- Parts we MAKE are left out too, and are NOT counted as skipped: they are
-- short of a production order, which is not this desk's job.
--
-- Headers and lines are written by ONE statement, with the view read into a
-- materialized CTE and the header insert's RETURNING feeding the line insert.
-- nl.part_replenishment is the most expensive read in this file, and this way
-- a draft run evaluates it once.
create function nl.draft_purchase_requests(
  p_vendor_no  text,
  p_request_id text,
  p_via        text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_ids     bigint[];
  v_skipped int;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'draft_purchase_requests');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if not nl.can_buy() then
    raise exception 'Only operations or an admin can draft a purchase request.' using errcode = 'NL403';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant', 'automation') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;
  if p_vendor_no is not null and not exists (select 1 from nl.vendors where vendor_no = p_vendor_no) then
    raise exception 'Vendor % does not exist.', p_vendor_no using errcode = 'NL404';
  end if;

  with needed as materialized (
    select r.item_no, r.vendor_no, r.vendor_terms, r.vendor_freight_terms,
           r.vendor_min_order, r.vendor_free_freight_at,
           r.suggested_qty, r.suggested_cost, r.unit_cost, r.requested_on, r.reason,
           r.buyable, r.item_card_incomplete
    from nl.part_replenishment r
    where r.needs_buying
      and (p_vendor_no is null or r.vendor_no = p_vendor_no)
  ),
  -- A part can only be ordered when we know who from and at what price.
  buyable as (
    select * from needed where buyable
  ),
  vendors as (
    select
      b.vendor_no,
      min(b.requested_on)           as needed_by,
      max(b.vendor_terms)           as terms,
      max(b.vendor_freight_terms)   as freight_terms,
      max(b.vendor_min_order)       as min_order,
      max(b.vendor_free_freight_at) as free_freight_at,
      sum(b.suggested_cost)         as subtotal
    from buyable b
    group by b.vendor_no
    -- A vendor the desk is already looking at is left alone.
    having not exists (
      select 1 from nl.purchase_requests pr
      where pr.vendor_no = b.vendor_no and pr.status = 'draft')
  ),
  new_requests as (
    insert into nl.purchase_requests (vendor_no, needed_by, terms, freight_note, subtotal,
                                      min_order, free_freight_at, meets_minimum, created_by)
    select
      v.vendor_no, v.needed_by, coalesce(v.terms, ''),
      -- The freight sentence the draft carries: the vendor's own words, and
      -- where this order sits against the threshold in them.
      concat_ws(' ',
        nullif(coalesce(v.freight_terms, ''), ''),
        case when v.free_freight_at is not null and v.subtotal < v.free_freight_at
             then '(this order is $' || trim(to_char(v.free_freight_at - v.subtotal, 'FM9999990.00'))
                  || ' under the free-freight threshold)'
             when v.free_freight_at is not null
             then '(this order clears the free-freight threshold)'
        end),
      v.subtotal, v.min_order, v.free_freight_at,
      (v.min_order is null or v.subtotal >= v.min_order),
      v_actor.id
    from vendors v
    returning id, vendor_no
  ),
  new_lines as (
    insert into nl.purchase_request_lines (request_id, line_no, item_no, quantity, unit_cost,
                                           requested_on, reason, suggested_qty)
    select
      nr.id,
      (row_number() over (partition by nr.id order by b.requested_on, b.item_no))::int,
      b.item_no, b.suggested_qty, b.unit_cost, b.requested_on, b.reason, b.suggested_qty
    from new_requests nr
    join buyable b on b.vendor_no = nr.vendor_no
    returning request_id
  )
  select coalesce(array_agg(nr.id order by nr.id), '{}'),
         (select count(*)::int from needed where item_card_incomplete)
    into v_ids, v_skipped
  from new_requests nr;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  select v_actor.id, p_via, 'draft_purchase_request', 'purchase_request', pr.id::text, p_request_id,
         jsonb_build_object('vendor_no', pr.vendor_no, 'subtotal', pr.subtotal,
                            'meets_minimum', pr.meets_minimum,
                            'lines', (select count(*) from nl.purchase_request_lines l
                                      where l.request_id = pr.id))
  from nl.purchase_requests pr
  where pr.id = any(v_ids);

  v_result := jsonb_build_object(
    'request_ids', to_jsonb(v_ids),
    'drafted', coalesce(array_length(v_ids, 1), 0),
    'skipped', coalesce(v_skipped, 0),
    'replayed', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Write: edit a line on a draft
-- ---------------------------------------------------------------------------

-- The desk changes a quantity or a date before approving. The lock is the
-- request's own row version, so two people editing one draft from stale pages
-- cannot both win.
create function nl.set_purchase_request_line(
  p_line_id             bigint,
  p_quantity            int,
  p_requested_on        date,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_line       nl.purchase_request_lines;
  v_req        nl.purchase_requests;
  v_updated_at timestamptz;
  v_subtotal   numeric(14, 2);
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_purchase_request_line');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if not nl.can_buy() then
    raise exception 'Only operations or an admin can change a purchase request.' using errcode = 'NL403';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  select * into v_line from nl.purchase_request_lines where id = p_line_id;
  if not found then
    raise exception 'Purchase request line % does not exist.', coalesce(p_line_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  select * into v_req from nl.purchase_requests where id = v_line.request_id;

  if v_req.status <> 'draft' then
    raise exception 'Request % was already %, so it cannot be changed.', v_req.id, v_req.status
      using errcode = 'NL422';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then
    raise exception 'A quantity is 1 to 1,000,000, not %.', coalesce(p_quantity::text, 'empty')
      using errcode = 'NL422';
  end if;
  if p_requested_on is null then
    raise exception 'Give a date to ask the vendor for.' using errcode = 'NL422';
  end if;
  if p_requested_on < nl.today() then
    raise exception 'A delivery date cannot be in the past.' using errcode = 'NL422';
  end if;
  if p_requested_on > nl.today() + 730 then
    raise exception 'A delivery date runs to two years out at most.' using errcode = 'NL422';
  end if;

  -- The lock: the draft must not have moved since the page loaded.
  update nl.purchase_requests
     set updated_at = updated_at
   where id = v_req.id
     and updated_at = p_expected_updated_at;
  if not found then
    raise exception 'Request % changed since the page was loaded. Reload and try again.', v_req.id
      using errcode = 'NL409';
  end if;

  update nl.purchase_request_lines
     set quantity = p_quantity,
         requested_on = p_requested_on,
         -- Once a person has touched a line it stays marked, so the draft
         -- shows what was the machine's idea and what was theirs.
         edited = (edited or p_quantity <> suggested_qty or p_requested_on <> v_line.requested_on)
   where id = p_line_id;

  -- Keep the header in step with its lines.
  select sum(round(l.quantity * l.unit_cost, 2)) into v_subtotal
  from nl.purchase_request_lines l where l.request_id = v_req.id;

  update nl.purchase_requests
     set subtotal = coalesce(v_subtotal, 0),
         meets_minimum = (min_order is null or coalesce(v_subtotal, 0) >= min_order),
         needed_by = (select min(l.requested_on) from nl.purchase_request_lines l
                      where l.request_id = v_req.id)
   where id = v_req.id
  returning updated_at into v_updated_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'set_purchase_request_line', 'purchase_request', v_req.id::text, p_request_id,
          jsonb_build_object('line_id', p_line_id, 'item_no', v_line.item_no,
                             'quantity_was', v_line.quantity, 'quantity_now', p_quantity,
                             'requested_was', v_line.requested_on, 'requested_now', p_requested_on));

  v_result := jsonb_build_object('request_id', v_req.id, 'line_id', p_line_id,
                                 'subtotal', coalesce(v_subtotal, 0),
                                 'updated_at', v_updated_at, 'replayed', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Write: approve a draft
-- ---------------------------------------------------------------------------

-- Approval is the only thing on this page that commits money, so it is the
-- strictest write in the file:
--
--   * operations or an admin, nobody else;
--   * the draft's own row version has to match the page's;
--   * one purchase order, in this desk's own tables, mirrored into 0016's
--     table when that exists, so the supply forecast clears;
--   * an audit row naming the order it created.
--
-- The vendor email is NOT queued here. It is built and checked against the
-- disclosure policy in TypeScript, in the same transaction, before
-- nl.queue_purchase_request_draft writes it (see
-- app/src/lib/server/procurement/outbox.ts). A draft that would tell a vendor
-- something it may not hear therefore rolls the approval back with it.
create function nl.approve_purchase_request(
  p_request_row_id      bigint,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_req        nl.purchase_requests;
  v_updated_at timestamptz;
  v_order_id   bigint;
  v_order_no   text;
  v_lines      int;
  v_mirrored   boolean := false;
  v_qty_col    text;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'approve_purchase_request');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if not nl.can_buy() then
    raise exception 'Only operations or an admin can approve a purchase request.' using errcode = 'NL403';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  select * into v_req from nl.purchase_requests where id = p_request_row_id;
  if not found then
    raise exception 'Purchase request % does not exist.', coalesce(p_request_row_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  if v_req.status <> 'draft' then
    raise exception 'Request % was already %.', v_req.id, v_req.status using errcode = 'NL422';
  end if;

  select count(*)::int into v_lines from nl.purchase_request_lines where request_id = v_req.id;
  if v_lines = 0 then
    raise exception 'Request % has no lines to order.', v_req.id using errcode = 'NL422';
  end if;
  if exists (select 1 from nl.purchase_request_lines l
             where l.request_id = v_req.id and l.unit_cost <= 0) then
    raise exception 'Request % has a line with no cost. Fix the item card first.', v_req.id
      using errcode = 'NL422';
  end if;

  -- The lock.
  update nl.purchase_requests
     set updated_at = updated_at
   where id = v_req.id
     and updated_at = p_expected_updated_at;
  if not found then
    raise exception 'Request % changed since the page was loaded. Reload and try again.', v_req.id
      using errcode = 'NL409';
  end if;

  insert into nl.procurement_orders (vendor_no, request_id, terms, freight_terms, subtotal, created_by)
  values (v_req.vendor_no, v_req.id, v_req.terms, v_req.freight_note, v_req.subtotal, v_actor.id)
  returning id, order_no into v_order_id, v_order_no;

  insert into nl.procurement_order_lines (order_id, line_no, item_no, quantity, unit_cost,
                                          original_promised_on, promised_on)
  select v_order_id, l.line_no, l.item_no, l.quantity, l.unit_cost, l.requested_on, l.requested_on
  from nl.purchase_request_lines l
  where l.request_id = v_req.id;

  -- Mirror into 0016's purchase order lines once that migration is here, so
  -- the supply forecast stops asking for these parts. The column names are
  -- looked up rather than assumed; if the shape turns out to be different
  -- again, the desk's own rows still hold the order and
  -- nl.incoming_supply() still counts them.
  if to_regclass('nl.purchase_order_lines') is not null then
    v_qty_col := nl.first_column('purchase_order_lines',
                   array['quantity_outstanding', 'outstanding_quantity', 'open_quantity', 'quantity', 'qty']);
    if v_qty_col is not null
       and nl.first_column('purchase_order_lines', array['item_no']) is not null then
      begin
        execute format(
          'insert into nl.purchase_order_lines (item_no, %I)
             select l.item_no, l.quantity from nl.procurement_order_lines l where l.order_id = $1',
          v_qty_col)
        using v_order_id;
        v_mirrored := true;
      exception when others then
        -- The mirror is a convenience, never the record. A column this
        -- migration cannot know about (a not-null document number, say)
        -- leaves the order exactly where it already is.
        v_mirrored := false;
      end;
    end if;
  end if;

  update nl.procurement_orders set mirrored = v_mirrored where id = v_order_id;

  update nl.purchase_requests
     set status = 'approved',
         decided_by = v_actor.id,
         decided_at = now(),
         order_id = v_order_id
   where id = v_req.id
  returning updated_at into v_updated_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'approve_purchase_request', 'purchase_request', v_req.id::text, p_request_id,
          jsonb_build_object('vendor_no', v_req.vendor_no, 'order_id', v_order_id,
                             'order_no', v_order_no, 'lines', v_lines,
                             'subtotal', v_req.subtotal, 'mirrored', v_mirrored));

  v_result := jsonb_build_object('request_id', v_req.id, 'order_id', v_order_id,
                                 'order_no', v_order_no, 'lines', v_lines, 'mirrored', v_mirrored,
                                 'updated_at', v_updated_at, 'replayed', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Write: queue the vendor email
-- ---------------------------------------------------------------------------

-- Store the email a person will send. The subject and body arrive already
-- built and already checked against the disclosure policy in
-- app/src/lib/server/procurement/disclosure.ts. This function refuses a draft
-- for a request that has not been approved, so there is no path that queues
-- an email about an order that does not exist.
--
-- p_mail_draft_id is the id of the mirrored row in 0021's nl.mail_drafts,
-- when the adapter managed to write one. Null means this table is the queue.
create function nl.queue_purchase_request_draft(
  p_request_row_id bigint,
  p_to_email       text,
  p_to_name        text,
  p_subject        text,
  p_body           text,
  p_mail_draft_id  bigint,
  p_request_id     text,
  p_via            text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_req    nl.purchase_requests;
  v_email  text := nullif(lower(btrim(coalesce(p_to_email, ''))), '');
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'queue_purchase_request_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if not nl.can_buy() then
    raise exception 'Only operations or an admin can queue a vendor email.' using errcode = 'NL403';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  select * into v_req from nl.purchase_requests where id = p_request_row_id;
  if not found then
    raise exception 'Purchase request % does not exist.', coalesce(p_request_row_id::text, 'empty')
      using errcode = 'NL404';
  end if;
  if v_req.status <> 'approved' then
    raise exception 'Request % is %, so there is no order to write to the vendor about.',
      v_req.id, v_req.status using errcode = 'NL422';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then
    raise exception '% does not look like an email address.', coalesce(p_to_email, 'empty')
      using errcode = 'NL422';
  end if;
  if length(btrim(coalesce(p_subject, ''))) < 3 then
    raise exception 'The email needs a subject.' using errcode = 'NL422';
  end if;
  if length(btrim(coalesce(p_body, ''))) < 3 then
    raise exception 'The email needs a body.' using errcode = 'NL422';
  end if;

  insert into nl.purchase_request_drafts (request_id, to_email, to_name, subject, body,
                                          mail_draft_id, queued_by)
  values (v_req.id, v_email, btrim(coalesce(p_to_name, '')), btrim(p_subject), btrim(p_body),
          p_mail_draft_id, v_actor.id)
  on conflict (request_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- A draft is already waiting for this request; do not write a second one.
    select id into v_id from nl.purchase_request_drafts where request_id = v_req.id;
  else
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (v_actor.id, p_via, 'queue_purchase_request_draft', 'purchase_request', v_req.id::text,
            p_request_id,
            jsonb_build_object('draft_id', v_id, 'to_email', v_email,
                               'mail_draft_id', p_mail_draft_id));
  end if;

  v_result := jsonb_build_object('draft_id', v_id, 'request_id', v_req.id,
                                 'mail_draft_id', p_mail_draft_id, 'replayed', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.procurement_signals enable row level security;
alter table nl.procurement_orders enable row level security;
alter table nl.procurement_order_lines enable row level security;
alter table nl.purchase_requests enable row level security;
alter table nl.purchase_request_lines enable row level security;
alter table nl.purchase_request_drafts enable row level security;

-- The whole team can read the desk. Only operations and admins write, and the
-- write functions check the same rule first and say why; these policies are
-- the backstop if a row ever reaches a table another way.
create policy procurement_signals_read on nl.procurement_signals
  for select to nl_app, nl_readonly using (true);
create policy procurement_signals_insert on nl.procurement_signals for insert to nl_app
  with check ((select nl.can_buy()));
create policy procurement_signals_update on nl.procurement_signals for update to nl_app
  using ((select nl.can_buy())) with check ((select nl.can_buy()));

create policy procurement_orders_read on nl.procurement_orders
  for select to nl_app, nl_readonly using (true);
create policy procurement_orders_insert on nl.procurement_orders for insert to nl_app
  with check (created_by = (select nl.current_user_id()) and (select nl.can_buy()));
create policy procurement_orders_update on nl.procurement_orders for update to nl_app
  using ((select nl.can_buy())) with check ((select nl.can_buy()));

create policy procurement_order_lines_read on nl.procurement_order_lines
  for select to nl_app, nl_readonly using (true);
create policy procurement_order_lines_insert on nl.procurement_order_lines for insert to nl_app
  with check ((select nl.can_buy()));
create policy procurement_order_lines_update on nl.procurement_order_lines for update to nl_app
  using ((select nl.can_buy())) with check ((select nl.can_buy()));

create policy purchase_requests_read on nl.purchase_requests for select to nl_app using (true);
create policy purchase_requests_insert on nl.purchase_requests for insert to nl_app
  with check (created_by = (select nl.current_user_id()) and (select nl.can_buy()));
create policy purchase_requests_update on nl.purchase_requests for update to nl_app
  using ((select nl.can_buy())) with check ((select nl.can_buy()));

create policy purchase_request_lines_read on nl.purchase_request_lines for select to nl_app using (true);
create policy purchase_request_lines_insert on nl.purchase_request_lines for insert to nl_app
  with check ((select nl.can_buy()));
create policy purchase_request_lines_update on nl.purchase_request_lines for update to nl_app
  using ((select nl.can_buy())) with check ((select nl.can_buy()));

create policy purchase_request_drafts_read on nl.purchase_request_drafts for select to nl_app using (true);
create policy purchase_request_drafts_insert on nl.purchase_request_drafts for insert to nl_app
  with check (queued_by = (select nl.current_user_id()) and (select nl.can_buy()));

grant select, insert on nl.procurement_signals to nl_app;
grant update (cleared_at, value_at_risk, detail) on nl.procurement_signals to nl_app;
grant select, insert on nl.procurement_orders, nl.procurement_order_lines to nl_app;
grant update (status, subtotal, mirrored, updated_at) on nl.procurement_orders to nl_app;
grant update (received_qty, promised_on) on nl.procurement_order_lines to nl_app;
grant select, insert on nl.purchase_requests, nl.purchase_request_lines to nl_app;
grant update (status, needed_by, subtotal, meets_minimum, note, decided_by, decided_at,
              order_id, updated_at) on nl.purchase_requests to nl_app;
grant update (quantity, requested_on, edited) on nl.purchase_request_lines to nl_app;
grant select, insert on nl.purchase_request_drafts to nl_app;
grant usage on sequence nl.procurement_order_no_seq to nl_app;

grant select on nl.part_usage, nl.part_replenishment, nl.procurement_new_demand,
  nl.procurement_late_supply to nl_app;

-- The read-only role (the assistant's SQL tool) gets the parts and the money,
-- never the people. nl.part_replenishment reads nl.procurement_orders on its
-- way to "what is already on order", so that table is granted column by
-- column, without created_by. nl.purchase_requests and
-- nl.purchase_request_drafts (who drafted it, who to email) stay out
-- altogether, and so do the two views that read them.
grant select on nl.part_usage, nl.part_replenishment to nl_readonly;
grant select (id, order_no, vendor_no, request_id, status, ordered_on, terms, freight_terms,
              subtotal, mirrored, created_at, updated_at) on nl.procurement_orders to nl_readonly;
grant select on nl.procurement_order_lines to nl_readonly;

grant execute on function
  nl.target_cover_days(), nl.signal_window_days(),
  nl.cost_move_threshold(), nl.lead_time_days(text), nl.default_lead_days(text),
  nl.item_lead_time_days(text),
  nl.pack_size(text, numeric), nl.round_to_pack(numeric, int), nl.free_freight_threshold(text),
  nl.replenishment_reason(int, numeric, int, int, int, int),
  nl.procurement_sources(), nl.first_column(text, text[]), nl.date_expression(text, text),
  nl.incoming_supply()
to nl_app, nl_readonly;

grant execute on function
  nl.can_buy(),
  nl.sweep_procurement_signals(text, text),
  nl.draft_purchase_requests(text, text, text),
  nl.set_purchase_request_line(bigint, int, date, timestamptz, text, text),
  nl.approve_purchase_request(bigint, timestamptz, text, text),
  nl.queue_purchase_request_draft(bigint, text, text, text, text, bigint, text, text)
to nl_app;
