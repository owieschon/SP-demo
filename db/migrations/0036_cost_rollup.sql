-- 0036 True cost and true lead time, known at an instant.
--
-- 0035 modelled what a part is made of and what each ingredient of its cost
-- is worth. This file answers the two questions that model exists for:
--
--   what does this part actually cost us, all in, at any depth?
--   how long does it actually take to get one, at any depth?
--
-- and it answers them in microseconds, because the desk agent and the
-- assistant call them in the middle of writing a reply to a customer.
--
-- WHY THE ANSWER IS STORED. A roll-up is a recursive walk down a tree, and a
-- recursive walk is the one shape the planner is worst at estimating (see
-- docs/sql.md: a recursive view over the customer family took 10,963 ms
-- because the planner guessed 1.4 million rows where 6,488 came back). At
-- 11,400 parts, four levels deep, computing a roll-up per request is not a
-- tuning problem, it is the wrong design.
--
-- So the answer is kept current instead:
--
--   nl.item_cost_rolled   one row per part: nine cost elements, the part's
--                         own share and the rolled total, the depth, and the
--                         item card's cost for comparison
--   nl.item_lead_rolled   one row per part: its own days, the critical path
--                         through everything below it, and that path in
--                         words
--
-- Statement-level triggers on the ten things that can change either figure
-- re-measure exactly the parts affected AND every part above them in the
-- tree, in one pass per level, bottom up. nl.rollup_drift() recomputes the
-- whole catalogue from scratch and returns anything that moved; the tests
-- require it to be empty after every kind of change.
--
-- THIS IS THE HOUSE STYLE, NOT A NEW IDEA. nl.commitment_delivery (migration
-- 0008) keeps delivered value current exactly this way, for exactly this
-- reason, and nl.delivery_drift() proves it. nl.warehouse_drift() (0019)
-- proves the same thing for stock. A stored figure is only trustworthy if
-- something independently recomputes it and complains.
--
-- WHERE THIS DIFFERS FROM 0008. Delivered value has a cheap independent
-- formulation (nl.commitment_lines, a plain sum over an index), so its drift
-- check compares two genuinely different code paths. A rolled cost has no
-- cheap independent formulation: bottom-up is the only way to compute it. So
-- nl.rollup_drift() recomputes every part from scratch through the same
-- arithmetic and reports what changed, which catches the real risk (a
-- trigger that did not fire) but not a mistake in the arithmetic itself.
-- That is what the hand-computed tests are for: a three-level tree whose
-- rolled cost and critical path are worked out by hand in the test file.

-- ---------------------------------------------------------------------------
-- Walking the tree
-- ---------------------------------------------------------------------------

/*
 * Every part above this one, at any depth, with the shortest depth at which
 * it appears. This is the mirror of nl.item_where_used() below, and it is
 * what the triggers use: a change to a part changes every part it feeds.
 *
 * "rows 8" and "set search_path" are both deliberate, and both come from the
 * lesson in docs/sql.md. The row estimate tells the planner a part's family
 * is small, and pinning the search path stops Postgres inlining the function,
 * which would throw that estimate away and recompute a bad one. A bill of
 * materials here is three or four levels with a handful of parents at each,
 * so 8 is about right; being wrong by a factor of two costs nothing, being
 * wrong by a factor of a hundred thousand costs ten seconds.
 *
 * The path guard is not decoration. nl.bom_cycle_guard() refuses to create a
 * loop, but a loop that somehow existed would spin here forever, so the walk
 * carries the parts it has already seen and stops at 32 levels whatever
 * happens. Same discipline as nl.customer_family() and the billing loop.
 */
create function nl.item_parents(p_item_no text)
returns table (item_no text, depth int)
language sql stable rows 8
set search_path = ''
as $$
  with recursive up (item_no, depth, path) as (
    select b.parent_item, 1, array[p_item_no, b.parent_item]
    from nl.bom_lines b
    where b.child_item = p_item_no
    union all
    select b.parent_item, u.depth + 1, u.path || b.parent_item
    from up u
    join nl.bom_lines b on b.child_item = u.item_no
    where u.depth < 32 and not b.parent_item = any (u.path)
  )
  select u.item_no, min(u.depth)::int from up u group by u.item_no
$$;

/*
 * Where-used: every parent this part feeds, at any depth, how much of it
 * each one takes, and how much open order value is riding on that parent
 * right now. That last column is the reason anyone opens this screen: a
 * tube gauge going short matters in proportion to the dollars waiting on the
 * parts made from it.
 */
create function nl.item_where_used(p_item_no text)
returns table (
  parent_item      text,
  description      text,
  depth            int,
  quantity_per     numeric,
  shape            text,
  open_lines       int,
  open_qty         int,
  open_order_value numeric
)
language sql stable rows 8
set search_path = ''
as $$
  with recursive up (item_no, depth, qty, path) as (
    select b.parent_item, 1, b.quantity_per * (1 + b.scrap_pct), array[p_item_no, b.parent_item]
    from nl.bom_lines b
    where b.child_item = p_item_no and not b.is_substitute
    union all
    select b.parent_item, u.depth + 1, u.qty * b.quantity_per * (1 + b.scrap_pct), u.path || b.parent_item
    from up u
    join nl.bom_lines b on b.child_item = u.item_no and not b.is_substitute
    where u.depth < 32 and not b.parent_item = any (u.path)
  ),
  rolled as (
    -- A part can feed the same parent down two branches; the quantities add
    -- and the depth shown is the shortest one.
    select u.item_no, min(u.depth)::int as depth, sum(u.qty) as qty
    from up u
    group by u.item_no
  )
  select
    r.item_no,
    i.description,
    r.depth,
    round(r.qty, 5),
    s.shape,
    coalesce(o.lines, 0)::int,
    coalesce(o.qty, 0)::int,
    coalesce(o.value, 0)
  from rolled r
  join nl.items i on i.item_no = r.item_no
  left join nl.item_supply_shape s on s.item_no = r.item_no
  left join lateral (
    select count(*)::int as lines, sum(l.quantity)::int as qty,
           round(sum(l.quantity * l.unit_price), 2) as value
    from nl.open_order_lines l
    where l.item_no = r.item_no
  ) o on true
