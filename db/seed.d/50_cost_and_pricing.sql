-- Cost, freight and price agreement history (migration 0018).
--
-- Runs after the base world (nl_seed.finish_build() calls every
-- nl_seed.extra_NN_name() in name order). Every draw is keyed, like
-- db/seed.sql, so Supabase and PGlite build the same thing.
--
-- Three histories are built here:
--
--   1. A cost timeline per part. Costs are built backwards from the current
--      cost on the item card: the newest row on the timeline is exactly
--      nl.items.unit_cost, and every earlier row is the current cost divided
--      by the revisions that came after it. That way the item card and the
--      timeline can never disagree, whatever the draws do.
--   2. A freight tariff with a few revisions and a monthly fuel surcharge.
--      The rates are set so that freight priced off the tariff lands in the
--      same range as the freight the ledger already billed (db/seed.sql
--      prices freight around 15 dollars at a 274 dollar subtotal, rising
--      slowly with order size).
--   3. Agreed net prices for the bigger accounts on the parts they buy most,
--      a little under their price group's discount. Some have expired, some
--      are open ended, and some have a prior agreement behind them.
create or replace function nl_seed.extra_50_cost_and_pricing()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today      date   := (select today from nl_seed.settings);
  v_first_year int    := (select first_year from nl_seed.settings);
  v_scale      double precision := (select scale from nl_seed.settings);
  v_accounts   int;
