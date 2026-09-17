-- 0022 Supply the demo world covers on purpose.
--
-- 0016's sample supply generators worked from the item master: whichever
-- parts happened to carry a figure in nl.stock.on_purchase_order or
-- on_production_order got an order, and every other part got nothing. Those
-- figures were drawn independently of what customers had ordered, so at full
-- scale 57% of open sales lines had nothing on order behind them
-- (no_supply 825, on_time 377, past_due 158, late_waiting_supply 90,
-- late_supply_overdue 7 of 1,457 lines). A parts maker of this size does not
-- run that way: it stocks its fast movers and buys or makes against the rest,
-- so most demand is covered and lateness is a question of dates.
--
-- This migration turns the generators around. The plan starts from demand:
--
--   1. take today's open sales lines, part by part, in the order stock is
--      handed out, and net them against what is on the shelf;
--   2. every line the shelf does not reach is a requirement: how many pieces
--      are missing, and the day they are missing by;
--   3. for each part, decide with a keyed draw whether it is covered at all
--      (usually yes, and less often the longer its lead time is, which is the
--      honest reason a part has nothing coming);
--   4. for a covered part, place one purchase order line (bought) or one
--      production order (made) per requirement, for exactly those pieces:
--      most due before the day they are needed, about two in five after it
--      (which is what makes a customer line late), and a few already past
--      due, mostly where the need is in the next few days, because that is
--      the situation a buyer recognizes;
--   5. buy or make stocked parts nobody is waiting for back up to their
--      reorder point now and then, so the supply book is not purely
--      demand-driven.
--
-- One order per requirement is also what keeps the mix steady at any size:
-- the shares inside the covered group no longer depend on how many lines an
-- average part happens to carry.
--
-- The item master is the derived side: db/seed.d/40_supply.sql sets
-- nl.stock.on_purchase_order and on_production_order to the quantities these
-- generators produce for today, which keeps the invariant the forecast tests
-- check (the item card and the open supply agree, part by part). The
-- generators read on_hand and demand, never those two columns, so there is no
-- circle.
--
-- Nothing about the sales export changes: the sales generator does not read
-- the supply side, so its files, their fingerprints and the fixtures are byte
-- for byte what they were.

-- ---------------------------------------------------------------------------
-- The plan: what demand needs that stock does not cover
-- ---------------------------------------------------------------------------

/*
 * One row per open sales line the shelf does not cover, which is one
 * requirement for the buyer or the planner.
 *
 *   seq         1, 2, 3 ... per part, in ship-date order
 *   need_by     the ship date of the line this requirement is for
 *   quantity    the pieces of that line the shelf does not cover
 *   made        true when the shop floor makes it, false when a vendor sells it
 *   covered     whether anybody has actually ordered this part (keyed draw,
 *               decided once per part, so an uncovered part stays uncovered
 *               all the way through)
 *
 * Both supply generators read this, so they cannot disagree about which part
 * is covered, or by which side of the house.
 */
create function nl.sample_supply_plan()
returns table (
  item_no     text,
  description text,
  made        boolean,
  vendor_no   text,
  work_center text,
  seq         int,
  need_by     date,
  quantity    int,
  lead_days   int,
  covered     boolean,
  today       date
)
language sql stable
set search_path = ''
as $$
with clock as materialized (
  select nl.today() as today
),
-- Today's open sales lines with a running sum per part, in the order
-- nl.open_line_projection hands stock out.
demand as (
  select d.item_no, d.document_no, d.line_no, d.ship_date, d.quantity,
         coalesce(s.on_hand, 0) as on_hand,
         sum(d.quantity) over (partition by d.item_no
                               order by d.ship_date, d.document_no, d.line_no
                               rows unbounded preceding) as demand_through
  from nl.sample_open_sales_lines((select today from clock)) d
  left join nl.stock s on s.item_no = d.item_no
),
-- The part of each line the shelf does not reach. The first such line may be
-- covered in part, so it asks only for the difference; the ones after it ask
-- for their whole quantity. Together they add up to the part's shortfall.
requirements as (
  select d.item_no, d.ship_date,
         least(d.quantity, d.demand_through - d.on_hand)::int as quantity,
         row_number() over (partition by d.item_no
                            order by d.ship_date, d.document_no, d.line_no)::int as seq
  from demand d
  where d.demand_through > d.on_hand
)
select
  r.item_no,
  i.description,
  -- A part with no vendor on its card is made here, whatever the card says.
  (i.replenishment <> 'Purchase' or i.vendor_no is null) as made,
  i.vendor_no,
  i.work_center,
  r.seq,
  r.ship_date as need_by,
  r.quantity,
  l.lead_days,
  -- Most of what stock does not cover is on order. A long lead time is the
  -- honest reason a part has nothing coming: nobody has committed to it yet.
  nl.sample_draw('cover|' || r.item_no)
    < case when l.lead_days >= 42 then 0.50::double precision
           when l.lead_days >= 28 then 0.74::double precision
           else 0.90::double precision end as covered,
  c.today
