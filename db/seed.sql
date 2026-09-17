-- The Northline world, built inside the database.
--
--   select nl.reset();                   empty every table in schema nl
--   select nl.build();                   the full world, dated relative to today
--   select nl.build('demo');             a mid-sized world (the local default)
--   select nl.build('small');            a small world, for tests
--   select nl.answer_pushed_windows();   what the nightly job does next
--
-- The full world is built at the scale of a mid-sized industrial parts
-- maker: about 4,500 customers, 11,400 parts and seven years of invoices
-- (roughly 110,000 invoices and half a million invoice lines). Its shapes
-- (how revenue spreads across customers, how often they order, how many
-- lines an invoice carries, seasonality, margins, freight, returns) were
-- tuned to match the distributions of a real business of this kind; no
-- names, records or exact figures were carried over, and dollars are
-- rescaled. Every name, number and dollar here is invented. A match with a
-- real business is a coincidence. Email addresses use the reserved .example
-- domain.
--
-- Randomness is keyed, not sequential. Every draw is a hash of a label, for
-- example 'line|1104|2025|7', so the same label always gives the same
-- number, in any order, on any Postgres 17. Supabase and the local PGlite
-- database therefore build the same world. Only the dates move with the
-- calendar (the world is always "as of today").
--
-- The build runs in three steps, so a slow server can run them one at a time:
--   select nl_seed.begin_build('full');      people, catalog, customers, baskets
--   select nl_seed.build_year(2020); ...     one call per year of invoices
--   select nl_seed.finish_build();           commitments, notes, next steps
-- nl.build() runs all three.
--
-- This file is not a migration: it creates helpers in schema nl_seed and the
-- entry points nl.reset() and nl.build(). Run it after the migrations.

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
                            'Terry','Dale','Kim','Lee','Shawn','Tracy','Jesse','Blake','Avery','Reese','Quinn',
                            'Jordan','Cameron','Dana','Rowan','Hayden','Logan','Emerson','Parker','Micah','Kendall'],
                      p_key || '|first')
         || ' ' ||
         nl_seed.pick(array['Alvarez','Brennan','Castillo','Dawson','Ellison','Foster','Garza','Holloway','Ibarra',
                            'Jennings','Keller','Lindqvist','Moreno','Navarro','Okafor','Pruitt','Quintero','Reyes',
                            'Sandoval','Tanaka','Underwood','Vasquez','Whitfield','Yates','Zimmerman','Ashworth',
                            'Bautista','Crowley','Delacroix','Esposito','Fairbanks','Gallagher','Haverford','Iverson',
                            'Kowalski','Lachance','Mendoza','Novak','Oyelaran','Petrakis','Rasmussen','Sorensen',
                            'Thibodeaux','Vandermeer','Wexler'],
                      p_key || '|last')
$$;

create or replace function nl_seed.phone(p_key text) returns text
language sql immutable parallel safe
as $$ select '(' || nl_seed.ri(200, 989, p_key || '|area') || ') 555-' || lpad(nl_seed.ri(100, 9999, p_key || '|line')::text, 4, '0') $$;

create or replace function nl_seed.slug(p_text text) returns text
language sql immutable parallel safe
as $$ select lower(regexp_replace(p_text, '[^A-Za-z0-9]+', '', 'g')) $$;

-- Which of the twelve agencies sells to a customer. Null (a house account)
-- for about 30% of customers; the bigger agencies carry more.
-- width_bucket counts how many thresholds the draw has passed.
create or replace function nl_seed.agency_for(p_key text) returns int
language sql immutable parallel safe
as $$
  select nullif(width_bucket(nl_seed.u(p_key || '|agency'),
    array[0.30, 0.46, 0.58, 0.68, 0.76, 0.82, 0.87, 0.91, 0.94, 0.96, 0.98, 0.99]::double precision[]), 0)
$$;

-- Who owns a customer, weighted the way a real sales team's books are
-- lopsided: three big books, a middle, and a small one. The caller decides
-- whether the customer has an owner at all.
create or replace function nl_seed.owner_for(p_key text) returns int
language sql immutable parallel safe
as $$
  select (array[2, 3, 4, 8, 9, 1, 10])[1 + width_bucket(nl_seed.u(p_key || '|owner'),
    array[0.264, 0.490, 0.708, 0.844, 0.918, 0.974]::double precision[])]
$$;

-- ---------------------------------------------------------------------------
-- The generator's own bookkeeping. The app never reads these.
-- ---------------------------------------------------------------------------

-- One row: what is being built.
create table if not exists nl_seed.settings (
  size        text not null,
  today       date not null,
  first_year  int not null,
  last_year   int not null,
  scale       double precision not null,  -- customers and parts, relative to full
  invoices    int not null default 0,      -- numbers handed out so far
  memos       int not null default 0
);

-- Seasonality: the share of a year's orders that land in each month.
create table if not exists nl_seed.months (
  month int primary key,
  share double precision not null,
  cum_lo double precision not null,
  cum_hi double precision not null
);

-- Year-to-year swings in the whole book: revenue and lines per customer.
create table if not exists nl_seed.years (
  year      int primary key,
  idx       int not null,                  -- 0 is the first year of history
  rev_mult  double precision not null,
  line_mult double precision not null,
  frac      double precision not null      -- share of the year that has happened
);

-- Every part, with how popular it is. lo/hi slice [0, 1) by popularity, so
-- a uniform draw picks a part in proportion to its weight.
create table if not exists nl_seed.item_plan (
  item_no text primary key,
  seq     int not null,
  weight  double precision not null,
  lo      double precision not null,
  hi      double precision not null
);
create index if not exists item_plan_hi_idx on nl_seed.item_plan (hi);

-- Every customer and its life: when it started and stopped buying, how
-- big it is (z, in standard deviations), how often it buys in a year.
create table if not exists nl_seed.portfolio (
  customer_no text primary key,
  seq         int not null,
  kind        text not null,      -- never, lapsed, alive, new
  z           double precision not null,
  ln_rev      double precision not null,
  first_idx   int not null,       -- first and last year index with purchases
  last_idx    int not null,
  q           double precision not null,  -- chance of buying in a given year
  parent_no   text,
  is_parent   boolean not null default false
);

-- A customer's buying year: its revenue target and how it spreads.
create table if not exists nl_seed.cust_year (
  customer_no text not null,
  year        int not null,
  revenue     double precision not null,
  lines       int not null,
  days        int not null,
  primary key (customer_no, year)
);

-- The parts a customer buys over its life, with a weight each. lo/hi slice
-- [0, 1) per customer, like item_plan.
create table if not exists nl_seed.baskets (
  customer_no text not null,
  item_no     text not null,
  lo          double precision not null,
  hi          double precision not null,
  primary key (customer_no, item_no)
);
create index if not exists baskets_pick_idx on nl_seed.baskets (customer_no, hi);

-- Credit memos waiting to be written (build_year fills and empties it).
create table if not exists nl_seed.memo_work (
  memo_no     text not null,
  line_no     int not null,
  invoice_no  text not null,
  customer_no text not null,
  bill_to_no  text not null,
  posted_on   date not null,
  customer_po text,
  item_no     text not null,
  quantity    int not null,
  unit_price  numeric(12, 2) not null,
  amount      numeric(12, 2) not null,
  unit_cost   numeric(12, 2) not null,
  primary key (memo_no, line_no)
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

-- Parts the family shipped between two dates, biggest first.
create or replace function nl_seed.family_items(p_customer text, p_from date, p_to date, p_key text)
returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(x.item_no order by x.amount desc, nl_seed.u(p_key || '|' || x.item_no)), '{}')
  from (
    select il.item_no, sum(il.amount) as amount
    from nl.invoice_lines il
    where il.customer_no in (select nl_seed.family(p_customer))
      and il.posted_on between p_from and p_to
      and il.quantity > 0
    group by il.item_no
  ) x
$$;

-- Popular sellable parts the family has never bought, in a keyed order.
create or replace function nl_seed.new_items(p_customer text, p_family text, p_key text)
returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(x.item_no order by nl_seed.u(p_key || '|' || x.item_no)), '{}')
  from (
    select i.item_no
    from nl.items i
    join nl_seed.item_plan ip on ip.item_no = i.item_no
    where not i.made_to_order and not i.proprietary and not i.blocked
      and (p_family is null or i.family = p_family)
      and not exists (
        select 1 from nl.invoice_lines il
        where il.item_no = i.item_no
          and il.customer_no in (select nl_seed.family(p_customer)))
    order by ip.weight desc
    limit 40
  ) x
$$;