$$;

-- ---------------------------------------------------------------------------
-- The two stored answers
-- ---------------------------------------------------------------------------

-- Nine cost elements, twice: what this part's own level costs, and what it
-- costs with everything below it. Six decimal places rather than four
-- because the figures are multiplied by quantities on the way up a tree, and
-- rounding at each level would show up in the cents at the top.
create table nl.item_cost_rolled (
  item_no        text primary key references nl.items (item_no) on delete cascade,

  -- This level only: a leaf's purchase cost, or the operations that turn its
  -- children into it.
  own_material   numeric(18, 6) not null default 0,
  own_component  numeric(18, 6) not null default 0,
  own_labor      numeric(18, 6) not null default 0,
  own_machine    numeric(18, 6) not null default 0,
  own_overhead   numeric(18, 6) not null default 0,
  own_outside    numeric(18, 6) not null default 0,
  own_scrap      numeric(18, 6) not null default 0,
  own_packaging  numeric(18, 6) not null default 0,
  own_expedite   numeric(18, 6) not null default 0,

  -- This level plus everything under it.
  material       numeric(18, 6) not null default 0,
  component      numeric(18, 6) not null default 0,
  labor          numeric(18, 6) not null default 0,
  machine        numeric(18, 6) not null default 0,
  overhead       numeric(18, 6) not null default 0,
  outside        numeric(18, 6) not null default 0,
  scrap          numeric(18, 6) not null default 0,
  packaging      numeric(18, 6) not null default 0,
  expedite       numeric(18, 6) not null default 0,

  own_cost       numeric(18, 6) generated always as (
                   own_material + own_component + own_labor + own_machine + own_overhead
                   + own_outside + own_scrap + own_packaging + own_expedite) stored,
  rolled_cost    numeric(18, 6) generated always as (
                   material + component + labor + machine + overhead
                   + outside + scrap + packaging + expedite) stored,

  levels         int not null default 0,     -- how deep the tree is under this part
  child_lines    int not null default 0,     -- costed lines at this level
  -- What the item card said when this was measured. Nothing here overwrites
  -- it: the difference is reported, not applied.
  card_cost      numeric(12, 2),
  measured_at    timestamptz not null default now()
);

comment on table nl.item_cost_rolled is
  'Rolled cost per part, kept current by the triggers in this migration. Nobody writes it directly. Same pattern as nl.commitment_delivery (0008).';

create index item_cost_rolled_levels_idx on nl.item_cost_rolled (levels desc);

-- The critical path: not the sum of every lead time in the tree, but the
-- longest chain through it, because the branches run in parallel.
create table nl.item_lead_rolled (
  item_no        text primary key references nl.items (item_no) on delete cascade,
  -- This level: buying it, or running its own operations.
  own_days       int not null default 0,
  -- This level plus the slowest chain under it.
  lead_days      int not null default 0,
  levels         int not null default 0,
  -- The child that decides the answer. Shorten any other branch and nothing
  -- changes; shorten this one and the promise date moves.
  critical_child text,
  -- The chain in words, one entry per level:
  --   {"K-2003: assemble 1 day", "S6-72SA: make 4 days", "RM-TUBE-600-16-AL: buy 28 days"}
  critical_path  text[] not null default '{}',
  basis          text not null default '',   -- buy, make, assemble, process
  measured_at    timestamptz not null default now()
);

comment on table nl.item_lead_rolled is
  'Lead time per part: the longest chain of purchase and processing times under it, so a promise date is arithmetic rather than a guess.';

create index item_lead_rolled_days_idx on nl.item_lead_rolled (lead_days desc);

alter table nl.item_cost_rolled enable row level security;
alter table nl.item_lead_rolled enable row level security;
create policy item_cost_rolled_read on nl.item_cost_rolled for select to nl_app, nl_readonly using (true);
create policy item_lead_rolled_read on nl.item_lead_rolled for select to nl_app, nl_readonly using (true);
grant select on nl.item_cost_rolled, nl.item_lead_rolled to nl_app, nl_readonly;

-- ---------------------------------------------------------------------------
-- Measuring
-- ---------------------------------------------------------------------------

/*
 * Measure these parts and everything above them, and store the answers.
 *
 * The order is the whole trick. A rolled cost is its own level plus its
 * children's rolled costs, so a part cannot be measured before its children.
 * So the working set (the parts named, plus every part above them) is sorted
 * into passes: pass 0 is the parts with nothing left to wait for, pass 1 the
 * parts whose children are all in pass 0, and so on. Each pass is ONE
 * set-based statement, so measuring the whole catalogue is four or five
 * statements rather than 11,400 function calls.
 *
 * Children outside the working set are not re-measured: their stored figures
 * are still right, because nothing that changed is under them.
 *
 * SECURITY DEFINER for the same reason as nl.measure_commitments() in 0008:
 * a trigger fired by a signed-in user's write has to be able to update these
 * tables, which no user may write directly. Nobody is granted EXECUTE.
 */
create function nl.measure_items(p_items text[]) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pass  int := 0;
  v_max   int;
  v_rows  int;
  v_total int := 0;
  v_today date := nl.today();
