-- The Northline world, built inside the database.
--
--   select nl.reset();                   empty every table in schema nl
--   select nl.build();                   build the full world, dated relative to today
--   select nl.build('small');            a smaller world, for tests
--   select nl.answer_pushed_windows();   what the nightly job does next
--
-- Everything here is invented: the company, its people, its customers, its
-- parts and every dollar. Names come from word lists; a match with a real
-- business is a coincidence. Email addresses use the reserved .example domain.
--
-- Randomness is keyed, not sequential. Every draw is a hash of a label, for
-- example 'qty|1104|L590-1818C|7', so the same label always gives the same
-- number, in any order, on any Postgres 17. Supabase and the local PGlite
-- database therefore build the same world. Only the dates move with the
-- calendar (the world is always "as of today").
--
-- This file is not a migration: it creates helpers in schema nl_seed and the
-- two entry points nl.reset() and nl.build(). Run it after the migrations.

create schema if not exists nl_seed;
revoke all on schema nl_seed from public;

-- ---------------------------------------------------------------------------
-- Keyed randomness
-- ---------------------------------------------------------------------------

-- A number in [0, 1) that depends only on the key: the top 53 bits of a
-- 64-bit hash, scaled.
create or replace function nl_seed.u(p_key text) returns double precision
language sql immutable parallel safe
as $$
  select ((hashtextextended(p_key, 20260918) >> 11) & 9007199254740991)::double precision
         / 9007199254740992
$$;

create or replace function nl_seed.ri(p_lo int, p_hi int, p_key text) returns int
language sql immutable parallel safe
as $$ select p_lo + floor(nl_seed.u(p_key) * (p_hi - p_lo + 1))::int $$;

create or replace function nl_seed.chance(p_probability double precision, p_key text) returns boolean
language sql immutable parallel safe
as $$ select nl_seed.u(p_key) < p_probability $$;

create or replace function nl_seed.pick(p_options text[], p_key text) returns text
language sql immutable parallel safe
as $$ select p_options[1 + floor(nl_seed.u(p_key) * cardinality(p_options))::int] $$;

-- A draw from a normal distribution (Box-Muller, two keyed uniforms).
create or replace function nl_seed.gauss(p_mean double precision, p_sd double precision, p_key text)
returns double precision
language sql immutable parallel safe
as $$
  select p_mean + p_sd
         * sqrt(-2 * ln(1 - nl_seed.u(p_key || '|a')))
         * cos(2 * pi() * nl_seed.u(p_key || '|b'))
$$;

create or replace function nl_seed.person(p_key text) returns text
language sql immutable parallel safe
as $$
  select nl_seed.pick(array['Alex','Jamie','Morgan','Taylor','Chris','Pat','Casey','Drew','Riley','Robin','Sydney',
                            'Terry','Dale','Kim','Lee','Shawn','Tracy','Jesse','Blake','Avery','Reese','Quinn'], p_key || '|first')
         || ' ' ||
         nl_seed.pick(array['Alvarez','Brennan','Castillo','Dawson','Ellison','Foster','Garza','Holloway','Ibarra',
                            'Jennings','Keller','Lindqvist','Moreno','Navarro','Okafor','Pruitt','Quintero','Reyes',
                            'Sandoval','Tanaka','Underwood','Vasquez','Whitfield','Yates','Zimmerman'], p_key || '|last')
$$;

create or replace function nl_seed.phone(p_key text) returns text
language sql immutable parallel safe
as $$ select '(' || nl_seed.ri(200, 989, p_key || '|area') || ') 555-' || lpad(nl_seed.ri(100, 9999, p_key || '|line')::text, 4, '0') $$;

create or replace function nl_seed.slug(p_text text) returns text
language sql immutable parallel safe
as $$ select lower(regexp_replace(p_text, '[^A-Za-z0-9]+', '', 'g')) $$;

-- Which agency sells to a customer (null is a house account), and who owns it.
create or replace function nl_seed.agency_for(p_key text) returns int
language sql immutable parallel safe
as $$
  select case
    when nl_seed.u(p_key || '|agency') < 0.42 then null
    when nl_seed.u(p_key || '|agency') < 0.66 then 1
    when nl_seed.u(p_key || '|agency') < 0.86 then 2
    else 3
  end
$$;

create or replace function nl_seed.owner_for(p_key text) returns int
language sql immutable parallel safe
as $$ select (array[1, 2, 3, 4])[nl_seed.ri(1, 4, p_key || '|owner')] $$;

-- ---------------------------------------------------------------------------
-- The generator's own bookkeeping. The app never reads these.
-- ---------------------------------------------------------------------------

create table if not exists nl_seed.customer_plan (
  customer_no text primary key,
  seq         int not null,
  kind        text not null,      -- hq, branch, independent, international
  size        text not null,      -- A (biggest) to D
  lifecycle   text not null       -- steady, new, growing, slipping, dormant, churned
);

create table if not exists nl_seed.item_plan (
  item_no  text primary key,
  qty_low  int not null,          -- a typical order line, low and high
  qty_high int not null
);

-- Every part a customer buys, and the rhythm they buy it on.
create table if not exists nl_seed.baskets (
  customer_no text not null,
  item_no     text not null,
  cadence     text not null,      -- clockwork, predictable, random, oneoff
  mean_gap    int not null,       -- days between orders
  sd_gap      double precision not null,
  first_day   date not null,
  last_day    date not null,
  primary key (customer_no, item_no)
);

create table if not exists nl_seed.ship_lines (
  customer_no text not null,
  item_no     text not null,
  step        int not null,
  day         date not null,
  qty         int not null,
  unit_price  numeric(12, 2) not null,
  amount      numeric(12, 2) not null,
  primary key (customer_no, item_no, step)
);

create table if not exists nl_seed.shipments (
  customer_no text not null,
  day         date not null,
  seq         int not null,
  total       numeric(12, 2) not null,
  primary key (customer_no, day)
);

create table if not exists nl_seed.eligible (
  customer_no text primary key,
  pick_order  int not null,
  taken       boolean not null default false
);

-- ---------------------------------------------------------------------------
-- Small helpers the commitment section uses
-- ---------------------------------------------------------------------------

-- A customer and every account billed to it.
create or replace function nl_seed.family(p_customer text) returns setof text
language sql stable
set search_path = ''
as $$
  select customer_no from nl.customers
  where customer_no = p_customer or bill_to_no = p_customer
$$;

-- What the family bought of these parts between two dates.
create or replace function nl_seed.family_delivered(p_customer text, p_items text[], p_from date, p_to date)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce(sum(il.amount), 0)
  from nl.invoice_lines il
  where il.customer_no in (select nl_seed.family(p_customer))
    and il.item_no = any (p_items)
    and il.posted_on between p_from and p_to
$$;

-- Parts the family shipped between two dates, in a keyed order.
create or replace function nl_seed.family_items(p_customer text, p_from date, p_to date, p_key text)
returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(x.item_no order by nl_seed.u(p_key || '|' || x.item_no)), '{}')
  from (
    select distinct il.item_no
    from nl.invoice_lines il
    where il.customer_no in (select nl_seed.family(p_customer))
      and il.posted_on between p_from and p_to
  ) x
$$;

-- Sellable parts the family has never bought, in a keyed order.
create or replace function nl_seed.new_items(p_customer text, p_family text, p_key text)
returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(i.item_no order by nl_seed.u(p_key || '|' || i.item_no)), '{}')
  from nl.items i
  where not i.made_to_order and not i.proprietary and not i.blocked
    and (p_family is null or i.family = p_family)
    and not exists (
      select 1 from nl.invoice_lines il
      where il.item_no = i.item_no
        and il.customer_no in (select nl_seed.family(p_customer)))
$$;