from requirements r
join nl.items i on i.item_no = r.item_no
left join nl.vendors v on v.vendor_no = i.vendor_no
cross join clock c
cross join lateral (
  select coalesce(nl.lead_time_days(i.lead_time),
                  nl.lead_time_days(v.lead_time),
                  nl.default_lead_days(i.replenishment)) as lead_days
) l
$$;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------

/*
 * The open purchase lines export for one day.
 *
 * Every line here exists for a reason: a requirement customers have put on a
 * bought part, or a stocked part below its reorder point. Lines are grouped
 * into purchase orders by vendor and the week they were first promised, the
 * way a buyer orders.
 *
 * Three things make the file differ from day to day: a line ordered today, a
 * line received today, and a vendor moving an expected receipt date out (the
 * promised date keeps what they said first).
 */
create or replace function nl.sample_open_purchase_lines(p_day date)
returns table (
  row_no        int,
  document_no   text,
  line_no       int,
  vendor_no     text,
  item_no       text,
  description   text,
  due_date      date,
  promised_date date,
  quantity      int,
  location_code text
)
language sql stable
set search_path = ''
as $$
with plan_all as (
  select * from nl.sample_supply_plan()
),
bought as (
  select * from plan_all p
  where p.covered and not p.made and p.vendor_no is not null
),
-- One line per requirement, due around the day it is needed.
against_demand as (
  select b.item_no, b.description, b.vendor_no, b.today, b.lead_days,
         'po|' || b.item_no || '|' || b.seq as key,
         false as received,
         b.quantity,
         case
           -- A part needed in the next few days whose vendor is already late.
           when b.need_by <= b.today + 3
                and nl.sample_draw('po.over.soon|' || b.item_no || '|' || b.seq) < 0.75::double precision
             then b.today - (1 + floor(nl.sample_draw('po.over|' || b.item_no || '|' || b.seq) * 20)::int)
           -- There in time.
           when nl.sample_draw('po.when|' || b.item_no || '|' || b.seq) < 0.55::double precision
             then greatest(b.need_by - floor(nl.sample_draw('po.early|' || b.item_no || '|' || b.seq) * 11)::int,
                           b.today)
           -- Lands after it is needed: this is what makes a customer line late.
           when nl.sample_draw('po.when|' || b.item_no || '|' || b.seq) < 0.95::double precision
             then b.need_by + (1 + floor(nl.sample_draw('po.late|' || b.item_no || '|' || b.seq) * 21)::int)
           -- Already past due, for a need further out.
           else b.today - (1 + floor(nl.sample_draw('po.over|' || b.item_no || '|' || b.seq) * 20)::int)
         end as due_now
  from bought b
),
-- Stocked parts nobody is waiting for, bought back up to their reorder point
-- now and then. Parts with a requirement are left out: their cover is decided
-- above, and a part deliberately left uncovered must stay uncovered.
replenishment as (
  select i.item_no, i.description, i.vendor_no, c.today,
         coalesce(nl.lead_time_days(v.lead_time), nl.lead_time_days(i.lead_time), 21) as lead_days,
         'po.rep|' || i.item_no as key,
         false as received,
         greatest(5, i.reorder_point - s.on_hand)::int as quantity,
         c.today + (7 + floor(nl.sample_draw('po.rep.due|' || i.item_no) * 45)::int) as due_now
  from nl.items i
  join nl.stock s on s.item_no = i.item_no
  join nl.vendors v on v.vendor_no = i.vendor_no
  cross join (select nl.today() as today) c
  where i.replenishment = 'Purchase'
    and not i.blocked
    and i.reorder_point is not null
    and s.on_hand < i.reorder_point
    and nl.sample_draw('po.rep|' || i.item_no) < 0.25::double precision
    and not exists (select 1 from plan_all p where p.item_no = i.item_no)
),
-- For one covered part in eight, a line that landed today: it is in
-- yesterday's file and gone from today's, which is what day over day shows.
landed as (
  select b.item_no, b.description, b.vendor_no, b.today, b.lead_days,
         'po.recv|' || b.item_no as key,
         true as received,
         greatest(1, b.quantity / 2)::int as quantity,
         b.today - floor(nl.sample_draw('po.got|' || b.item_no) * 6)::int as due_now
  from bought b
  where b.seq = 1 and nl.sample_draw('po.recv|' || b.item_no) < 0.12::double precision
),
lines as (
  select * from against_demand
  union all select * from replenishment
  union all select * from landed
),
dated as (
  select l.*,
         -- A vendor who moves a date out only does it once, a day or two ago.
         case
           when not l.received and nl.sample_draw(l.key || '|slip') < 0.12::double precision
           then 3 + floor(nl.sample_draw(l.key || '|slip.days') * 12)::int
           else 0
         end as slipped,
         l.today - floor(nl.sample_draw(l.key || '|slip.on') * 3)::int as slipped_on
  from lines l
),
ordered as (
  select d.*,
         -- What the vendor promised first, and when we placed the order: a
         -- lead time before the promised date, or, for an order promised far
         -- out, somewhere in the last six weeks. One order in twenty was
         -- placed today, which is what makes it "new" in today's file.
         d.due_now - d.slipped as promised,
         case
           when not d.received and nl.sample_draw(d.key || '|new') < 0.05::double precision then d.today
           else least(d.due_now - d.slipped - d.lead_days,
                      d.today - 1 - floor(nl.sample_draw(d.key || '|lag') * 45)::int)
         end as ordered_on,
         case when d.received then d.today else null::date end as received_on
  from dated d
),
-- One purchase order per vendor per week of first promise; the numbering
-- covers every line in the world, so a document keeps its number whichever
-- day is asked about.
numbered as (
  select o.*,
         dense_rank() over (order by o.vendor_no, to_char(o.promised, 'IYYY-IW')) as po_seq,
         row_number() over (partition by o.vendor_no, to_char(o.promised, 'IYYY-IW')
                            order by o.item_no, o.key) as po_line
  from ordered o
),
open_lines as (
  select 'PO-' || lpad((104000 + n.po_seq)::text, 6, '0') as document_no,
         (n.po_line * 10000)::int as line_no,
         n.vendor_no, n.item_no, n.description,
         -- Before the day the vendor moved it, the file showed the old date.
         case when n.slipped > 0 and p_day < n.slipped_on then n.promised else n.due_now end as due_date,
         n.promised as promised_date,
         n.quantity
  from numbered n
  where n.ordered_on <= p_day
    and (n.received_on is null or n.received_on > p_day)
)
select
  (row_number() over (order by l.document_no collate "C", l.line_no))::int as row_no,
  l.document_no, l.line_no, l.vendor_no, l.item_no, l.description,
  l.due_date, l.promised_date, l.quantity, 'MAIN'::text as location_code
