-- The policy engine's world: the catalog, the company-wide values that match
-- what the code used to have written in, and a believable spread of
-- exceptions with the reason each one was made.
--
-- Two things happen here, in this order.
--
-- 1. The catalog is loaded again. nl.policy_types and nl.data_dictionary are
--    reference data, not invented data, and they live in migration 0034 so a
--    database built from migrations alone is complete. But nl.reset()
--    truncates every table in schema nl, and the nightly job calls it, so the
--    rows have to be put back after every rebuild. nl.load_policy_catalog()
--    is the same function the migration calls, and it is idempotent.
--
-- 2. Policies are set. The company-wide rows deliberately repeat the numbers
--    that were hard-coded before 0034, because the point of the first release
--    of an engine like this is that nothing changes: the pipeline does not
--    reprice, freight does not move, quotes hold for the same month. The
--    exceptions on top are what the engine is for, and each one carries the
--    sentence a person would have said.
--
-- Two of them have already expired, which is how the effective-date logic
-- shows up on screen without anybody having to imagine it, and one account
-- has two rows at the same scope on the same day so priority has something
-- to settle.
--
-- Accounts and parts are chosen by what they are rather than by name (the
-- ones that collect on their own carrier account, the two with the most open
-- order value, the pipe family), so the same story comes out at every world
-- size.
create or replace function nl_seed.extra_90_policies() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set        nl_seed.settings;
  v_today      date;
  v_history    date;   -- where the invented history starts
  v_march      date;   -- the first of the month six months back, for "since March"
  v_admin      int := 1;   -- Elena Brooks, admin
  v_manager    int := 2;   -- Dana Whitlock, account manager
  v_operations int := 5;   -- Priya Raman, operations
