-- 0038 Capacity in hours, and a shortage explained down to the metal.
--
-- Two questions the forecast in 0016 cannot answer, because both of them
-- need the routings and the bills of material that 0035 added:
--
--   1. Which cell is the bottleneck, in hours rather than in line counts? A
--      work centre with four late orders and a work centre with four hundred
--      hours of work behind it are not the same problem, and counting lines
--      cannot tell them apart.
--   2. Why is this part short? Not "there is no stock", but which component
--      runs out, how much is missing, and which purchase or production order
--      would clear it.
--
-- Both are views over what is already there. Nothing is stored.

-- ---------------------------------------------------------------------------
-- Work centre load
-- ---------------------------------------------------------------------------

/*
 * Hours of work sitting in front of each cell, by the week it is due,
 * against the hours that cell can actually sell in a week.
 *
 * The hours come from the open production orders (0016) and the routing of
 * the part each one is for: setup once per order, run time times the
 * quantity, both stretched by the cell's efficiency, because a cell that
 * yields 51 minutes an hour needs 70 minutes of clock to do an hour of work.
 *
 * TWO THINGS THE SCREEN HAS TO SAY OUT LOUD:
 *
 *   * An order whose routing names four cells is counted in all four, so the
 *     total across cells is larger than the order book. That is correct and
 *     it is not a total: it is four separate answers to four separate
 *     questions about four separate cells.
 *   * Only the ordered part's own routing counts. Making a parent usually
 *     means making its children too, and those hours are real, but they
 *     belong to production orders that do not exist yet. Counting them here
 *     would be a plan, not a load, and a load is what a supervisor is
 *     looking at.
 */
create view nl.work_center_load with (security_invoker = true) as
with params as materialized (
  select nl.today() as today
),
demand as (
  select
    o.work_center      as order_work_center,
    o.order_no,
    o.item_no,
    o.quantity,
    o.due_date,
    -- The week the work is due, starting Monday.
    date_trunc('week', o.due_date)::date as due_week,
    o.due_date < p.today as overdue,
    r.work_center,
    r.seq,
    r.description,
    -- Setup is paid once for the order; run time is per piece. Both are
    -- divided by the cell's efficiency to turn work into clock.
    round((r.setup_minutes + r.run_minutes_per_piece * o.quantity) / 60 / r.efficiency, 3) as hours,
    round(r.setup_minutes / 60 / r.efficiency, 3) as setup_hours
  from nl.open_production_orders o
  join nl.routing_operations_effective r on r.item_no = o.item_no
  cross join params p
  where not r.is_outside and r.work_center is not null
)
select
  d.work_center,
  w.name           as work_center_name,
  w.department,
  d.due_week,
  count(distinct d.order_no)::int                                as orders,
  count(distinct d.item_no)::int                                 as parts,
  count(distinct d.order_no) filter (where d.overdue)::int        as overdue_orders,
  sum(d.quantity)::bigint                                        as pieces,
  round(sum(d.hours), 2)                                         as hours_required,
  round(sum(d.setup_hours), 2)                                   as setup_hours,
  round(sum(d.hours) filter (where d.overdue), 2)                as hours_overdue,
  c.effective_hours_per_week                                     as hours_available,
  case when c.effective_hours_per_week > 0
       then round(sum(d.hours) / c.effective_hours_per_week, 3) end as load_ratio,
  round(sum(d.hours) - c.effective_hours_per_week, 2)            as hours_over,
  -- One of these three words is what a supervisor reads.
  case
    when c.effective_hours_per_week <= 0 then 'no capacity set'
    when sum(d.hours) > c.effective_hours_per_week then 'over'
    when sum(d.hours) > c.effective_hours_per_week * 0.85 then 'tight'
    else 'clear'
  end as state,
  -- True when this cell is not where the order was booked: the order's own
  -- work centre column says one cell and the routing walks through several.
  bool_or(d.work_center <> coalesce(nullif(d.order_work_center, ''), d.work_center)) as also_counted_elsewhere
from demand d
join nl.work_centers w on w.code = d.work_center
join nl.work_center_capacity c on c.code = d.work_center
group by d.work_center, w.name, w.department, d.due_week, c.effective_hours_per_week;