-- A commitment title that fits its parts: named after the family most of
-- them belong to.
create or replace function nl_seed.title_for(p_items text[], p_key text) returns text
language sql stable
set search_path = ''
as $$
  select coalesce((
    select case f.family
      when 'elbow' then nl_seed.pick(array['Fleet elbow restock', 'Elbow stocking program'], p_key || '|title')
      when 'stack' then nl_seed.pick(array['Chrome stack program', 'Turnout stacks for the west yard'], p_key || '|title')
      when 'pipe' then 'Q4 pipe stocking order'
      when 'muffler' then 'Muffler line changeover'
      when 'clamp' then 'Clamp standing order'
      when 'flex' then 'Flex pipe consolidation'
      when 'shield' then 'Heat shield retrofit'
      when 'bracket' then 'Rain cap and bracket restock'
      when 'kit' then 'Dual stack kits for the new lot'
      when 'raw' then 'Tube stock for the fab shop'
      when 'custom' then 'Custom Y-pipe build'
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

-- A typical order quantity for a part, from its price: cheap parts go out
-- by the dozen, a kit goes out one at a time.
create or replace function nl_seed.typical_qty(p_item text, p_key text) returns int
language sql stable
set search_path = ''
as $$
  select greatest(1, round(exp(nl_seed.gauss(ln(greatest(1, 120 / greatest(i.list_price * 0.49, 1))), 0.5, p_key))))::int
  from nl.items i
  where i.item_no = p_item
$$;

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
-- Step 1a: what is being built, the calendar, the people
-- ---------------------------------------------------------------------------

create or replace function nl_seed.build_settings(p_size text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today date := nl.today();
  v_year  int  := extract(year from nl.today())::int;
  v_first int;
begin
  -- Customers and parts relative to the full world, and how many years back.
  v_first := v_year - case p_size when 'full' then 6 when 'demo' then 2 else 1 end;
  insert into nl_seed.settings (size, today, first_year, last_year, scale)
  values (p_size, v_today, v_first, v_year,
          case p_size when 'full' then 1.0 when 'demo' then 0.156 else 0.02 end);

  -- Seasonality: share of a year's orders by month. March, May and October
  -- are busy; November and December are quiet.
  insert into nl_seed.months (month, share, cum_lo, cum_hi)
  select m, s, sum(s) over (order by m) - s, sum(s) over (order by m)
  from unnest(array[0.0863, 0.0821, 0.0937, 0.0784, 0.0938, 0.0825,
                    0.0782, 0.0847, 0.0827, 0.0896, 0.0701, 0.0779]) with ordinality as t(s, m);
  -- The shares add to 1.0000 give or take rounding; make the last one exact.
  update nl_seed.months set cum_hi = 1 where month = 12;

  -- The book's revenue and line count per customer drift from year to year.
  -- The last entry is this year; lines per dollar fall over time as orders
  -- consolidate.
  insert into nl_seed.years (year, idx, rev_mult, line_mult, frac)
  select y, y - v_first,
         (array[1.03, 1.13, 1.14, 1.10, 0.99, 1.00, 1.03])[7 - (v_year - y)],
         (array[1.22, 1.18, 1.06, 0.93, 0.94, 1.00, 0.86])[7 - (v_year - y)],
         case when y < v_year then 1.0
              else (select m.cum_lo
                           + m.share * (extract(day from v_today) - 1)
                             / extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'))
                    from nl_seed.months m where m.month = extract(month from v_today)::int)
         end
  from generate_series(v_first, v_year) as y;
end $$;

create or replace function nl_seed.build_people() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_scale double precision := (select scale from nl_seed.settings);
  v_vendors int;
begin
  insert into nl.users (id, email, full_name, title, role, active) values
    (1,  'elena.brooks@northline.example',  'Elena Brooks',  'Sales Director',     'admin',           true),
    (2,  'dana.whitlock@northline.example', 'Dana Whitlock', 'Account Manager',    'account_manager', true),
    (3,  'marcus.bell@northline.example',   'Marcus Bell',   'Account Manager',    'account_manager', true),
    (4,  'sam.ortiz@northline.example',     'Sam Ortiz',     'Account Manager',    'account_manager', true),
    (5,  'priya.raman@northline.example',   'Priya Raman',   'Operations Lead',    'operations',      true),
    (6,  'jordan.pike@northline.example',   'Jordan Pike',   'Order Desk',         'operations',      true),
    (7,  'terry.vance@northline.example',   'Terry Vance',   'Account Manager (no longer with the company)', 'account_manager', false),
    (8,  'nora.quinlan@northline.example',  'Nora Quinlan',  'Account Manager',    'account_manager', true),
    (9,  'tariq.hale@northline.example',    'Tariq Hale',    'Account Manager',    'account_manager', true),
    (10, 'ines.carver@northline.example',   'Ines Carver',   'Inside Sales',       'account_manager', true),
    (11, 'cole.brandt@northline.example',   'Cole Brandt',   'Inside Sales',       'account_manager', true),
    (12, 'wes.tanner@northline.example',    'Wes Tanner',    'Production Planner', 'operations',      true),
    (13, 'lena.ortmann@northline.example',  'Lena Ortmann',  'Purchasing',         'operations',      true),
    (14, 'hazel.min@northline.example',     'Hazel Min',     'Customer Service',   'operations',      true);

  insert into nl.agencies (id, code, name, territory) values
    (1,  '410', 'Summit Rep Group',           'Texas and the Gulf'),
    (2,  '520', 'Ridgeline Sales Associates', 'Mountain West'),
    (3,  '630', 'Bluewater Marketing',        'Great Lakes and Canada'),
    (4,  '215', 'Prairie Wind Sales',         'Plains states'),
    (5,  '325', 'Keystone Territory Partners','Mid-Atlantic'),
    (6,  '740', 'Palmetto Rep Co.',           'Southeast'),
    (7,  '815', 'Cascade Crest Associates',   'Pacific Northwest'),
    (8,  '905', 'Desert Line Marketing',      'Southwest'),
    (9,  '118', 'Heartland Fleet Reps',       'Missouri Valley'),
    (10, '260', 'Northwoods Sales Group',     'Upper Midwest'),
    (11, '372', 'Bayshore Associates',        'Florida'),
    (12, '488', 'Granite Peak Reps',          'New England');

  -- Deeper discounts go to bigger customers (see build_customers).
  insert into nl.price_groups (code, label, discount) values
    ('JOBBER',     'Jobber',      0.38),
    ('DEALER',     'Dealer',      0.45),
    ('PERFORMANC', 'Performance', 0.48),
    ('ELITE',      'Elite',       0.50),
    ('MASTER',     'Master Distributor', 0.57);

  -- Vendors: a long list in the vendor master, a short list actually used.
  v_vendors := greatest(20, round(1252 * greatest(v_scale, 0.04)))::int;
  insert into nl.vendors (vendor_no, name, city, state, lead_time)
  select 'V' || (10000 + x.n * 10),
         x.name,
         split_part(x.place, '|', 1),
         split_part(x.place, '|', 2),
         nl_seed.pick(array['1W','2W','2W','3W','4W','4W','6W','8W',''], 'vendor.lead|' || x.name)
  from (
    select row_number() over (order by nl_seed.u('vendor|' || p || '|' || w || '|' || s)) as n,
           p || ' ' || w || ' ' || s as name,
           nl_seed.pick(array['Sandusky|OH','Toledo|OH','Erie|PA','Duluth|MN','Grand Rapids|MI','Akron|OH',
             'Columbus|OH','Cleveland|OH','Fort Wayne|IN','Scranton|PA','Peoria|IL','Racine|WI','Dayton|OH',
             'Lansing|MI','Youngstown|OH','Elkhart|IN','Joliet|IL','Kenosha|WI','Muncie|IN','Canton|OH',
             'Houston|TX','Tulsa|OK','Wichita|KS','Omaha|NE','Charlotte|NC','Greenville|SC','Nashville|TN'],
             'vendor.place|' || p || '|' || w || '|' || s) as place
    from unnest(array['Lakeshore','Midland','Cardinal','Northstar','Great Lakes','Summit','Buckeye','Harbor',
                      'Pioneer','Keystone','Riverbend','Ironwood','Tri-County','Heartland','Allied','Precision',
                      'Frontier','Liberty','Pemberton','Superior','Patriot','Crescent','Eagle','Continental',
                      'Valley','Union','Standard','Atlas','Reliance','Mercer','Dominion','Granite','Beacon',
                      'Cornerstone','Maple Leaf','Oak Ridge','Sterling','Unity','Paramount','Redstone']) as p,
         unnest(array['Plating','Tube','Steel','Clamp','Flex','Muffler','Fastener','Stamping','Packaging',
                      'Heat Shield','Rubber','Gasket','Wire','Coating','Machining','Forge','Spring','Hose',
                      'Bearing','Finishing']) as w,
         unnest(array['Co.','Inc.','Supply','Products','Industries','Mfg','Works','Corp.']) as s
    order by 1
    limit v_vendors
  ) x;
end $$;

-- ---------------------------------------------------------------------------
-- Step 1b: the catalog
-- ---------------------------------------------------------------------------

-- Part numbers follow a grammar (family, diameter, angle, legs, finish) so
-- a close-sibling search has something to work with. Every family produces
-- more candidates than it needs; a keyed draw keeps the right number.
-- Prices start from a typical selling price, then list = selling / 0.49
-- (customers pay about half of list) and cost = list x (1 - list margin),
-- with the list margin set per product group so gross margins land where
-- this industry's do: straight pipe high, chrome and accessories lower.
create or replace function nl_seed.build_catalog() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_s double precision := (select case size when 'full' then 1.0 when 'demo' then 0.25 else 0.04 end
                           from nl_seed.settings);
  v_used int;
begin
  drop table if exists pg_temp.cand;
  create temporary table cand (
    item_no text, description text, category text, family text, product_group text,
    selling double precision, chrome boolean, big boolean
  ) on commit drop;

  -- Elbows: L{diameter}{angle}-{leg a}{leg b}{finish}
  insert into cand
  select 'L' || replace(d.dia, '.', '') || g.deg || '-' || la || lb || f.fin,
         d.dia || '" ' || g.deg || ' DEG ELBOW ' || la || '" X ' || lb || '" ' || f.finish,
         'ELBOWS', 'elbow', case when f.fin in ('C', 'SC') then 'CHROME' else 'PIPE' end,
         (12 + d.dia::numeric * 4 + (la + lb) * 0.5 + g.deg * 0.05) * f.mult,
         f.fin in ('C', 'SC'), d.dia::numeric >= 7
  from unnest(array['3','3.5','4','5','6','7','8']) as d(dia)
  cross join unnest(array[15, 22, 30, 45, 60, 90]) as g(deg)
  cross join unnest(array[6, 8, 10, 12, 14, 16, 18, 20, 24, 30]) as la
  cross join unnest(array[6, 8, 10, 12, 14, 16, 18, 20, 24, 30]) as lb
  cross join (values ('A', 'ALUMINIZED', 1.0), ('C', 'CHROME', 1.6), ('S', 'STAINLESS', 1.4),
                     ('SA', 'ALUMINIZED SLIP', 1.05), ('SC', 'CHROME SLIP', 1.65), ('B', 'BLACK', 1.2))
    as f(fin, finish, mult)
  where nl_seed.chance(0.127 * v_s, 'item.elbow|' || d.dia || '|' || g.deg || '|' || la || '|' || lb || '|' || f.fin);

  -- Stacks: S{diameter}-{length}{style}{finish}
  insert into cand
  select 'S' || d.dia || '-' || l.len || s.st || f.fin,
         d.dia || '" X ' || l.len || '" ' || s.style || ' STACK ' || f.finish,
         'STACKS', 'stack', case when f.fin = 'C' then 'CHROME' else 'PIPE' end,
         (25 + d.dia * 6 + l.len * 0.45) * f.mult,
         f.fin = 'C', l.len >= 96
  from unnest(array[4, 5, 6, 7, 8]) as d(dia)
  cross join generate_series(24, 144, 6) as l(len)
  cross join (values ('S', 'STRAIGHT CUT'), ('M', 'MITER CUT'), ('K', 'CURVED'), ('W', 'WEST COAST TURNOUT'),
                     ('B', 'BULL HAULER'), ('R', 'REDUCER')) as s(st, style)
  cross join (values ('A', 'ALUMINIZED', 1.0), ('C', 'CHROME', 1.7), ('S', 'STAINLESS', 1.5), ('B', 'BLACK', 1.2))
    as f(fin, finish, mult)
  where nl_seed.chance(0.595 * v_s, 'item.stack|' || d.dia || '|' || l.len || '|' || s.st || '|' || f.fin);

  -- Straight pipe: P{diameter}-{length}{material}{ends}
  insert into cand
  select 'P' || replace(d.dia, '.', '') || '-' || l.len || m.mat || e.en,
         d.dia || '" X ' || l.len || '" PIPE ' || m.material || ' ' || e.ends,
         'PIPE', 'pipe', case when m.mat = 'C' then 'CHROME' else 'PIPE' end,
         (6 + d.dia::numeric * 2.5 + l.len * 0.25) * m.mult * e.mult,
         m.mat = 'C', l.len >= 96
  from unnest(array['2.5','3','3.5','4','5','6','7','8']) as d(dia)
  cross join unnest(array[12, 18, 24, 30, 36, 48, 60, 72, 96, 120, 144]) as l(len)
  cross join (values ('A', 'ALUMINIZED', 1.0), ('S', 'STAINLESS', 1.5), ('C', 'CHROME', 1.8)) as m(mat, material, mult)
  cross join (values ('P', 'PLAIN', 1.0), ('E', 'ONE END EXPANDED', 1.05), ('X', 'BOTH ENDS EXPANDED', 1.1))
    as e(en, ends, mult)
  where nl_seed.chance(0.884 * v_s, 'item.pipe|' || d.dia || '|' || l.len || '|' || m.mat || '|' || e.en);

  -- Flex pipe: FL{diameter}-{length}{type}
  insert into cand
  select 'FL' || replace(d.dia, '.', '') || '-' || l.len || t.ty,
         d.dia || '" X ' || l.len || '" FLEX PIPE ' || t.kind,
         'FLEX', 'flex', 'FLEX', (15 + d.dia::numeric * 6 + l.len * 1.2) * t.mult, false, false
  from unnest(array['2.5','3','3.5','4','5','6','7','8']) as d(dia)
  cross join unnest(array[6, 8, 10, 12, 14, 16, 18, 24, 30, 36]) as l(len)
  cross join (values ('SS', 'STAINLESS', 1.3), ('GA', 'GALVANIZED', 1.0), ('IL', 'INTERLOCK', 1.5)) as t(ty, kind, mult)
  where nl_seed.chance(0.833 * v_s, 'item.flex|' || d.dia || '|' || l.len || '|' || t.ty);

  -- Mufflers: M-{number}
  insert into cand
  select 'M-' || (1000 + g.i * 7),
         'MUFFLER ' || nl_seed.pick(array['OVAL','ROUND','RECTANGULAR'], 'item.muffler.shape|' || g.i)
           || ' ' || nl_seed.pick(array['10','11','12','13'], 'item.muffler.dia|' || g.i)
           || '" X ' || nl_seed.pick(array['24','30','36','42'], 'item.muffler.body|' || g.i)
           || '" ' || nl_seed.pick(array['4','5','6'], 'item.muffler.io|' || g.i) || '" IN/OUT',
         'MUFFLERS', 'muffler', 'MUFFLERS', nl_seed.ri(60, 320, 'item.muffler.price|' || g.i), false, false
  from generate_series(1, 900) as g(i)
  where nl_seed.chance(0.778 * v_s, 'item.muffler|' || g.i);

  -- Clamps: CL{diameter}{type}{material}
  insert into cand
  select 'CL' || replace(d.dia, '.', '') || t.ct || m.mt,
         d.dia || '" ' || t.band || ' CLAMP ' || m.material,
         'CLAMPS', 'clamp', 'ACCESSORY', (4 + d.dia::numeric * 1.6) * t.mult * m.mult, false, false
  from unnest(array['2.5','3','3.5','4','4.5','5','5.5','6','7','8']) as d(dia)
  cross join (values ('B', 'BAND', 1.0), ('W', 'WIDE BAND', 1.5), ('V', 'V-BAND', 2.5), ('U', 'U-BOLT', 0.8),
                     ('S', 'SADDLE', 1.3), ('L', 'LAP JOINT', 1.8)) as t(ct, band, mult)
  cross join (values ('Z', 'ZINC', 1.0), ('SS', 'STAINLESS', 1.8)) as m(mt, material, mult)
  where nl_seed.chance(0.917 * v_s, 'item.clamp|' || d.dia || '|' || t.ct || '|' || m.mt);

  -- Heat shields: HS{diameter}-{length}{style}
  insert into cand
  select 'HS' || d.dia || '-' || l.len || s.st,
         'HEAT SHIELD ' || d.dia || '" X ' || l.len || '" ' || s.style,
         'ACCESSORY', 'shield', 'ACCESSORY', 20 + d.dia * 3 + l.len * 0.4, false, false
  from unnest(array[4, 5, 6, 7, 8]) as d(dia)
  cross join unnest(array[12, 18, 24, 30, 36, 48, 60, 72]) as l(len)
  cross join (values ('P', 'PERFORATED STAINLESS'), ('S', 'SOLID STAINLESS'), ('C', 'CHROME')) as s(st, style)
  where nl_seed.chance(0.917 * v_s, 'item.shield|' || d.dia || '|' || l.len || '|' || s.st);

  -- Rain caps, brackets and hangers: RB{kind}{diameter}{finish}{variant}
  insert into cand
  select 'RB' || k.kc || d.dia || f.fc || v.n,
         k.kind || ' ' || d.dia || '" ' || f.finish || ' STYLE ' || v.n,
         'ACCESSORY', 'bracket', 'ACCESSORY', nl_seed.ri(8, 45, 'item.bracket.price|' || k.kc || d.dia || f.fc || v.n),
         false, false
  from (values ('RC', 'RAIN CAP'), ('MB', 'MOUNTING BRACKET'), ('SB', 'STACK BRACKET'), ('HG', 'HANGER'),
               ('GD', 'GUARD')) as k(kc, kind)
  cross join unnest(array[3, 4, 5, 6, 7, 8, 9, 10]) as d(dia)
  cross join (values ('Z', 'ZINC'), ('S', 'STAINLESS'), ('B', 'BLACK')) as f(fc, finish)
  cross join generate_series(1, 4) as v(n)
  where nl_seed.chance(0.73 * v_s, 'item.bracket|' || k.kc || '|' || d.dia || '|' || f.fc || '|' || v.n);

  -- Kits, assembled from other parts.
  insert into cand
  select 'K-' || (2000 + g.i * 3),
         nl_seed.pick(array['DUAL','SINGLE'], 'item.kit.kind|' || g.i) || ' STACK KIT '
           || nl_seed.pick(array['5','6','7','8'], 'item.kit.dia|' || g.i) || '" '
           || nl_seed.pick(array['CHROME','ALUMINIZED','STAINLESS'], 'item.kit.finish|' || g.i),
         'KITS', 'kit', 'KITS', nl_seed.ri(250, 950, 'item.kit.price|' || g.i), false, false
  from generate_series(1, 800) as g(i)
  where nl_seed.chance(0.625 * v_s, 'item.kit|' || g.i);

  -- Raw material sold to fab shops: tube and sheet.
  insert into cand
  select 'RW-' || (500 + g.i * 3),
         case when nl_seed.chance(0.7, 'item.raw.kind|' || g.i)
              then 'TUBE ' || nl_seed.pick(array['3','3.5','4','5','6','7','8'], 'item.raw.dia|' || g.i) || '" '
                   || nl_seed.pick(array['16GA','14GA','12GA'], 'item.raw.ga|' || g.i) || ' '
                   || nl_seed.pick(array['10FT','20FT'], 'item.raw.len|' || g.i) || ' '
                   || nl_seed.pick(array['ALUMINIZED','STAINLESS 409','STAINLESS 304'], 'item.raw.mat|' || g.i)
              else 'SHEET ' || nl_seed.pick(array['16GA','14GA','11GA'], 'item.raw.ga|' || g.i) || ' '
                   || nl_seed.pick(array['4X8','4X10','5X10'], 'item.raw.size|' || g.i) || ' '
                   || nl_seed.pick(array['ALUMINIZED','STAINLESS 409'], 'item.raw.mat|' || g.i)
         end,
         'RAW', 'raw', 'RAW', nl_seed.ri(20, 180, 'item.raw.price|' || g.i), false, false
  from generate_series(1, 400) as g(i)
  where nl_seed.chance(0.625 * v_s, 'item.raw|' || g.i);

  -- Custom parts, made to order from a drawing.
  insert into cand
  select 'CU-' || (40000 + g.i * 3),
         'CUSTOM ' || nl_seed.pick(array['ELBOW','STACK','Y-PIPE','EXTENSION','TURNOUT','REDUCER','MANIFOLD'],
                                   'item.custom.kind|' || g.i)
           || ' PER DRAWING ' || nl_seed.ri(10000, 99999, 'item.custom.dwg|' || g.i),
         nl_seed.pick(array['ELBOWS','STACKS','PIPE'], 'item.custom.cat|' || g.i),
         'custom', 'PIPE', nl_seed.ri(60, 700, 'item.custom.price|' || g.i), false, false
  from generate_series(1, 6000) as g(i)
  where nl_seed.chance(0.617 * v_s, 'item.custom|' || g.i);

  -- Proprietary parts: one big customer buys each.
  insert into cand
  select 'PR-' || (7000 + g.i * 11),
         'PROPRIETARY ' || nl_seed.pick(array['MANIFOLD ADAPTER','STACK','BRACKET SET','Y-PIPE'], 'item.prop.kind|' || g.i)
           || ' DWG ' || nl_seed.ri(100, 999, 'item.prop.dwg|' || g.i),
         nl_seed.pick(array['ELBOWS','STACKS','ACCESSORY'], 'item.prop.cat|' || g.i),
         'proprietary', 'PIPE', nl_seed.ri(90, 400, 'item.prop.price|' || g.i), false, false
  from generate_series(1, 100) as g(i)
  where g.i <= 2 or nl_seed.chance(0.6 * v_s, 'item.prop|' || g.i);

  -- Vendors actually used on items: a short list, the first few used most.
  v_used := greatest(10, round(132 * v_s))::int;

  insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
                        replenishment, work_center, vendor_no, lead_time, made_to_order, proprietary, blocked)
  select c.item_no, c.description, c.category, c.family, c.product_group,
         round((p.list * (1 - m.margin + nl_seed.gauss(0, 0.02, 'item.margin|' || c.item_no)))::numeric, 2),
         round(p.list::numeric, 2),
         r.replenishment,
         case r.replenishment
           when 'Purchase' then ''
           when 'Assembly' then 'ASSEMBLY'
           else case c.family when 'elbow' then 'BEND CELL' when 'stack' then 'CUT CELL' when 'pipe' then 'CUT CELL'
                              when 'shield' then 'WELD CELL' when 'muffler' then 'WELD CELL'
                              else nl_seed.pick(array['BEND CELL','WELD CELL','CUT CELL'], 'item.wc|' || c.item_no) end
         end,
         case when r.replenishment = 'Purchase' or c.chrome
              then 'V' || (10000 + (1 + floor(v_used * nl_seed.u('item.vendor|' || c.item_no) ^ 2))::int * 10) end,
         case when nl_seed.chance(0.57, 'item.lead|' || c.item_no) then ''
              else nl_seed.pick(array['6W','6W','6W','4W','4W','4W','1D','1D','1D','5W','5W','3W','3W','8W',
                                      '2W','2W','1W','1W','10W','12W'], 'item.lead.v|' || c.item_no) end,
         c.family = 'custom'
           or (c.family in ('elbow', 'stack') and nl_seed.chance(case when c.chrome or c.big then 0.45 else 0.2 end,
                                                                 'item.mto|' || c.item_no))
           or (c.family = 'pipe' and nl_seed.chance(0.1, 'item.mto|' || c.item_no)),
         c.family = 'proprietary',
         nl_seed.chance(case c.family when 'custom' then 0.35 when 'proprietary' then 0 else 0.18 end,
                        'item.blocked|' || c.item_no)
  from cand c
  join (values ('PIPE', 0.907), ('CHROME', 0.809), ('ACCESSORY', 0.77), ('FLEX', 0.78),
               ('MUFFLERS', 0.77), ('RAW', 0.657), ('KITS', 0.78)) as m(product_group, margin)
    on m.product_group = c.product_group
  cross join lateral (
    select c.selling / 0.49 * exp(nl_seed.gauss(0, 0.08, 'item.price|' || c.item_no)) as list
  ) p
  cross join lateral (
    select case c.family
      when 'kit' then 'Assembly'
      when 'custom' then case when nl_seed.chance(0.05, 'item.repl|' || c.item_no) then 'Assembly' else 'Prod. Order' end
      when 'elbow' then case when nl_seed.chance(0.45, 'item.repl|' || c.item_no) then 'Purchase' else 'Prod. Order' end
      when 'stack' then case when nl_seed.chance(0.30, 'item.repl|' || c.item_no) then 'Purchase' else 'Prod. Order' end
      when 'pipe' then case when nl_seed.chance(0.10, 'item.repl|' || c.item_no) then 'Purchase' else 'Prod. Order' end
      when 'muffler' then case when nl_seed.chance(0.80, 'item.repl|' || c.item_no) then 'Purchase' else 'Prod. Order' end
      when 'shield' then 'Prod. Order'
      when 'proprietary' then 'Prod. Order'
      else 'Purchase'
    end as replenishment
  ) r;
  drop table if exists pg_temp.cand;

  -- How popular each part is. Popularity is very uneven (a tenth of the
  -- parts carry most of the sales); custom, blocked and made-to-order parts
  -- sell rarely. Each product group's total is then set to its share of
  -- sales. Proprietary parts are left out: each belongs to one customer.
  insert into nl_seed.item_plan (item_no, seq, weight, lo, hi)
  with raw as (
    select i.item_no, i.product_group,
           exp(nl_seed.gauss(0, 2.6, 'item.pop|' || i.item_no))
           * case when i.family = 'custom' then 0.15 when i.made_to_order then 0.5 else 1 end
           * case when i.blocked then 0.05 else 1 end as w
    from nl.items i
    where not i.proprietary
  ),
  weighted as (
    select r.item_no,
           r.w / sum(r.w) over (partition by r.product_group) * s.share as weight
    from raw r
    -- Line quantities are rounded up to whole pieces, which inflates the
    -- dear groups (kits, custom pipe), so these weights are set below or
    -- above each group's target share of sales (pipe .35, chrome .24,
    -- accessories .16, flex .11, mufflers .09, raw .035, kits .015) until
    -- the built ledger lands on it.
    join (values ('PIPE', 0.234), ('CHROME', 0.245), ('ACCESSORY', 0.338), ('FLEX', 0.199),
                 ('MUFFLERS', 0.074), ('RAW', 0.030), ('KITS', 0.0024)) as s(product_group, share)
      on s.product_group = r.product_group
  ),
  ordered as (
    select item_no, weight, row_number() over (order by item_no)::int as seq,
           sum(weight) over (order by item_no) as cum,
           sum(weight) over () as total
    from weighted
  )
  select item_no, seq, weight, (cum - weight) / total, cum / total
  from ordered;
  update nl_seed.item_plan set hi = 1 where hi = (select max(hi) from nl_seed.item_plan);

  -- What the item master says is on the shelf.
  insert into nl.stock (item_no, on_hand, on_production_order, on_purchase_order, shelf, bin, as_of)
  select i.item_no,
         case when i.made_to_order or i.blocked then 0
              else greatest(0, round(nl_seed.gauss(b.base, b.base * 0.8, 'stock|' || i.item_no)))::int end,
         case when i.replenishment = 'Prod. Order' and not i.blocked and nl_seed.chance(0.2, 'stock.prod|' || i.item_no)
              then (array[10, 25, 50, 100])[nl_seed.ri(1, 4, 'stock.prod.qty|' || i.item_no)] else 0 end,
         case when i.replenishment = 'Purchase' and not i.blocked and nl_seed.chance(0.25, 'stock.purch|' || i.item_no)
              then (array[25, 50, 100, 250])[nl_seed.ri(1, 4, 'stock.purch.qty|' || i.item_no)] else 0 end,
         s.shelf,
         s.shelf || '-' || nl_seed.ri(1, 6, 'stock.bin|' || i.item_no),
         (select today from nl_seed.settings)
  from nl.items i
  join (values ('clamp', 150), ('flex', 30), ('bracket', 60), ('pipe', 20), ('elbow', 8), ('stack', 4),
               ('muffler', 6), ('shield', 8), ('kit', 2), ('raw', 15), ('proprietary', 10), ('custom', 0)) as b(family, base)
    on b.family = i.family
  cross join lateral (
    select substr('ABCDEFGHJK', nl_seed.ri(1, 10, 'stock.shelf|' || i.item_no), 1)
           || '-' || nl_seed.ri(1, 40, 'stock.shelf.n|' || i.item_no) as shelf
  ) s;
end $$;

-- ---------------------------------------------------------------------------
-- Step 1c: customers
-- ---------------------------------------------------------------------------

-- The customer master of a parts maker is mostly history: about a fifth of
-- the accounts never bought, another fifth stopped before the invoice
-- history starts, and the rest come and go. Revenue per customer is
-- lognormal (a few big accounts carry most of the business), and each
-- account buys in a given year with a probability that grows with its size.
create or replace function nl_seed.build_customers() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set      nl_seed.settings;
  v_n        int;
  v_years    int;
  v_parents  int;
  v_kid_cap  int;
  v_history  date;
begin
  select * into v_set from nl_seed.settings;
  v_n := round(4490 * v_set.scale)::int;
  v_years := v_set.last_year - v_set.first_year + 1;
  v_parents := greatest(2, round(164 * v_set.scale))::int;
  v_kid_cap := case v_set.size when 'full' then 300 else ceil(v_n * 0.08)::int end;
  v_history := make_date(v_set.first_year, 1, 1);

  -- Life stages, in the proportions of a real customer master.
  insert into nl_seed.portfolio (customer_no, seq, kind, z, ln_rev, first_idx, last_idx, q)
  with drawn as (
    select g.seq,
           case when nl_seed.u('cust.kind|' || g.seq) < 0.21 then 'never'
                when nl_seed.u('cust.kind|' || g.seq) < 0.41 then 'lapsed'
                when nl_seed.u('cust.kind|' || g.seq) < 0.81 then 'alive'
                else 'new' end as kind,
           nl_seed.gauss(0, 1, 'cust.z|' || g.seq) as z
    from generate_series(1, v_n) as g(seq)
  ),
  lives as (
    select d.*,
           -- Years until the account stops buying: a geometric draw whose
           -- rate falls with size (big accounts last).
           ceil(ln(1 - nl_seed.u('cust.life|' || d.seq))
                / ln(1 - least(0.6, greatest(0.04, 0.06 - 0.03 * d.z))))::int as life,
           case when d.kind = 'new' then nl_seed.ri(1, v_years - 1, 'cust.start|' || d.seq) else 0 end as start_idx
    from drawn d
  ),
  numbered as (
    -- Older accounts carry lower numbers, the way a real customer master does.
    select l.*,
           row_number() over (order by
             case l.kind when 'lapsed' then 0
                         when 'alive' then 1
                         when 'new' then 2 + l.start_idx
                         else nl_seed.u('cust.never.at|' || l.seq) * (v_years + 2) end,
             nl_seed.u('cust.no|' || l.seq)) as rank
    from lives l
  )
  select (1100 + n.rank * 5 + nl_seed.ri(0, 4, 'cust.no.jitter|' || n.seq))::text,
         n.seq, n.kind, n.z, 7.65 + 1.66 * n.z,
         case when n.kind in ('never', 'lapsed') then 1 else n.start_idx end,
         case when n.kind in ('never', 'lapsed') then 0 else n.start_idx + n.life - 1 end,
         1 / (1 + exp(-(1.6 + 1.2 * n.z)))
  from numbered n;

  -- Chains: a head office with branches billed to it. Most chains have one
  -- or two branches; a few have dozens.
  update nl_seed.portfolio p set is_parent = true
  from (
    select customer_no from nl_seed.portfolio
    where kind in ('alive', 'new')
    order by z + nl_seed.gauss(0, 1, 'cust.parent|' || customer_no) desc
    limit v_parents
  ) x
  where p.customer_no = x.customer_no;

  with par as (
    select customer_no, row_number() over (order by customer_no) as rn,
           least(v_kid_cap,
             case when nl_seed.u('cust.kids|' || customer_no) < 0.415 then 1
                  when nl_seed.u('cust.kids|' || customer_no) < 0.604 then nl_seed.ri(2, 3, 'cust.kids.n|' || customer_no)
                  when nl_seed.u('cust.kids|' || customer_no) < 0.902 then nl_seed.ri(4, 10, 'cust.kids.n|' || customer_no)
                  when nl_seed.u('cust.kids|' || customer_no) < 0.994 then nl_seed.ri(11, 50, 'cust.kids.n|' || customer_no)
                  else nl_seed.ri(51, 294, 'cust.kids.n|' || customer_no) end) as kids
    from nl_seed.portfolio where is_parent
  ),
  ranges as (
    select customer_no, sum(kids) over (order by rn) - kids as lo, sum(kids) over (order by rn) as hi
    from par
  ),
  pool as (
    select customer_no, row_number() over (order by nl_seed.u('cust.child|' || customer_no)) - 1 as pn
    from nl_seed.portfolio where not is_parent
  )
  update nl_seed.portfolio p set parent_no = r.customer_no
  from pool
  join ranges r on pool.pn >= r.lo and pool.pn < r.hi
  where p.customer_no = pool.customer_no;

  -- The customer master. Head offices and independents first, then branches,
  -- which take their head office's owner, agency, price group and domain.
  insert into nl.customers (customer_no, name, city, state, country, email_domain, price_group,
                            ships_own_carrier, blocked, closed, owner_id, agency_id, customer_since)
  with roots as (
    -- Head offices and independents each get a name: independents from the
    -- place-and-trade list, head offices from the chain list.
    select p.customer_no,
           row_number() over (partition by p.is_parent order by nl_seed.u('cust.name.pick|' || p.customer_no)) as name_rank
    from nl_seed.portfolio p
    where p.parent_no is null
  ),
  names as (
    select row_number() over (order by nl_seed.u('cust.name|' || x.name)) as name_rank, x.name
    from (
      select distinct w || ' ' || k as name
      from unnest(array['Amarillo','Bayou','Big Sky','Cascade','Prairie','Gulf Coast','High Plains','Ironhorse',
        'Panhandle','Red River','Rio Grande','Rocky Mountain','Sandhills','Sooner','Timberline','Tidewater',
        'Yellowstone','Ozark','Piney Woods','Blue Ridge','Great Basin','Copper State','Badlands','Cimarron',
        'Brazos','Pecos','Wasatch','Bitterroot','Sabine','Palo Duro','Llano','Caprock','Sangre','Front Range',
        'Snake River','Four Corners','Permian','Trinity','Guadalupe','Sierra','Lakeland','Tri-State','Midway',
        'Crossroads','Interstate','Northfork','Southfork','Eastgate','Westgate','Riverside','Hilltop','Keystone',
        'Cornbelt','Heartland','Bluegrass','Magnolia','Palmetto','Suwannee','Chattahoochee','Cumberland',
        'Allegheny','Shenandoah','Catskill','Adirondack','Green Mountain','Kennebec','Merrimack','Mohawk',
        'Wabash','Maumee','Kankakee','Fox Valley','Driftless','Iron Range','Red Cedar','Black Hills','Platte',
        'Flint Hills','Smoky Hill','Arbuckle','Ouachita','Delta','Gulfport','Coastal','Cypress','Live Oak',
        'Mesa','Canyon','Juniper','Sagebrush','Tumbleweed','Longhorn','Mustang','Bison','Eagle Pass',
        'Hill Country','Twin Rivers','Three Forks','Clearwater','Stillwater','Deer Creek','Elk Ridge',
        'Pine Bluff','Cedar Creek','Willow Creek','Bear Creek','Silver Lake','Grand Prairie']) as w,
           unnest(array['Truck Parts','Diesel Supply','Fleet Service','Chrome & Stack','Truck Center',
        'Heavy Duty Parts','Trailer & Truck','Freight Systems','Truck Repair','Equipment Co.','Exhaust Pros',
        'Diesel Works','Fleet Maintenance','Truck & Tractor','Parts Warehouse','Transport Supply',
        'Truck Accessories','Muffler Shop','Diesel Repair','Truck Stop Service','Fleet Parts','Driveline',
        'Custom Chrome','Truck Outfitters','Service Center','Diesel & Welding','Parts Depot','Truck Sales',
        'Lube & Tire','Machine & Fab','Hauling Supply','Big Rig Parts','Rig Shop','Towing & Repair',
        'Mobile Diesel','Heavy Haul Supply','Truck Wash & Parts','Fab Shop','Industrial Supply','Ag & Fleet']) as k
      union
      select distinct s || ' ' || k
      from unnest(array['Garza','Holloway','Ibarra','Jennings','Keller','Moreno','Navarro','Pruitt','Quintero',
        'Sandoval','Underwood','Whitfield','Yates','Ashworth','Crowley','Fairbanks','Gallagher','Iverson',
        'Kowalski','Mendoza','Novak','Rasmussen','Sorensen','Thibodeaux','Wexler','Delgado','Brandvold',
        'Hargrove','McAlister','Stroud']) as s,
           unnest(array['Truck Parts','Diesel Supply','Fleet Service','Truck Repair','Diesel Works',
        'Muffler Shop','Diesel Repair','Service Center','Truck & Tractor','Towing & Repair',
        'Mobile Diesel','Fab Shop','& Sons Truck Parts','Brothers Diesel','Family Truck Center']) as k
    ) x
  ),
  chain_names as (
    select row_number() over (order by nl_seed.u('chain.name|' || x.name)) as name_rank, x.name
    from (
      select b || ' ' || k as name
      from unnest(array['TruckSource','Fleetline','Lone Star','Roadmaster','Highway','Dieselpoint','Rigline',
        'Truckworks','Haulmark','Axle','Mileage','Waypoint','Cross Country','Longhaul','Overland','Route 66',
        'Transcon','Keystone Fleet','Midstates','Coast to Coast','Big Wheel','Iron Mile','Gearhead','Bulldog',
        'Northway','Southway','Pathfinder','Trailhead','Crossline','Freightway','Rigmaster','Redline',
        'Blue Diamond','Silver State','Golden Spike','Pony Express','Cardinal Fleet','Liberty Fleet',
        'Patriot Diesel','Eagle Fleet','Summit Fleet','Continental Truck','United Heavy Duty','Allied Fleet',
        'Mainline','Frontline','Topline','Primeline','Diamondback','Steelhorse']) as b,
           unnest(array['Parts','Truck Centers','Fleet Supply','Diesel','Heavy Duty']) as k
    ) x
  ),
  places as (
    select row_number() over (order by ord) as n, city, state, country
    from (
      select ord, split_part(c, '|', 1) as city, split_part(c, '|', 2) as state, 'US' as country
      from unnest(array['Houston|TX','Dallas|TX','San Antonio|TX','Fort Worth|TX','El Paso|TX','Amarillo|TX',
        'Lubbock|TX','Odessa|TX','Laredo|TX','Beaumont|TX','Tyler|TX','Corpus Christi|TX','Waco|TX','Abilene|TX',
        'Oklahoma City|OK','Tulsa|OK','Lawton|OK','Shreveport|LA','Lafayette|LA','Baton Rouge|LA','Little Rock|AR',
        'Fort Smith|AR','Texarkana|AR','Denver|CO','Grand Junction|CO','Pueblo|CO','Billings|MT','Missoula|MT',
        'Boise|ID','Idaho Falls|ID','Spokane|WA','Yakima|WA','Tacoma|WA','Medford|OR','Portland|OR','Reno|NV',
        'Las Vegas|NV','Salt Lake City|UT','Ogden|UT','Casper|WY','Cheyenne|WY','Albuquerque|NM','Las Cruces|NM',
        'Phoenix|AZ','Tucson|AZ','Fresno|CA','Bakersfield|CA','Stockton|CA','Sacramento|CA','Ontario|CA',
        'Toledo|OH','Akron|OH','Columbus|OH','Dayton|OH','Cincinnati|OH','Erie|PA','Harrisburg|PA','Allentown|PA',
        'Pittsburgh|PA','Gary|IN','Indianapolis|IN','Fort Wayne|IN','Rockford|IL','Joliet|IL','Peoria|IL',
        'Green Bay|WI','Madison|WI','Milwaukee|WI','Des Moines|IA','Cedar Rapids|IA','Davenport|IA','Omaha|NE',
        'Lincoln|NE','Sioux Falls|SD','Rapid City|SD','Fargo|ND','Bismarck|ND','Minneapolis|MN','St. Cloud|MN',
        'Kansas City|MO','Springfield|MO','St. Louis|MO','Wichita|KS','Salina|KS','Jacksonville|FL','Tampa|FL',
        'Orlando|FL','Mobile|AL','Birmingham|AL','Montgomery|AL','Jackson|MS','Memphis|TN','Nashville|TN',
        'Chattanooga|TN','Knoxville|TN','Atlanta|GA','Savannah|GA','Macon|GA','Charlotte|NC','Greensboro|NC',
        'Columbia|SC','Greenville|SC','Richmond|VA','Roanoke|VA','Louisville|KY','Lexington|KY','Charleston|WV',
        'Baltimore|MD','Albany|NY','Syracuse|NY','Buffalo|NY','Hartford|CT','Worcester|MA','Manchester|NH',
        'Bangor|ME','Detroit|MI','Grand Rapids|MI','Lansing|MI','Saginaw|MI']) with ordinality as t(c, ord)
      union all
      select 1000 + ord, split_part(c, '|', 1), split_part(c, '|', 2), 'CA'
      from unnest(array['Calgary|AB','Edmonton|AB','Red Deer|AB','Cranbrook|BC','Kamloops|BC','Winnipeg|MB',
        'Regina|SK','Saskatoon|SK','Mississauga|ON','London|ON','Sudbury|ON','Moncton|NB']) with ordinality as t(c, ord)
      union all
      -- Outside the US and Canada the state column stays blank: those
      -- countries' regions are not two-letter postal codes, and the app
      -- shows 'City, Country' for them.
      select 2000 + ord, split_part(c, '|', 1), '', split_part(c, '|', 2)
      from unnest(array['Monterrey|MX','León|MX','Saltillo|MX','Chihuahua|MX','Santiago|CL',
        'Bogotá|CO','Lima|PE','Panama City|PA']) with ordinality as t(c, ord)
    ) all_places
  ),
  located as (
    -- 97% of customers are in the US, 2% in Canada, 1% further south.
    select p.customer_no,
           (select pl.n from places pl
             where pl.country = case when nl_seed.u('cust.country|' || p.customer_no) < 0.97 then 'US'
                                     when nl_seed.u('cust.country|' || p.customer_no) < 0.99 then 'CA'
                                     else 'XX' end
                or (pl.country not in ('US', 'CA') and nl_seed.u('cust.country|' || p.customer_no) >= 0.99)
             order by nl_seed.u('cust.city|' || p.customer_no || '|' || pl.n)
             limit 1) as place_n
    from nl_seed.portfolio p
  ),
  heads as (
    select p.customer_no, p.kind, p.z, p.first_idx, p.last_idx,
           case when p.is_parent then cn.name || ' - ' || pl.city else nm.name end as name,
           pl.city, pl.state, pl.country
    from nl_seed.portfolio p
    join roots r on r.customer_no = p.customer_no
    left join names nm on nm.name_rank = r.name_rank and not p.is_parent
    left join chain_names cn on cn.name_rank = r.name_rank and p.is_parent
    join located lo on lo.customer_no = p.customer_no
    join places pl on pl.n = lo.place_n
  )
  select h.customer_no, h.name, h.city, h.state, h.country,
         nl_seed.slug(case when position(' - ' in h.name) > 0 then split_part(h.name, ' - ', 1) else h.name end)
           || '.example',
         case when h.z > 1.88 then 'MASTER' when h.z > 1.04 then 'ELITE' when h.z > 0.25 then 'PERFORMANC'
              when h.z > -1.04 then 'DEALER' else 'JOBBER' end,
         nl_seed.chance(0.10, 'cust.carrier|' || h.customer_no),
         nl_seed.chance(case when h.kind = 'never' then 0.6
                             when h.kind = 'lapsed' then 0.85
                             when h.last_idx < v_years - 1 then 0.4
                             else 0.02 end, 'cust.blocked|' || h.customer_no),
         h.kind = 'lapsed' and nl_seed.chance(0.1, 'cust.closed|' || h.customer_no),
         case when nl_seed.chance(case when h.kind in ('never', 'lapsed') then 0.4 else 0.16 end,
                                  'cust.unowned|' || h.customer_no) then null
              else nl_seed.owner_for('cust|' || h.customer_no) end,
         nl_seed.agency_for('cust|' || h.customer_no),
         case h.kind
           when 'lapsed' then v_history - nl_seed.ri(400, 8000, 'cust.since|' || h.customer_no)
           when 'alive' then v_history - nl_seed.ri(100, 6000, 'cust.since|' || h.customer_no)
           when 'new' then make_date(v_set.first_year + h.first_idx, 1, 1)
                           + nl_seed.ri(0, 150, 'cust.since|' || h.customer_no)
           else least(v_set.today - 1, v_history - 3000 + nl_seed.ri(0, 3000 + (v_set.today - v_history),
                                                                   'cust.since|' || h.customer_no))
         end
  from heads h
  order by h.customer_no;

  -- Branches.
  insert into nl.customers (customer_no, name, bill_to_no, city, state, country, email_domain, price_group,
                            ships_own_carrier, blocked, closed, owner_id, agency_id, customer_since)
  select b.customer_no,
         split_part(hq.name, ' - ', 1) || ' - ' || b.city
           || case when b.dup > 1 then ' ' || b.dup else '' end,
         hq.customer_no, b.city, b.state, hq.country, hq.email_domain, hq.price_group,
         hq.ships_own_carrier,
         nl_seed.chance(case when b.kind in ('never', 'lapsed') then 0.5 else 0.03 end, 'cust.blocked|' || b.customer_no),
         false, hq.owner_id, hq.agency_id,
         greatest(hq.customer_since, v_history - nl_seed.ri(0, 2000, 'cust.since|' || b.customer_no))
  from (
    select p.customer_no, p.parent_no, p.kind, x.city, x.state,
           row_number() over (partition by p.parent_no, x.city order by p.customer_no) as dup
    from nl_seed.portfolio p
    cross join lateral (
      select split_part(c, '|', 1) as city, split_part(c, '|', 2) as state
      from (select nl_seed.pick(array['Houston|TX','San Antonio|TX','Oklahoma City|OK','Tulsa|OK','Little Rock|AR',
        'Shreveport|LA','Salt Lake City|UT','Albuquerque|NM','Cheyenne|WY','Billings|MT','Waco|TX','Abilene|TX',
        'Lubbock|TX','Denver|CO','Phoenix|AZ','Tucson|AZ','Reno|NV','Boise|ID','Spokane|WA','Portland|OR',
        'Fresno|CA','Stockton|CA','Omaha|NE','Des Moines|IA','Kansas City|MO','St. Louis|MO','Wichita|KS',
        'Memphis|TN','Nashville|TN','Atlanta|GA','Birmingham|AL','Jackson|MS','Charlotte|NC','Columbia|SC',
        'Richmond|VA','Louisville|KY','Indianapolis|IN','Columbus|OH','Toledo|OH','Detroit|MI','Chicago|IL',
        'Milwaukee|WI','Minneapolis|MN','Fargo|ND','Sioux Falls|SD','Jacksonville|FL','Tampa|FL',
        'Pittsburgh|PA','Harrisburg|PA','Buffalo|NY'], 'cust.branch.city|' || p.customer_no) as c) y
    ) x
    where p.parent_no is not null
  ) b
  join nl.customers hq on hq.customer_no = b.parent_no
  order by b.customer_no;

  -- People at each customer: two in three accounts have a contact on file,
  -- almost always exactly one. Branches get their branch manager.
  insert into nl.contacts (customer_no, full_name, title, email, phone, is_primary)
  select c.customer_no, x.full_name, x.title,
         lower(replace(x.full_name, ' ', '.')) || '@' || c.email_domain,
         nl_seed.phone('contact.phone|' || c.customer_no || '|' || g.n),
         g.n = 1
  from nl.customers c
  join nl_seed.portfolio p on p.customer_no = c.customer_no
  cross join lateral generate_series(1,
    case when not nl_seed.chance(case when p.kind in ('alive', 'new') then 0.8 else 0.47 end,
                                 'contacts|' || c.customer_no) then 0
         when nl_seed.chance(0.9, 'contacts.n|' || c.customer_no) then 1
         when nl_seed.chance(0.8, 'contacts.n2|' || c.customer_no) then 2
         else 3 end) as g(n)
  cross join lateral (
    select nl_seed.person('contact|' || c.customer_no || '|' || g.n) as full_name,
           case when c.bill_to_no is not null and g.n = 1 then 'Branch Manager'
                else nl_seed.pick(array['Parts Manager','Purchasing','Owner','General Manager','Buyer',
                                        'Service Manager','Counter Lead','Operations Manager'],
                                  'contact.title|' || c.customer_no || '|' || g.n) end as title
  ) x
  order by c.customer_no, g.n;
end $$;

-- ---------------------------------------------------------------------------
-- Step 1d: buying years and baskets
-- ---------------------------------------------------------------------------

create or replace function nl_seed.build_baskets() returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Each buying year: revenue, how many different parts, how many lines,
  -- how many order days. Bigger accounts buy more parts, more often, with
  -- more lines per part (the relationships were fitted on real ledgers of
  -- this kind; the constants are theirs, the dollars are shifted).
  insert into nl_seed.cust_year (customer_no, year, revenue, lines, days)
  select p.customer_no, y.year,
         exp(r.ln_r) * y.frac * 0.4,
         greatest(k.parts, round(k.parts * (1 + 0.42 * greatest(0, r.ln_r - 8)) * y.frac * y.line_mult))::int,
         least(ceil(250 * y.frac)::int + 1,
               greatest(1, round(exp(1.1 + 0.8 * (r.ln_r - 7.65)
                                     + nl_seed.gauss(0, 0.3, 'cy.days|' || p.customer_no || '|' || y.year)) * y.frac)))::int
  from nl_seed.portfolio p
  join nl_seed.years y on y.idx between p.first_idx and p.last_idx
  join nl.customers c on c.customer_no = p.customer_no
  cross join lateral (
    select p.ln_rev + nl_seed.gauss(0, 0.7, 'cy.rev|' || p.customer_no || '|' || y.year) + ln(y.rev_mult) as ln_r
  ) r
  cross join lateral (
    select greatest(1, round(exp(-3.92 + 0.765 * r.ln_r
                                 + nl_seed.gauss(0, 0.35, 'cy.parts|' || p.customer_no || '|' || y.year))))::int as parts
  ) k
  where (p.kind = 'new' and y.idx = p.first_idx)
     or nl_seed.chance(p.q, 'cy.active|' || p.customer_no || '|' || y.year);

  -- A lifetime basket, about seven years of parts: draws from the catalog
  -- by popularity, each part weighted by how much of the account's
  -- business it takes. Proprietary parts go to the biggest live accounts.
  insert into nl_seed.baskets (customer_no, item_no, lo, hi)
  with buyers as (
    select p.customer_no, p.ln_rev,
           ceil(exp(-3.92 + 0.765 * p.ln_rev) * 7)::int as draws
    from nl_seed.portfolio p
    where exists (select 1 from nl_seed.cust_year cy where cy.customer_no = p.customer_no)
  ),
  drawn as (
    select distinct b.customer_no, ip.item_no
    from buyers b
    cross join lateral generate_series(1, b.draws) as g(j)
    cross join lateral (
      select x.item_no from nl_seed.item_plan x
      where x.hi > nl_seed.u('basket|' || b.customer_no || '|' || g.j)
      order by x.hi, x.seq
      limit 1
    ) ip
  ),
  weighted as (
    select d.customer_no, d.item_no,
           exp(nl_seed.gauss(0, 1.6, 'basket.w|' || d.customer_no || '|' || d.item_no)) as w
    from drawn d
  ),
  owners as (
    -- The proprietary parts, one each to the biggest accounts still buying.
    select pr.item_no, big.customer_no
    from (select item_no, row_number() over (order by item_no) as n from nl.items where proprietary) pr
    join (select b.customer_no, row_number() over (order by b.ln_rev desc) as n
          from buyers b
          join nl_seed.portfolio p on p.customer_no = b.customer_no
          where p.last_idx >= (select max(idx) from nl_seed.years)) big
      on big.n = pr.n
  ),
  all_rows as (
    select customer_no, item_no, w from weighted
    union all
    select o.customer_no, o.item_no, 0.08 * (select sum(w) from weighted x where x.customer_no = o.customer_no)
    from owners o
  ),
  ordered as (
    select customer_no, item_no, w,
           sum(w) over (partition by customer_no order by item_no) as cum,
           sum(w) over (partition by customer_no) as total
    from all_rows
  )
  select customer_no, item_no, (cum - w) / total,
         case when cum = total then 1 else cum / total end
  from ordered;
end $$;

-- ---------------------------------------------------------------------------
-- Step 2: one year of invoices
-- ---------------------------------------------------------------------------

-- For every account that bought this year: pick its order days (weekdays,
-- following the seasonality), spread its lines over its basket and those
-- days, and size each line so the year adds up to the account's revenue.
-- Lines for the same part on the same day merge. One invoice per account
-- per day, numbered in date order. Then freight, and credit memos.
create or replace function nl_seed.build_year(p_year int) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_set   nl_seed.settings;
  v_yr    nl_seed.years;
  v_inv   int;
  v_memos int;
  v_lines int;
begin
  select * into v_set from nl_seed.settings;
  select * into v_yr from nl_seed.years where year = p_year;
  if not found then
    raise exception 'Year % is outside this world (% to %).', p_year, v_set.first_year, v_set.last_year;
  end if;
  if exists (select 1 from nl.invoices where doc_type = 'invoice' and posted_on >= make_date(p_year, 1, 1)) then
    raise exception 'Year % (or a later one) is already built. Build the years in order, once.', p_year;
  end if;

  drop table if exists pg_temp.yr_days, pg_temp.yr_lines, pg_temp.yr_invoices;

  -- Order days. A draw below the share of the year that has happened picks
  -- a month by its seasonal share and a day inside it, so this year's days
  -- all fall before today.
  create temporary table yr_days as
  select cy.customer_no, g.n as day_no,
         case
           when extract(isodow from d.day) = 6 then d.day - 1
           when extract(isodow from d.day) = 7 and d.day + 1 < v_set.today
                and extract(year from d.day + 1) = p_year then d.day + 1
           when extract(isodow from d.day) = 7 then d.day - 2
           else d.day
         end as day
  from nl_seed.cust_year cy
  cross join lateral generate_series(1, cy.days) as g(n)
  cross join lateral (select nl_seed.u('day|' || cy.customer_no || '|' || p_year || '|' || g.n) * v_yr.frac as x) r
  join nl_seed.months m on r.x >= m.cum_lo and r.x < m.cum_hi
  cross join lateral (
    select make_date(p_year, m.month, 1)
           + floor((r.x - m.cum_lo) / m.share
                   * extract(day from make_date(p_year, m.month, 1) + interval '1 month - 1 day'))::int as day
  ) d
  where cy.year = p_year;
  alter table yr_days add primary key (customer_no, day_no);

  -- Lines, merged per account, day and part.
  create temporary table yr_lines as
  select l.customer_no, l.day, l.item_no, l.unit_price, sum(l.qty)::int as qty
  from (
    select cy.customer_no, dd.day, b.item_no,
           pr.unit_price,
           greatest(1, round(cy.revenue / cy.lines
                             * exp(nl_seed.gauss(0, 1.3, 'line.amt|' || cy.customer_no || '|' || p_year || '|' || g.j) - 0.845)
                             / pr.unit_price))::int as qty
    from nl_seed.cust_year cy
    cross join lateral generate_series(1, cy.lines) as g(j)
    cross join lateral (
      select x.item_no from nl_seed.baskets x
      where x.customer_no = cy.customer_no
        and x.hi > nl_seed.u('line|' || cy.customer_no || '|' || p_year || '|' || g.j)
      order by x.hi
      limit 1
    ) b
    join yr_days dd
      on dd.customer_no = cy.customer_no
     -- Most order days carry a single line; the rest of the lines crowd
     -- onto a few big stock-order days (the low day numbers). An account
     -- with fewer lines than days gets one line per day.
     and dd.day_no = case
           when cy.lines <= cy.days then g.j
           when g.j <= floor(0.7 * cy.days) then cy.days - floor(0.7 * cy.days)::int + g.j
           else 1 + floor((cy.days - floor(0.7 * cy.days))
                          * power(nl_seed.u('line.day|' || cy.customer_no || '|' || p_year || '|' || g.j), 1.5))::int
         end
    join nl.customers c on c.customer_no = cy.customer_no
    join nl.price_groups pg on pg.code = c.price_group
    join nl.items i on i.item_no = b.item_no
    -- One price per account, part and year: the tier discount, give or take.
    cross join lateral (
      select greatest(0.5, round((i.list_price * (1 - pg.discount)
               * exp(nl_seed.gauss(0, 0.02, 'price|' || cy.customer_no || '|' || b.item_no || '|' || p_year)))::numeric, 2))
             as unit_price
    ) pr
    where cy.year = p_year
  ) l
  group by l.customer_no, l.day, l.item_no, l.unit_price;

  -- One invoice per account per day, in date order.
  create temporary table yr_invoices as
  select v_set.invoices + row_number() over (order by s.day, s.customer_no) as seq,
         s.customer_no, s.day, s.subtotal
  from (
    select customer_no, day, sum(round(qty * unit_price, 2)) as subtotal
    from yr_lines
    group by customer_no, day
  ) s;

  -- Freight: most small orders pay it, big orders ship free, and an account
  -- on its own carrier never pays it.
  insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, order_no, customer_po,
                           subtotal, freight)
  select 'SI' || (700000 + v.seq), 'invoice', v.customer_no, coalesce(c.bill_to_no, c.customer_no), v.day,
         'SO' || (600000 + v.seq),
         case when nl_seed.u('po|' || v.seq) < 0.2 then ''
              when nl_seed.u('po|' || v.seq) < 0.6 then nl_seed.ri(10000, 999999, 'po.no|' || v.seq)::text
              else 'PO-' || nl_seed.ri(1000, 99999, 'po.no|' || v.seq) end,
         v.subtotal,
         case
           when c.ships_own_carrier then 0
           when not nl_seed.chance(case when v.subtotal < 250 then 0.85 when v.subtotal < 1000 then 0.78
                                        when v.subtotal < 1800 then 0.38 when v.subtotal < 5000 then 0.045
                                        else 0 end, 'freight|' || v.seq) then 0
           else round(least(400, greatest(5, exp(ln(15) + nl_seed.gauss(0, 0.6, 'freight.amt|' || v.seq))
                                              * power(greatest(v.subtotal, 1) / 274, 0.2)))::numeric, 2)
         end
  from yr_invoices v
  join nl.customers c on c.customer_no = v.customer_no
  order by v.seq;

  insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
  select 'SI' || (700000 + v.seq),
         row_number() over (partition by v.seq order by l.item_no),
         l.customer_no, l.day, l.item_no, l.qty, l.unit_price, round(l.qty * l.unit_price, 2), i.unit_cost
  from yr_lines l
  join yr_invoices v on v.customer_no = l.customer_no and v.day = l.day
  join nl.items i on i.item_no = l.item_no;
  get diagnostics v_lines = row_count;

  -- Credit memos on about one invoice in ten, five to forty days later.
  -- One in five is a return: some pieces of one line come back. The rest
  -- correct the price: every line of the invoice is credited a share.
  insert into nl_seed.memo_work (memo_no, line_no, invoice_no, customer_no, bill_to_no, posted_on, customer_po,
                                 item_no, quantity, unit_price, amount, unit_cost)
  with picked as (
    select 'CM' || (800000 + v_set.memos
                    + row_number() over (order by m.credit_day, inv.invoice_no)) as memo_no,
           inv.invoice_no, inv.customer_no, inv.bill_to_no, inv.customer_po, m.credit_day,
           nl_seed.chance(0.2, 'memo.kind|' || inv.invoice_no) as is_return,
           (0.2 + 0.8 * nl_seed.u('memo.qty|' || inv.invoice_no))::numeric as return_share,
           (0.05 + 0.35 * nl_seed.u('memo.adj|' || inv.invoice_no))::numeric as price_share
    from nl.invoices inv
    cross join lateral (
      select inv.posted_on + nl_seed.ri(5, 40, 'memo.day|' || inv.invoice_no) as credit_day
    ) m
    where inv.doc_type = 'invoice'
      and inv.posted_on between make_date(p_year, 1, 1) and v_set.today - 41
      and nl_seed.chance(0.10, 'memo|' || inv.invoice_no)
  )
  select pk.memo_no, row_number() over (partition by pk.memo_no order by l.line_no),
         pk.invoice_no, pk.customer_no, pk.bill_to_no, pk.credit_day, pk.customer_po,
         l.item_no,
         case when pk.is_return then -greatest(1, round(l.quantity * pk.return_share))::int else 0 end,
         case when pk.is_return then l.unit_price else 0 end,
         case when pk.is_return then -round(l.unit_price * greatest(1, round(l.quantity * pk.return_share)), 2)
              else -round(l.amount * pk.price_share, 2) end,
         l.unit_cost
  from picked pk
  join nl.invoice_lines l on l.invoice_no = pk.invoice_no
  where not pk.is_return
     or l.line_no = (select l2.line_no from nl.invoice_lines l2
                      where l2.invoice_no = pk.invoice_no
                      order by nl_seed.u('memo.line|' || l2.invoice_no || '|' || l2.line_no)
                      limit 1);

  select count(distinct memo_no) into v_memos from nl_seed.memo_work;

  insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, customer_po, applies_to, subtotal)
  select memo_no, 'credit_memo', min(customer_no), min(bill_to_no), min(posted_on), min(customer_po),
         min(invoice_no), sum(amount)
  from nl_seed.memo_work
  group by memo_no
  order by memo_no;

  insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
  select memo_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost
  from nl_seed.memo_work;

  delete from nl_seed.memo_work;

  select count(*) into v_inv from yr_invoices;
  update nl_seed.settings set invoices = invoices + v_inv, memos = memos + v_memos;
  drop table if exists pg_temp.yr_days, pg_temp.yr_lines, pg_temp.yr_invoices;

  return jsonb_build_object('year', p_year, 'invoices', v_inv, 'lines', v_lines, 'credit_memos', v_memos);