-- A commitment title that fits its parts: named after the family most of
-- them belong to.
create or replace function nl_seed.title_for(p_items text[], p_key text) returns text
language sql stable
set search_path = ''
as $$
  select coalesce((
    select case f.family
      when 'elbow' then 'Fleet elbow restock'
      when 'stack' then nl_seed.pick(array['Chrome stack program', 'Turnout stacks for the west yard'], p_key || '|title')
      when 'pipe' then 'Q4 pipe stocking order'
      when 'muffler' then 'Muffler line changeover'
      when 'clamp' then 'Clamp standing order'
      when 'flex' then 'Flex pipe consolidation'
      when 'shield' then 'Heat shield retrofit'
      when 'kit' then 'Dual stack kits for the new lot'
      when 'custom' then 'Custom Y-pipe build'
      when 'bracket' then 'Rain cap and bracket restock'
      when 'proprietary' then 'Proprietary adapter program'
    end
    from (
      select i.family
      from unnest(p_items) with ordinality as x(item_no, n)
      join nl.items i on i.item_no = x.item_no
      group by i.family
      order by count(*) desc, min(x.n)
      limit 1
    ) f), 'Parts program')
$$;

-- The price this customer pays for a part.
create or replace function nl_seed.net_price(p_customer text, p_item text) returns numeric
language sql stable
set search_path = ''
as $$
  select round(i.list_price * (1 - pg.discount), 2)
  from nl.items i, nl.customers c
  join nl.price_groups pg on pg.code = c.price_group
  where i.item_no = p_item and c.customer_no = p_customer
$$;