begin
  if p_items is null or cardinality(p_items) = 0 then
    return 0;
  end if;

  -- 1. The working set: the parts named, plus every part above them.
  drop table if exists pg_temp.mfg_work;
  create temporary table mfg_work (item_no text primary key, lvl int) on commit drop;

  insert into pg_temp.mfg_work (item_no, lvl)
  select distinct x.item_no, null::int
  from (
    select t.item_no from unnest(p_items) as t(item_no)
    union
    select p.item_no
    from unnest(p_items) as t(item_no)
    cross join lateral nl.item_parents(t.item_no) p
  ) x
  -- A part named by a DELETE trigger may be gone already.
  join nl.items i on i.item_no = x.item_no;

  if not exists (select 1 from pg_temp.mfg_work) then
    return 0;
  end if;

  -- 2. Sort it into passes, children first.
  loop
    update pg_temp.mfg_work w set lvl = v_pass
    where w.lvl is null
      and not exists (
        select 1
        from nl.bom_lines b
        join pg_temp.mfg_work w2 on w2.item_no = b.child_item and w2.lvl is null
        where b.parent_item = w.item_no and not b.is_substitute);
    exit when not found;
    v_pass := v_pass + 1;
    exit when v_pass > 40;
  end loop;
  -- Anything still unsorted is in a loop, which nl.bom_cycle_guard() refuses
  -- to create but old data could hold. Measure it last, with whatever its
  -- children currently say, so a loop costs one wrong number instead of a
  -- hung transaction.
  update pg_temp.mfg_work set lvl = v_pass where lvl is null;

  -- 3. This level's own cost lines, once, for the whole working set. Reading
  -- the view per part would turn one scan into thousands of little ones.
  drop table if exists pg_temp.mfg_own;
  create temporary table mfg_own on commit drop as
  select l.item_no, l.element, l.seq, l.amount
  from nl.item_own_cost_lines l
  where l.item_no in (select w.item_no from pg_temp.mfg_work w);
  create index mfg_own_item_idx on pg_temp.mfg_own (item_no);
  analyze pg_temp.mfg_own;

  select max(lvl) into v_max from pg_temp.mfg_work;

  -- 4. One statement per pass.
  for v_pass in 0 .. v_max loop
    insert into nl.item_cost_rolled (
      item_no,
      own_material, own_component, own_labor, own_machine, own_overhead,
      own_outside, own_scrap, own_packaging, own_expedite,
      material, component, labor, machine, overhead,
      outside, scrap, packaging, expedite,
      levels, child_lines, card_cost, measured_at)
    select
      w.item_no,
      own.material, own.component, own.labor, own.machine, own.overhead,
      own.outside, sc.scrap, own.packaging, own.expedite,
      own.material + kids.material,
      own.component + kids.component,
      own.labor + kids.labor,
      own.machine + kids.machine,
      own.overhead + kids.overhead,
      own.outside + kids.outside,
      sc.scrap + kids.scrap,
      own.packaging + kids.packaging,
      own.expedite + kids.expedite,
      case when kids.lines = 0 then 0 else kids.levels + 1 end,
      kids.lines,
      i.unit_cost,
      now()
    from pg_temp.mfg_work w
    join nl.items i on i.item_no = w.item_no
    -- This level's own cost, by element.
    cross join lateral (
      select
        coalesce(sum(o.amount) filter (where o.element = 'material'), 0)  as material,
        coalesce(sum(o.amount) filter (where o.element = 'component'), 0) as component,
        coalesce(sum(o.amount) filter (where o.element = 'labor'), 0)     as labor,
        coalesce(sum(o.amount) filter (where o.element = 'machine'), 0)   as machine,
        coalesce(sum(o.amount) filter (where o.element = 'overhead'), 0)  as overhead,
        coalesce(sum(o.amount) filter (where o.element = 'outside'), 0)   as outside,
        coalesce(sum(o.amount) filter (where o.element = 'packaging'), 0) as packaging,
        coalesce(sum(o.amount) filter (where o.element = 'expedite'), 0)  as expedite
      from pg_temp.mfg_own o
      where o.item_no = w.item_no
    ) own
    -- What the children bring, at their own rolled cost, times how many of
    -- them one of these takes (including the bill of materials' own scrap
    -- allowance on the material itself).
    --
    -- A substitute line is skipped: it is an alternate for a line that is
    -- already counted, and counting both would buy the part twice.
    --
    -- A phantom child needs no special case here. Its rolled cost already
    -- contains its own children, so passing it through the same arithmetic
    -- gives the parent exactly what exploding the phantom would have given.
    cross join lateral (
      select
        coalesce(sum(r.material  * q.qty), 0) as material,
        coalesce(sum(r.component * q.qty), 0) as component,
        coalesce(sum(r.labor     * q.qty), 0) as labor,
        coalesce(sum(r.machine   * q.qty), 0) as machine,
        coalesce(sum(r.overhead  * q.qty), 0) as overhead,
        coalesce(sum(r.outside   * q.qty), 0) as outside,
        coalesce(sum(r.scrap     * q.qty), 0) as scrap,
        coalesce(sum(r.packaging * q.qty), 0) as packaging,
        coalesce(sum(r.expedite  * q.qty), 0) as expedite,
        coalesce(sum(r.rolled_cost * q.qty), 0) as total,
        coalesce(max(r.levels), 0)            as levels,
        count(*)::int                         as lines
      from nl.bom_lines b
      join nl.item_cost_rolled r on r.item_no = b.child_item
      cross join lateral (select b.quantity_per * (1 + b.scrap_pct) as qty) q
      where b.parent_item = w.item_no
        and not b.is_substitute
        and (b.effective_from is null or b.effective_from <= v_today)
        and (b.effective_to is null or b.effective_to >= v_today)
    ) kids
    -- The scrap allowance, and why it is computed here rather than in
    -- nl.item_own_cost_lines: a piece lost at an operation carries away
    -- everything spent on it up to that point, which includes the children's
    -- rolled cost. So it can only be worked out once the children are known.
    --
    -- Walking the operations in sequence, the value in the piece at
    -- operation k is what came in plus the conversion cost through k. To get
    -- one good piece out of an operation that yields y, you have to start
    -- (1/y) pieces, so (1 - y) / y pieces are lost, each worth that much.
    -- Which is why a scrap at the polish cell costs so much more than the
    -- same scrap at the saw.
    cross join lateral (
      select coalesce(sum(round((own.material + own.component + own.packaging + kids.total
                                 + t.conv_through) * (1 - t.yield_pct) / t.yield_pct, 6)), 0) as scrap
      from (
        select
          ro.seq,
          ro.yield_pct,
          sum(coalesce(c.conv, 0)) over (order by ro.seq rows unbounded preceding) as conv_through
        from nl.routing_operations_effective ro
        left join (
          select o2.seq, sum(o2.amount) as conv
          from pg_temp.mfg_own o2
          where o2.item_no = w.item_no
            and o2.element in ('labor', 'machine', 'overhead', 'outside', 'expedite')
          group by o2.seq
        ) c on c.seq = ro.seq
        where ro.item_no = w.item_no
      ) t
      where t.yield_pct < 1
    ) sc
    where w.lvl = v_pass
    on conflict (item_no) do update set
      own_material  = excluded.own_material,
      own_component = excluded.own_component,
      own_labor     = excluded.own_labor,
      own_machine   = excluded.own_machine,
      own_overhead  = excluded.own_overhead,
      own_outside   = excluded.own_outside,
      own_scrap     = excluded.own_scrap,
      own_packaging = excluded.own_packaging,
      own_expedite  = excluded.own_expedite,
      material      = excluded.material,
      component     = excluded.component,
      labor         = excluded.labor,
      machine       = excluded.machine,
      overhead      = excluded.overhead,
      outside       = excluded.outside,
      scrap         = excluded.scrap,
      packaging     = excluded.packaging,
      expedite      = excluded.expedite,
      levels        = excluded.levels,
      child_lines   = excluded.child_lines,
      card_cost     = excluded.card_cost,
      measured_at   = excluded.measured_at;

    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;

    -- Lead time, the same pass, the same order. The critical path is this
    -- level's own days plus the slowest chain under it, and the chain in
    -- words is this level's line in front of that child's chain, so it
    -- composes in one step instead of being walked again.
    insert into nl.item_lead_rolled (
      item_no, own_days, lead_days, levels, critical_child, critical_path, basis, measured_at)
    select
      w.item_no,
      own.days,
      own.days + coalesce(kid.lead_days, 0),
      case when kid.item_no is null then 0 else kid.levels + 1 end,
      kid.item_no,
      array[w.item_no || ': ' || own.basis || ' ' || own.days
            || case when own.days = 1 then ' day' else ' days' end]
        || coalesce(kid.critical_path, '{}'::text[]),
      own.basis,
      now()
    from pg_temp.mfg_work w
    join nl.items i on i.item_no = w.item_no
    left join nl.vendors v on v.vendor_no = i.vendor_no
    -- Does this part have a parts list, does it have steps of its own, and
    -- do any of those steps change the metal? The last one is the same test
    -- nl.item_supply_shape uses, so the basis here and the shape there
    -- always say the same thing about the same part.
    cross join lateral (
      select
        exists (select 1 from nl.bom_lines b
                 where b.parent_item = w.item_no and not b.is_substitute
                   and (b.effective_from is null or b.effective_from <= v_today)
                   and (b.effective_to is null or b.effective_to >= v_today)) as has_bom,
        (select count(*)::int from nl.routing_operations_effective r where r.item_no = w.item_no) as ops,
        (select count(*)::int from nl.routing_operations_effective r
          where r.item_no = w.item_no
            and (r.is_outside or coalesce(r.work_center, '') not in ('ASSEMBLY', 'PACK'))) as fab_ops
    ) has
    cross join lateral (
      select
        -- A part with no parts list has to be bought before anything can be
        -- done to it, so its purchase lead time is part of its own days
        -- whether or not it also has a routing. That is what makes a plated
        -- bought part take the plater's time on top of the vendor's.
        (case when has.has_bom then 0
              else coalesce(nl.lead_time_days(i.lead_time),
                            nl.lead_time_days(v.lead_time),
                            nl.default_lead_days(i.replenishment)) end
         + coalesce((
             select sum(
               case
                 when r.is_outside then coalesce(nl.lead_time_days(r.outside_lead_time), 5)
                 else greatest(1, ceil((r.setup_minutes + r.run_minutes_per_piece * r.standard_lot_size
                                        + r.queue_minutes + r.move_minutes)
                                       / (60 * r.hours_per_day * r.shifts * r.efficiency)))
               end)::int
             from nl.routing_operations_effective r
             where r.item_no = w.item_no), 0)
         -- A parts list and no steps at all is still a day on the bench.
         + case when has.has_bom and has.ops = 0 then 1 else 0 end)::int as days,
        case
          when has.has_bom and has.fab_ops > 0 then 'make'
          when has.has_bom then 'assemble'
          when has.fab_ops > 0 then 'process'
          else 'buy'
        end as basis
    ) own
    -- The slowest child decides the answer.
    left join lateral (
      select l.item_no, l.lead_days, l.levels, l.critical_path
      from nl.bom_lines b
      join nl.item_lead_rolled l on l.item_no = b.child_item
      where b.parent_item = w.item_no
        and not b.is_substitute
        and (b.effective_from is null or b.effective_from <= v_today)
        and (b.effective_to is null or b.effective_to >= v_today)
      order by l.lead_days desc, l.item_no
      limit 1
    ) kid on true
    where w.lvl = v_pass
    on conflict (item_no) do update set
      own_days       = excluded.own_days,
      lead_days      = excluded.lead_days,
      levels         = excluded.levels,
      critical_child = excluded.critical_child,
      critical_path  = excluded.critical_path,
      basis          = excluded.basis,
      measured_at    = excluded.measured_at;
  end loop;

  drop table if exists pg_temp.mfg_own;
  drop table if exists pg_temp.mfg_work;
  return v_total;