end $$;

-- ---------------------------------------------------------------------------
-- Step 3: commitments, notes, next steps
-- ---------------------------------------------------------------------------

-- Past commitments, set-based: windows on real buying history. Most were
-- kept (the ledger shows it); a few were pushed or broken and someone said so.
create or replace function nl_seed.build_history() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set    nl_seed.settings;
  v_kept   int;
  v_short  int;
  v_min    numeric;
begin
  select * into v_set from nl_seed.settings;
  v_kept := case v_set.size when 'full' then 2553 when 'demo' then 170 else 2 end;
  v_short := case v_set.size when 'full' then 50 when 'demo' then 9 else 0 end;
  v_min := case v_set.size when 'small' then 500 else 600 end;

  drop table if exists pg_temp.hist;

  -- Candidate windows: a head office or independent account, in a year it
  -- bought, 45 to 180 days long, closed at least a month ago.
  create temporary table hist as
  with windows as (
    select cy.customer_no, s.starts_on, s.starts_on + nl_seed.ri(45, 180, 'hist.len|' || cy.customer_no || '|' || cy.year) as ends_on,
           nl_seed.u('hist.pick|' || cy.customer_no || '|' || cy.year) as pick
    from nl_seed.cust_year cy
    join nl.customers c on c.customer_no = cy.customer_no and c.bill_to_no is null
    cross join lateral (
      select make_date(cy.year, 1, 1) + nl_seed.ri(0, 300, 'hist.start|' || cy.customer_no || '|' || cy.year) as starts_on
    ) s
    where cy.revenue >= v_min * 2
  ),
  chosen as (
    select w.*, row_number() over (order by w.pick) as n
    from windows w
    where w.ends_on < v_set.today - 30
    order by w.pick
    limit (v_kept + v_short) * 6
  ),
  bought as (
    -- What the family bought in the window, part by part.
    select ch.n, il.item_no, sum(il.amount) as amount
    from chosen ch
    join nl.customers f on f.customer_no = ch.customer_no or f.bill_to_no = ch.customer_no
    join nl.invoice_lines il
      on il.customer_no = f.customer_no
     and il.posted_on between ch.starts_on and ch.ends_on
    group by ch.n, il.item_no
  ),
  scoped as (
    select b.*, row_number() over (partition by b.n order by b.amount desc, b.item_no) as rank
    from bought b
    where b.amount > 0
  ),
  summed as (
    select ch.n, ch.customer_no, ch.starts_on, ch.ends_on,
           array_agg(s.item_no order by s.rank) as items,
           sum(s.amount) as delivered
    from chosen ch
    join scoped s on s.n = ch.n and s.rank <= nl_seed.ri(2, 8, 'hist.parts|' || ch.n)
    group by ch.n, ch.customer_no, ch.starts_on, ch.ends_on
  )
  select row_number() over (order by s.n) as k, s.*
  from summed s
  where s.delivered >= v_min;

  -- The first few fell short; the rest were kept.
  insert into nl.commitments (id, title, customer_no, buyer_contact_id, owner_id, committed_value,
                              starts_on, ends_on, confidence, created_by, created_at)
  overriding system value
  select 3000 + row_number() over (order by h.starts_on, h.k),
         case when h.k > v_short then nl_seed.title_for(h.items, 'hist|' || h.k)
              else nl_seed.pick(array['Stocking order that slipped', 'Program lost to a competitor',
                                      'Fleet order on hold'], 'hist.short.title|' || h.k) end,
         h.customer_no,
         (select ct.id from nl.contacts ct where ct.customer_no = h.customer_no order by ct.is_primary desc, ct.id limit 1),
         coalesce(c.owner_id, 1),
         case when h.k > v_short
              then round(h.delivered * (0.88 + 0.17 * nl_seed.u('hist.value|' || h.k))::numeric, 2)
              else round(h.delivered * (2 + 2 * nl_seed.u('hist.value|' || h.k))::numeric, 2) end,
         h.starts_on, h.ends_on,
         case when h.k > v_short then nl_seed.ri(6, 9, 'hist.conf|' || h.k) * 10 else 50 end,
         coalesce(c.owner_id, 1),
         (h.starts_on + time '09:30') at time zone 'America/Chicago'
  from hist h
  join nl.customers c on c.customer_no = h.customer_no
  where h.k <= v_kept + v_short;

  insert into nl.commitment_items (commitment_id, item_no)
  select cm.id, x.item_no
  from nl.commitments cm
  join hist h on h.customer_no = cm.customer_no and h.starts_on = cm.starts_on and h.ends_on = cm.ends_on
  cross join lateral unnest(h.items) as x(item_no)
  where h.k <= v_kept + v_short
  on conflict do nothing;

  -- The short ones: the owner answered a week or two after the window closed.
  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note)
  select cm.id, o.outcome, 'person', cm.owner_id,
         (cm.ends_on + nl_seed.ri(3, 20, 'hist.answer|' || cm.id) + time '15:00') at time zone 'America/Chicago',
         case o.outcome
           when 'pushed' then nl_seed.pick(array['Buyer says the order moved to next quarter.',
                                                 'Fleet delivery slipped; the order is still coming.'], 'hist.note|' || cm.id)
           else nl_seed.pick(array['Lost to a competitor on price.', 'The fleet contract fell through.',
                                   'They consolidated vendors and we were cut.'], 'hist.note|' || cm.id)
         end
  from nl.commitments cm
  join hist h on h.customer_no = cm.customer_no and h.starts_on = cm.starts_on and h.ends_on = cm.ends_on
  cross join lateral (
    select case when nl_seed.chance(0.4, 'hist.outcome|' || h.k) then 'pushed' else 'broken' end as outcome
  ) o
  where h.k <= v_short;

  drop table if exists pg_temp.hist;

  -- New commitments continue the numbering.
  perform setval(pg_get_serial_sequence('nl.commitments', 'id'),
                 coalesce((select max(id) from nl.commitments), 3000), (select count(*) > 0 from nl.commitments));