from open_lines l
order by l.document_no collate "C", l.line_no
$$;

-- ---------------------------------------------------------------------------
-- Production orders
-- ---------------------------------------------------------------------------

/*
 * The open production orders export for one day: the same idea as the
 * purchase lines, for the parts the shop floor makes. One order per
 * requirement on the part's work center, mostly finished before the day it is
 * needed, about two in five after it, a few already past due. An order due
 * inside two weeks is Released; further out it may still be Firm Planned.
 */
create or replace function nl.sample_open_production_orders(p_day date)
returns table (
  row_no      int,
  order_no    text,
  item_no     text,
  work_center text,
  status      text,
  due_date    date,
  quantity    int
)
language sql stable
set search_path = ''
as $$
with plan_all as (
  select * from nl.sample_supply_plan()
),
made as (
  select * from plan_all p
  where p.covered and p.made
),
against_demand as (
  select m.item_no, m.work_center, m.today,
         'mo|' || m.item_no || '|' || m.seq as key,
         false as finished,
         m.quantity,
         case
           when m.need_by <= m.today + 3
                and nl.sample_draw('mo.over.soon|' || m.item_no || '|' || m.seq) < 0.75::double precision
             then m.today - (1 + floor(nl.sample_draw('mo.over|' || m.item_no || '|' || m.seq) * 14)::int)
           when nl.sample_draw('mo.when|' || m.item_no || '|' || m.seq) < 0.58::double precision
             then greatest(m.need_by - floor(nl.sample_draw('mo.early|' || m.item_no || '|' || m.seq) * 9)::int,
                           m.today)
           when nl.sample_draw('mo.when|' || m.item_no || '|' || m.seq) < 0.96::double precision
             then m.need_by + (1 + floor(nl.sample_draw('mo.late|' || m.item_no || '|' || m.seq) * 18)::int)
           else m.today - (1 + floor(nl.sample_draw('mo.over|' || m.item_no || '|' || m.seq) * 14)::int)
         end as due_now
  from made m
),
-- Stocked parts nobody is waiting for, made back up to their reorder point.
replenishment as (
  select i.item_no, i.work_center, c.today,
         'mo.rep|' || i.item_no as key,
         false as finished,
         greatest(5, i.reorder_point - s.on_hand)::int as quantity,
         c.today + (5 + floor(nl.sample_draw('mo.rep.due|' || i.item_no) * 35)::int) as due_now
  from nl.items i
  join nl.stock s on s.item_no = i.item_no
  cross join (select nl.today() as today) c
  where i.replenishment = 'Prod. Order'
    and not i.blocked
    and i.reorder_point is not null
    and s.on_hand < i.reorder_point
    and nl.sample_draw('mo.rep|' || i.item_no) < 0.25::double precision
    and not exists (select 1 from plan_all p where p.item_no = i.item_no)
),
-- For one covered part in eight, an order that came off the floor today.
off_the_floor as (
  select m.item_no, m.work_center, m.today,
         'mo.done|' || m.item_no as key,
         true as finished,
         greatest(1, m.quantity / 2)::int as quantity,
         m.today - floor(nl.sample_draw('mo.done|' || m.item_no) * 4)::int as due_now
  from made m
  where m.seq = 1 and nl.sample_draw('mo.done|' || m.item_no) < 0.12::double precision
),
orders as (
  select * from against_demand
  union all select * from replenishment
  union all select * from off_the_floor
),
dated as (
  select o.*,
         case
           when not o.finished and nl.sample_draw(o.key || '|slip') < 0.1::double precision
           then 3 + floor(nl.sample_draw(o.key || '|slip.days') * 10)::int
           else 0
         end as slipped,
         o.today - floor(nl.sample_draw(o.key || '|slip.on') * 3)::int as slipped_on
  from orders o
),
scheduled as (
  select d.*,
         -- When the planner wrote the order: a few weeks before it is due,
         -- or, for one due far out, somewhere in the last month. One in
         -- twenty was written today.
         case
           when not d.finished and nl.sample_draw(d.key || '|new') < 0.05::double precision then d.today
           else least(d.due_now - d.slipped - (5 + floor(nl.sample_draw(d.key || '|start') * 16)::int),
                      d.today - 1 - floor(nl.sample_draw(d.key || '|lag') * 30)::int)
         end as created_on,
         case when d.finished then d.today else null::date end as finished_on
  from dated d
),
numbered as (
  select s.*, row_number() over (order by s.item_no, s.key) as mo_seq
  from scheduled s
),
open_orders as (
  select 'MO-' || lpad((200000 + n.mo_seq)::text, 6, '0') as order_no,
         n.item_no, n.work_center, n.quantity, n.key,
         case when n.slipped > 0 and p_day < n.slipped_on then n.due_now - n.slipped else n.due_now end as due_date
  from numbered n
  where n.created_on <= p_day
    and (n.finished_on is null or n.finished_on > p_day)
)
select
  (row_number() over (order by o.order_no collate "C"))::int as row_no,
  o.order_no, o.item_no, o.work_center,
  case
    when o.due_date <= p_day + 14 then 'Released'
    when nl.sample_draw(o.key || '|status') < 0.5::double precision then 'Released'
    else 'Firm Planned'
  end as status,
  o.due_date, o.quantity
from open_orders o
order by o.order_no collate "C"
$$;

grant execute on function nl.sample_supply_plan() to nl_app;