end $$;

-- Measure the whole catalogue. The seed calls this once at the end of the
-- build, and nl.rollup_drift() calls it to recompute from scratch.
create function nl.measure_all_items() returns int
language sql
security definer
set search_path = ''
as $$
  select nl.measure_items(array(select i.item_no from nl.items i order by i.item_no))
$$;

/*
 * What the triggers call. It returns early while nothing has been measured
 * yet, which is how the build stays fast: inserting 11,400 parts, then
 * 40,000 bill-of-materials lines, then 30,000 operations would otherwise
 * re-measure the catalogue on every statement. nl.measure_all_items() at the
 * end of db/seed.d/95_manufacturing.sql does it once instead.
 *
 * This is the same guard as nl.remeasure_after_ledger_change() in 0008,
 * which returns early while there are no commitments.
 */
create function nl.remeasure(p_items text[]) returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from nl.item_cost_rolled) then
    return 0;
  end if;
  return nl.measure_items(p_items);
end $$;

-- ---------------------------------------------------------------------------
-- The triggers: the ten things that can change a rolled cost or a lead time
-- ---------------------------------------------------------------------------

-- 1. A bill-of-materials line. The parent changes, and so does everything
-- above the parent, which nl.remeasure works out.
create function nl.remeasure_after_bom_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct parent_item) into v_items from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct parent_item) into v_items from old_rows;
  else
    select array_agg(distinct parent_item) into v_items
    from (select parent_item from new_rows union select parent_item from old_rows) s;
  end if;
  perform nl.remeasure(v_items);
  return null;