-- The same thing rolled to one row per cell, for the board's header: the
-- next four weeks against what the cell can do in four weeks.
create view nl.work_center_load_now with (security_invoker = true) as
with params as materialized (
  select nl.today() as today
)
select
  c.code,
  c.name,
  c.department,
  c.shifts,
  c.effective_hours_per_week,
  coalesce(l.orders, 0)::int      as orders,
  coalesce(l.overdue_orders, 0)::int as overdue_orders,
  round(coalesce(l.hours_required, 0), 2) as hours_required,
  round(coalesce(l.hours_overdue, 0), 2)  as hours_overdue,
  round(c.effective_hours_per_week * 4, 2) as hours_available_4w,
  case when c.effective_hours_per_week > 0
       then round(coalesce(l.hours_required, 0) / (c.effective_hours_per_week * 4), 3) end as load_ratio,
  case
    when c.effective_hours_per_week <= 0 then 'no capacity set'
    when coalesce(l.hours_required, 0) > c.effective_hours_per_week * 4 then 'over'
    when coalesce(l.hours_required, 0) > c.effective_hours_per_week * 4 * 0.85 then 'tight'
    else 'clear'
  end as state,
  -- How many days of the backlog are already late.
  l.first_due,
  l.last_due
from nl.work_center_capacity c
cross join params p
left join lateral (
  select
    count(distinct o.order_no)::int as orders,
    count(distinct o.order_no) filter (where o.due_date < p.today)::int as overdue_orders,
    sum((r.setup_minutes + r.run_minutes_per_piece * o.quantity) / 60 / r.efficiency) as hours_required,
    sum((r.setup_minutes + r.run_minutes_per_piece * o.quantity) / 60 / r.efficiency)
      filter (where o.due_date < p.today) as hours_overdue,
    min(o.due_date) as first_due,
    max(o.due_date) as last_due
  from nl.open_production_orders o
  join nl.routing_operations_effective r on r.item_no = o.item_no
  where r.work_center = c.code and not r.is_outside
    and o.due_date <= p.today + 28
) l on true
where c.active;

-- ---------------------------------------------------------------------------
-- Why is it short?
-- ---------------------------------------------------------------------------

/*
 * Explode a quantity of a part into everything it needs, and say for each
 * one whether it is there. One row per part in the tree, at any depth:
 *
 *   required        how many the quantity asked for needs, scrap included
 *   on_hand         what the item master says
 *   allocated       what open orders have already claimed (0010)
 *   free            on hand less allocated
 *   short           what is missing
 *   covering        the purchase or production order that would clear it,
 *                   and the date it lands
 *
 * The first row with short > 0 at the greatest depth is the answer to "why
 * can we not build this": everything above it is short because that one is.
 */