end $$;

-- Today's board: a handful of commitments in every state, placed on
-- accounts that can carry them.
create or replace function nl_seed.build_board() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set      nl_seed.settings;
  v_today    date;
  v_small    boolean;
  v_full     boolean;
  v_key      text;
  v_row      record;
  v_quota    int;
  v_made     int;
  v_items    text[];
  v_qtys     int[];
  v_value    numeric;
  v_delivered numeric;
  v_start    date;
  v_end      date;
  v_id       bigint;
begin
  select * into v_set from nl_seed.settings;
  v_today := v_set.today;
  v_small := v_set.size = 'small';
  v_full := v_set.size = 'full';

  -- Accounts that can carry one: a head office or independent, buying this
  -- year or last, not blocked, with someone to talk to. A keyed order
  -- decides who gets which kind, so the board looks the same every day.
  insert into nl_seed.eligible (customer_no, pick_order)
  select c.customer_no, row_number() over (order by nl_seed.u('commit.pick|' || c.customer_no))
  from nl.customers c
  join nl_seed.portfolio p on p.customer_no = c.customer_no
  where c.bill_to_no is null
    and not c.blocked and not c.closed
    and p.last_idx >= (select max(idx) from nl_seed.years)
    and exists (select 1 from nl.contacts ct where ct.customer_no = c.customer_no)
    and (select sum(cy.revenue) from nl_seed.cust_year cy
          where cy.customer_no = c.customer_no and cy.year >= v_set.last_year - 1)
        >= case v_set.size when 'full' then 15000 when 'demo' then 10000 else 2000 end;

  -- Delivering: the window is open and parts in scope are shipping.
  v_quota := case v_set.size when 'full' then 12 when 'demo' then 6 else 1 end;
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

  -- Kept recently: the window closed and delivery reached the committed value.
  v_quota := case v_set.size when 'full' then 4 when 'demo' then 3 else 1 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'kept|' || v_row.customer_no;
    v_start := v_today - nl_seed.ri(150, 240, v_key || '|start');
    v_end := v_today - nl_seed.ri(45, 90, v_key || '|end');
    v_items := nl_seed.family_items(v_row.customer_no, v_start, v_end, v_key);
    continue when cardinality(v_items) = 0;
    v_items := v_items[1:nl_seed.ri(4, 8, v_key || '|n')];
    v_delivered := nl_seed.family_delivered(v_row.customer_no, v_items, v_start, v_end);
    continue when v_delivered < 1000;
    perform nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key), round(v_delivered * 0.97, 2),
      v_start, v_end, 90, v_items, null);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Quoted: a quote went out for parts this customer has never bought, so
  -- nothing can have shipped against it yet.
  v_quota := case v_set.size when 'full' then 8 when 'demo' then 5 else 1 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'quoted|' || v_row.customer_no;
    v_items := nl_seed.new_items(v_row.customer_no, null, v_key);
    continue when cardinality(v_items) < 2;
    v_items := v_items[1:nl_seed.ri(2, 5, v_key || '|n')];
    select array_agg(nl_seed.typical_qty(x.item_no, v_key || '|qty|' || x.item_no) * 4 order by x.n)
      into v_qtys
    from unnest(v_items) with ordinality as x(item_no, n);
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
  v_quota := case v_set.size when 'full' then 6 when 'demo' then 4 else 2 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'promised|' || v_row.customer_no;
    v_items := nl_seed.new_items(v_row.customer_no, null, v_key);
    continue when cardinality(v_items) = 0;
    v_items := v_items[1:nl_seed.ri(1, 3, v_key || '|n')];
    perform nl_seed.add_commitment(
      v_row.customer_no, nl_seed.title_for(v_items, v_key),
      nl_seed.ri(case when v_full then 15 else 8 end, case when v_full then 120 else 60 end, v_key || '|value') * 1000,
      v_today - nl_seed.ri(2, 25, v_key || '|start'), v_today + nl_seed.ri(60, 180, v_key || '|end'),
      50, v_items, null, v_made > 0);
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
    v_made := v_made + 1;
  end loop;

  -- Closed short, not answered yet. The last one has a newer quote for the
  -- same parts, which is the evidence the nightly job needs to answer
  -- "pushed" on its own; the others need a person.
  v_quota := case when v_full then 6 else 3 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'short|' || v_row.customer_no;
    v_start := v_today - nl_seed.ri(90, 140, v_key || '|start');
    v_end := v_today - nl_seed.ri(20, 45, v_key || '|end');
    v_items := nl_seed.family_items(v_row.customer_no, v_start - 365, v_start, v_key);
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
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order limit 1 loop
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

  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order limit 1 loop
    v_key := 'broken|' || v_row.customer_no;
    v_items := (nl_seed.new_items(v_row.customer_no, 'muffler', v_key))[1:2];
    v_id := nl_seed.add_commitment(
      v_row.customer_no, 'Muffler program lost on price', 27500,
      v_today - 160, v_today - 50, 20, v_items, null);
    insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note)
    select v_id, 'broken', 'person', owner_id, now() - interval '40 days',
           'Lost to a competitor on price, not quality.'
    from nl.commitments where id = v_id;
    update nl_seed.eligible set taken = true where customer_no = v_row.customer_no;
  end loop;

  -- Operations-sized: big programs with a quote on file.
  v_quota := case v_set.size when 'full' then 3 when 'demo' then 2 else 1 end;
  v_made := 0;
  for v_row in select e.customer_no from nl_seed.eligible e where not e.taken order by e.pick_order loop
    exit when v_made >= v_quota;
    v_key := 'ops|' || v_row.customer_no;
    select array_agg(x.item_no order by nl_seed.u(v_key || '|' || x.item_no))
      into v_items
    from (
      select i.item_no
      from nl.items i
      join nl_seed.item_plan ip on ip.item_no = i.item_no
      where i.family = (array['stack', 'elbow', 'pipe'])[v_made + 1]
        and not i.made_to_order and not i.blocked
        and (v_made > 0 or i.product_group = 'CHROME')
      order by ip.weight desc
      limit 20
    ) x;
    v_items := v_items[1:6];
    select array_agg(nl_seed.typical_qty(x.item_no, v_key || '|qty|' || x.item_no) * 10 order by x.n)
      into v_qtys
    from unnest(v_items) with ordinality as x(item_no, n);
    select round(greatest(90000, sum(x.qty * nl_seed.net_price(v_row.customer_no, x.item_no)) * 2), 2)
      into v_value
    from unnest(v_items, v_qtys) as x(item_no, qty);
    v_start := v_today - nl_seed.ri(10, 40, v_key || '|start');
    v_id := nl_seed.add_commitment(
      v_row.customer_no,
      (array['Fleet-wide chrome stack refit', 'Annual elbow supply agreement', 'Regional pipe supply agreement'])[v_made + 1],
      v_value, v_start, v_today + nl_seed.ri(90, 200, v_key || '|end'), 75, v_items, v_qtys);
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
end $$;

