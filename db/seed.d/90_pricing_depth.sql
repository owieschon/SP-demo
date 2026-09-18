-- Published price sheets, published ladders and the exceptions behind a
-- number (migration 0027).
--
-- Runs last, after the catalog, the ledger, the supply snapshots and the
-- agreements in 50_cost_and_pricing.sql, because every generation of every
-- sheet is worked out from the tier price and the top selling parts are
-- chosen from the ledger. Every draw is keyed, like db/seed.sql, so Supabase
-- and PGlite build the same world.
--
-- Five things are built here:
--
--   1. Three generations of price sheet per tier, over the last few years.
--      The newest generation is exactly round(list x (1 - tier discount), 2),
--      so the sheet in force and nl.price_for() cannot disagree; the older
--      generations are a few percent under it, because list price has moved
--      since. Then one send per generation per account, up to the generation
--      that account is actually holding, so a third of the book is working
--      off a sheet that has been replaced.
--   2. A published volume ladder on the parts that sell most: quantities 1,
--      6, 12, 25, 50 and 100, a price each, printed on every generation of
--      the sheet. A second, shorter set of ladders belongs to the tier rather
--      than to a sheet, which is the other half of nl.price_breaks.
--   3. A break policy on the agreements: most let a published ladder go
--      under the agreed price, a few are firm at every quantity.
--   4. A spread of trade exceptions, live and expired: an announced increase,
--      increases already in force, material and freight surcharges, accounts
--      holding an older sheet by agreement, lead times that have slipped,
--      allocation while stock is short, parts discontinued with a
--      replacement, and order minimums.
--   5. The vendor and part relationship: a primary source for every bought
--      part and a second source for about a quarter, with what that vendor
--      quotes, when they said it, the minimum order and the order multiple,
--      their own price ladder, and three years of receipts per pair. The
--      receipts are drawn so that vendors differ in shape and not just in
--      average, because a median of 18 days with a ninetieth of 45 is a
--      different supplier from 24 days every time, and the promise rule has
--      to be able to tell them apart.
create or replace function nl_seed.extra_90_pricing_depth()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today       date := (select today from nl_seed.settings);
  v_first_year  int  := (select first_year from nl_seed.settings);
  v_last_year   int  := (select last_year from nl_seed.settings);
  v_scale       double precision := (select scale from nl_seed.settings);
  v_ladder_n    int;
  v_tier_n      int;
  v_owner       int;