create function nl.item_shortage_explosion(p_item_no text, p_quantity numeric default 1)
returns table (
  depth            int,
  item_no          text,
  description      text,
  kind             text,
  shape            text,
  quantity_per     numeric,
  required         numeric,
  on_hand          int,
  allocated        int,
  free             numeric,
  short            numeric,
  covering_source  text,
  covering_document text,
  covering_quantity int,
  covering_date    date,
  lead_days        int,
  path             text[]
)
language sql stable rows 30
set search_path = ''
as $$
  with recursive tree (item_no, depth, mult, path) as (
    select p_item_no, 0, greatest(coalesce(p_quantity, 1), 1)::numeric, array[p_item_no]
    union all
    select b.child_item, t.depth + 1,
           t.mult * b.quantity_per * (1 + b.scrap_pct),
           t.path || b.child_item
    from tree t
    join nl.bom_lines b on b.parent_item = t.item_no
    where not b.is_substitute
      and (b.effective_from is null or b.effective_from <= (select nl.today()))
      and (b.effective_to is null or b.effective_to >= (select nl.today()))
      and t.depth < 32
      and not b.child_item = any (t.path)
  ),
  -- The same part can appear down two branches; its needs add, the depth
  -- shown is the shortest, and the path shown is the shortest path to it.
  -- Window functions rather than a group by, because array_agg of an array
  -- column in Postgres builds one flat array of both, and the path is wanted
  -- whole.
  needed as (
    select x.item_no, x.depth, x.required, x.path
    from (
      select
        t.item_no,
        min(t.depth) over (partition by t.item_no)::int as depth,
        sum(t.mult) over (partition by t.item_no)       as required,
        t.path,
        row_number() over (partition by t.item_no order by t.depth, t.path) as pick
      from tree t
    ) x
    where x.pick = 1
  )
  select
    n.depth,
    n.item_no,
    i.description,
    i.kind,
    s.shape,
    case when n.depth = 0 then 1
         else round(n.required / greatest(coalesce(p_quantity, 1), 1), 5) end,
    round(n.required, 4),
    coalesce(sp.on_hand, 0)::int,
    coalesce(sp.allocated, 0)::int,
    (coalesce(sp.on_hand, 0) - coalesce(sp.allocated, 0))::numeric,
    greatest(n.required - (coalesce(sp.on_hand, 0) - coalesce(sp.allocated, 0)), 0)::numeric,
    cover.source,
    cover.document_no,
    cover.quantity::int,
    cover.lands_on,
    coalesce(lr.lead_days, 0),
    n.path
  from needed n
  join nl.items i on i.item_no = n.item_no
  left join nl.item_supply_shape s on s.item_no = n.item_no
  left join nl.stock_position sp on sp.item_no = n.item_no
  left join nl.item_lead_rolled lr on lr.item_no = n.item_no
  -- The first supply order that lands, whichever side it comes from. A part
  -- with nothing on order gets no row here, and the shortage stands.
  left join lateral (
    select source, document_no, quantity, lands_on
    from (
      select 'purchase' as source, pl.document_no, pl.quantity, pl.due_date as lands_on
      from nl.open_purchase_lines pl
      where pl.item_no = n.item_no
      union all
      select 'production', po.order_no, po.quantity, po.due_date
      from nl.open_production_orders po
      where po.item_no = n.item_no
    ) supply
    order by supply.lands_on, supply.document_no
    limit 1
  ) cover on true
$$;

/*
 * The shortage watch: open customer lines the ERP allocation says are short
 * (0010), with the part underneath them that is actually causing it.
 *
 * It is deliberately one query per short line rather than one big join: the
 * explosion is a function call per line and the list is short (the lines
 * that are short, not every open line), so the cost follows the problem
 * rather than the order book.
 */
create view nl.shortage_watch with (security_invoker = true) as
select
  a.document_no,
  a.line_no,
  a.customer_no,
  cu.name as customer_name,
  cu.owner_id,
  a.item_no,
  a.description,
  a.ship_date,
  a.quantity,
  a.short,
  round(a.short * a.unit_price, 2) as value_short,
  s.shape,
  cause.item_no          as blocking_item,
  cause.description      as blocking_description,
  cause.kind             as blocking_kind,
  cause.depth            as blocking_depth,
  cause.short            as blocking_short,
  cause.covering_source  as blocking_covering_source,
  cause.covering_document as blocking_covering_document,
  cause.covering_date    as blocking_covering_date,
  cause.lead_days        as blocking_lead_days
from nl.open_line_allocation a
join nl.customers cu on cu.customer_no = a.customer_no
left join nl.item_supply_shape s on s.item_no = a.item_no
-- The deepest part that is short is the one holding everything up. Ties go
-- to the biggest shortage, then to the part number, so the answer is stable.
left join lateral (
  select x.item_no, x.description, x.kind, x.depth, x.short,
         x.covering_source, x.covering_document, x.covering_date, x.lead_days
  from nl.item_shortage_explosion(a.item_no, a.short) x
  where x.short > 0 and x.depth > 0
  order by x.depth desc, x.short desc, x.item_no
  limit 1
) cause on true
where a.short > 0;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

grant select on nl.work_center_load, nl.work_center_load_now to nl_app, nl_readonly;
grant select on nl.shortage_watch to nl_app;
grant execute on function nl.item_shortage_explosion(text, numeric) to nl_app, nl_readonly;