-- What the sales team left behind in the last year: notes (about six a
-- month across a hundred live accounts), calls and emails in the last two
-- months, and next steps, most of them done.
create or replace function nl_seed.build_activity() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set nl_seed.settings;
begin
  select * into v_set from nl_seed.settings;

  drop table if exists pg_temp.live;
  create temporary table live as
  select c.customer_no, c.owner_id, p.z
  from nl.customers c
  join nl_seed.portfolio p on p.customer_no = c.customer_no
  where c.bill_to_no is null
    and c.owner_id is not null
    and exists (select 1 from nl_seed.cust_year cy
                where cy.customer_no = c.customer_no and cy.year >= v_set.last_year - 1);

  insert into nl.activities (customer_no, kind, body, author_id, via, occurred_at, created_at)
  select l.customer_no, 'note',
         nl_seed.pick(array['Spoke with purchasing; they are consolidating vendors this quarter.',
           'Chrome demand is up with their new fleet contract.',
           'Asked for lead times on 8 inch stacks before they commit.',
           'Prefers email over calls before 10am.',
           'Wants a standing order for clamps, monthly.',
           'Their counter lead is new; send the catalog.',
           'Lost a muffler bid to a competitor on price, not quality.',
           'Expanding the service bays; expect more pipe next year.',
           'Buyer is out until the end of the month.',
           'Asked about stainless options for the new trucks.',
           'Wants to see the price sheet before the budget meeting.',
           'Freight is their main complaint; offered to review the free-freight threshold.'],
           'note.text|' || l.customer_no || '|' || g.n),
         l.owner_id, 'seed', t.at, t.at
  from live l
  cross join lateral generate_series(1,
    least(40, floor(exp(nl_seed.gauss(ln(4) + 0.5 * l.z, 0.8, 'notes|' || l.customer_no))))::int) as g(n)
  cross join lateral (
    select ((v_set.today - nl_seed.ri(1, 365, 'note.day|' || l.customer_no || '|' || g.n))
            + time '08:00' + make_interval(mins => nl_seed.ri(0, 540, 'note.min|' || l.customer_no || '|' || g.n)))
           at time zone 'America/Chicago' as at
  ) t;

  insert into nl.activities (customer_no, kind, call_outcome, body, author_id, via, occurred_at, created_at)
  select l.customer_no,
         case k.kind when 'voicemail' then 'call' else k.kind end,
         case k.kind
           when 'voicemail' then 'voicemail'
           when 'call' then nl_seed.pick(array['reached','reached','callback','no_answer'], 'call.outcome|' || l.customer_no || '|' || g.n)
         end,
         nl_seed.pick(array['Went over open backorders.', 'Sent the updated price sheet.',
           'Asked for the Q4 forecast.', 'Left a message about the chrome lead time.',
           'Stopped by with the new catalog.', 'Confirmed the ship date on the open order.'],
           'call.text|' || l.customer_no || '|' || g.n),
         l.owner_id, 'seed', t.at, t.at
  from live l
  cross join lateral generate_series(1, case when nl_seed.chance(0.65, 'calls|' || l.customer_no)
                                             then nl_seed.ri(1, 4, 'calls.n|' || l.customer_no) else 0 end) as g(n)
  cross join lateral (
    select nl_seed.pick(array['call','call','email','email','meeting','voicemail'], 'call.kind|' || l.customer_no || '|' || g.n) as kind
  ) k
  cross join lateral (
    select ((v_set.today - nl_seed.ri(1, 60, 'call.day|' || l.customer_no || '|' || g.n))
            + time '08:00' + make_interval(mins => nl_seed.ri(0, 540, 'call.min|' || l.customer_no || '|' || g.n)))
           at time zone 'America/Chicago' as at
  ) t;

  -- Next steps: added over the last year, due a few days to a month later.
  -- Old ones are nearly all done; recent ones mostly open, some overdue.
  insert into nl.next_steps (customer_no, title, due_on, owner_id, created_by, created_at, completed_at, completed_by)
  select l.customer_no, s.title, s.due_on, l.owner_id, l.owner_id, s.created_at,
         case when s.done then s.created_at + make_interval(days => nl_seed.ri(1, 30, 'step.done|' || l.customer_no || '|' || g.n)) end,
         case when s.done then l.owner_id end
  from live l
  cross join lateral generate_series(1, case when nl_seed.chance(0.6, 'steps|' || l.customer_no)
                                             then nl_seed.ri(1, 4, 'steps.n|' || l.customer_no) else 0 end) as g(n)
  cross join lateral (
    select nl_seed.pick(array['Follow up on the chrome quote','Confirm the Q4 stack forecast','Send updated tier pricing',
             'Set up a plant visit','Ask about the new location','Review open backorders with purchasing',
             'Get the drawing for the custom Y-pipe','Check in on the muffler program','Book the counter-day training',
             'Close the loop on the freight claim'], 'step.title|' || l.customer_no || '|' || g.n) as title,
           (v_set.today - a.age + nl_seed.ri(3, 30, 'step.due|' || l.customer_no || '|' || g.n)) as due_on,
           ((v_set.today - a.age) + time '10:00') at time zone 'America/Chicago' as created_at,
           nl_seed.chance(case when a.age > 45 then 0.95 when a.age > 14 then 0.7 else 0.25 end,
                          'step.done?|' || l.customer_no || '|' || g.n) as done
    from (select nl_seed.ri(1, 365, 'step.age|' || l.customer_no || '|' || g.n) as age) a
  ) s;

  drop table if exists pg_temp.live;