create or replace function nl_seed.add_commitment(
  p_customer   text,
  p_title      text,
  p_value      numeric,
  p_starts_on  date,
  p_ends_on    date,
  p_confidence int,
  p_items      text[],
  p_quantities int[],
  p_with_buyer boolean default true
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_owner int;
  v_buyer bigint;
  v_id    bigint;
begin
  select coalesce(owner_id, 1) into v_owner from nl.customers where customer_no = p_customer;
  if p_with_buyer then
    select id into v_buyer from nl.contacts
    where customer_no = p_customer
    order by is_primary desc, id
    limit 1;
  end if;

  insert into nl.commitments (title, customer_no, buyer_contact_id, owner_id, committed_value,
                              starts_on, ends_on, confidence, created_by, created_at)
  values (p_title, p_customer, v_buyer, v_owner, p_value, p_starts_on, p_ends_on, p_confidence, v_owner,
          (p_starts_on + time '09:30') at time zone 'America/Chicago')
  returning id into v_id;

  insert into nl.commitment_items (commitment_id, item_no, quantity)
  select v_id, x.item_no, p_quantities[x.n]
  from unnest(p_items) with ordinality as x(item_no, n);

  return v_id;
end $$;

create or replace function nl_seed.add_quote(
  p_customer      text,
  p_commitment_id bigint,
  p_quoted_on     date,
  p_items         text[],
  p_quantities    int[]
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_owner   int;
  v_contact bigint;
  v_id      bigint;
begin
  select coalesce(owner_id, 1) into v_owner from nl.customers where customer_no = p_customer;
  select id into v_contact from nl.contacts
  where customer_no = p_customer
  order by is_primary desc, id
  limit 1;

  insert into nl.quotes (customer_no, contact_id, commitment_id, quoted_on, valid_until, source, created_by, created_at)
  values (p_customer, v_contact, p_commitment_id, p_quoted_on, p_quoted_on + 30, 'seed', v_owner,
          (p_quoted_on + time '14:00') at time zone 'America/Chicago')
  returning id into v_id;

  insert into nl.quote_lines (quote_id, line_no, item_no, quantity, unit_price)
  select v_id, x.n, x.item_no, p_quantities[x.n], nl_seed.net_price(p_customer, x.item_no)
  from unnest(p_items) with ordinality as x(item_no, n);

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- nl.reset()
-- ---------------------------------------------------------------------------

create or replace function nl.reset() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_tables text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename)
    into v_tables
  from pg_tables
  where schemaname in ('nl', 'nl_seed');
  if v_tables is not null then
    execute 'truncate table ' || v_tables || ' restart identity cascade';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- nl.build()
-- ---------------------------------------------------------------------------

create or replace function nl.build(p_size text default 'full') returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_today   date := nl.today();
  v_year    int  := extract(year from nl.today())::int;
  v_small   boolean;
  v_history date;       -- first day of the invoice history
  v_lines_from date;    -- first day the line-level export reaches back to

  v_regions text[] := array['Amarillo','Bayou','Big Sky','Cascade','Prairie','Gulf Coast','High Plains','Ironhorse',
    'Panhandle','Red River','Rio Grande','Rocky Mountain','Sandhills','Sooner','Timberline','Tidewater','Yellowstone',
    'Ozark','Piney Woods','Blue Ridge','Great Basin','Copper State','Badlands','Cimarron','Brazos','Pecos','Wasatch',
    'Bitterroot','Sabine','Palo Duro','Llano','Caprock','Sangre','Front Range','Snake River','Four Corners','Permian',
    'Trinity','Guadalupe','Sierra'];
  v_kinds text[] := array['Truck Parts','Diesel Supply','Fleet Service','Chrome & Stack','Truck Center',
    'Heavy Duty Parts','Trailer & Truck','Freight Systems','Truck Repair','Equipment Co.'];
  v_cities text[] := array['Amarillo|TX','Lubbock|TX','Odessa|TX','Laredo|TX','Beaumont|TX','Tyler|TX','El Paso|TX',
    'Corpus Christi|TX','Tulsa|OK','Lawton|OK','Shreveport|LA','Lafayette|LA','Fort Smith|AR','Texarkana|AR',
    'Denver|CO','Grand Junction|CO','Billings|MT','Missoula|MT','Boise|ID','Spokane|WA','Yakima|WA','Medford|OR',
    'Reno|NV','Salt Lake City|UT','Casper|WY','Albuquerque|NM','Phoenix|AZ','Fresno|CA','Bakersfield|CA',
    'Toledo|OH','Akron|OH','Erie|PA','Gary|IN','Rockford|IL','Green Bay|WI','Des Moines|IA','Omaha|NE',
    'Sioux Falls|SD','Fargo|ND','Jacksonville|FL','Mobile|AL','Chattanooga|TN','Kansas City|MO'];
  v_tiers text[] := array['DEALER','DEALER','DEALER','DEALER','PERFORMANC','PERFORMANC','PERFORMANC',
    'JOBBER','JOBBER','ELITE'];
  v_titles text[] := array['Parts Manager','Purchasing','Owner','General Manager','Buyer','Service Manager',
    'Counter Lead','Operations Manager'];
  v_notes text[] := array['Spoke with purchasing; they are consolidating vendors this quarter.',
    'Chrome demand is up with their new fleet contract.',
    'Asked for lead times on 8 inch stacks before they commit.',
    'Prefers email over calls before 10am.',
    'Wants a standing order for clamps, monthly.',
    'Their counter lead is new; send the catalog.',
    'Lost a muffler bid to a competitor on price, not quality.',
    'Expanding the service bays; expect more pipe next year.'];
  v_call_notes text[] := array['Went over open backorders.', 'Sent the updated price sheet.',
    'Asked for the Q4 forecast.', 'Left a message about the chrome lead time.',
    'Stopped by with the new catalog.'];
  v_steps text[] := array['Follow up on the chrome quote','Confirm the Q4 stack forecast','Send updated tier pricing',
    'Set up a plant visit','Ask about the new location','Review open backorders with purchasing',
    'Get the drawing for the custom Y-pipe','Check in on the muffler program','Book the counter-day training',
    'Close the loop on the freight claim'];
  v_due_days int[] := array[-9, -4, -2, -1, 0, 0, 1, 2, 3, 5, 8, 12, 20, 35, 60];

  v_next     int := 1101;
  v_key      text;
  v_row      record;
  v_branch   text;
  v_hq       text;
  v_agency   int;
  v_owner    int;
  v_tier     text;
  v_carrier  boolean;
  v_since    date;
  v_count    int;
  v_new      int;
  v_life     text;

  -- commitments
  v_quota    int;
  v_made     int;
  v_items    text[];
  v_qtys     int[];
  v_value    numeric;
  v_delivered numeric;
  v_start    date;
  v_end      date;
  v_id       bigint;
  v_n        int;
  v_result   jsonb;
begin
  if p_size is null or p_size not in ('full', 'small') then
    raise exception 'nl.build() takes ''full'' or ''small'', not %.', coalesce(p_size, 'null');
  end if;
  if exists (select 1 from nl.users) then
    raise exception 'nl.build() needs an empty schema. Run nl.reset() first.';
  end if;

  v_small := p_size = 'small';
  v_history := case when v_small then v_today - 430 else make_date(v_year - 3, 1, 3) end;
  -- Like the real exports: invoices go back three years and a bit, invoice
  -- lines only to January of the year before last.
  v_lines_from := case when v_small then v_history else make_date(v_year - 2, 1, 2) end;

  -- The people --------------------------------------------------------------
  insert into nl.users (id, email, full_name, title, role, active) values
    (1, 'elena.brooks@northline.example',  'Elena Brooks',  'Sales Director',  'admin',           true),
    (2, 'dana.whitlock@northline.example', 'Dana Whitlock', 'Account Manager', 'account_manager', true),
    (3, 'marcus.bell@northline.example',   'Marcus Bell',   'Account Manager', 'account_manager', true),
    (4, 'sam.ortiz@northline.example',     'Sam Ortiz',     'Account Manager', 'account_manager', true),
    (5, 'priya.raman@northline.example',   'Priya Raman',   'Operations Lead', 'operations',      true),
    (6, 'jordan.pike@northline.example',   'Jordan Pike',   'Order Desk',      'operations',      true),
    (7, 'terry.vance@northline.example',   'Terry Vance',   'Account Manager (no longer with the company)', 'account_manager', false);

  insert into nl.agencies (id, code, name, territory) values
    (1, '410', 'Summit Rep Group',           'Texas and the Gulf'),
    (2, '520', 'Ridgeline Sales Associates', 'Mountain West'),
    (3, '630', 'Bluewater Marketing',        'Great Lakes and Canada');

  insert into nl.price_groups (code, label, discount) values
    ('JOBBER',     'Jobber',      0.29),
    ('DEALER',     'Dealer',      0.44),
    ('PERFORMANC', 'Performance', 0.48),
    ('ELITE',      'Elite',       0.523);

  insert into nl.vendors (vendor_no, name, city, state, lead_time) values
    ('V1010', 'Lakeshore Plating Co.',    'Sandusky',     'OH', '3W'),
    ('V1020', 'Midland Tube & Steel',     'Toledo',       'OH', '2W'),
    ('V1030', 'Cardinal Clamp Co.',       'Erie',         'PA', '4W'),
    ('V1040', 'Northstar Flex Products',  'Duluth',       'MN', '6W'),
    ('V1050', 'Great Lakes Muffler Mfg',  'Grand Rapids', 'MI', '5W'),
    ('V1060', 'Summit Fasteners',         'Akron',        'OH', '2W'),
    ('V1070', 'Buckeye Stamping',         'Columbus',     'OH', '4W'),
    ('V1080', 'Harbor Packaging Supply',  'Cleveland',    'OH', '1W'),
    ('V1090', 'Pioneer Heat Shield',      'Fort Wayne',   'IN', '3W'),
    ('V1100', 'Keystone Rubber & Gasket', 'Scranton',     'PA', '2W');

  -- Customers ---------------------------------------------------------------
  -- Chains: the head office is its own customer, and its branches bill to it.
  for v_row in
    select * from (values
      (1, 'TruckSource', 'Dallas', 'TX',
          array['Houston|TX','San Antonio|TX','Oklahoma City|OK','Tulsa|OK','Little Rock|AR','Shreveport|LA']),
      (2, 'Fleetline Parts', 'Denver', 'CO',
          array['Salt Lake City|UT','Albuquerque|NM','Cheyenne|WY','Billings|MT']),
      (3, 'Lone Star Truck Centers', 'Fort Worth', 'TX',
          array['Waco|TX','Abilene|TX','Lubbock|TX'])
    ) as t(n, chain, city, state, branches)
    where not v_small or t.n = 1
    order by t.n
  loop
    v_key := 'chain|' || v_row.n;
    v_agency := nl_seed.agency_for(v_key);
    v_owner := nl_seed.owner_for(v_key);
    v_tier := nl_seed.pick(v_tiers, v_key || '|tier');
    v_carrier := nl_seed.chance(0.5, v_key || '|carrier');
    v_hq := v_next::text;
    insert into nl.customers (customer_no, name, bill_to_no, city, state, country, email_domain, price_group,
                              ships_own_carrier, owner_id, agency_id, customer_since)
    values (v_hq, v_row.chain || ' - ' || v_row.city, null, v_row.city, v_row.state, 'US',
            nl_seed.slug(v_row.chain) || '.example', v_tier, v_carrier, v_owner, v_agency,
            v_history - nl_seed.ri(400, 3000, v_key || '|since'));
    insert into nl_seed.customer_plan values (v_hq, v_next, 'hq', 'A', 'steady');
    v_next := v_next + 1;

    v_n := 0;
    foreach v_branch in array v_row.branches loop
      v_n := v_n + 1;
      exit when v_small and v_n > 3;
      insert into nl.customers (customer_no, name, bill_to_no, city, state, country, email_domain, price_group,
                                ships_own_carrier, owner_id, agency_id, customer_since)
      values (v_next::text, v_row.chain || ' - ' || split_part(v_branch, '|', 1), v_hq,
              split_part(v_branch, '|', 1), split_part(v_branch, '|', 2), 'US',
              nl_seed.slug(v_row.chain) || '.example', v_tier, v_carrier, v_owner, v_agency,
              v_history - nl_seed.ri(60, 1500, v_key || '|branch|' || v_n || '|since'));
      insert into nl_seed.customer_plan
      values (v_next::text, v_next, 'branch',
              nl_seed.pick(array['B','B','C'], v_key || '|branch|' || v_n || '|size'), 'steady');
      v_next := v_next + 1;
    end loop;
  end loop;

  -- Independents. Names are region + kind pairs taken in a keyed order, so
  -- they never repeat. Their place in that order decides their life stage:
  -- a few gone quiet, a few lost, a few slipping or growing, two blocked,
  -- two closed, a few nobody owns yet, and the newest few just started.
  v_count := case when v_small then 24 else 52 end;
  v_new := case when v_small then 2 else 5 end;
  for v_row in
    select row_number() over (order by nl_seed.u('indep.name|' || r || '|' || k)) as i,
           r || ' ' || k as name
    from unnest(v_regions) as r, unnest(v_kinds) as k
    order by nl_seed.u('indep.name|' || r || '|' || k)
    limit v_count
  loop
    v_key := 'indep|' || v_row.i;
    v_life := case
      when v_row.i > v_count - v_new then 'new'
      when v_small then case v_row.i when 1 then 'dormant' when 2 then 'churned' when 3 then 'slipping'
                                     when 4 then 'growing' when 6 then 'churned' else 'steady' end
      when v_row.i <= 4 then 'dormant'
      when v_row.i <= 8 then 'churned'
      when v_row.i <= 12 then 'slipping'
      when v_row.i <= 16 then 'growing'
      when v_row.i in (19, 20) then 'churned'
      else 'steady'
    end;
    v_since := case when v_life = 'new' then v_today - nl_seed.ri(150, 170, v_key || '|since')
                    else v_history - nl_seed.ri(30, 2000, v_key || '|since') end;
    insert into nl.customers as ins (customer_no, name, city, state, country, email_domain, price_group,
                              ships_own_carrier, blocked, closed, owner_id, agency_id, customer_since)
    values (
      -- New accounts carry newer, higher numbers, the way a real customer master does.
      case when v_life = 'new'
           then (20000 + (v_row.i - (v_count - v_new)) * 113 + nl_seed.ri(0, 90, v_key || '|no'))::text
           else v_next::text end,
      v_row.name,
      split_part(nl_seed.pick(v_cities, v_key || '|city'), '|', 1),
      split_part(nl_seed.pick(v_cities, v_key || '|city'), '|', 2),
      'US',
      nl_seed.slug(v_row.name) || '.example',
      nl_seed.pick(v_tiers, v_key || '|tier'),
      nl_seed.chance(0.3, v_key || '|carrier'),
      -- blocked
      case when v_small then v_row.i = 5 else v_row.i in (17, 18) end,
      -- closed
      case when v_small then v_row.i = 6 else v_row.i in (19, 20) end,
      -- owner: a few accounts nobody owns yet
      case when (v_small and v_row.i in (17, 18)) or (not v_small and v_row.i between 41 and 44) then null
           else nl_seed.owner_for(v_key) end,
      -- a closed account is back to the house
      case when (v_small and v_row.i = 6) or (not v_small and v_row.i in (19, 20)) then null
           else nl_seed.agency_for(v_key) end,
      v_since)
    returning ins.customer_no into v_hq;
    insert into nl_seed.customer_plan
    values (v_hq, 100 + v_row.i::int, 'independent',
            nl_seed.pick(array['A','B','B','C','C','C','D','D'], v_key || '|size'), v_life);
    if v_life <> 'new' then
      v_next := v_next + 1;
    end if;
  end loop;

  -- Canada and Latin America.
  for v_row in
    select * from (values
      (1, 'Northern Fleet Supply', 'Calgary', 'AB', 'CA'),
      (2, 'Kootenay Truck & Trailer', 'Cranbrook', 'BC', 'CA'),
      (3, 'Maple Diesel', 'Winnipeg', 'MB', 'CA'),
      (4, 'Ontario Heavy Duty', 'Mississauga', 'ON', 'CA'),
      -- Outside the US and Canada the state column stays blank: those
      -- countries' regions are not two-letter postal codes, and the app shows
      -- 'City, Country' for them.
      (5, 'Transportes del Norte Refacciones', 'Monterrey', '', 'MX'),
      (6, 'Refacciones Bajío', 'León', '', 'MX'),
      (7, 'Andina Camiones', 'Santiago', '', 'CL'),
      (8, 'Caribe Fleet Parts', 'Bogotá', '', 'CO')
    ) as t(n, name, city, state, country)
    where not v_small or t.n in (1, 5)
    order by t.n
  loop
    v_key := 'intl|' || v_row.n;
    insert into nl.customers (customer_no, name, city, state, country, email_domain, price_group,
                              ships_own_carrier, owner_id, agency_id, customer_since)
    values (v_next::text, v_row.name, v_row.city, v_row.state, v_row.country,
            nl_seed.slug(v_row.name) || '.example',
            nl_seed.pick(array['DEALER','PERFORMANC'], v_key || '|tier'),
            true,
            case when v_row.country = 'CA' then nl_seed.owner_for(v_key) else 1 end,
            case when v_row.country = 'CA' then 3 end,
            v_history - nl_seed.ri(100, 2500, v_key || '|since'));
    insert into nl_seed.customer_plan
    values (v_next::text, 300 + v_row.n, 'international', nl_seed.pick(array['B','C'], v_key || '|size'), 'steady');
    v_next := v_next + 1;
  end loop;

  -- People at each customer. Branches get their branch manager.
  insert into nl.contacts (customer_no, full_name, title, email, phone, is_primary)
  select c.customer_no, p.full_name, p.title,
         lower(replace(p.full_name, ' ', '.')) || '@' || c.email_domain,
         nl_seed.phone('contact.phone|' || c.customer_no || '|' || p.n),
         p.n = 1
  from nl.customers c
  join nl_seed.customer_plan cp on cp.customer_no = c.customer_no
  cross join lateral (
    select g.n,
           nl_seed.person('contact|' || c.customer_no || '|' || g.n) as full_name,
           case when cp.kind = 'branch' then 'Branch Manager'
                else nl_seed.pick(v_titles, 'contact.title|' || c.customer_no || '|' || g.n) end as title
    from generate_series(1, case when cp.kind = 'branch' then 1
                                 else nl_seed.ri(1, 3, 'contacts|' || c.customer_no) end) as g(n)
  ) p
  order by cp.seq, p.n;

  -- Parts -------------------------------------------------------------------
  -- Part numbers follow a grammar (family, diameter, angle, legs, finish) so
  -- a close-sibling search has something to work with. Prices are cost over
  -- one minus the family's list margin.

  -- Elbows: L{diameter}{angle}-{leg a}{leg b}{finish}
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'L' || d.dia || g.deg || '-' || l.la || l.lb || f.fin,
         d.dia || '" ' || g.deg || ' DEG ELBOW ' || l.la || '" X ' || l.lb || '" ' || f.finish,
         'ELBOWS', 'elbow', case when f.chrome then 'CHROME' else 'PIPE' end,
         x.cost, round(x.cost / 0.28, 2), 'Prod. Order',
         case when f.chrome then 'CHROME' else 'BEND CELL' end,
         case when f.chrome then 'V1010' end,
         case when f.chrome then '3W'
              when nl_seed.chance(0.6, 'item.lead|L' || d.dia || g.deg || l.la || l.lb || f.fin) then '1W'
              else '' end
  from (values (4), (5), (6), (7), (8)) as d(dia)
  cross join (values (45), (90)) as g(deg)
  cross join (values (12, 12), (18, 18), (18, 24), (24, 24), (12, 18), (20, 20), (24, 30), (16, 16)) as l(la, lb)
  cross join (values ('A', 'ALUMINIZED', false), ('C', 'CHROME', true),
                     ('SA', 'ALUMINIZED SLIP', false), ('SC', 'CHROME SLIP', true)) as f(fin, finish, chrome)
  cross join lateral (
    select round(((14 + d.dia * 4 + (l.la + l.lb) * 0.35) * case when f.chrome then 1.9 else 1 end)::numeric, 2) as cost
  ) x
  where nl_seed.chance(0.19, 'item.elbow|' || d.dia || '|' || g.deg || '|' || l.la || '|' || l.lb || '|' || f.fin);

  -- Stacks: S{diameter}-{length}{style}{finish}
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'S' || d.dia || '-' || l.len || s.st || f.fin,
         d.dia || '" X ' || l.len || '" ' || s.style || ' STACK ' || f.finish,
         'STACKS', 'stack', case when f.chrome then 'CHROME' else 'PIPE' end,
         x.cost, round(x.cost / 0.30, 2), 'Prod. Order',
         case when f.chrome then 'CHROME' else 'CUT CELL' end,
         case when f.chrome then 'V1010' end,
         case when f.chrome then '3W'
              when nl_seed.chance(0.6, 'item.lead|S' || d.dia || l.len || s.st || f.fin) then '1W'
              else '' end
  from (values (5), (6), (7), (8)) as d(dia)
  cross join (values (36), (48), (60), (72), (84), (96), (108), (120)) as l(len)
  cross join (values ('S', 'STRAIGHT CUT'), ('M', 'MITER CUT'), ('K', 'CURVED'), ('W', 'WEST COAST TURNOUT')) as s(st, style)
  cross join (values ('A', 'ALUMINIZED', false), ('C', 'CHROME', true)) as f(fin, finish, chrome)
  cross join lateral (
    select round(((40 + d.dia * 6 + l.len * 0.9) * case when f.chrome then 1.8 else 1 end)::numeric, 2) as cost
  ) x
  where nl_seed.chance(0.16, 'item.stack|' || d.dia || '|' || l.len || '|' || s.st || '|' || f.fin);

  -- Straight pipe: P{diameter}-{length}A
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'P' || d.dia || '-' || l.len || 'A',
         d.dia || '" X ' || l.len || '" STRAIGHT PIPE ALUMINIZED',
         'PIPE', 'pipe', 'PIPE', x.cost, round(x.cost / 0.22, 2), 'Prod. Order', 'CUT CELL', null, '1W'
  from (values (3), (4), (5), (6)) as d(dia)
  cross join (values (24), (36), (48), (60), (120)) as l(len)
  cross join lateral (select round((8 + d.dia * 3 + l.len * 0.45)::numeric, 2) as cost) x
  where nl_seed.chance(0.75, 'item.pipe|' || d.dia || '|' || l.len);

  -- Mufflers: the first eight are bought in, the rest are welded here.
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'M-' || (1005 + g.i * 5),
         'MUFFLER ' || nl_seed.pick(array['OVAL','ROUND'], 'item.muffler.shape|' || g.i)
           || ' ' || nl_seed.pick(array['24','30','36'], 'item.muffler.body|' || g.i)
           || '" BODY ' || nl_seed.pick(array['4','5'], 'item.muffler.io|' || g.i) || '" IN/OUT',
         'MUFFLERS', 'muffler', 'MUFFLER', x.cost, round(x.cost / 0.45, 2),
         case when g.i < 8 then 'Purchase' else 'Prod. Order' end,
         case when g.i < 8 then '' else 'WELD CELL' end,
         case when g.i < 8 then 'V1050' end,
         case when g.i < 8 then '5W' else '2W' end
  from generate_series(0, 11) as g(i)
  cross join lateral (select nl_seed.ri(70, 220, 'item.muffler.cost|' || g.i)::numeric as cost) x;

  -- Clamps: CL-{diameter}{band}
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'CL-' || replace(d.dia, '.', '') || t.ct,
         d.dia || '" ' || t.band || ' CLAMP',
         'CLAMPS', 'clamp', 'CLAMPS', x.cost, round(x.cost / 0.40, 2), 'Purchase', '', 'V1030', '4W'
  from (values ('3'), ('3.5'), ('4'), ('5'), ('6')) as d(dia)
  cross join (values ('B', 'BAND'), ('W', 'WIDE BAND'), ('V', 'V-BAND')) as t(ct, band)
  cross join lateral (
    select round((3 + d.dia::numeric * 1.4 + case when t.ct = 'V' then 4 else 0 end)::numeric, 2) as cost
  ) x;

  -- Flex pipe: FL-{diameter}-{length}
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'FL-' || d.dia || '-' || l.len,
         d.dia || '" X ' || l.len || '" FLEX PIPE STAINLESS',
         'FLEX', 'flex', 'FLEX', x.cost, round(x.cost / 0.50, 2), 'Purchase', '', 'V1040', '6W'
  from (values (3), (4), (5)) as d(dia)
  cross join (values (18), (24), (36)) as l(len)
  cross join lateral (select round((12 + d.dia * 4 + l.len * 0.5)::numeric, 2) as cost) x;

  -- Heat shields and brackets.
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'HS-' || (100 + g.i * 10),
         'HEAT SHIELD ' || nl_seed.pick(array['4','5','6'], 'item.shield.dia|' || g.i) || '" '
           || nl_seed.pick(array['36','48','60'], 'item.shield.len|' || g.i) || '" STAINLESS',
         'ACCESSORY', 'shield', 'ACCESS', x.cost, round(x.cost / 0.38, 2), 'Prod. Order', 'WELD CELL', null, '2W'
  from generate_series(1, 6) as g(i)
  cross join lateral (select nl_seed.ri(18, 45, 'item.shield.cost|' || g.i)::numeric as cost) x;

  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'RB-' || (30 + g.i * 5) || 'ZN',
         nl_seed.pick(array['RAIN CAP','MOUNTING BRACKET','STACK BRACKET'], 'item.bracket.kind|' || g.i) || ' '
           || nl_seed.pick(array['5','6','7','8'], 'item.bracket.dia|' || g.i) || '" ZINC',
         'ACCESSORY', 'bracket', 'ACCESS', x.cost, round(x.cost / 0.45, 2), 'Purchase', '', 'V1070', '4W'
  from generate_series(1, 6) as g(i)
  cross join lateral (select nl_seed.ri(6, 22, 'item.bracket.cost|' || g.i)::numeric as cost) x;

  -- Kits, assembled from other parts.
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time)
  select 'K-' || (200 + g.i),
         nl_seed.pick(array['DUAL','SINGLE'], 'item.kit.kind|' || g.i) || ' STACK KIT '
           || nl_seed.pick(array['6','7','8'], 'item.kit.dia|' || g.i) || '" '
           || nl_seed.pick(array['CHROME','ALUMINIZED'], 'item.kit.finish|' || g.i),
         'KITS', 'kit', 'KIT', x.cost, round(x.cost / 0.42, 2), 'Assembly', 'ASSEMBLY', null, ''
  from generate_series(1, 5) as g(i)
  cross join lateral (select nl_seed.ri(380, 1100, 'item.kit.cost|' || g.i)::numeric as cost) x;

  -- Custom parts, made to order from a drawing.
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time, made_to_order)
  select 'CU-' || (4000 + g.i * 7),
         'CUSTOM ' || nl_seed.pick(array['ELBOW','STACK','Y-PIPE','EXTENSION','TURNOUT'], 'item.custom.kind|' || g.i)
           || ' PER DRAWING ' || nl_seed.ri(1000, 9999, 'item.custom.dwg|' || g.i),
         nl_seed.pick(array['ELBOWS','STACKS','PIPE'], 'item.custom.cat|' || g.i),
         'custom', 'CUSTOM', x.cost, round(x.cost / 0.34, 2), 'Prod. Order',
         nl_seed.pick(array['BEND CELL','WELD CELL','CUT CELL'], 'item.custom.wc|' || g.i), null,
         case when nl_seed.chance(0.5, 'item.custom.lead|' || g.i) then '' else '2W' end,
         true
  from generate_series(1, 15) as g(i)
  cross join lateral (select nl_seed.ri(60, 900, 'item.custom.cost|' || g.i)::numeric as cost) x;

  -- Proprietary parts: one big customer buys each.
  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time, proprietary)
  select 'PR-' || (7000 + g.i * 11),
         'PROPRIETARY ' || nl_seed.pick(array['MANIFOLD ADAPTER','STACK','BRACKET SET'], 'item.prop.kind|' || g.i)
           || ' DWG ' || nl_seed.ri(100, 999, 'item.prop.dwg|' || g.i),
         nl_seed.pick(array['ELBOWS','STACKS','ACCESSORY'], 'item.prop.cat|' || g.i),
         'proprietary', 'PROPRIETAR', x.cost, round(x.cost / 0.30, 2), 'Prod. Order', 'WELD CELL', null, '2W', true
  from generate_series(1, 4) as g(i)
  cross join lateral (select nl_seed.ri(90, 400, 'item.prop.cost|' || g.i)::numeric as cost) x;

  -- A few parts are blocked in the item master.
  update nl.items set blocked = true
  where nl_seed.chance(0.03, 'item.blocked|' || item_no);

  -- How much of a part a typical order line carries.
  insert into nl_seed.item_plan (item_no, qty_low, qty_high)
  select i.item_no, r.lo, r.hi
  from nl.items i
  join (values ('elbow', 4, 24), ('stack', 2, 10), ('pipe', 5, 40), ('muffler', 2, 8), ('clamp', 20, 120),
               ('flex', 6, 30), ('shield', 4, 20), ('bracket', 10, 60), ('kit', 1, 4), ('custom', 1, 6),
               ('proprietary', 2, 12)) as r(family, lo, hi)
    on r.family = i.family;

  -- What the item master says is on the shelf.
  insert into nl.stock (item_no, on_hand, on_production_order, on_purchase_order, shelf, bin, as_of)
  select i.item_no,
         case when i.made_to_order then 0
              else greatest(0, round(nl_seed.gauss(b.base, b.base * 0.6, 'stock|' || i.item_no)))::int end,
         case when i.replenishment = 'Prod. Order' and nl_seed.chance(0.35, 'stock.prod|' || i.item_no)
              then (array[25, 50, 100, 150])[nl_seed.ri(1, 4, 'stock.prod.qty|' || i.item_no)] else 0 end,
         case when i.replenishment = 'Purchase' and nl_seed.chance(0.4, 'stock.purch|' || i.item_no)
              then (array[100, 200, 500])[nl_seed.ri(1, 3, 'stock.purch.qty|' || i.item_no)] else 0 end,
         s.shelf,
         s.shelf || '-' || nl_seed.ri(1, 6, 'stock.bin|' || i.item_no),
         v_today
  from nl.items i
  join (values ('clamp', 400), ('flex', 120), ('bracket', 200), ('pipe', 90), ('elbow', 40), ('stack', 18),
               ('muffler', 25), ('shield', 30), ('kit', 6), ('proprietary', 10), ('custom', 0)) as b(family, base)
    on b.family = i.family
  cross join lateral (
    select substr('ABCDEFG', nl_seed.ri(1, 7, 'stock.shelf|' || i.item_no), 1)
           || '-' || nl_seed.ri(1, 24, 'stock.shelf.n|' || i.item_no) as shelf
  ) s;

  -- Baskets: which parts each customer buys, and on what rhythm ----------------
  insert into nl_seed.baskets (customer_no, item_no, cadence, mean_gap, sd_gap, first_day, last_day)
  with chosen as (
    -- Regular parts: a basket sized to the customer.
    select x.customer_no, x.item_no
    from (
      select cp.customer_no, i.item_no,
             row_number() over (partition by cp.customer_no
                                order by nl_seed.u('basket|' || cp.customer_no || '|' || i.item_no)) as rn,
             case cp.size
               when 'A' then nl_seed.ri(22, 36, 'basket.size|' || cp.customer_no)
               when 'B' then nl_seed.ri(11, 22, 'basket.size|' || cp.customer_no)
               when 'C' then nl_seed.ri(5, 11, 'basket.size|' || cp.customer_no)
               else nl_seed.ri(1, 4, 'basket.size|' || cp.customer_no)
             end as basket_size
      from nl_seed.customer_plan cp
      cross join nl.items i
      where not i.made_to_order and not i.proprietary
    ) x
    where x.rn <= x.basket_size
    union
    -- Half the bigger customers also buy one custom part.
    select x.customer_no, x.item_no
    from (
      select cp.customer_no, i.item_no,
             row_number() over (partition by cp.customer_no
                                order by nl_seed.u('basket.custom|' || cp.customer_no || '|' || i.item_no)) as rn
      from nl_seed.customer_plan cp
      cross join nl.items i
      where i.made_to_order and cp.size <> 'D' and nl_seed.chance(0.5, 'basket.custom|' || cp.customer_no)
    ) x
    where x.rn = 1
    union
    -- Each proprietary part belongs to one of the biggest customers.
    select a.customer_no, p.item_no
    from (select item_no, row_number() over (order by item_no) as n from nl.items where proprietary) p
    join (select customer_no, row_number() over (order by seq) as n, count(*) over () as total
          from nl_seed.customer_plan where size = 'A') a
      on a.n = 1 + (p.n - 1) % a.total
  ),
  rhythm as (
    select c.customer_no, c.item_no, cp.lifecycle,
           case when nl_seed.u(k.key || '|cadence') < 0.25 then 'clockwork'
                when nl_seed.u(k.key || '|cadence') < 0.60 then 'predictable'
                when nl_seed.u(k.key || '|cadence') < 0.85 then 'random'
                else 'oneoff' end as cadence,
           k.key
    from chosen c
    join nl_seed.customer_plan cp on cp.customer_no = c.customer_no
    cross join lateral (select c.customer_no || '|' || c.item_no as key) k
  ),
  gaps as (
    select r.*,
           case r.cadence
             when 'clockwork'   then nl_seed.ri(21, 45, r.key || '|gap')
             when 'predictable' then nl_seed.ri(30, 75, r.key || '|gap')
             when 'random'      then nl_seed.ri(60, 200, r.key || '|gap')
             else 0
           end as mean_gap
    from rhythm r
  )
  select g.customer_no, g.item_no, g.cadence, g.mean_gap,
         g.mean_gap * case g.cadence when 'clockwork' then 0.1 when 'predictable' then 0.3 else 0.9 end,
         -- the first order of this part
         (case when g.lifecycle = 'new' then v_today - nl_seed.ri(20, 150, g.key || '|start')
               else v_history + nl_seed.ri(0, case when v_small then 60 else 240 end, g.key || '|start') end)
           + nl_seed.ri(0, case when g.cadence = 'oneoff' then (case when v_small then 200 else 500 end)
                                else g.mean_gap end, g.key || '|offset'),
         -- the last day it could be ordered
         case
           when g.lifecycle = 'churned' then v_today - nl_seed.ri(200, 330, g.key || '|end')
           when g.lifecycle = 'dormant' then v_today - nl_seed.ri(75, 130, g.key || '|end')
           when c.blocked then v_today - nl_seed.ri(120, 300, g.key || '|end')
           else v_today - 1
         end
  from gaps g
  join nl.customers c on c.customer_no = g.customer_no;

  -- The ledger ----------------------------------------------------------------
  -- Walk each basket's rhythm from its first order to its last possible day.
  -- Fewer orders land in November and December. Growing accounts buy more
  -- this year, slipping ones less.
  with recursive walk (customer_no, item_no, step, day) as (
    select b.customer_no, b.item_no, 0, b.first_day
    from nl_seed.baskets b
    union all
    select w.customer_no, w.item_no, w.step + 1,
           w.day + greatest(3, round(nl_seed.gauss(b.mean_gap, b.sd_gap,
                                     'gap|' || w.customer_no || '|' || w.item_no || '|' || w.step)))::int
    from walk w
    join nl_seed.baskets b on b.customer_no = w.customer_no and b.item_no = w.item_no
    where b.cadence <> 'oneoff' and w.step < 400 and w.day <= b.last_day
  ),
  lines as (
    select w.customer_no, w.item_no, w.step, w.day,
           greatest(1, round(
             nl_seed.gauss((ip.qty_low + ip.qty_high) / 2.0, (ip.qty_high - ip.qty_low) / 4.0,
                           'qty|' || w.customer_no || '|' || w.item_no || '|' || w.step)
             * case when extract(year from w.day)::int = v_year and cp.lifecycle = 'growing' then 1.35
                    when extract(year from w.day)::int = v_year and cp.lifecycle = 'slipping' then 0.55
                    else 1 end))::int as qty,
           round((i.list_price * (1 - pg.discount)
                  * nl_seed.gauss(1, 0.02, 'price|' || w.customer_no || '|' || w.item_no || '|' || w.step))::numeric, 2)
             as unit_price
    from walk w
    join nl_seed.baskets b on b.customer_no = w.customer_no and b.item_no = w.item_no
    join nl_seed.item_plan ip on ip.item_no = w.item_no
    join nl_seed.customer_plan cp on cp.customer_no = w.customer_no
    join nl.items i on i.item_no = w.item_no
    join nl.customers c on c.customer_no = w.customer_no
    join nl.price_groups pg on pg.code = c.price_group
    where w.day <= b.last_day
      and w.day >= v_history
      and not (extract(month from w.day) >= 11
               and nl_seed.chance(0.35, 'skip|' || w.customer_no || '|' || w.item_no || '|' || w.step))
  )
  insert into nl_seed.ship_lines (customer_no, item_no, step, day, qty, unit_price, amount)
  select customer_no, item_no, step, day, qty, unit_price, round(unit_price * qty, 2)
  from lines;

  -- One shipment, and one invoice, per customer per day, numbered in date order.
  insert into nl_seed.shipments (customer_no, day, seq, total)
  select customer_no, day, row_number() over (order by day, customer_no), sum(amount)
  from nl_seed.ship_lines
  group by customer_no, day;

  -- Freight is free above a yearly threshold, and never charged to a
  -- customer who ships on their own carrier account.
  insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, order_no, customer_po,
                           subtotal, freight)
  select 'SI' || (700000 + s.seq), 'invoice', s.customer_no, coalesce(c.bill_to_no, c.customer_no), s.day,
         'SO' || (610000 + s.seq), 'PO-' || (41000 + s.seq), s.total,
         case
           when c.ships_own_carrier then 0
           when s.total >= case extract(year from s.day)::int
                             when v_year then 1800 when v_year - 1 then 1700 when v_year - 2 then 1600 else 1500 end
             then 0
           else round(least(220, 38 + s.total * 0.025), 2)
         end
  from nl_seed.shipments s
  join nl.customers c on c.customer_no = s.customer_no
  order by s.seq;

  insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
  select 'SI' || (700000 + s.seq),
         row_number() over (partition by s.seq order by l.item_no),
         l.customer_no, l.day, l.item_no, l.qty, l.unit_price, l.amount, i.unit_cost
  from nl_seed.ship_lines l
  join nl_seed.shipments s on s.customer_no = l.customer_no and s.day = l.day
  join nl.items i on i.item_no = l.item_no
  where l.day >= v_lines_from;

  -- The odd return: a credit memo ten to thirty days later, for up to two pieces.
  with returned as (
    select l.*, s.seq,
           row_number() over (order by l.day, l.customer_no, l.item_no, l.step) as rseq,
           l.day + nl_seed.ri(10, 30, 'return.day|' || l.customer_no || '|' || l.item_no || '|' || l.step) as credit_day
    from nl_seed.ship_lines l
    join nl_seed.shipments s on s.customer_no = l.customer_no and s.day = l.day
    where l.day >= v_lines_from
      and l.day + 30 < v_today
      and nl_seed.chance(0.004, 'return|' || l.customer_no || '|' || l.item_no || '|' || l.step)
  ),
  memos as (
    insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, customer_po, applies_to, subtotal)
    select 'CM' || (800000 + r.rseq), 'credit_memo', r.customer_no, coalesce(c.bill_to_no, c.customer_no),
           r.credit_day, 'PO-' || (41000 + r.seq), 'SI' || (700000 + r.seq),
           -round(r.unit_price * least(r.qty, 2), 2)
    from returned r
    join nl.customers c on c.customer_no = r.customer_no
    returning invoice_no
  )
  insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
  select 'CM' || (800000 + r.rseq), 1, r.customer_no, r.credit_day, r.item_no,
         -least(r.qty, 2), r.unit_price, -round(r.unit_price * least(r.qty, 2), 2), i.unit_cost
  from returned r
  join nl.items i on i.item_no = r.item_no
  where exists (select 1 from memos m where m.invoice_no = 'CM' || (800000 + r.rseq));

  -- What the sales team left behind ------------------------------------------
  -- Notes on most accounts.
  insert into nl.activities (customer_no, kind, body, author_id, via, occurred_at, created_at)
  select c.customer_no, 'note',
         nl_seed.pick(v_notes, 'note.text|' || c.customer_no || '|' || g.n),
         coalesce(c.owner_id, 1), 'seed', t.at, t.at
  from nl.customers c
  join nl_seed.customer_plan cp on cp.customer_no = c.customer_no and cp.kind <> 'branch'
  cross join lateral generate_series(1, case when nl_seed.chance(0.6, 'notes|' || c.customer_no)
                                             then nl_seed.ri(1, 3, 'notes.n|' || c.customer_no) else 0 end) as g(n)
  cross join lateral (
    select ((v_today - nl_seed.ri(3, 200, 'note.day|' || c.customer_no || '|' || g.n))
            + time '08:00' + make_interval(mins => nl_seed.ri(0, 540, 'note.min|' || c.customer_no || '|' || g.n)))
           at time zone 'America/Chicago' as at
  ) t;

  -- Calls, emails and visits in the last two months.
  insert into nl.activities (customer_no, kind, call_outcome, body, author_id, via, occurred_at, created_at)
  select c.customer_no,
         case k.kind when 'voicemail' then 'call' else k.kind end,
         case k.kind
           when 'voicemail' then 'voicemail'
           when 'call' then nl_seed.pick(array['reached','reached','callback'], 'call.outcome|' || c.customer_no || '|' || g.n)
         end,
         nl_seed.pick(v_call_notes, 'call.text|' || c.customer_no || '|' || g.n),
         coalesce(c.owner_id, 1), 'seed', t.at, t.at
  from nl.customers c
  join nl_seed.customer_plan cp on cp.customer_no = c.customer_no and cp.kind <> 'branch'
  cross join lateral generate_series(1, case when cp.lifecycle <> 'churned' and nl_seed.chance(0.65, 'calls|' || c.customer_no)
                                             then nl_seed.ri(1, 4, 'calls.n|' || c.customer_no) else 0 end) as g(n)
  cross join lateral (
    select nl_seed.pick(array['call','call','email','email','meeting','voicemail'], 'call.kind|' || c.customer_no || '|' || g.n) as kind
  ) k
  cross join lateral (
    select ((v_today - nl_seed.ri(1, 60, 'call.day|' || c.customer_no || '|' || g.n))
            + time '08:00' + make_interval(mins => nl_seed.ri(0, 540, 'call.min|' || c.customer_no || '|' || g.n)))
           at time zone 'America/Chicago' as at
  ) t;

  -- Open next steps, some overdue.
  insert into nl.next_steps (customer_no, title, due_on, owner_id, created_by, created_at)
  select c.customer_no,
         nl_seed.pick(v_steps, 'step.title|' || c.customer_no || '|' || g.n),
         v_today + v_due_days[nl_seed.ri(1, cardinality(v_due_days), 'step.due|' || c.customer_no || '|' || g.n)],
         coalesce(c.owner_id, 1), coalesce(c.owner_id, 1),
         now() - make_interval(days => nl_seed.ri(1, 30, 'step.added|' || c.customer_no || '|' || g.n))
  from nl.customers c
  join nl_seed.customer_plan cp on cp.customer_no = c.customer_no and cp.kind <> 'branch'
  cross join lateral generate_series(1, case when cp.lifecycle <> 'churned' and nl_seed.chance(0.55, 'steps|' || c.customer_no)
                                             then nl_seed.ri(1, 2, 'steps.n|' || c.customer_no) else 0 end) as g(n);

  -- Commitments ---------------------------------------------------------------
  -- Accounts that can carry one: buying, not blocked, not tiny. A keyed
  -- order decides who gets which kind, so the board looks the same every day.
  insert into nl_seed.eligible (customer_no, pick_order)
  select c.customer_no, row_number() over (order by nl_seed.u('commit.pick|' || c.customer_no))
  from nl.customers c
  join nl_seed.customer_plan cp on cp.customer_no = c.customer_no
  where cp.kind in ('hq', 'independent', 'international')
    and cp.lifecycle in ('steady', 'new', 'growing', 'slipping')
    and not c.blocked and not c.closed
    and cp.size <> 'D';

  -- Delivering: the window is open and parts in scope are shipping.
  v_quota := case when v_small then 1 else 6 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'delivering|' || v_row.customer_no;
    v_start := v_today - nl_seed.ri(30, 90, v_key || '|start');
    v_end := v_today + nl_seed.ri(31, 70, v_key || '|end');
    v_items := nl_seed.family_items(v_row.customer_no, v_start, v_today, v_key);
    continue when cardinality(v_items) = 0;
    v_items := v_items[1:nl_seed.ri(3, 7, v_key || '|n')];
    v_delivered := nl_seed.family_delivered(v_row.customer_no, v_items, v_start, v_today);
    continue when v_delivered <= 0;
    v_value := round(v_delivered / (0.3 + nl_seed.u(v_key || '|share') * 0.45)::numeric, 2);
    perform nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key), v_value, v_start, v_end,
      case when nl_seed.chance(0.6, v_key || '|conf') then nl_seed.ri(5, 9, v_key || '|conf.v') * 10 else 50 end,
      v_items, null);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Kept: the window closed and delivery reached the committed value.
  v_quota := case when v_small then 1 else 4 end;
  v_made := 0;
  for v_row in
    select e.customer_no from nl_seed.eligible e
    join nl_seed.customer_plan cp on cp.customer_no = e.customer_no
    where not e.taken and cp.size in ('A', 'B') and cp.lifecycle <> 'new'
    order by e.pick_order
  loop
    exit when v_made >= v_quota;
    v_key := 'kept|' || v_row.customer_no;
    v_start := v_today - nl_seed.ri(150, 240, v_key || '|start');
    v_end := v_today - nl_seed.ri(45, 90, v_key || '|end');
    v_items := nl_seed.family_items(v_row.customer_no, v_start, v_end, v_key);
    continue when cardinality(v_items) = 0;
    v_items := v_items[1:nl_seed.ri(4, 8, v_key || '|n')];
    v_delivered := nl_seed.family_delivered(v_row.customer_no, v_items, v_start, v_end);
    continue when v_delivered < 2500;
    perform nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key), round(v_delivered * 0.97, 2),
      v_start, v_end, 90, v_items, null);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Quoted: a quote went out for parts this customer has never bought, so
  -- nothing can have shipped against it yet.
  v_quota := case when v_small then 1 else 5 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'quoted|' || v_row.customer_no;
    v_items := nl_seed.new_items(v_row.customer_no, null, v_key);
    continue when cardinality(v_items) < 2;
    v_items := v_items[1:nl_seed.ri(2, 5, v_key || '|n')];
    select array_agg(nl_seed.ri(ip.qty_low, ip.qty_high, v_key || '|qty|' || x.item_no) * 2 order by x.n)
      into v_qtys
    from unnest(v_items) with ordinality as x(item_no, n)
    join nl_seed.item_plan ip on ip.item_no = x.item_no;
    select round(sum(x.qty * nl_seed.net_price(v_row.customer_no, x.item_no))
                 * nl_seed.ri(2, 4, v_key || '|mult'), 2)
      into v_value
    from unnest(v_items, v_qtys) as x(item_no, qty);
    v_start := v_today - nl_seed.ri(5, 40, v_key || '|start');
    v_end := v_today + nl_seed.ri(10, 45, v_key || '|end');
    v_id := nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key), v_value, v_start, v_end,
      case when nl_seed.chance(0.5, v_key || '|conf') then nl_seed.ri(4, 6, v_key || '|conf.v') * 10 else 50 end,
      v_items, v_qtys);
    perform nl_seed.add_quote(v_row.customer_no, v_id,
      greatest(v_start, v_today - nl_seed.ri(1, 12, v_key || '|quoted')), v_items, v_qtys);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Promised: a named buyer and a number, nothing quoted yet. The first one
  -- has no named buyer, which the board flags.
  v_quota := 2 + case when v_small then 0 else 2 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'promised|' || v_row.customer_no;
    v_items := nl_seed.new_items(v_row.customer_no, null, v_key);
    continue when cardinality(v_items) = 0;
    v_items := v_items[1:nl_seed.ri(1, 3, v_key || '|n')];
    perform nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key),
      nl_seed.ri(8, 60, v_key || '|value') * 1000,
      v_today - nl_seed.ri(2, 25, v_key || '|start'), v_today + nl_seed.ri(30, 90, v_key || '|end'),
      50, v_items, null, v_made > 0);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Closed short, not answered yet. The last one has a newer quote for the
  -- same parts, which is the evidence the nightly job needs to answer
  -- "pushed" on its own; the other two need a person.
  v_quota := 3;
  v_made := 0;
  for v_row in
    select e.customer_no from nl_seed.eligible e
    join nl_seed.customer_plan cp on cp.customer_no = e.customer_no
    where not e.taken and cp.lifecycle <> 'new'
    order by e.pick_order
  loop
    exit when v_made >= v_quota;
    v_key := 'short|' || v_row.customer_no;
    v_start := v_today - nl_seed.ri(90, 140, v_key || '|start');
    v_end := v_today - nl_seed.ri(20, 45, v_key || '|end');
    select coalesce(array_agg(b.item_no order by nl_seed.u(v_key || '|' || b.item_no)), '{}')
      into v_items
    from nl_seed.baskets b
    join nl.items i on i.item_no = b.item_no
    where b.customer_no = v_row.customer_no and not i.made_to_order;
    continue when cardinality(v_items) < 2;
    v_items := v_items[1:nl_seed.ri(2, 5, v_key || '|n')];
    v_delivered := nl_seed.family_delivered(v_row.customer_no, v_items, v_start, v_end);
    v_id := nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key),
      round(greatest(v_delivered * 2.2, 15000), 2), v_start, v_end, 70, v_items, null);
    if v_made = v_quota - 1 then
      perform nl_seed.add_quote(v_row.customer_no, null, v_end + nl_seed.ri(3, 10, v_key || '|requote'),
        v_items[1:1], array[nl_seed.ri(4, 20, v_key || '|requote.qty')]);
    end if;
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Pushed and broken, both answered by the owner.
  for v_row in
    select e.customer_no from nl_seed.eligible e
    join nl_seed.customer_plan cp on cp.customer_no = e.customer_no
    where not e.taken and cp.lifecycle <> 'new'
    order by e.pick_order
    limit 1
  loop
    v_key := 'pushed|' || v_row.customer_no;
    v_items := nl_seed.family_items(v_row.customer_no, v_today - 120, v_today, v_key);
    v_items := case when cardinality(v_items) >= 1 then v_items[1:3]
                    else (nl_seed.new_items(v_row.customer_no, 'stack', v_key))[1:3] end;
    v_delivered := nl_seed.family_delivered(v_row.customer_no, v_items, v_today - 120, v_today - 30);
    v_id := nl_seed.add_commitment(
      v_row.customer_no, 'Stack order slipped to next quarter', greatest(42000, round(v_delivered * 2, 2)),
      v_today - 120, v_today - 30, 50, v_items, null);
    insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note)
    select v_id, 'pushed', 'person', owner_id, now() - interval '12 days',
           'Buyer confirmed the order is still coming. Their fleet refresh moved to next quarter.'
    from nl.commitments where id = v_id;
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
  end loop;

  for v_row in
    select e.customer_no from nl_seed.eligible e
    join nl_seed.customer_plan cp on cp.customer_no = e.customer_no
    where not e.taken and cp.lifecycle <> 'new'
    order by e.pick_order
    limit 1
  loop
    v_key := 'broken|' || v_row.customer_no;
    v_items := nl_seed.new_items(v_row.customer_no, 'muffler', v_key);
    v_items := v_items[1:2];
    v_id := nl_seed.add_commitment(
      v_row.customer_no, 'Muffler program lost on price', 27500,
      v_today - 160, v_today - 50, 20, v_items, null);
    insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note)
    select v_id, 'broken', 'person', owner_id, now() - interval '40 days',
           'Lost to a competitor on price, not quality.'
    from nl.commitments where id = v_id;
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
  end loop;

  -- Operations-sized: big stack and elbow programs with a quote on file.
  v_quota := case when v_small then 1 else 2 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'ops|' || v_row.customer_no;
    select array_agg(i.item_no order by nl_seed.u(v_key || '|' || i.item_no))
      into v_items
    from nl.items i
    where i.family = case when v_made = 0 then 'stack' else 'elbow' end
      and not i.made_to_order and not i.blocked
      and (v_made > 0 or i.item_no like '%C');
    v_items := v_items[1:6];
    select array_agg(nl_seed.ri(10, 40, v_key || '|qty|' || x.item_no) order by x.n)
      into v_qtys
    from unnest(v_items) with ordinality as x(item_no, n);
    select round(greatest(90000, sum(x.qty * nl_seed.net_price(v_row.customer_no, x.item_no)) * 2), 2)
      into v_value
    from unnest(v_items, v_qtys) as x(item_no, qty);
    v_start := v_today - nl_seed.ri(10, 40, v_key || '|start');
    v_id := nl_seed.add_commitment(
      v_row.customer_no,
      case when v_made = 0 then 'Fleet-wide chrome stack refit' else 'Annual elbow supply agreement' end,
      v_value, v_start, v_today + nl_seed.ri(50, 80, v_key || '|end'), 75, v_items, v_qtys);
    perform nl_seed.add_quote(v_row.customer_no, v_id, v_start + nl_seed.ri(0, 5, v_key || '|quoted'),
      v_items, v_qtys);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- A next step on most open commitments.
  insert into nl.next_steps (customer_no, commitment_id, title, due_on, owner_id, created_by, created_at)
  select p.customer_no, p.id,
         case p.status
           when 'promised' then 'Get a quote in front of the buyer'
           when 'quoted' then 'Follow up on the quote'
           else 'Confirm the next release date'
         end,
         v_today + nl_seed.ri(-3, 14, 'commit.step.due|' || p.id),
         p.owner_id, p.owner_id,
         now() - make_interval(days => nl_seed.ri(1, 10, 'commit.step.added|' || p.id))
  from nl.commitment_progress p
  where not p.is_settled
    and not p.needs_outcome
    and nl_seed.chance(0.7, 'commit.step|' || p.id);

  select jsonb_build_object(
    'size', p_size,
    'today', v_today,
    'customers', (select count(*) from nl.customers),
    'contacts', (select count(*) from nl.contacts),
    'items', (select count(*) from nl.items),
    'invoices', (select count(*) from nl.invoices),
    'invoice_lines', (select count(*) from nl.invoice_lines),
    'activities', (select count(*) from nl.activities),
    'next_steps', (select count(*) from nl.next_steps),
    'commitments', (select jsonb_object_agg(status, n) from (
        select status, count(*) as n from nl.commitment_progress group by status) s),
    'needs_outcome', (select count(*) from nl.commitment_progress where needs_outcome),
    'revenue_by_year', (select jsonb_object_agg(y, v order by y) from (
        select extract(year from posted_on)::int as y, round(sum(subtotal)) as v
        from nl.invoices group by 1) r)
  ) into v_result;
  return v_result;
end $$;

revoke execute on all functions in schema nl_seed from public;
revoke execute on function nl.reset(), nl.build(text) from public;