end $$;

create trigger bom_lines_remeasure_insert after insert on nl.bom_lines
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_bom_change();
create trigger bom_lines_remeasure_update after update on nl.bom_lines
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_bom_change();
create trigger bom_lines_remeasure_delete after delete on nl.bom_lines
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_bom_change();

-- 2. A routing operation. Same idea, keyed on the part it belongs to.
create function nl.remeasure_after_routing_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct item_no) into v_items from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct item_no) into v_items from old_rows;
  else
    select array_agg(distinct item_no) into v_items
    from (select item_no from new_rows union select item_no from old_rows) s;
  end if;
  perform nl.remeasure(v_items);
  return null;
end $$;

create trigger routing_remeasure_insert after insert on nl.routing_operations
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_routing_change();
create trigger routing_remeasure_update after update on nl.routing_operations
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_routing_change();
create trigger routing_remeasure_delete after delete on nl.routing_operations
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_routing_change();

-- 3. The item card itself: its cost, its lead time, its vendor, its kind or
-- the ERP's replenishment word. A new part is measured so that every part
-- has a row from the moment it exists.
create function nl.remeasure_after_item_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(item_no) into v_items from new_rows;
  else
    select array_agg(n.item_no) into v_items
    from new_rows n
    join old_rows o on o.item_no = n.item_no
    where (n.unit_cost, n.lead_time, n.vendor_no, n.kind, n.replenishment)
      is distinct from (o.unit_cost, o.lead_time, o.vendor_no, o.kind, o.replenishment);
  end if;
  perform nl.remeasure(v_items);
  return null;
end $$;

create trigger items_remeasure_insert after insert on nl.items
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_item_change();
create trigger items_remeasure_update after update on nl.items
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_item_change();

-- 4. A cost revision (0018). Only the ones that could change what a piece
-- costs today matter: a revision dated next month changes nothing yet.
create function nl.remeasure_after_item_cost_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items text[];
  v_today date := nl.today();
begin
  if tg_op = 'DELETE' then
    select array_agg(distinct item_no) into v_items from old_rows where effective_from <= v_today;
  elsif tg_op = 'INSERT' then
    select array_agg(distinct item_no) into v_items from new_rows where effective_from <= v_today;
  else
    select array_agg(distinct item_no) into v_items
    from (select item_no, effective_from from new_rows
          union select item_no, effective_from from old_rows) s
    where s.effective_from <= v_today;
  end if;
  perform nl.remeasure(v_items);
  return null;
end $$;

create trigger item_costs_remeasure_insert after insert on nl.item_costs
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_item_cost_change();
create trigger item_costs_remeasure_update after update on nl.item_costs
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_item_cost_change();
create trigger item_costs_remeasure_delete after delete on nl.item_costs
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_item_cost_change();

/*
 * 5 to 10. A rate changed somewhere: a cell's hours or efficiency, a labour
 * rate, a machine, the capital behind a machine, an overhead pool, or a
 * vendor's lead time. None of those name a part, so each one has to find the
 * parts it reaches.
 *
 * One function for all six, told which kind of change it is answering, so
 * the six triggers do not repeat the same twenty lines. The lookups all go
 * through the indexes 0035 put on nl.routing_operations for exactly this.
 */
create function nl.items_touched_by_rate(p_kind text, p_keys text[])
returns text[]
language sql stable
set search_path = ''
as $$
  select array_agg(distinct x.item_no)
  from (
    -- A cell: every part with an operation at it.
    select r.item_no from nl.routing_operations r
    where p_kind = 'work_center' and r.work_center = any (p_keys)
    union
    -- A labour class: named on the operation, or inherited from its cell.
    select r.item_no from nl.routing_operations r
    where p_kind = 'labor_class' and r.labor_class = any (p_keys)
    union
    select r.item_no
    from nl.routing_operations r
    join nl.work_centers w on w.code = r.work_center
    where p_kind = 'labor_class' and r.labor_class is null and w.labor_class = any (p_keys)
    union
    -- A machine.
    select r.item_no from nl.routing_operations r
    where p_kind = 'machine' and r.machine = any (p_keys)
    union
    -- The capital behind a machine.
    select r.item_no
    from nl.routing_operations r
    join nl.machines m on m.code = r.machine
    where p_kind = 'asset' and m.asset_no = any (p_keys)
    union
    -- An overhead pool: every part with an operation in a department the
    -- pool reaches. An empty department reaches the whole plant.
    select r.item_no
    from nl.routing_operations r
    left join nl.work_centers w on w.code = r.work_center
    where p_kind = 'overhead'
      and exists (
        select 1 from nl.overhead_pools p
        where p.code = any (p_keys)
          and (p.department = '' or p.department = coalesce(w.department, '')))
    union
    -- A vendor: the parts it supplies, and the parts it processes for us.
    select i.item_no from nl.items i
    where p_kind = 'vendor' and i.vendor_no = any (p_keys)
    union
    select r.item_no from nl.routing_operations r
    where p_kind = 'vendor' and r.vendor_no = any (p_keys)
  ) x