begin
  -- -------------------------------------------------------------------------
  -- 1. The sheets
  --
  -- Sheets go out in March and November. Three generations, newest first, of
  -- whichever of those anchors fall inside the world's own history.
  -- -------------------------------------------------------------------------
  drop table if exists pg_temp.sheet_gen;
  create temporary table sheet_gen as
  select
    row_number() over (order by a.anchor desc)::int as gen,   -- 1 is the current sheet
    a.anchor as effective_from,
    -- The day before the next generation starts, and null for the newest.
    lag(a.anchor) over (order by a.anchor desc) - 1 as effective_to
  from (
    select make_date(y.y, m.m, 1) as anchor
    from generate_series(v_first_year, v_last_year) as y(y)
    cross join (values (3), (11)) as m(m)
    where make_date(y.y, m.m, 1) <= v_today
      and make_date(y.y, m.m, 1) >= make_date(v_first_year, 1, 1)
    order by 1 desc
    limit 3
  ) a;

  insert into nl.price_sheets (code, name, price_group, effective_from, effective_to,
                               published_on, note)
  select
    'PS-' || pg.code || '-' || to_char(g.effective_from, 'YYYY-MM'),
    pg.label || ' net prices, ' || to_char(g.effective_from, 'FMMonth YYYY'),
    pg.code,
    g.effective_from,
    g.effective_to,
    -- The sheet goes out a couple of weeks before it takes effect, which is
    -- how a buyer comes to be holding one before it starts.
    g.effective_from - 14,
    case when g.gen = (select max(gen) from pg_temp.sheet_gen)
         then 'Where the published sheet history starts'
         when g.gen = 1 then 'The sheet in force'
         else 'Replaced by the next generation'
    end
  from pg_temp.sheet_gen g
  cross join nl.price_groups pg
  order by pg.code, g.effective_from;

  -- The page prices. The current generation is the tier price to the cent;
  -- each older generation is a few percent under the one after it, which is
  -- what it means for list to have moved. Custom and proprietary parts are
  -- not on a printed sheet: those are quoted one at a time.
  drop table if exists pg_temp.sheet_step;
  create temporary table sheet_step as
  select
    s.id as sheet_id,
    g.gen,
    i.item_no,
    i.list_price,
    pg.discount,
    round(i.list_price * (1 - pg.discount), 2) as tier_price,
    -- The generations between this one and the current one, multiplied
    -- together as a sum of logs so the oldest sheet compounds properly.
    case when g.gen = 1 then 0::double precision
         else (select sum(ln(1 - (0.025 + 0.03 * nl_seed.u(
                       'sheet.step|' || i.item_no || '|' || pg.code || '|' || j.j))))
               from generate_series(2, g.gen) as j(j))
    end as ln_factor
  from nl.items i
  cross join nl.price_groups pg
  join pg_temp.sheet_gen g on true
  join nl.price_sheets s on s.price_group = pg.code and s.effective_from = g.effective_from
  where not i.blocked
    and i.family not in ('custom', 'proprietary')
    and i.list_price > 0
    and round(i.list_price * (1 - pg.discount), 2) > 0;

  insert into nl.price_sheet_lines (sheet_id, item_no, sheet_price, list_at_publication, note)
  select
    st.sheet_id,
    st.item_no,
    p.price,
    -- The list the page price was worked out from, so an old sheet still
    -- explains itself after list has moved on.
    case when st.gen = 1 then st.list_price
         else greatest(0.01::numeric, round(p.price / (1 - st.discount), 2)) end,
    case when i.family = 'raw' then 'Priced off the mill index on the day of publication' else '' end
  from pg_temp.sheet_step st
  join nl.items i on i.item_no = st.item_no
  cross join lateral (
    select greatest(0.01::numeric,
                    round((st.tier_price::double precision * exp(st.ln_factor))::numeric, 2)) as price
  ) p;

  -- Which sheet each account is holding. Two thirds are on the current one;
  -- the rest are working off a generation that has been replaced, which is
  -- the thing a reply has to notice before it quotes a number.
  insert into nl.price_sheet_sends (customer_no, sheet_id, sent_on, sent_how, note)
  select
    c.customer_no,
    s.id,
    -- A sheet lands in the weeks after it takes effect, and never in the future.
    least(v_today, g.effective_from + nl_seed.ri(1, 25,
          'sheet.sent|' || c.customer_no || '|' || g.gen)),
    nl_seed.pick(array['email', 'email', 'email', 'mail', 'rep visit', 'portal'],
                 'sheet.how|' || c.customer_no || '|' || g.gen),
    ''
  from nl.customers c
  join pg_temp.sheet_gen g
    -- The generation they hold, and every older one, so the trail is there.
    on g.gen >= (case
      when nl_seed.chance(0.66, 'sheet.hold|' || c.customer_no) then 1
      when nl_seed.chance(0.70, 'sheet.hold2|' || c.customer_no) then 2
      else 3
    end)
  join nl.price_sheets s on s.price_group = c.price_group and s.effective_from = g.effective_from
  where not c.blocked and not c.closed
  order by c.customer_no, g.effective_from;

  -- -------------------------------------------------------------------------
  -- 2. The ladders
  --
  -- A ladder is printed on the sheet for the parts that move in quantity.
  -- Rung one is the sheet price, so a ladder explains itself without anyone
  -- having to look up the sheet as well.
  -- -------------------------------------------------------------------------
  v_ladder_n := greatest(10, round(80 * v_scale))::int;
  v_tier_n   := greatest(4, round(30 * v_scale))::int;

  drop table if exists pg_temp.ladder_part;
  create temporary table ladder_part as
  with sellers as (
    select il.item_no, sum(il.amount) as revenue
    from nl.invoice_lines il
    join nl.items i on i.item_no = il.item_no
    where il.posted_on > v_today - 730
      and il.quantity > 0
      and not i.blocked
      and i.family not in ('custom', 'proprietary')
    group by il.item_no
    order by sum(il.amount) desc, il.item_no
    limit v_ladder_n + v_tier_n
  )
  select
    s.item_no,
    row_number() over (order by s.revenue desc, s.item_no) as rank
  from sellers s;

  -- The sheet ladders: every generation of every sheet, for the top parts.
  -- The rung prices fall as the quantity rises, and a running minimum keeps
  -- them falling even where rounding would have tied two rungs together.
  insert into nl.price_breaks (sheet_id, item_no, min_quantity, break_price, note)
  select
    r.sheet_id,
    r.item_no,
    r.min_quantity,
    -- Non-increasing by construction: the lowest price at this rung or any
    -- rung below it.
    min(r.raw_price) over (partition by r.sheet_id, r.item_no
                           order by r.min_quantity rows unbounded preceding),
    r.note
  from (
    select
      psl.sheet_id,
      psl.item_no,
      q.min_quantity,
      q.note,
      case when q.min_quantity = 1 then psl.sheet_price
           else greatest(0.01::numeric,
                         round(psl.sheet_price * (1 - d.cut)::numeric, 2)) end as raw_price
    from pg_temp.ladder_part lp
    join nl.price_sheet_lines psl on psl.item_no = lp.item_no
    cross join (values
      (1,   'One to five'),
      (6,   'Half a dozen or more'),
      (12,  'A dozen or more'),
      (25,  'Twenty-five or more'),
      (50,  'Fifty or more'),
      (100, 'One hundred or more')) as q(min_quantity, note)
    cross join lateral (
      -- The cut deepens rung by rung, so the ladder always goes one way.
      select coalesce((
        select sum(0.012 + 0.018 * nl_seed.u(
                 'break.cut|' || lp.item_no || '|' || psl.sheet_id || '|' || s.step))
        from generate_series(2, case q.min_quantity
                                  when 1 then 1 when 6 then 2 when 12 then 3
                                  when 25 then 4 when 50 then 5 else 6 end) as s(step)
      ), 0) as cut
    ) d
    where lp.rank <= v_ladder_n
  ) r;

  -- The tier ladders: a shorter standing ladder that outlives one sheet
  -- generation, on the parts just below the top sellers. nl.price_quote_for()
  -- reads these only when the sheet in force prints no ladder for the part,
  -- which is exactly the case here.
  insert into nl.price_breaks (price_group, item_no, min_quantity, break_price, note)
  select
    r.price_group,
    r.item_no,
    r.min_quantity,
    min(r.raw_price) over (partition by r.price_group, r.item_no
                           order by r.min_quantity rows unbounded preceding),
    r.note
  from (
    select
      pg.code as price_group,
      lp.item_no,
      q.min_quantity,
      q.note,
      case when q.min_quantity = 1 then round(i.list_price * (1 - pg.discount), 2)
           else greatest(0.01::numeric,
                  round(round(i.list_price * (1 - pg.discount), 2) * (1 - q.cut)::numeric, 2)) end
        as raw_price
    from pg_temp.ladder_part lp
    join nl.items i on i.item_no = lp.item_no
    cross join nl.price_groups pg
    cross join lateral (values
      (1,   0.0::double precision, 'One to eleven'),
      (12,  0.035,                 'A dozen or more'),
      (50,  0.075,                 'Fifty or more')) as q(min_quantity, cut, note)
    where lp.rank > v_ladder_n
      and round(i.list_price * (1 - pg.discount), 2) > 0
  ) r;

  -- -------------------------------------------------------------------------
  -- 3. Which agreements a ladder may go under
  --
  -- About one in six agreements is written as a firm net price at every
  -- quantity. The rest are a starting point the published ladder may beat,
  -- which is how a buyer reads two documents and takes the better one.
  -- -------------------------------------------------------------------------
  update nl.customer_prices cp
  set break_policy = 'agreement only'
  where nl_seed.chance(0.17, 'deal.firm|' || cp.customer_no || '|' || cp.item_no
                             || '|' || cp.valid_from);

  -- -------------------------------------------------------------------------
  -- 4. The exceptions
  --
  -- A spread of the things that actually happen, live and expired, each with
  -- a reason, a window and a person who owns it.
  -- -------------------------------------------------------------------------

  -- An increase announced for a future date, with the wording of the letter.
  v_owner := nl_seed.owner_for('exc.increase');
  insert into nl.trade_exceptions (kind, scope, announced_on, effective_from, pct, reason, wording, owner_id)
  values ('price increase', 'catalog', v_today - 19, v_today + 46, 0.0450,
    'Steel and stainless both moved again over the summer and the mills will not hold the second half',
    'Effective ' || to_char(v_today + 46, 'FMMonth FMDD, YYYY')
      || ', published prices rise by 4.5 percent across the catalog. Orders placed and'
      || ' scheduled before that date ship at current prices. Your sheet will be reissued'
      || ' two weeks beforehand.',
    v_owner);

  -- An increase that is already in force on one family.
  v_owner := nl_seed.owner_for('exc.increase.pipe');
  insert into nl.trade_exceptions (kind, scope, family, announced_on, effective_from, pct,
                                   reason, wording, owner_id)
  values ('price increase', 'family', 'pipe', v_today - 165, v_today - 120, 0.0600,
    'Tube cost rose faster than the annual roll up allowed for',
    'Pipe and tube prices rose 6 percent. The rest of the sheet was unchanged.',
    v_owner);

  -- One that has run out, so an expired exception is in the world too.
  v_owner := nl_seed.owner_for('exc.increase.clamp');
  insert into nl.trade_exceptions (kind, scope, family, announced_on, effective_from, effective_to,
                                   pct, reason, wording, owner_id)
  values ('price increase', 'family', 'clamp', v_today - 440, v_today - 400, v_today - 40, 0.0300,
    'A temporary increase while the band stock was bought on the open market',
    'The 3 percent clamp increase has been withdrawn now that the contract stock is back.',
    v_owner);

  -- A live material surcharge, and a live freight one, each billed as its own
  -- line rather than folded into the price.
  v_owner := nl_seed.owner_for('exc.sur.material');
  insert into nl.trade_exceptions (kind, scope, family, announced_on, effective_from, effective_to,
                                   pct, reason, wording, owner_id)
  values ('surcharge', 'family', 'raw', v_today - 80, v_today - 70, v_today + 80, 0.0550,
    'The mill added a stainless alloy surcharge that we are passing through at cost',
    'A 5.5 percent alloy surcharge appears as its own line on raw material orders. It comes'
      || ' off as soon as the mill withdraws it.',
    v_owner);

  v_owner := nl_seed.owner_for('exc.sur.freight');
  insert into nl.trade_exceptions (kind, scope, announced_on, effective_from, effective_to,
                                   pct, reason, wording, owner_id)
  values ('surcharge', 'catalog', v_today - 35, v_today - 30, v_today + 60, 0.0200,
    'Carrier fuel cost jumped two months running and the published tariff has not caught up',
    'A 2 percent freight surcharge is shown separately on the invoice. Orders over the free'
      || ' freight threshold are not affected.',
    v_owner);

  -- An expired surcharge.
  v_owner := nl_seed.owner_for('exc.sur.old');
  insert into nl.trade_exceptions (kind, scope, announced_on, effective_from, effective_to,
                                   pct, reason, wording, owner_id)
  values ('surcharge', 'catalog', v_today - 270, v_today - 260, v_today - 150, 0.0300,
    'A short surcharge while a second coil source was qualified',
    'The 3 percent material surcharge ended and is no longer billed.',
    v_owner);

  -- Accounts that keep an older sheet on one family by agreement. This is the
  -- one exception kind that moves the price, because it was written to.
  insert into nl.trade_exceptions (kind, scope, family, customer_no, announced_on, effective_from,
                                   effective_to, held_sheet_id, reason, wording, owner_id)
  select
    'customer exception',
    'family',
    top.family,
    top.customer_no,
    top.held_from - 10,
    top.held_from,
    -- Two thirds are still live; the rest ran out earlier this year.
    case when nl_seed.chance(0.66, 'exc.cust.live|' || top.customer_no)
         then v_today + nl_seed.ri(30, 160, 'exc.cust.to|' || top.customer_no)
         else v_today - nl_seed.ri(20, 90, 'exc.cust.gone|' || top.customer_no)
    end,
    top.sheet_id,
    'Agreed at the annual review: this account stays on the prior sheet for this family'
      || ' while the program year runs',
    'Your pricing on this family is held at the ' || top.sheet_name
      || ' until the date shown. Everything else moves with the current sheet.',
    coalesce(top.owner_id, 1)
  from (
    select
      c.customer_no,
      c.owner_id,
      i.family,
      ps.id as sheet_id,
      ps.name as sheet_name,
      ps.effective_from + nl_seed.ri(20, 60, 'exc.cust.from|' || c.customer_no) as held_from,
      row_number() over (order by sum(il.amount) desc, c.customer_no) as rank
    from nl.invoice_lines il
    join nl.customers c on c.customer_no = il.customer_no
    join nl.items i on i.item_no = il.item_no
    -- The generation behind the current one for their tier.
    join nl.price_sheets ps
      on ps.price_group = c.price_group
     and ps.effective_to is not null
     and ps.effective_to = (select max(effective_to) from nl.price_sheets inner_ps
                            where inner_ps.price_group = c.price_group
                              and inner_ps.effective_to is not null)
    where il.posted_on > v_today - 540
      and il.quantity > 0
      and not c.blocked and not c.closed
      and i.family not in ('custom', 'proprietary')
    group by c.customer_no, c.owner_id, i.family, ps.id, ps.name, ps.effective_from
  ) top
  where top.rank <= greatest(4, round(40 * v_scale))::int
    and top.held_from <= v_today;

  -- Lead times that have slipped, on the parts people ask about most.
  insert into nl.trade_exceptions (kind, scope, item_no, announced_on, effective_from, effective_to,
                                   days, reason, wording, owner_id)
  select
    'lead time',
    'item',
    lp.item_no,
    w.effective_from - nl_seed.ri(5, 25, 'exc.lead.ann|' || lp.item_no),
    w.effective_from,
    w.effective_to,
    nl.item_lead_days(lp.item_no) + nl_seed.ri(14, 45, 'exc.lead.days|' || lp.item_no),
    nl_seed.pick(array[
      'The vendor moved the promised date out twice and has not recovered the schedule',
      'The bender is the bottleneck and the queue in front of this part is four weeks deep',
      'The mill is short of the gauge this part is rolled from',
      'A tooling repair took the work center down for a fortnight and the backlog is still there'],
      'exc.lead.why|' || lp.item_no),
    'Lead time on this part is longer than the card shows. We will confirm a date on the order'
      || ' rather than quote the standard figure.',
    -- A lead time is owned by the people who can do something about it: the
    -- planner, purchasing, or the operations lead.
    nl_seed.pick(array['12', '13', '5'], 'exc.lead.owner|' || lp.item_no)::int
  from pg_temp.ladder_part lp
  cross join lateral (
    select
      f.effective_from,
      -- Roughly a third have already been cleared, and a closed window
      -- always closes after it opened.
      case when nl_seed.chance(0.34, 'exc.lead.done|' || lp.item_no)
           then f.effective_from + nl_seed.ri(5, 20, 'exc.lead.to|' || lp.item_no) end
        as effective_to
    from (select v_today - nl_seed.ri(35, 70, 'exc.lead.from|' || lp.item_no) as effective_from) f
  ) w
  where lp.rank <= greatest(4, round(14 * v_scale))::int
    and nl_seed.chance(0.75, 'exc.lead.pick|' || lp.item_no);

  -- A whole family out at the vendor.
  v_owner := 12;   -- the production planner owns a vendor wide slip
  insert into nl.trade_exceptions (kind, scope, family, announced_on, effective_from, days,
                                   reason, wording, owner_id)
  select 'lead time', 'family', f.family, v_today - 50, v_today - 40, 45,
    'The vendor that supplies this whole family is running six weeks behind on every size',
    'Anything in this family is quoting 45 days until the vendor recovers. We will call with a'
      || ' date before we take the order.',
    v_owner
  from (
    select i.family
    from nl.items i
    where i.family in ('flex', 'shield', 'bracket')
    group by i.family
    order by count(*) desc, i.family
    limit 1
  ) f;

  -- Allocation while stock is short.
  insert into nl.trade_exceptions (kind, scope, item_no, announced_on, effective_from, effective_to,
                                   quantity, reason, wording, owner_id)
  select
    'allocation',
    'item',
    lp.item_no,
    v_today - nl_seed.ri(20, 40, 'exc.alloc.ann|' || lp.item_no),
    v_today - nl_seed.ri(2, 18, 'exc.alloc.from|' || lp.item_no),
    v_today + nl_seed.ri(20, 70, 'exc.alloc.to|' || lp.item_no),
    nl_seed.ri(10, 60, 'exc.alloc.qty|' || lp.item_no),
    'Stock is short and the next production run is committed, so the remaining pieces are'
      || ' spread across the accounts that buy this part every month',
    'While this part is on allocation we can take up to the quantity shown per order. Tell us'
      || ' what you need for the month and we will schedule the rest.',
    nl_seed.pick(array['12', '5', '13'], 'exc.alloc.owner|' || lp.item_no)::int
  from pg_temp.ladder_part lp
  where lp.rank between 3 and greatest(6, round(10 * v_scale))::int
    and nl_seed.chance(0.6, 'exc.alloc.pick|' || lp.item_no);

  -- Parts we have stopped selling, each with the part that replaces it. The
  -- replacement is a part in the same family that is not itself being
  -- discontinued, so no account is pointed at a dead number.
  insert into nl.trade_exceptions (kind, scope, item_no, announced_on, effective_from,
                                   replacement_item_no, reason, wording, owner_id)
  select
    'discontinued',
    'item',
    d.item_no,
    v_today - nl_seed.ri(120, 200, 'exc.disc.ann|' || d.item_no),
    v_today - nl_seed.ri(20, 100, 'exc.disc.from|' || d.item_no),
    d.replacement_item_no,
    nl_seed.pick(array[
      'The tooling wore out and the replacement part covers the same applications',
      'Superseded by a part with a better weld joint at the same price',
      'Volume fell below what a production run needs and the replacement fits the same trucks'],
      'exc.disc.why|' || d.item_no),
    'This part number has been discontinued. The replacement shown is a direct fit and we hold'
      || ' it in stock.',
    nl_seed.owner_for('exc.disc.owner|' || d.item_no)
  from (
    select
      old.item_no,
      -- The nearest part by number in the same family, which keeps the pair
      -- stable between builds.
      (select rep.item_no
       from nl.items rep
       where rep.family = old.family
         and rep.item_no <> old.item_no
         and not rep.blocked
       order by rep.item_no
       limit 1) as replacement_item_no
    from (
      select i.item_no, i.family,
             row_number() over (order by nl_seed.u('exc.disc.pick|' || i.item_no)) as pick
      from nl.items i
      join pg_temp.ladder_part lp on lp.item_no = i.item_no
      where lp.rank > 6 and not i.blocked
    ) old
    where old.pick <= greatest(2, round(8 * v_scale))::int
  ) d
  where d.replacement_item_no is not null;

  -- An order minimum for the whole book, and pack sizes on the parts that
  -- come out of the press in multiples.
  v_owner := nl_seed.owner_for('exc.min.order');
  insert into nl.trade_exceptions (kind, scope, announced_on, effective_from, amount,
                                   reason, wording, owner_id)
  values ('order minimum', 'catalog', v_today - 400, v_today - 380, 250.00,
    'Picking, packing and paperwork cost more than a small order brings in',
    'Orders under 250 dollars carry a handling charge. We are glad to hold a small order and'
      || ' ship it with your next one instead.',
    v_owner);

  insert into nl.trade_exceptions (kind, scope, item_no, announced_on, effective_from, quantity,
                                   reason, wording, owner_id)
  select
    'order minimum',
    'item',
    lp.item_no,
    v_today - nl_seed.ri(300, 500, 'exc.pack.ann|' || lp.item_no),
    v_today - nl_seed.ri(250, 290, 'exc.pack.from|' || lp.item_no),
    nl_seed.pick(array['4', '6', '10', '12', '25'], 'exc.pack.qty|' || lp.item_no)::int,
    'This part is boxed at the press and the carton is not opened in the warehouse',
    'This part ships in full cartons. We will round an order up to the next carton and say so'
      || ' on the confirmation.',
    nl_seed.pick(array['12', '14', '6'], 'exc.pack.owner|' || lp.item_no)::int
  from pg_temp.ladder_part lp
  where lp.rank between 2 and greatest(4, round(12 * v_scale))::int
    and nl_seed.chance(0.5, 'exc.pack.pick|' || lp.item_no);


  -- -------------------------------------------------------------------------
  -- 5. The vendor and part relationship, and the receipts behind it
  --
  -- Every bought part gets a primary source, and about a quarter get a second
  -- one. Each carries what that vendor quotes, when they said it, and what
  -- ordering it takes. Then a receipt history per vendor and part, drawn so
  -- the shape of a vendor matters: some are the same number every time, some
  -- have a median a buyer could live with and a tail that ruins a promise.
  -- That difference is the whole point of keeping a percentile rather than an
  -- average, so the data has to contain it.
  -- -------------------------------------------------------------------------

  -- How each vendor behaves, once, so every part they supply inherits it.
  -- tail is how far the ninetieth percentile runs past the median: 0.1 is a
  -- vendor who is boringly consistent, 1.2 is one whose quote means nothing.
  drop table if exists pg_temp.vendor_habit;
  create temporary table vendor_habit as
  select
    v.vendor_no,
    coalesce(nl.lead_time_days(v.lead_time), 21) as card_days,
    -- A fifth of vendors are consistent, a fifth are bad, the rest in between.
    case
      when nl_seed.chance(0.20, 'vh.kind|' || v.vendor_no) then 0.10
      when nl_seed.chance(0.25, 'vh.bad|' || v.vendor_no)  then 0.90
      else 0.30 + 0.30 * nl_seed.u('vh.tail|' || v.vendor_no)
    end as tail,
    -- How optimistic their quote is against what they do. Most quote a little
    -- short of reality, which is why the observed figure is worth having.
    0.88 + 0.22 * nl_seed.u('vh.quote|' || v.vendor_no) as quote_ratio
  from nl.vendors v;

  -- The vendor and part rows. The primary source is the vendor the item card
  -- already names; the alternate is the next vendor along by number, which
  -- keeps the pairing the same between builds.
  insert into nl.vendor_items (vendor_no, item_no, is_primary, vendor_item_no,
                               quoted_lead_days, quoted_on, quote_reference,
                               min_order_qty, order_multiple, unit_cost,
                               status, status_note, replacement_item_no)
  select
    src.vendor_no,
    src.item_no,
    src.is_primary,
    -- Their own part number, which is never ours.
    upper(substr(nl_seed.slug(src.vendor_no), 1, 3)) || '-'
      || lpad(nl_seed.ri(1000, 99999, 'vi.theirno|' || src.vendor_no || '|' || src.item_no)::text, 5, '0'),
    src.quoted_days,
    src.quoted_on,
    src.quote_reference,
    src.min_order_qty,
    src.order_multiple,
    src.unit_cost,
    src.status,
    src.status_note,
    src.replacement_item_no
  from (
    select
      pair.vendor_no,
      i.item_no,
      pair.is_primary,
      -- What they quote: their habit applied to the card figure, which is
      -- usually a little short of what they manage.
      greatest(3, round(h.card_days * h.quote_ratio
                        * (1 + 0.15 * (nl_seed.u('vi.q|' || pair.vendor_no || '|' || i.item_no) - 0.5)))::int)
        as quoted_days,
      -- The day they said it: an annual quote, somewhere in the last year.
      v_today - nl_seed.ri(20, 360, 'vi.qon|' || pair.vendor_no || '|' || i.item_no) as quoted_on,
      nl_seed.pick(array[
        'Annual quote sheet',
        'Quote reissued after the gauge change',
        'Quote confirmed by email',
        'Price sheet for the program year'],
        'vi.qref|' || pair.vendor_no || '|' || i.item_no) as quote_reference,
      -- Minimum order and order multiple: small parts come by the carton,
      -- fabricated ones one at a time.
      case when i.family in ('clamp', 'bracket', 'shield') then nl_seed.ri(10, 50, 'vi.moq|' || i.item_no)
           when i.family in ('elbow', 'pipe', 'flex') then nl_seed.ri(2, 12, 'vi.moq|' || i.item_no)
           else 1 end as min_order_qty,
      case when i.family in ('clamp', 'bracket', 'shield')
           then nl_seed.pick(array['5', '10', '25'], 'vi.mult|' || i.item_no)::int
           else 1 end as order_multiple,
      -- Their price at one piece: a bit under what we carry as cost, because
      -- the item cost has freight in and a margin of error on it.
      greatest(0.01::numeric,
               round(i.unit_cost * (0.88 + 0.16 * nl_seed.u('vi.cost|' || pair.vendor_no || '|' || i.item_no))::numeric, 2))
        as unit_cost,
      st.status,
      st.status_note,
      case when st.status = 'discontinued' then st.replacement end as replacement_item_no
    from nl.items i
    join vendor_habit h on true
    cross join lateral (values
      (i.vendor_no, true),
      -- A second source for about a quarter of parts: the next vendor by
      -- number, wrapping round at the end of the list.
      (case when nl_seed.chance(0.25, 'vi.second|' || i.item_no)
            then (select alt.vendor_no from nl.vendors alt
                  where alt.vendor_no > i.vendor_no order by alt.vendor_no limit 1)
       end, false)
    ) as pair(vendor_no, is_primary)
    cross join lateral (
      select
        case
          -- A few are on allocation at the vendor right now.
          when pair.is_primary and nl_seed.chance(0.02, 'vi.alloc|' || i.item_no) then 'allocation'
          -- A few they no longer make, with the part they point at instead.
          when pair.is_primary and nl_seed.chance(0.015, 'vi.gone|' || i.item_no) then 'discontinued'
          else 'active'
        end as status,
        (select rep.item_no from nl.items rep
         where rep.family = i.family and rep.item_no <> i.item_no and not rep.blocked
         order by rep.item_no limit 1) as replacement
    ) s0
    cross join lateral (
      select
        s0.status,
        s0.replacement,
        case s0.status
          when 'allocation' then 'The vendor has this part on allocation while their own material is short'
          when 'discontinued' then 'The vendor has stopped making this part and points at the replacement'
          else ''
        end as status_note
    ) st
    where i.replenishment = 'Purchase'
      and i.vendor_no is not null
      and h.vendor_no = pair.vendor_no
      and pair.vendor_no is not null
  ) src
  -- A discontinued row needs somewhere to point, or it says nothing useful.
  where src.status <> 'discontinued' or src.replacement_item_no is not null
  on conflict (vendor_no, item_no) do nothing;

  -- The vendor's own ladder: three rungs, so a purchase request can say what
  -- buying a carton more would save.
  insert into nl.vendor_item_breaks (vendor_no, item_no, min_quantity, unit_cost, note)
  select
    r.vendor_no, r.item_no, r.min_quantity,
    min(r.raw_cost) over (partition by r.vendor_no, r.item_no
                          order by r.min_quantity rows unbounded preceding),
    r.note
  from (
    select
      vi.vendor_no, vi.item_no, q.min_quantity, q.note,
      case when q.min_quantity = 1 then vi.unit_cost
           else greatest(0.01::numeric, round(vi.unit_cost * (1 - q.cut)::numeric, 2)) end as raw_cost
    from nl.vendor_items vi
    cross join (values
      (1,   0.0::double precision, 'Their price at one'),
      (25,  0.045,                 'Twenty-five or more'),
      (100, 0.085,                 'One hundred or more')) as q(min_quantity, cut, note)
    where vi.unit_cost is not null
      and vi.status = 'active'
      and nl_seed.chance(0.45, 'vib.pick|' || vi.vendor_no || '|' || vi.item_no)
  ) r;

  -- The receipts. Between one and eleven per vendor and part over the last
  -- three years, so most parts have enough history for the observed figure
  -- and some deliberately do not: a part with two receipts has to fall back
  -- to the quote, and that branch needs data to prove it.
  insert into nl.purchase_receipts (document_no, line_no, vendor_no, item_no,
                                    ordered_on, promised_on, received_on, quantity, unit_cost)
  select
    'PO1' || lpad(((row_number() over (order by d.vendor_no, d.item_no, d.n)) + 40000)::text, 6, '0'),
    1,
    d.vendor_no,
    d.item_no,
    d.ordered_on,
    -- What they committed to on the line. Usually the quote; about a third of
    -- the time they add a bit because they already know they are behind,
    -- which is why committed is its own thing and not the quote again.
    d.ordered_on + d.quoted_days
      + case when nl_seed.chance(0.35, 'pr.commit|' || d.vendor_no || '|' || d.item_no || '|' || d.n)
             then nl_seed.ri(3, 15, 'pr.slack|' || d.vendor_no || '|' || d.item_no || '|' || d.n)
             else 0 end,
    d.ordered_on + d.actual_days,
    d.quantity,
    d.unit_cost
  from (
    select
      vi.vendor_no,
      vi.item_no,
      g.n,
      vi.quoted_lead_days as quoted_days,
      -- Spread the orders back over three years, newest first.
      v_today - nl_seed.ri(12, 1080, 'pr.when|' || vi.vendor_no || '|' || vi.item_no || '|' || g.n)
        as ordered_on,
      -- What actually happened: the median for this pair, plus a one-sided
      -- tail scaled by the vendor's habit. u^3 keeps most receipts near the
      -- median and sends a few a long way past it, which is the shape a real
      -- late delivery has.
      greatest(1, round(
        med.days
        * (1 + h.tail * power(nl_seed.u('pr.tail|' || vi.vendor_no || '|' || vi.item_no || '|' || g.n), 3))
        + nl_seed.gauss(0, 1.2, 'pr.jitter|' || vi.vendor_no || '|' || vi.item_no || '|' || g.n)
      )::int) as actual_days,
      greatest(vi.min_order_qty,
               vi.order_multiple * nl_seed.ri(1, 8, 'pr.qty|' || vi.vendor_no || '|' || vi.item_no || '|' || g.n))
        as quantity,
      coalesce(vi.unit_cost, 1.00) as unit_cost
    from nl.vendor_items vi
    join vendor_habit h on h.vendor_no = vi.vendor_no
    cross join lateral (
      -- The typical figure for this pair: a bit either side of the quote, so
      -- the quote and the observed median are not the same number.
      select greatest(2, round(vi.quoted_lead_days
                               * (0.95 + 0.25 * nl_seed.u('pr.med|' || vi.vendor_no || '|' || vi.item_no)))::int) as days
    ) med
    cross join lateral (
      -- Most pairs have enough history to trust; about one in six does not.
      select case when nl_seed.chance(0.17, 'pr.thin|' || vi.vendor_no || '|' || vi.item_no)
                  then nl_seed.ri(1, 3, 'pr.few|' || vi.vendor_no || '|' || vi.item_no)
                  else nl_seed.ri(5, 11, 'pr.many|' || vi.vendor_no || '|' || vi.item_no)
             end as receipts
    ) k
    cross join lateral generate_series(1, k.receipts) as g(n)
    where vi.quoted_lead_days is not null
      -- Only the source we actually buy from has a receipt history worth
      -- having; an alternate is a quote and nothing else, which is exactly
      -- why the promise rule has a 'quoted' branch.
      and (vi.is_primary or nl_seed.chance(0.15, 'pr.alt|' || vi.vendor_no || '|' || vi.item_no))
  ) d;

  drop table if exists pg_temp.vendor_habit;

  drop table if exists pg_temp.sheet_gen;
  drop table if exists pg_temp.sheet_step;
  drop table if exists pg_temp.ladder_part;
end $$;

revoke execute on function nl_seed.extra_90_pricing_depth() from public;