begin
  -- -------------------------------------------------------------------------
  -- 1. Cost revisions
  --
  -- One to three a year per part. Most are rises of 2 to 8%; about one in
  -- five is a small fall. Through 2021 and 2022 (the supply squeeze) the
  -- rises are bigger and the falls rarer. Raw material and bought parts move
  -- the most, parts we make the least, because most of a made part's cost is
  -- labor and burden at our own work centers.
  -- -------------------------------------------------------------------------
  drop table if exists pg_temp.cost_moves;
  create temporary table cost_moves as
  select m.item_no, m.year, m.effective_from, m.mult
  from (
    select
      i.item_no,
      y.year,
      -- The revision lands in its own slot of the year, so two revisions
      -- never share a month and the dates always run forward. Day 2 or
      -- later, because the opening cost sits on 1 January.
      make_date(
        y.year,
        (g.n - 1) * (12 / k.k)
          + nl_seed.ri(1, 12 / k.k, 'cost.month|' || i.item_no || '|' || y.year || '|' || g.n),
        nl_seed.ri(2, 28, 'cost.day|' || i.item_no || '|' || y.year || '|' || g.n)
      ) as effective_from,
      1 + step.pct * vol.factor as mult
    from nl.items i
    cross join nl_seed.years y
    cross join lateral (
      select nl_seed.ri(1, 3, 'cost.changes|' || i.item_no || '|' || y.year) as k
    ) k
    cross join lateral generate_series(1, k.k) as g(n)
    cross join lateral (
      select case
        when i.family = 'raw' then 1.3
        when i.replenishment = 'Purchase' then 1.0
        else 0.55
      end as factor
    ) vol
    cross join lateral (
      select case
        -- A fall, and it is rarer while everything is going up.
        when nl_seed.chance(case when y.year between 2021 and 2022 then 0.08 else 0.18 end,
                            'cost.dir|' || i.item_no || '|' || y.year || '|' || g.n)
        then -(0.01 + 0.04 * nl_seed.u('cost.fall|' || i.item_no || '|' || y.year || '|' || g.n))
        when y.year between 2021 and 2022
        then 0.05 + 0.12 * nl_seed.u('cost.jump|' || i.item_no || '|' || y.year || '|' || g.n)
        else 0.02 + 0.06 * nl_seed.u('cost.rise|' || i.item_no || '|' || y.year || '|' || g.n)
      end as pct
    ) step
  ) m
  -- This year's revisions stop at today, like everything else in the world.
  where m.effective_from <= v_today;

  insert into nl.item_costs (item_no, vendor_no, effective_from, unit_cost, source, note)
  with steps as (
    select
      cm.item_no,
      cm.year,
      cm.effective_from,
      cm.mult,
      -- The revisions so far, and all of them, as logs so they multiply by
      -- adding. cost after revision n = current cost x exp(cum - total),
      -- which is exactly the current cost divided by everything that came
      -- after n.
      sum(ln(cm.mult)) over (partition by cm.item_no order by cm.effective_from) as cum_ln,
      sum(ln(cm.mult)) over (partition by cm.item_no) as total_ln
    from pg_temp.cost_moves cm
  ),
  every_row as (
    -- The opening cost, before the first revision.
    select
      i.item_no,
      0 as year,
      make_date(v_first_year, 1, 1) as effective_from,
      1.0::double precision as mult,
      0::double precision as cum_ln,
      coalesce(t.total_ln, 0) as total_ln,
      true as is_base
    from nl.items i
    left join (
      select item_no, max(total_ln) as total_ln from steps group by item_no
    ) t on t.item_no = i.item_no
    union all
    select s.item_no, s.year, s.effective_from, s.mult, s.cum_ln, s.total_ln, false
    from steps s
  ),
  numbered as (
    select
      e.*,
      row_number() over (partition by e.item_no order by e.effective_from desc) as from_end
    from every_row e
  )
  select
    n.item_no,
    -- A part we buy carries the vendor that quoted it; a part we make does not.
    case when i.replenishment = 'Purchase' then i.vendor_no end,
    n.effective_from,
    -- The newest row is the item card's cost, to the cent, by construction.
    case when n.from_end = 1 then i.unit_cost
         else greatest(0.01::numeric,
                       round((i.unit_cost::double precision * exp(n.cum_ln - n.total_ln))::numeric, 2))
    end,
    src.source,
    nt.note
  from numbered n
  join nl.items i on i.item_no = n.item_no
  cross join lateral (
    select case
      when n.is_base then 'standard revision'
      when i.replenishment = 'Purchase' then
        case when nl_seed.chance(0.55, 'cost.src|' || n.item_no || '|' || n.effective_from)
             then 'vendor quote' else 'purchase receipt' end
      else 'standard revision'
    end as source
  ) src
  cross join lateral (
    select case
      when n.is_base then 'Opening standard cost, where this history starts'
      when n.mult < 1 and src.source = 'standard revision' then nl_seed.pick(array[
        'Scrap rate improved at the work center, standard lowered',
        'Standard cost review, less material per piece after the fixture change',
        'Coil came down and the roll up followed it'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
      when n.mult < 1 then nl_seed.pick(array[
        'Supplier pricing eased on the next quote',
        'Second source came in lower on the same gauge',
        'Receipt landed under the quote, cost trued down'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
      when n.year between 2021 and 2022 and src.source = 'standard revision' then nl_seed.pick(array[
        'Material and burden both moved, standard rolled up',
        'Second increase this year, standard rolled up again',
        'Coil cost passed through to the standard'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
      when n.year between 2021 and 2022 then nl_seed.pick(array[
        'Mill surcharge passed through on the new quote',
        'Supplier held the old price six weeks then repriced it',
        'Receipt came in well above the quote',
        'Coil and freight in both up, quote reissued'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
      when src.source = 'standard revision' then nl_seed.pick(array[
        'Standard cost review, labor and burden updated',
        'Annual roll up of the standard',
        'Work center rate changed, standard revised'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
      when src.source = 'vendor quote' then nl_seed.pick(array[
        'Annual quote from the supplier',
        'Quote renewed with a small increase',
        'Quote reissued after the gauge change',
        'New quote held for twelve months'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
      else nl_seed.pick(array[
        'Landed cost from the last receipt, freight in included',
        'Receipt came in above the quote, standard trued up',
        'Average cost moved with the last receipt'],
        'cost.note|' || n.item_no || '|' || n.effective_from)
    end as note
  ) nt;

  drop table if exists pg_temp.cost_moves;

  -- -------------------------------------------------------------------------
  -- 2. The freight tariff and the fuel surcharge
  --
  -- Bands hold for a year or two at a time. The opening period starts with
  -- the invoice history, and the later revisions only appear in a world that
  -- reaches back that far (the small and demo worlds are shorter).
  -- -------------------------------------------------------------------------
  drop table if exists pg_temp.freight_plan;
  create temporary table freight_plan as
  select p.effective_from, p.free_over, p.note, p.band_0, p.band_250, p.band_1000
  from (values
    (make_date(v_first_year, 1, 1), 1200::numeric,
     'Opening tariff, where this history starts',                  10.50::numeric, 14.50::numeric, 18.00::numeric),
    (date '2021-07-01', 1200::numeric,
     'Carrier general rate increase',                              11.00::numeric, 15.50::numeric, 19.00::numeric),
    (date '2022-04-01', 1500::numeric,
     'Rates reset while capacity was tight, free freight moved up', 12.50::numeric, 17.50::numeric, 21.50::numeric),
    (date '2023-03-01', 1500::numeric,
     'Annual rate review, small increase',                         12.75::numeric, 18.00::numeric, 22.00::numeric),
    (date '2024-04-01', 1800::numeric,
     'New carrier agreement, free freight moved up again',         13.25::numeric, 18.50::numeric, 23.00::numeric),
    (date '2025-05-01', 1800::numeric,
     'Annual rate review',                                         13.75::numeric, 19.25::numeric, 24.00::numeric),
    (date '2026-03-01', 2000::numeric,
     'Rate review, free freight set at two thousand',              14.25::numeric, 20.00::numeric, 25.00::numeric)
  ) as p(effective_from, free_over, note, band_0, band_250, band_1000)
  where p.effective_from <= v_today
    and p.effective_from >= make_date(v_first_year, 1, 1);

  insert into nl.freight_periods (effective_from, free_over, note)
  select f.effective_from, f.free_over, f.note
  from pg_temp.freight_plan f
  order by f.effective_from;

  insert into nl.freight_rates (effective_from, min_subtotal, rate)
  select f.effective_from, b.min_subtotal, b.rate
  from pg_temp.freight_plan f
  cross join lateral (values
    (0::numeric, f.band_0),
    (250::numeric, f.band_250),
    (1000::numeric, f.band_1000)
  ) as b(min_subtotal, rate)
  order by f.effective_from, b.min_subtotal;

  drop table if exists pg_temp.freight_plan;

  -- The surcharge wanders between 8 and 28 percent: two slow waves, a little
  -- keyed noise on top, and a spike either side of the middle of 2022, when
  -- diesel ran away from everyone.
  insert into nl.fuel_surcharge (month, percent, note)
  select
    m.month,
    least(28::numeric, greatest(8::numeric, round((
      13.5
      + 3.4 * sin(2 * pi() * m.n / 23.0 + 1.1)
      + 2.1 * sin(2 * pi() * m.n / 9.0 + 0.4)
      + nl_seed.gauss(0, 0.8, 'fuel|' || m.month)
      + m.spike)::numeric, 1))),
    case when m.spike > 4 then 'Diesel climbed fast and the carriers reset the surcharge every month'
         else '' end
  from (
    select
      g.month::date as month,
      row_number() over (order by g.month)::int as n,
      -- Ten points at the middle of 2022, fading either side, nothing at all
      -- more than six months out.
      greatest(0, 10 - 1.8 * abs((extract(year from g.month) - 2022) * 12
                                 + extract(month from g.month) - 6)) as spike
    from generate_series(make_date(v_first_year, 1, 1),
                         date_trunc('month', v_today)::date,
                         interval '1 month') as g(month)
  ) m
  order by m.month;

  -- -------------------------------------------------------------------------
  -- 3. Customer price agreements
  --
  -- The accounts that buy the most, on the parts they buy the most of. An
  -- agreed price sits a little under the account's price group discount,
  -- which is how these are negotiated: the buyer asks for a few points off
  -- the tier on the handful of numbers they order every month.
  -- -------------------------------------------------------------------------
  v_accounts := greatest(6, round(120 * v_scale))::int;

  drop table if exists pg_temp.price_deals;
  create temporary table price_deals as
  with top_accounts as (
    select il.customer_no
    from nl.invoice_lines il
    join nl.customers c on c.customer_no = il.customer_no
    where il.posted_on > v_today - 730
      and il.posted_on <= v_today
      and not c.blocked
      and not c.closed
    group by il.customer_no
    order by sum(il.amount) desc, il.customer_no
    limit v_accounts
  ),
  ranked as (
    select
      ta.customer_no,
      il.item_no,
      row_number() over (partition by ta.customer_no
                         order by sum(il.amount) desc, il.item_no) as rank
    from top_accounts ta
    join nl.invoice_lines il on il.customer_no = ta.customer_no
    join nl.items i on i.item_no = il.item_no
    where il.posted_on > v_today - 730
      and il.posted_on <= v_today
      and il.quantity > 0
      and not i.blocked
    group by ta.customer_no, il.item_no
  ),
  chosen as (
    select r.customer_no, r.item_no
    from ranked r
    where r.rank <= nl_seed.ri(1, 3, 'deal.count|' || r.customer_no)
  )
  select
    ch.customer_no,
    ch.item_no,
    coalesce(c.owner_id, 1) as agreed_by,
    -- A few points under the tier price, and now and then a much deeper one,
    -- which is how a price ends up under the margin floor.
    greatest(0.25::numeric,
      round(round(i.list_price * (1 - pg.discount), 2)
            * (1 - case when nl_seed.chance(0.15, 'deal.deep|' || ch.customer_no || '|' || ch.item_no)
                        then 0.10 + 0.06 * nl_seed.u('deal.off|' || ch.customer_no || '|' || ch.item_no)
                        else 0.02 + 0.06 * nl_seed.u('deal.off|' || ch.customer_no || '|' || ch.item_no)
                   end)::numeric, 2)) as net_price,
    w.has_prior,
    w.prior_from,
    w.prior_to,
    w.current_from,
    w.current_to
  from chosen ch
  join nl.customers c on c.customer_no = ch.customer_no
  join nl.items i on i.item_no = ch.item_no
  join nl.price_groups pg on pg.code = c.price_group
  cross join lateral (
    select
      nl_seed.chance(0.40, 'deal.prior|' || ch.customer_no || '|' || ch.item_no) as has_prior,
      v_today - nl_seed.ri(760, 900, 'deal.p1|' || ch.customer_no || '|' || ch.item_no) as prior_from
  ) p
  cross join lateral (
    select
      p.has_prior,
      p.prior_from,
      p.prior_from + nl_seed.ri(280, 330, 'deal.p2|' || ch.customer_no || '|' || ch.item_no) as prior_to
  ) q
  cross join lateral (
    select
      q.has_prior,
      case when q.has_prior then q.prior_from end as prior_from,
      case when q.has_prior then q.prior_to end as prior_to,
      -- The current agreement starts after the prior one ended, or somewhere
      -- in the last year and a half when there was no prior one.
      case when q.has_prior
           then q.prior_to + nl_seed.ri(6, 45, 'deal.p3|' || ch.customer_no || '|' || ch.item_no)
           else v_today - nl_seed.ri(30, 520, 'deal.p4|' || ch.customer_no || '|' || ch.item_no)
      end as current_from
  ) v
  cross join lateral (
    select
      v.has_prior, v.prior_from, v.prior_to, v.current_from,
      -- About a third of the agreements have an end date on them. The rest
      -- are open ended, which is what nl.price_for() calls an open agreement.
      case when nl_seed.chance(0.30, 'deal.ends|' || ch.customer_no || '|' || ch.item_no)
           then v.current_from + nl_seed.ri(150, 330, 'deal.end|' || ch.customer_no || '|' || ch.item_no)
      end as current_to
  ) w;

  -- The agreement in force now (or the last one, if it has run out).
  insert into nl.customer_prices (customer_no, item_no, net_price, valid_from, valid_to, agreed_by, note)
  select
    d.customer_no,
    d.item_no,
    d.net_price,
    d.current_from,
    d.current_to,
    d.agreed_by,
    nl_seed.pick(array[
      'Annual stocking agreement, reviewed with the buyer',
      'Fleet program pricing, holds through the season',
      'Held at last year plus two points after the cost review',
      'Matched a competitor quote the buyer sent over',
      'Volume agreement tied to a quarterly release',
      'Agreed on the call after the plant visit'],
      'deal.note|' || d.customer_no || '|' || d.item_no)
  from pg_temp.price_deals d
  order by d.customer_no, d.item_no;

  -- The agreement it replaced, for the accounts that have been on one for
  -- years. Its window closes before the current one opens, so no two
  -- agreements for the same account and part ever overlap.
  insert into nl.customer_prices (customer_no, item_no, net_price, valid_from, valid_to, agreed_by, note)
  select
    d.customer_no,
    d.item_no,
    -- The old agreement was a little cheaper, because costs have moved since.
    greatest(0.25::numeric,
             round(d.net_price * (0.90 + 0.06 * nl_seed.u('deal.old|' || d.customer_no || '|' || d.item_no))::numeric, 2)),
    d.prior_from,
    d.prior_to,
    d.agreed_by,
    nl_seed.pick(array[
      'Prior year agreement, replaced by the current one',
      'Superseded when the new quote went out',
      'Ran to the end of the program year'],
      'deal.oldnote|' || d.customer_no || '|' || d.item_no)
  from pg_temp.price_deals d
  where d.has_prior
  order by d.customer_no, d.item_no;

  drop table if exists pg_temp.price_deals;
end $$;

revoke execute on function nl_seed.extra_50_cost_and_pricing() from public;