$$;

create function nl.remeasure_after_rate_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys  text[];
  v_kind  text := tg_argv[0];
  v_col   text := tg_argv[1];
begin
  -- The key column differs per table, so it is read out of the transition
  -- table by name.
  if tg_op = 'DELETE' then
    execute format('select array_agg(distinct %I::text) from old_rows', v_col) into v_keys;
  elsif tg_op = 'INSERT' then
    execute format('select array_agg(distinct %I::text) from new_rows', v_col) into v_keys;
  else
    execute format(
      'select array_agg(distinct k) from (select %I::text as k from new_rows union select %I::text from old_rows) s',
      v_col, v_col) into v_keys;
  end if;
  perform nl.remeasure(nl.items_touched_by_rate(v_kind, v_keys));
  return null;
end $$;

create trigger work_centers_remeasure after update on nl.work_centers
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('work_center', 'code');
create trigger labor_rates_remeasure_insert after insert on nl.labor_rates
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('labor_class', 'labor_class');
create trigger labor_rates_remeasure_update after update on nl.labor_rates
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('labor_class', 'labor_class');
create trigger labor_rates_remeasure_delete after delete on nl.labor_rates
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_rate_change('labor_class', 'labor_class');
create trigger machines_remeasure after update on nl.machines
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('machine', 'code');
create trigger capital_assets_remeasure after update on nl.capital_assets
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('asset', 'asset_no');
create trigger overhead_periods_remeasure_insert after insert on nl.overhead_pool_periods
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('overhead', 'pool_code');
create trigger overhead_periods_remeasure_update after update on nl.overhead_pool_periods
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_rate_change('overhead', 'pool_code');
create trigger overhead_periods_remeasure_delete after delete on nl.overhead_pool_periods
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_rate_change('overhead', 'pool_code');
-- A vendor's lead time, and only that: a vendor row is touched whenever
-- somebody adds a contact to it (0015), and re-measuring every part a vendor
-- supplies because a phone number changed would be silly. Postgres will not
-- take a column list and transition tables on the same trigger, so the
-- filter is here rather than in the trigger's definition.
create function nl.remeasure_after_vendor_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys text[];
begin
  select array_agg(distinct n.vendor_no) into v_keys
  from new_rows n
  join old_rows o on o.vendor_no = n.vendor_no
  where n.lead_time is distinct from o.lead_time;
  perform nl.remeasure(nl.items_touched_by_rate('vendor', v_keys));
  return null;
end $$;

create trigger vendors_remeasure_lead after update on nl.vendors
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_vendor_change();

-- ---------------------------------------------------------------------------
-- Checking and repairing
-- ---------------------------------------------------------------------------

/*
 * Recompute every part from scratch and return the ones whose figures moved.
 * Always empty; the tests require it after every kind of change, and the
 * nightly job can report it.
 *
 * Read the note at the top of this file about how this differs from
 * nl.delivery_drift(): a rolled cost has no cheap second formulation, so
 * this recomputes through the same arithmetic and leaves the recomputed
 * figures in place. It catches a trigger that did not fire, which is the
 * real risk. It does not catch a mistake in the arithmetic, which is what
 * the hand-computed tests are for.
 */
create function nl.rollup_drift()
returns table (
  item_no       text,
  stored_cost   numeric,
  measured_cost numeric,
  stored_days   int,
  measured_days int
)
language plpgsql
set search_path = ''
as $$
begin
  drop table if exists pg_temp.mfg_before;
  create temporary table mfg_before on commit drop as
  select c.item_no, c.rolled_cost, l.lead_days
  from nl.item_cost_rolled c
  left join nl.item_lead_rolled l on l.item_no = c.item_no;

  perform nl.measure_all_items();

  return query
  select b.item_no, b.rolled_cost, c.rolled_cost, b.lead_days, l.lead_days
  from pg_temp.mfg_before b
  join nl.item_cost_rolled c on c.item_no = b.item_no
  left join nl.item_lead_rolled l on l.item_no = b.item_no
  where b.rolled_cost is distinct from c.rolled_cost
     or b.lead_days is distinct from l.lead_days
  order by b.item_no;
end $$;

-- Parts that have no rolled figure at all, which would mean the build or a
-- trigger missed them. Cheap, and read-only, so the nightly job can run it
-- without recomputing anything.
create function nl.rollup_gaps()
returns table (item_no text, missing text)
language sql stable
set search_path = ''
as $$
  select i.item_no,
         case when c.item_no is null and l.item_no is null then 'cost and lead time'
              when c.item_no is null then 'cost'
              else 'lead time' end
  from nl.items i
  left join nl.item_cost_rolled c on c.item_no = i.item_no
  left join nl.item_lead_rolled l on l.item_no = i.item_no
  where c.item_no is null or l.item_no is null
$$;

-- For the nightly job, next to nl.repair_delivery().
create function nl.repair_rollups() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_drifted text[];
  v_gaps    int;
