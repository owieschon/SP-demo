-- The procurement desk has something to find on a fresh world.
--
-- Migration 0022 derives everything it shows from the catalog, the ledger and
-- the item card, so a world where every part happens to be well stocked would
-- render an empty page and prove nothing. This file shapes the world so each
-- of the seven signals has at least one real subject:
--
--   below_reorder_point   a handful of parts pushed under their policy
--   demand_jumped         a commitment written this month for a short part
--   purchase_order_late   one desk purchase order whose promised date passed
--   vendor_cost_moved     a cost revision dated inside the signal window
--   no_vendor             one bought-in part with its vendor cleared
--   no_cost               one new part set up for a job and never costed
--   under_vendor_minimum  one vendor whose short parts miss its minimum order
--
-- It also fills in a reorder policy where 0015 left one out, because 0015
-- only sets a policy for parts selling at least a dozen a year and the desk
-- should still plan the steady mid-volume parts underneath that.
--
-- Runs after the base world and after the other seed.d files
-- (nl_seed.finish_build() calls every nl_seed.extra_NN_name() in name order,
-- and 80 comes after 50_cost_and_pricing). Every draw is keyed, like
-- db/seed.sql, so Supabase and PGlite build the same thing, and every count
-- scales with nl_seed.settings.scale so a small world is small.
create or replace function nl_seed.extra_80_procurement()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today   date := (select today from nl_seed.settings);
  v_scale   double precision := (select scale from nl_seed.settings);
  -- How many parts to push under their reorder point. Six on the full world,
  -- and never fewer than two, so the smallest world still has a list.
  v_short   int := greatest(2, round(6 * greatest(v_scale, 0.34))::int);
  v_buyer   int;
  v_vendor  text;
  v_item    text;
  v_cust    text;
  v_owner   int;
  v_cid     bigint;
  v_order   bigint;