end $$;

-- ---------------------------------------------------------------------------
-- The entry points
-- ---------------------------------------------------------------------------

create or replace function nl_seed.begin_build(p_size text) returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if p_size is null or p_size not in ('full', 'demo', 'small') then
    raise exception 'The world comes in ''full'', ''demo'' or ''small'', not %.', coalesce(p_size, 'null');
  end if;
  if exists (select 1 from nl.users) or exists (select 1 from nl_seed.settings) then
    raise exception 'Building needs an empty schema. Run nl.reset() first.';
  end if;

  perform nl_seed.build_settings(p_size);
  perform nl_seed.build_people();
  perform nl_seed.build_catalog();
  perform nl_seed.build_customers();
  perform nl_seed.build_baskets();

  return jsonb_build_object(
    'size', p_size,
    'years', (select jsonb_agg(year order by year) from nl_seed.years),
    'customers', (select count(*) from nl.customers),
    'items', (select count(*) from nl.items),
    'buying_years', (select count(*) from nl_seed.cust_year),
    'basket_parts', (select count(*) from nl_seed.baskets));
end $$;

create or replace function nl_seed.finish_build() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_set nl_seed.settings;
begin
  select * into v_set from nl_seed.settings;
  if (select count(distinct extract(year from posted_on)) from nl.invoices where doc_type = 'invoice')
     < v_set.last_year - v_set.first_year + 1 then
    raise exception 'Build every year (nl_seed.build_year) before finishing.';
  end if;

  perform nl_seed.build_history();
  perform nl_seed.build_board();
  perform nl_seed.build_activity();

  return jsonb_build_object(
    'size', v_set.size,
    'today', v_set.today,
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
        from nl.invoices group by 1) r));
end $$;

create or replace function nl.build(p_size text default 'full') returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_year int;
begin
  perform nl_seed.begin_build(p_size);
  for v_year in select year from nl_seed.years order by year loop
    perform nl_seed.build_year(v_year);
  end loop;
  return nl_seed.finish_build();
end $$;

revoke execute on all functions in schema nl_seed from public;
revoke execute on function nl.reset(), nl.build(text) from public;