begin
  select count(*)::int into v_gaps from nl.rollup_gaps();
  select array_agg(item_no order by item_no) into v_drifted from nl.rollup_drift();
  return jsonb_build_object(
    'gaps_before', v_gaps,
    'repaired', coalesce(to_jsonb(v_drifted), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Reading the answers
-- ---------------------------------------------------------------------------

/*
 * The breakdown: every line of cost in the whole tree under a part, with the
 * level it came from and the multiplier that got it there.
 *
 * The explosion is small (a few dozen rows for the deepest part in the
 * catalogue), and each node's own cost lines come straight from
 * nl.item_own_cost_lines, so the page gets the detail (which pool, which
 * cell, which vendor, what the loaded rate was) that the stored totals
 * cannot carry. The scrap allowance is the one line that comes from the
 * stored row, because it depends on everything below it.
 *
 * The sum of the amount column is the stored rolled cost, to the cent. A
 * test holds them to that.
 */
create function nl.item_cost_rollup(p_item_no text)
returns table (
  level        int,
  item_no      text,
  parent_item  text,
  description  text,
  element      text,
  source       text,
  detail       text,
  quantity_per numeric,
  unit_amount  numeric,
  amount       numeric
)
language sql stable rows 40
set search_path = ''
as $$
  with recursive tree (item_no, parent_item, level, mult, path) as (
    select p_item_no, null::text, 0, 1::numeric, array[p_item_no]
    union all
    select b.child_item, t.item_no, t.level + 1,
           t.mult * b.quantity_per * (1 + b.scrap_pct),
           t.path || b.child_item
    from tree t
    join nl.bom_lines b on b.parent_item = t.item_no
    where not b.is_substitute
      and (b.effective_from is null or b.effective_from <= (select nl.today()))
      and (b.effective_to is null or b.effective_to >= (select nl.today()))
      and t.level < 32
      and not b.child_item = any (t.path)
  ),
  -- The same part can appear twice in one tree; its quantities add.
  nodes as (
    select t.item_no, min(t.level)::int as level,
           (array_agg(t.parent_item order by t.level))[1] as parent_item,
           sum(t.mult) as mult
    from tree t
    group by t.item_no
  )
  select
    n.level,
    n.item_no,
    n.parent_item,
    i.description,
    l.element,
    l.source,
    l.detail,
    round(n.mult, 5),
    round(l.amount, 6),
    round(l.amount * n.mult, 6)
  from nodes n
  join nl.items i on i.item_no = n.item_no
  cross join lateral (
    select o.element, o.source, o.detail, o.amount
    from nl.item_own_cost_lines o
    where o.item_no = n.item_no
    union all
    select 'scrap', '', 'Pieces lost at this part''s own operations, valued where they are lost',
           r.own_scrap
    from nl.item_cost_rolled r
    where r.item_no = n.item_no and r.own_scrap <> 0
  ) l
$$;

/*
 * The lead-time tree: every part under this one with its own days, its
 * rolled days and whether it sits on the critical path. The critical path is
 * the chain nl.item_lead_rolled already stores, so marking it costs a lookup
 * rather than a second walk.
 */
create function nl.item_lead_time_rollup(p_item_no text)
returns table (
  level          int,
  item_no        text,
  parent_item    text,
  description    text,
  basis          text,
  own_days       int,
  lead_days      int,
  is_critical    boolean,
  critical_child text
)
language sql stable rows 40
set search_path = ''
as $$
  with recursive tree (item_no, parent_item, level, path) as (
    select p_item_no, null::text, 0, array[p_item_no]
    union all
    select b.child_item, t.item_no, t.level + 1, t.path || b.child_item
    from tree t
    join nl.bom_lines b on b.parent_item = t.item_no
    where not b.is_substitute
      and (b.effective_from is null or b.effective_from <= (select nl.today()))
      and (b.effective_to is null or b.effective_to >= (select nl.today()))
      and t.level < 32
      and not b.child_item = any (t.path)
  ),
  -- The critical chain, as the stored row names it, walked down.
  critical as (
    select unnest(l.critical_path) as line
    from nl.item_lead_rolled l
    where l.item_no = p_item_no
  ),
  critical_items as (
    select split_part(c.line, ':', 1) as item_no from critical c
  )
  select
    min(t.level)::int,
    t.item_no,
    (array_agg(t.parent_item order by t.level))[1],
    i.description,
    coalesce(l.basis, ''),
    coalesce(l.own_days, 0),
    coalesce(l.lead_days, 0),
    exists (select 1 from critical_items ci where ci.item_no = t.item_no),
    l.critical_child
  from tree t
  join nl.items i on i.item_no = t.item_no
  left join nl.item_lead_rolled l on l.item_no = t.item_no
  group by t.item_no, i.description, l.basis, l.own_days, l.lead_days, l.critical_child
$$;

-- Rolled cost against the item card's cost, for the parts where the two
-- disagree most. Nothing here changes the card: this is the report an
-- accountant reads before deciding to roll standard cost.
create view nl.item_cost_variance with (security_invoker = true) as
select
  c.item_no,
  i.description,
  i.family,
  i.product_group,
  s.shape,
  c.card_cost,
  round(c.rolled_cost, 2) as rolled_cost,
  round(c.rolled_cost - c.card_cost, 2) as difference,
  case when c.card_cost > 0 then round((c.rolled_cost - c.card_cost) / c.card_cost, 4) end as difference_pct,
  c.levels,
  round(c.material, 2)  as material,
  round(c.component, 2) as component,
  round(c.labor, 2)     as labor,
  round(c.machine, 2)   as machine,
  round(c.overhead, 2)  as overhead,
  round(c.outside, 2)   as outside,
  round(c.scrap, 2)     as scrap,
  round(c.packaging, 2) as packaging,
  round(c.expedite, 2)  as expedite,
  i.list_price,
  case when i.list_price > 0 then round((i.list_price - c.rolled_cost) / i.list_price, 4) end as rolled_margin
from nl.item_cost_rolled c
join nl.items i on i.item_no = c.item_no
left join nl.item_supply_shape s on s.item_no = c.item_no;

/*
 * One part, one answer, everything an agent needs to reply to a customer
 * without asking a second question:
 *
 *   what it is and how it is made (the derived shape, in a sentence)
 *   what it truly costs, with the breakdown and the three biggest pieces
 *   how long it truly takes, with the critical path
 *   what is on hand and where
 *   what is on order and when it lands
 *   the earliest date a quantity could ship if it were ordered today
 *
 * Every figure here is either a single-row lookup on a primary key or a
 * short index range, which is why it answers in single-digit milliseconds on
 * the full world. The roll-ups are the reason: computing them here would
 * take hundreds of times longer than everything else in the function put
 * together.
 */
create function nl.item_truth(p_item_no text, p_quantity int default 1)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'item_no', i.item_no,
    'description', i.description,
    'family', i.family,
    'category', i.category,
    'product_group', i.product_group,
    'kind', i.kind,
    'blocked', i.blocked,
    'made_to_order', i.made_to_order,
    'today', (select nl.today()),

    'shape', jsonb_build_object(
      'shape', s.shape,
      'sentence', s.sentence,
      'bom_lines', s.bom_lines,
      'operations', s.operations,
      'outside_steps', s.outside_steps,
      'cells', s.cells,
      'erp_replenishment', i.replenishment,
      'erp_agrees', s.agrees_with_erp),

    'cost', jsonb_build_object(
      'rolled', round(c.rolled_cost, 4),
      'card', c.card_cost,
      'difference', round(c.rolled_cost - c.card_cost, 4),
      'levels', c.levels,
      'measured_at', c.measured_at,
      'elements', jsonb_build_object(
        'material', round(c.material, 4),
        'component', round(c.component, 4),
        'labor', round(c.labor, 4),
        'machine', round(c.machine, 4),
        'overhead', round(c.overhead, 4),
        'outside', round(c.outside, 4),
        'scrap', round(c.scrap, 4),
        'packaging', round(c.packaging, 4),
        'expedite', round(c.expedite, 4)),
      -- The three biggest pieces, which is what an agent quotes.
      'top', (select jsonb_agg(jsonb_build_object('element', e.element, 'amount', round(e.amount, 4),
                                                  'share', case when c.rolled_cost > 0
                                                                then round(e.amount / c.rolled_cost, 4) end)
                               order by e.amount desc)
              from (select * from (values
                      ('material', c.material), ('component', c.component), ('labor', c.labor),
                      ('machine', c.machine), ('overhead', c.overhead), ('outside', c.outside),
                      ('scrap', c.scrap), ('packaging', c.packaging), ('expedite', c.expedite)
                    ) as v(element, amount)
                    where v.amount > 0
                    order by v.amount desc
                    limit 3) e),
      'list_price', i.list_price,
      'rolled_margin', case when i.list_price > 0
                            then round((i.list_price - c.rolled_cost) / i.list_price, 4) end),

    'lead_time', jsonb_build_object(
      'days', l.lead_days,
      'own_days', l.own_days,
      'basis', l.basis,
      'levels', l.levels,
      'critical_child', l.critical_child,
      'critical_path', to_jsonb(l.critical_path),
      'ready_on', ((select nl.today()) + l.lead_days)),

    'on_hand', jsonb_build_object(
      'quantity', coalesce(sp.on_hand, 0),
      'allocated', coalesce(sp.allocated, 0),
      'available', coalesce(sp.available, 0),
      'by_location', coalesce(sp.by_location, '{}'::jsonb),
      'bins', coalesce((select jsonb_agg(jsonb_build_object(
                                 'location', b.location_code, 'zone', b.zone, 'bin', b.bin,
                                 'quantity', b.quantity, 'counted_on', b.counted_on)
                               order by b.location_code, b.bin)
                        from nl.stock_bins b where b.item_no = i.item_no), '[]'::jsonb)),

    'on_order', jsonb_build_object(
      'purchase', coalesce((select jsonb_agg(jsonb_build_object(
                                     'document_no', p.document_no, 'vendor_no', p.vendor_no,
                                     'quantity', p.quantity, 'due_date', p.due_date,
                                     'overdue', p.due_date < (select nl.today()))
                                   order by p.due_date, p.document_no)
                            from nl.open_purchase_lines p where p.item_no = i.item_no), '[]'::jsonb),
      'production', coalesce((select jsonb_agg(jsonb_build_object(
                                       'order_no', o.order_no, 'work_center', o.work_center,
                                       'quantity', o.quantity, 'due_date', o.due_date,
                                       'status', o.status,
                                       'overdue', o.due_date < (select nl.today()))
                                     order by o.due_date, o.order_no)
                              from nl.open_production_orders o where o.item_no = i.item_no), '[]'::jsonb)),

    -- The one question a customer actually asks.
    'promise', nl.available_to_promise(i.item_no, greatest(coalesce(p_quantity, 1), 1), (select nl.today())),

    'sources', coalesce((select jsonb_agg(jsonb_build_object(
                                  'source_kind', so.source_kind, 'priority', so.priority,
                                  'vendor_no', so.vendor_no, 'work_center', so.work_center,
                                  'from_location', so.from_location,
                                  'min_qty', so.min_qty, 'max_qty', so.max_qty,
                                  'unit_price', so.unit_price, 'lead_time', so.lead_time)
                                order by so.priority, so.id)
                         from nl.item_sources so
                         where so.item_no = i.item_no
                           and (so.effective_from is null or so.effective_from <= (select nl.today()))
                           and (so.effective_to is null or so.effective_to >= (select nl.today()))
                        ), '[]'::jsonb))
  from nl.items i
  left join nl.item_supply_shape s on s.item_no = i.item_no
  left join nl.item_cost_rolled c on c.item_no = i.item_no
  left join nl.item_lead_rolled l on l.item_no = i.item_no
  left join nl.stock_position sp on sp.item_no = i.item_no
  where i.item_no = p_item_no
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- The measuring and the triggers are nobody's to call.
revoke execute on function
  nl.measure_items(text[]),
  nl.measure_all_items(),
  nl.remeasure(text[]),
  nl.items_touched_by_rate(text, text[]),
  nl.remeasure_after_bom_change(),
  nl.remeasure_after_routing_change(),
  nl.remeasure_after_item_change(),
  nl.remeasure_after_item_cost_change(),
  nl.remeasure_after_rate_change(),
  nl.remeasure_after_vendor_change(),
  nl.rollup_drift(),
  nl.repair_rollups()
from public;

grant select on nl.item_cost_variance to nl_app, nl_readonly;

grant execute on function
  nl.item_parents(text),
  nl.item_where_used(text),
  nl.item_cost_rollup(text),
  nl.item_lead_time_rollup(text),
  nl.item_truth(text, int),
  nl.rollup_gaps()
to nl_app, nl_readonly;