begin
  -- Whoever raises the seeded purchase order has to be somebody who could
  -- have raised it, so the audit trail and the row-level security policies
  -- agree with the data.
  select id into v_buyer from nl.users
   where role in ('operations', 'admin') and active order by role, id limit 1;
  if v_buyer is null then
    return;   -- a world with nobody in operations: nothing to seed
  end if;

  -- -------------------------------------------------------------------------
  -- 1. A reorder policy where 0015 did not set one.
  --
  -- 0015 sets a policy for parts selling at least 12 a year. Below that it
  -- leaves both columns null, which reads as "not stocked to a reorder
  -- point". For a stocked, purchasable part that still sells a few times a
  -- year, that is not true: the plant does hold a couple on the shelf. So
  -- give those a small policy, sized the same way 0015 sizes the busy ones
  -- (sales during the lead time, plus two weeks of cover).
  -- Made-to-order, custom, proprietary and blocked parts are left alone.
  --
  -- ONLY WHEN THE SUPPLY FORECAST IS NOT HERE. db/seed.d/40_supply.sql plans
  -- the supply in its sample export files against demand, which reads the
  -- reorder policy, and then stores each file's fingerprint so that
  -- re-uploading it says "already loaded". It runs before this file, so
  -- filling in a policy afterwards changes what those files would hold and
  -- the stored fingerprints stop matching. Measured on a small world: the
  -- sample production orders went from 42 lines to 68, and two of 0016's own
  -- tests failed.
  --
  -- The policy fill genuinely belongs BEFORE anything that plans against it,
  -- which means a seed.d file numbered below 40 rather than this one. Until
  -- somebody moves it there, it runs on a world without the forecast (where
  -- the desk needs it, because nothing else fills these in) and stands aside
  -- on a world with one (where 40_supply's own reorder-point-aware planning
  -- has already given the desk plenty to look at).
  -- -------------------------------------------------------------------------
  if to_regclass('nl.open_production_orders') is null then
    update nl.items i
       set safety_stock = r.safety,
           reorder_point = r.safety + greatest(1, ceil(r.weekly * r.lead_weeks)::int)
      from (
        select
          it.item_no,
          u.units_365d / 52.0 as weekly,
          greatest(1, ceil(u.units_365d / 52.0 * 2)::int) as safety,
          nl.item_lead_time_days(it.item_no) / 7.0 as lead_weeks
        from nl.items it
        join nl.part_usage u on u.item_no = it.item_no
        where it.reorder_point is null
          and it.safety_stock is null
          and not it.made_to_order
          and not it.proprietary
          and not it.blocked
          and it.family not in ('custom')
          and u.units_365d between 1 and 11
      ) r
     where i.item_no = r.item_no;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. A handful of parts deliberately under their reorder point.
  --
  -- Taking stock off the shelf, rather than raising the reorder point, is how
  -- it happens in life: the part sold and nobody reordered. The parts chosen
  -- are the steady sellers with a vendor and a policy, so the suggestion the
  -- desk sees is one a buyer would actually place.
  -- -------------------------------------------------------------------------
  if to_regclass('nl.open_production_orders') is null then
  update nl.stock s
     set on_hand = greatest(0, pick.floor_qty)
    from (
      select
        r.item_no,
        -- Land somewhere between empty and just under the policy, so the
        -- list shows a range of urgency rather than one shape repeated.
        floor(r.policy_level * nl_seed.u('procure.short|' || r.item_no) * 0.6)::int as floor_qty
      from nl.part_replenishment r
      where r.policy_level is not null
        and r.policy_level >= 4
        and r.vendor_no is not null
        and r.unit_cost > 0
        and not r.blocked
        and not r.made_to_order
        and r.demand_shape in ('steady', 'lumpy')
        -- Nothing already on the way, so taking stock off the shelf is enough
        -- to make the part genuinely short. This also keeps the file away
        -- from nl.stock.on_purchase_order and on_production_order, which
        -- db/seed.d/40_supply.sql picks its sample purchase and production
        -- orders from: zeroing those columns here changed which parts its
        -- sample files hold, and the fingerprints it had already stored for
        -- them stopped matching.
        and r.on_order_total = 0
      order by nl_seed.u('procure.pick|' || r.item_no)
      limit v_short
    ) pick
   where s.item_no = pick.item_no;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. One vendor whose short parts do not reach its minimum order.
  --
  -- Pick a vendor with several cheap parts, short them all, and set a
  -- minimum order comfortably above what they add up to. This is the case the
  -- desk has to group into one order rather than place three small ones.
  -- -------------------------------------------------------------------------
  select r.vendor_no into v_vendor
  from nl.part_replenishment r
  where r.vendor_no is not null
    and r.unit_cost between 1 and 40
    and not r.blocked
    and not r.made_to_order
    and r.policy_level is not null
    and r.on_order_total = 0
  group by r.vendor_no
  having count(*) >= 3
  order by nl_seed.u('procure.minvendor|' || r.vendor_no)
  limit 1;

  if v_vendor is not null then
    -- Empty the shelf for that vendor's three cheapest policy parts.
    if to_regclass('nl.open_production_orders') is null then
    update nl.stock s
       set on_hand = 0
      from (
        select r.item_no
        from nl.part_replenishment r
        where r.vendor_no = v_vendor
          and r.policy_level is not null
          and r.unit_cost between 1 and 40
          and not r.blocked
          and not r.made_to_order
          and r.on_order_total = 0
        order by r.unit_cost, r.item_no
        limit 3
      ) pick
     where s.item_no = pick.item_no;
    end if;

    -- Then set a minimum this vendor's short parts cannot reach on their own.
    -- Twice the subtotal plus $500 leaves room for the cost revisions further
    -- down this file to move the subtotal without the case going away.
    update nl.vendors v
       set min_order = ceil((coalesce(short.subtotal, 0) * 2 + 500) / 250.0) * 250,
           freight_terms = 'Prepaid over $'
             || trim(to_char(ceil((coalesce(short.subtotal, 0) * 3 + 500) / 500.0) * 500, 'FM999,999'))
      from (
        select sum(r.suggested_cost) as subtotal
        from nl.part_replenishment r
        where r.vendor_no = v_vendor and r.needs_buying
      ) short
     where v.vendor_no = v_vendor;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. One bought-in part with no vendor on its item card.
  --
  -- This is the everyday version of bad master data: somebody set up the part
  -- to be purchased and never said who from, so nothing can be ordered and
  -- nobody notices until a customer asks for it.
  -- -------------------------------------------------------------------------
  -- Chosen from the parts that are ALREADY short, so the case shows up on the
  -- buying list and not only in the signal log. It has to carry its own lead
  -- time formula, because taking the vendor away also takes the vendor's lead
  -- time away, and a part that then plans on the house default could stop
  -- being short and vanish off the list. Not one of the min-order vendor's
  -- parts, which step 3 has its own plans for.
  select r.item_no into v_item
  from nl.part_replenishment r
  join nl.items i on i.item_no = r.item_no
  join nl.stock st on st.item_no = r.item_no
  where r.needs_buying
    and i.replenishment = 'Purchase'
    and i.vendor_no is not null
    and i.lead_time ~ '^[0-9]+[DWMY]$'
    and r.vendor_no <> coalesce(v_vendor, '')
    -- db/seed.d/40_supply.sql draws its sample purchase orders from the
    -- parts where nl.stock.on_purchase_order is above zero, joining each one
    -- to its vendor, and stores the fingerprint of the file it wrote. Taking
    -- the vendor off such a part would change that file. This has to test
    -- the column itself and not r.on_order_total, because once the supply
    -- forecast is applied on_order_total comes from ITS tables and says
    -- nothing about what the item master still holds.
    and coalesce(st.on_purchase_order, 0) = 0
  order by nl_seed.u('procure.novendor|' || r.item_no)
  limit 1;

  if v_item is not null then
    update nl.items set vendor_no = null where item_no = v_item;
    -- And empty the shelf, so it stays on the list whatever the arithmetic
    -- does either side of this change.
    if to_regclass('nl.open_production_orders') is null then
      update nl.stock set on_hand = 0 where item_no = v_item;
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. One part with no cost at all.
  --
  -- A part set up for a job and never costed. This is the case that would
  -- price a whole purchase order at nothing, which is why 0022 refuses to
  -- approve a draft containing one.
  --
  -- It is a NEW part rather than an existing one with its cost cleared,
  -- because 50_cost_and_pricing holds three invariants this file must not
  -- break: every part has a cost timeline, its newest row equals the item
  -- card, and no step in any timeline is a fall of more than 10%. Zeroing an
  -- existing part's newest cost would be a 100% fall. A new part with one
  -- opening row of zero has no step at all, so all three still hold.
  --
  -- It is made here, not bought in, so it raises 'no_cost' without also
  -- raising 'no_vendor' (which only looks at purchased parts).
  -- -------------------------------------------------------------------------
  if not exists (select 1 from nl.items where item_no = 'P-9001') then
    insert into nl.items (item_no, description, category, family, product_group,
                          unit_cost, list_price, replenishment, work_center)
    values ('P-9001', 'BRACKET WELDMENT 6" UNCOSTED', 'ACCESSORY', 'bracket', 'ACCESSORY',
            0, 0, 'Prod. Order', 'WELD CELL');
    insert into nl.stock (item_no, on_hand, as_of) values ('P-9001', 0, v_today);
    -- One opening row, so the part still has a timeline and the timeline
    -- still agrees with the card.
    insert into nl.item_costs (item_no, effective_from, unit_cost, source, note)
    values ('P-9001', (v_today - 400)::date, 0, 'standard revision',
            'Opening standard cost, where this history starts');

    -- A sale, so the desk's signals see a part that matters rather than a
    -- number nobody has used. Cost zero, which is what the card says, so the
    -- ledger still agrees with the cost timeline (see db/seed.d/55).
    select customer_no into v_cust
    from nl.customers
    where not blocked and not closed and owner_id is not null
    order by nl_seed.u('procure.nocost.cust|' || customer_no)
    limit 1;
    if v_cust is not null then
      insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
      values ('PD-NC-1', 'invoice', v_cust, coalesce(
                (select bill_to_no from nl.customers where customer_no = v_cust), v_cust),
              (v_today - 40)::date, 480);
      insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
                                    quantity, unit_price, amount, unit_cost)
      values ('PD-NC-1', 1, v_cust, (v_today - 40)::date, 'P-9001', 4, 120, 480, 0);
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 6. A cost revision inside the signal window.
  --
  -- 50_cost_and_pricing builds the cost history, but its newest revisions can
  -- all be older than nl.signal_window_days() on any given day, and then
  -- "a vendor put its price up" has nothing to find.
  --
  -- So the newest revision of a few short bought-in parts is MOVED into the
  -- window and raised, rather than a new revision being inserted on top. That
  -- keeps 50_cost_and_pricing's other invariant: one to three revisions a
  -- part a year. Only parts whose newest revision is already in this year are
  -- eligible, so moving the date cannot push a revision across a year
  -- boundary and make some year the fourth.
  -- -------------------------------------------------------------------------
  drop table if exists pg_temp.costmove;
  create temporary table costmove on commit drop as
  with picked as (
    select r.item_no, r.vendor_no
    from nl.part_replenishment r
    join nl.items i on i.item_no = r.item_no
    where r.needs_buying
      and r.vendor_no is not null
      and r.unit_cost > 0
      -- A bought-in part, so its cost rows keep a vendor and 'vendor quote'
      -- stays a truthful source for them.
      and i.replenishment = 'Purchase'
    order by r.item_no
    limit greatest(2, round(4 * greatest(v_scale, 0.5))::int)
  ),
  newest as (
    select distinct on (c.item_no)
           c.item_no, c.vendor_no, c.effective_from, c.unit_cost
    from nl.item_costs c
    join picked p on p.item_no = c.item_no
    order by c.item_no, c.effective_from desc
  ),
  with_previous as (
    select
      n.item_no,
      n.effective_from as was_from,
      prev.effective_from as prev_from,
      prev.unit_cost as prev_cost
    from newest n
    cross join lateral (
      select c.effective_from, c.unit_cost
      from nl.item_costs c
      where c.item_no = n.item_no and c.effective_from < n.effective_from
      order by c.effective_from desc
      limit 1
    ) prev
    -- Already in this year, so moving the date stays inside it.
    where extract(year from n.effective_from) = extract(year from v_today)
  )
  select
    w.item_no,
    w.was_from,
    -- Somewhere in the last three weeks, but never on or before the revision
    -- it follows, and never before this January.
    greatest(
      (v_today - nl_seed.ri(3, 20, 'procure.costmove.when|' || w.item_no))::date,
      (w.prev_from + 1)::date,
      date_trunc('year', v_today)::date
    ) as now_from,
    -- A 6% rise on the revision before it: enough to clear
    -- nl.cost_move_threshold() and well inside the 25% the cost history
    -- allows for any one step.
    round(w.prev_cost * 1.06, 2) as now_cost
  from with_previous w;

  -- A part whose previous revision is itself inside the window has no room
  -- to move into; leave it alone.
  delete from pg_temp.costmove where now_from > v_today;

  update nl.item_costs c
     set effective_from = m.now_from,
         unit_cost = m.now_cost,
         source = 'vendor quote',
         note = 'Annual letter from the vendor'
    from pg_temp.costmove m
   where c.item_no = m.item_no
     and c.effective_from = m.was_from;

  -- The newest cost revision IS the current cost (0018's own rule), so the
  -- item card follows every cost this file moved.
  update nl.items i
     set unit_cost = m.now_cost
    from pg_temp.costmove m
   where i.item_no = m.item_no;

  -- And the ledger is stamped with the cost that applied on each line's own
  -- day (db/seed.d/55), so every line of a part whose history just moved has
  -- to be stamped again.
  update nl.invoice_lines il
     set unit_cost = nl.item_cost_on(il.item_no, il.posted_on)
   where il.item_no in (select item_no from pg_temp.costmove)
     and il.unit_cost is distinct from nl.item_cost_on(il.item_no, il.posted_on);

  -- -------------------------------------------------------------------------
  -- 7. A commitment written this month for a part that cannot cover it.
  --
  -- This is what makes 'demand_jumped' different from 'below reorder point':
  -- somebody has just promised a customer parts the shelf does not have.
  -- -------------------------------------------------------------------------
  select r.item_no into v_item
  from nl.part_replenishment r
  where r.needs_buying and r.vendor_no is not null
  order by r.suggested_cost desc, r.item_no
  limit 1;

  if v_item is not null then
    -- An account that already buys this part, so the commitment reads true.
    select il.customer_no into v_cust
    from nl.invoice_lines il
    join nl.customers cu on cu.customer_no = il.customer_no
    where il.item_no = v_item
      and il.quantity > 0
      and not cu.blocked
      and not cu.closed
      and cu.owner_id is not null
    order by il.posted_on desc
    limit 1;

    if v_cust is not null then
      select owner_id into v_owner from nl.customers where customer_no = v_cust;
      insert into nl.commitments (title, customer_no, owner_id, committed_value,
                                  starts_on, ends_on, confidence, created_by, created_at)
      values ('Stocking program for the coming quarter', v_cust, v_owner, 18500,
              v_today - 5, v_today + 85, 60, v_owner,
              ((v_today - 5) + time '10:15') at time zone 'America/Chicago')
      returning id into v_cid;
      insert into nl.commitment_items (commitment_id, item_no, quantity)
      values (v_cid, v_item, 120);
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 8. One purchase order the desk raised whose promised date has passed,
  --    and which the vendor has already moved once.
  --
  -- Before migration 0016 lands, the ERP's own purchase orders are only a
  -- quantity on the item card with no date on it, so a late purchase order
  -- can only come from an order this desk raised. One is seeded here for that
  -- reason, dated before today and with original_promised_on earlier still,
  -- which is both of the things the signal looks for.
  -- -------------------------------------------------------------------------
  select r.item_no, r.vendor_no into v_item, v_vendor
  from nl.part_replenishment r
  where r.needs_buying and r.vendor_no is not null and r.unit_cost > 0
  order by r.item_no
  limit 1;

  if v_item is not null then
    insert into nl.procurement_orders (vendor_no, status, ordered_on, terms, freight_terms,
                                       subtotal, created_by, created_at)
    select v_vendor, 'open', (v_today - 45)::date, v.terms, v.freight_terms,
           0, v_buyer, ((v_today - 45) + time '08:20') at time zone 'America/Chicago'
    from nl.vendors v
    where v.vendor_no = v_vendor
    returning id into v_order;

    insert into nl.procurement_order_lines (order_id, line_no, item_no, quantity, unit_cost,
                                            original_promised_on, promised_on)
    select v_order, 1, v_item, 40, i.unit_cost,
           (v_today - 17)::date,   -- what the vendor first said
           (v_today - 3)::date     -- then moved out, and still missed it
    from nl.items i
    where i.item_no = v_item;

    update nl.procurement_orders o
       set subtotal = (select round(sum(l.quantity * l.unit_cost), 2)
                       from nl.procurement_order_lines l where l.order_id = o.id)
     where o.id = v_order;

    insert into nl.audit_log (actor_id, via, action, entity, entity_id, detail)
    select v_buyer, 'seed', 'approve_purchase_request', 'purchase_request', 'seed',
           jsonb_build_object('order_id', v_order, 'vendor_no', v_vendor, 'note',
                              'Seeded so the desk has a late purchase order to show');
  end if;
end $$;

revoke execute on function nl_seed.extra_80_procurement() from public;