begin
  perform nl.load_policy_catalog();

  select * into v_set from nl_seed.settings;
  v_today   := nl.today();
  v_history := pg_catalog.make_date(v_set.first_year, 1, 1);
  v_march   := (pg_catalog.date_trunc('month', v_today) - interval '6 months')::date;

  -- -------------------------------------------------------------------------
  -- 1. The company-wide rows: the numbers that used to be written in
  -- -------------------------------------------------------------------------

  -- The free freight threshold, one row per tariff period, with the same
  -- dates and the same figures the tariff has. nl.freight_for() reads the
  -- policy first and the tariff only when no policy matches, so this makes
  -- the engine the source of the number without changing the number.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select
    'freight.free_over', 'global', '',
    pg_catalog.to_jsonb(p.free_over),
    p.effective_from,
    (pg_catalog.lead(p.effective_from) over (order by p.effective_from)) - 1,
    0,
    'Set with the freight tariff of the day: ' || p.note,
    null
  from nl.freight_periods p;

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  values
    ('freight.terms', 'global', '', '"prepaid and add"', v_history, null, 0,
     'What the price sheet has always said: we pay the carrier and the freight goes on the invoice.',
     v_operations),
    ('commercial.min_margin', 'global', '', '0.20', v_history, null, 0,
     'A fifth is where a line stops paying for the order desk, the pick, the pack and the freight it rides on.',
     v_admin),
    ('commercial.quote_valid_days', 'global', '', '30', v_history, null, 0,
     'Thirty days is what the quote form has always said.',
     v_admin),
    ('commercial.payment_terms', 'global', '', '"net 30"', v_history, null, 0,
     'Standard terms on the price sheet. Anything else is agreed account by account.',
     v_admin),
    ('fulfilment.min_order_value', 'global', '', '250', v_history, null, 0,
     'Under this the order desk asks the buyer to add to the order rather than ship it.',
     v_operations);

  -- -------------------------------------------------------------------------
  -- 2. Freight: the accounts that do not work the standard way
  -- -------------------------------------------------------------------------

  -- Every account that collects on its own carrier account. This is the
  -- question that started the engine off: whether the customer pays the
  -- freight or we do, and it was a boolean on the customer card with nothing
  -- reading it.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'freight.terms', 'customer', c.customer_no, '"collect"', v_march, null, 0,
         'They collect on their own carrier account, so nothing rides on our bill.',
         v_operations
  from nl.customers c
  where c.ships_own_carrier
    and not c.closed;

  -- Free freight from a thousand for the two biggest accounts in the book.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'freight.free_over', 'customer', t.customer_no, '1000', v_march, null, 0,
         'Agreed at the 2026 price review: free freight from a thousand, in exchange for ordering to a cadence.',
         v_manager
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    limit 2
  ) t;

  -- An account with no dock. Nothing reads this yet, and it is here because a
  -- freight quote that forgets the liftgate is wrong by forty dollars every
  -- time.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'freight.accessorials', 'customer', t.customer_no,
         '["liftgate", "appointment"]', v_march, null, 0,
         'No dock at their shop: every delivery needs a liftgate and a booked time.',
         v_operations
  from (
    select c.customer_no from nl.customers c
    where not c.closed and not c.blocked
    order by c.customer_no desc
    limit 1
  ) t;

  -- -------------------------------------------------------------------------
  -- 3. Commercial: terms, quote validity and the margin floor
  -- -------------------------------------------------------------------------

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.payment_terms', 'customer', t.customer_no, '"net 45"',
         v_march, null, 0,
         'Net 45 agreed with their controller when they moved to a standing monthly order.',
         v_admin
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    limit 1
  ) t;

  -- Any account we have stopped for credit pays before it ships.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.payment_terms', 'customer', c.customer_no, '"prepaid"',
         v_march, null, 0,
         'Prepaid until the account is current again.',
         v_admin
  from nl.customers c
  where c.blocked and not c.closed
  order by c.customer_no
  limit 2;

  -- A buyer who works to a fortnight, and a whole tier that plans a quarter
  -- ahead. Both are read by nl.approve_rfq_draft().
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.quote_valid_days', 'customer', t.customer_no, '14', v_march, null, 0,
         'Their buyer works to a fortnight, and anything older gets requoted anyway.',
         v_manager
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    offset 2 limit 1
  ) t;

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.quote_valid_days', 'customer_segment', g.code, '60', v_march, null, 0,
         'Master distributors plan a quarter at a time, so a month is not long enough to be useful.',
         v_admin
  from nl.price_groups g
  where g.code = 'MASTER';

  -- The margin floor by part family. Pipe is the best margin in the book and
  -- raw material sold to fabrication shops is the thinnest, so one number for
  -- both was always wrong.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.min_margin', 'item_family', f.family,
         case f.family when 'pipe' then '0.32'::jsonb else '0.12'::jsonb end,
         v_march, null, 0,
         case f.family
           when 'pipe' then 'Pipe carries the best margin in the book and is not discounted into the ground.'
           else 'Raw tube and sheet sold to fabrication shops carries about a third of the book margin.'
         end,
         v_admin
  from (select distinct i.family from nl.items i where i.family in ('pipe', 'raw')) f;

  -- -------------------------------------------------------------------------
  -- 4. Fulfilment: who gets stock first
  -- -------------------------------------------------------------------------

  -- The priority list, as data. The two accounts with the most open order
  -- value go in front of the ship date, and the whole Elite tier goes in
  -- front of everybody with no priority at all.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'fulfilment.allocation_priority', 'customer', t.customer_no,
         pg_catalog.to_jsonb(t.rank), v_march, null, 0,
         case t.seat
           when 1 then 'Their fleet is down when a part is short, and they call the plant when it is.'
           else 'Second on the priority list since the spring review.'
         end,
         v_operations
  from (
    select
      a.customer_no,
      pg_catalog.row_number() over (order by a.open_value desc, a.customer_no) as seat,
      case pg_catalog.row_number() over (order by a.open_value desc, a.customer_no)
        when 1 then 80 else 60 end as rank
    from (
      select l.customer_no, pg_catalog.sum(l.quantity * l.unit_price) as open_value
      from nl.open_order_lines l
      group by l.customer_no
    ) a
    order by a.open_value desc, a.customer_no
    limit 2
  ) t;

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'fulfilment.allocation_priority', 'customer_segment', g.code, '30', v_march, null, 0,
         'The Elite tier buys to a cadence and expects the cadence to be met.',
         v_operations
  from nl.price_groups g
  where g.code = 'ELITE';

  -- An account whose dock books one delivery per order.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'fulfilment.split_shipments', 'customer', t.customer_no, 'false', v_march, null, 0,
         'Their dock books one delivery against one order, so a part shipment is refused at the gate.',
         v_operations
  from (
    select c.customer_no from nl.customers c
    where not c.closed and not c.blocked
    order by c.customer_no
    limit 1
  ) t;

  -- Clamps are boxed in tens, so a quantity of 14 is really 20.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'fulfilment.order_multiple', 'item_family', 'clamp', '10', v_history, null, 0,
         'Clamps come from the supplier boxed in tens and are not split.',
         v_operations
  where exists (select 1 from nl.items i where i.family = 'clamp');

  -- -------------------------------------------------------------------------
  -- 5. Quality and operations
  -- -------------------------------------------------------------------------

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'quality.required_documents', 'customer', t.customer_no,
         '["packing list", "certificate of conformance", "material test report"]',
         v_march, null, 0,
         'Their quality team will not receive a pallet without the paperwork on it.',
         v_operations
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    offset 1 limit 1
  ) t;

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'quality.required_documents', 'item_family', 'raw',
         '["packing list", "domestic melt"]', v_history, null, 0,
         'A domestic melt certificate travels with raw material or the buyer cannot use it.',
         v_operations
  where exists (select 1 from nl.items i where i.family = 'raw');

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'operations.target_days_of_cover', 'location', l.code, '45', v_march, null, 0,
         'The west coast forward stock is five days from the plant, so it holds more.',
         v_operations
  from nl.locations l
  where l.code = 'WEST';

  -- -------------------------------------------------------------------------
  -- 6. Two that have already expired
  -- -------------------------------------------------------------------------

  -- A promotion that ended with the year. It is kept rather than deleted
  -- because it is the answer to "why did we quote them free freight in
  -- November".
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'freight.free_over', 'customer', t.customer_no, '800',
         pg_catalog.make_date(v_set.last_year - 1, 4, 1),
         pg_catalog.make_date(v_set.last_year - 1, 12, 31),
         0,
         'A promotion for the 2025 season. It ended with the year and is kept so an old quote still makes sense.',
         v_manager
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    offset 3 limit 1
  ) t
  where v_set.last_year - 1 >= v_set.first_year;

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.quote_valid_days', 'customer', t.customer_no, '7',
         (v_today - 400)::date, (v_today - 60)::date, 0,
         'Held to a week while steel moved every fortnight. Back to the standard month since.',
         v_manager
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    offset 4 limit 1
  ) t;

  -- -------------------------------------------------------------------------
  -- 7. One account with two rows on the same day, for priority to settle
  -- -------------------------------------------------------------------------

  -- Both are about the same account, the same policy and the same date. The
  -- standing floor is the one anybody would expect; the lower one carries a
  -- priority because it was agreed above it, for a programme with an end in
  -- sight. Without priority, "the newest row wins" would make the answer
  -- depend on which was typed second, which is not a rule anybody can hold in
  -- their head.
  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.min_margin', 'customer', t.customer_no, '0.24', v_march, null, 0,
         'The standing floor for this account, set when they moved up a tier.',
         v_admin
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    offset 5 limit 1
  ) t;

  insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from,
                           effective_to, priority, note, set_by)
  select 'commercial.min_margin', 'customer', t.customer_no, '0.18', v_march, null, 10,
         'Agreed above the standing floor while the chrome programme runs, to hold the volume.',
         v_admin
  from (
    select l.customer_no
    from nl.invoice_lines l
    where l.posted_on > v_today - 365
    group by l.customer_no
    order by pg_catalog.sum(l.amount) desc, l.customer_no
    offset 5 limit 1
  ) t;
end $$;
