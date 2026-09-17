-- The invented world for the GRCRM demo, built inside the database.
--
--   select demo.reset();   wipe every business table the demo owns
--   select demo.build();   build the world, dated relative to today
--
-- Everything is synthetic: the company, its people, its customers, its parts
-- and every dollar. Names come from word lists; any match with a real
-- business is coincidence. The schema is the real GRCRM schema, applied
-- unchanged, so the data has to be shaped the way the ERP exports shape it:
-- item ledger lines with negative quantities for sales, a customer ledger of
-- invoices, credit memos and payments, a Jet "Open Sales Lines" snapshot
-- loaded through gr_wh_import, and JSON records that the mirror trigger
-- projects into the relational tables. The app then reads it with no
-- demo-only code at all.
--
-- Randomness is seeded, so the same world comes back every run; only the
-- dates move with the calendar. Re-run it the morning of a demo.

create schema if not exists demo;

create or replace function demo.ri(a int, b int) returns int language sql volatile as
  $f$ select a + floor(random() * (b - a + 1))::int $f$;
create or replace function demo.pick(arr text[]) returns text language sql volatile as
  $f$ select arr[1 + floor(random() * array_length(arr, 1))::int] $f$;
create or replace function demo.gauss(mean double precision, sd double precision) returns double precision language sql volatile as
  $f$ select mean + sd * sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()) $f$;
create or replace function demo.chance(p double precision) returns boolean language sql volatile as
  $f$ select random() < p $f$;
create or replace function demo.hex(n int) returns text language sql volatile as
  $f$ select substr(md5(random()::text), 1, n) $f$;
create or replace function demo.person() returns text language sql volatile as
  $f$ select demo.pick(array['Alex','Jamie','Morgan','Taylor','Chris','Pat','Casey','Drew','Riley','Robin','Sydney','Terry','Dale','Kim','Lee','Shawn','Tracy','Jesse','Blake','Avery','Reese','Quinn'])
         || ' ' || demo.pick(array['Alvarez','Brennan','Castillo','Dawson','Ellison','Foster','Garza','Holloway','Ibarra','Jennings','Keller','Lindqvist','Moreno','Navarro','Okafor','Pruitt','Quintero','Reyes','Sandoval','Tanaka','Underwood','Vasquez','Whitfield','Yates','Zimmerman']) $f$;
create or replace function demo.phone() returns text language sql volatile as
  $f$ select '(' || demo.ri(200, 989) || ') 555-' || lpad(demo.ri(100, 9999)::text, 4, '0') $f$;
-- Lines copied from a deal's scope onto an expected order get their own ids:
-- the mirror keys line items by id, and one id in two places is a duplicate.
create or replace function demo.relines(j jsonb) returns jsonb language sql volatile as
  $f$ select coalesce((select jsonb_agg((e.v - 'id') || jsonb_build_object('id', 'li_' || demo.hex(16)) order by e.i) from jsonb_array_elements(coalesce(j, '[]'::jsonb)) with ordinality as e(v, i)), '[]'::jsonb) $f$;
-- A quote on file (metadata only; the PDF itself is never opened in the demo).
create or replace function demo.quote_meta(deal_id text) returns jsonb language sql volatile as
  $f$ select jsonb_build_array(jsonb_build_object('id', 'q_' || demo.hex(16), 'name', 'Sales Quote ' || demo.ri(448000, 449999) || '.pdf', 'type', 'application/pdf', 'size', demo.ri(40000, 140000), 'storagePath', 'demo/quotes/' || deal_id || '.pdf', 'uploadedAt', now() - (demo.ri(1, 12) || ' days')::interval)) $f$;

-- Staging tables: the world's own bookkeeping, never read by the app.
create table if not exists demo.customers (
  customer_no text primary key, name text, bill_to text, chain text, is_hq boolean default false, branch_of text,
  city text, state text, country text, code text, rep text, grp text, owner text, tier text, size text,
  own_carrier boolean, blocked text default '', lifecycle text default 'steady', account_id text, lifetime numeric default 0);
create table if not exists demo.items (
  item_no text primary key, description text, category text, posting text, family text, product_group text,
  made_to_order boolean default false, proprietary boolean default false, cost numeric, price numeric,
  replenishment text, work_center text, vendor_no text, lead text, qlo int, qhi int,
  qoh int, qoh_gr int, on_prod int default 0, on_purch int default 0, shelf text, bin text, blocked boolean default false);
create table if not exists demo.baskets (customer_no text, item_no text, cadence text, mean_gap int, sd_gap double precision);
create table if not exists demo.ship_lines (id serial, customer_no text, item_no text, day date, qty int, unit numeric, amount numeric, cost numeric, doc text, po text);
create table if not exists demo.jet_orders (doc text primary key, customer_no text, ship date, taken date, partial boolean, po text, agent text, in_today boolean, in_yesterday boolean);
create table if not exists demo.jet_lines (doc text, pos int, item_no text, qty int, outstanding int, unit numeric);

create or replace function demo.reset() returns void language plpgsql as $body$
declare t text; names text[] := array[
  'records','accounts','commitments','contacts','notes','next_steps','locations','quotes','upcoming_orders','line_items','po_log','reps','channels',
  'sku_transactions','customer_ledger','invoices','bc_customers','items','item_master_lines','item_master_snapshots','item_master_staging','vendors','open_sales_lines','open_sales_snapshots',
  'kit_components','account_events','nudges','audit_events','import_batches','user_permissions','revenue_goals','mirror_failures','write_requests','agent_cards','proposals','reactions','reorder_suppressions','refresh_requests','system_events',
  'promos','promo_codes','promo_signoffs','events','event_costs','event_attendees','event_milestones','event_leads','event_transitions','sales_drafts','sales_draft_lines','price_sheets','draft_edits','account_funnel','bc_export_files','revenue_baseline'];
begin
  for t in select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name = any(names) loop
    execute format('truncate table public.%I restart identity cascade', t);
  end loop;
  truncate demo.customers, demo.items, demo.baskets, demo.ship_lines, demo.jet_orders, demo.jet_lines;
end $body$;

create or replace function demo.build(p_seed double precision default 0.42) returns jsonb language plpgsql as $body$
#variable_conflict use_column
declare
  today date := current_date;
  yr int := extract(year from current_date)::int;
  first_ledger date := make_date(extract(year from current_date)::int - 3, 1, 3);
  first_item date := make_date(extract(year from current_date)::int - 2, 1, 2);
  c record; b record; r record; s record; acct record; it record;
  n int; i int; k int; x double precision; day date; start_day date; end_day date;
  next_num int := 1101; next_id int := 1001; next_deal int := 3001;
  entry bigint := 500001; cl_seq bigint := 900001; inv_seq int := 700001; so_seq int := 610001;
  owners text[] := array['Owen','Dana','Marcus','Sam'];
  regions text[] := array['Amarillo','Bayou','Big Sky','Cascade','Prairie','Gulf Coast','High Plains','Ironhorse','Panhandle','Red River','Rio Grande','Rocky Mountain','Sandhills','Sooner','Timberline','Tidewater','Yellowstone','Ozark','Piney Woods','Blue Ridge','Great Basin','Copper State','Badlands','Cimarron','Brazos','Pecos','Wasatch','Bitterroot','Sabine','Palo Duro','Llano','Caprock','Sangre','Front Range','Snake River','Four Corners','Permian','Trinity','Guadalupe','Sierra'];
  kinds text[] := array['Truck Parts','Diesel Supply','Fleet Service','Chrome & Stack','Truck Center','Heavy Duty Parts','Trailer & Truck','Freight Systems','Truck Repair','Equipment Co.'];
  tiers text[] := array['DEALER','DEALER','DEALER','DEALER','PERFORMANC','PERFORMANC','PERFORMANC','JOBBER','JOBBER','ELITE'];
  titles text[] := array['Parts Manager','Purchasing','Owner','General Manager','Buyer','Service Manager','Counter Lead','Operations Manager'];
  steps text[] := array['Follow up on the chrome quote','Confirm Q4 stack forecast','Send updated tier pricing','Set up a plant visit','Ask about the new location','Review open backorders with purchasing','Get the drawing for the custom Y-pipe','Check in on the muffler program','Book the counter-day training','Close the loop on the freight claim'];
  notes text[] := array['Spoke with purchasing, they are consolidating vendors this quarter.','Chrome demand is up with the new fleet contract.','Asked for lead times on 8 inch stacks before they commit.','Prefers email over calls before 10am.','Wants a standing order for clamps, monthly.','Their counter guy is new, send the catalog.','Lost a bid on mufflers to a competitor on price, not quality.','Expanding the service bays, more pipe next year.'];
  deal_titles text[] := array['Chrome stack program','Fleet elbow restock','Muffler line changeover','Clamp standing order','Custom Y-pipe build','Q4 pipe stocking order','Heat shield retrofit','Dual stack kits for the new lot','Turnout stacks for the west yard','Flex pipe consolidation'];
  due_days int[] := array[-9,-4,-2,-1,0,0,1,2,3,5,8,12,20,35,60];
  code text; owner text; rep text; grp text; hq text; nm text; used text[] := array[]::text[]; chain_tier text; chain_carrier boolean; is_partial boolean;
  disc numeric; amount numeric; cost numeric; freight numeric; open boolean; age int; docnum text; billto text; cm numeric;
  contacts jsonb; scope jsonb; delivered numeric; value numeric; remaining numeric; jrows jsonb; sha text; res jsonb; goal numeric; qmeta jsonb;
  claims text := json_build_object('email', 'owen@grcrm.demo', 'role', 'authenticated', 'sub', '00000000-0000-4000-8000-000000000001')::text;
begin
  perform setseed(p_seed);
  -- Act as the admin for the functions that check who is calling, and mark this as API work for the audit trigger.
  perform set_config('request.jwt.claims', claims, true), set_config('gr.api', '1', true);

  -- The people --------------------------------------------------------------
  insert into public.user_permissions (email, display_name, role, owner_name, ops, active) values
    ('owen@grcrm.demo','Owen','admin','Owen',true,true), ('dana@grcrm.demo','Dana','team','Dana',false,true), ('marcus@grcrm.demo','Marcus','team','Marcus',false,true),
    ('sam@grcrm.demo','Sam','team','Sam',false,true), ('priya@grcrm.demo','Priya','team','Priya',true,true), ('jordan@grcrm.demo','Jordan','team','Jordan',false,true);

  insert into public.vendors (vendor_no, name, search_name, contact, phone, email, city, state, country_region_code, lead_time_calculation, purchaser_code, payment_terms_code, shipment_method_code, vendor_posting_group, blocked, purchases_amount, balance_amount, last_date_modified, source_file, loaded_at)
  select v.vendor_no, v.name, upper(v.name), demo.person(), demo.phone(), '', v.city, v.state, 'US', v.lead, 'PIC', 'NET30', 'GROUND', 'DOMESTIC', '', demo.ri(20, 400) * 1000, demo.ri(0, 60) * 1000, today - demo.ri(1, 90), 'Vendor List.xlsx', now()
  from (values ('V1010','Lakeshore Plating Co.','Sandusky','OH','3W'), ('V1020','Midland Tube & Steel','Toledo','OH','2W'), ('V1030','Cardinal Clamp Co.','Erie','PA','4W'), ('V1040','Northstar Flex Products','Duluth','MN','6W'),
    ('V1050','Great Lakes Muffler Mfg','Grand Rapids','MI','5W'), ('V1060','Summit Fasteners','Akron','OH','2W'), ('V1070','Buckeye Stamping','Columbus','OH','4W'), ('V1080','Harbor Packaging Supply','Cleveland','OH','1W'),
    ('V1090','Pioneer Heat Shield','Fort Wayne','IN','3W'), ('V1100','Keystone Rubber & Gasket','Scranton','PA','2W')) as v(vendor_no, name, city, state, lead);

  -- Customers ---------------------------------------------------------------
  -- Three chains whose branches bill to a head office.
  for r in select * from (values ('TruckSource','Dallas','TX', array['Houston|TX','San Antonio|TX','Oklahoma City|OK','Tulsa|OK','Little Rock|AR','Shreveport|LA']),
                                ('Fleetline Parts','Denver','CO', array['Salt Lake City|UT','Albuquerque|NM','Cheyenne|WY','Billings|MT']),
                                ('Lone Star Truck Centers','Fort Worth','TX', array['Waco|TX','Abilene|TX','Lubbock|TX'])) as t(chain, city, state, branches) loop
    x := random(); code := case when x < 0.42 then '1' when x < 0.66 then '410' when x < 0.86 then '520' else '630' end;
    owner := demo.pick(owners);
    rep := case code when '1' then 'HOUSE - ' || upper(owner) when '410' then upper(demo.pick(array['Carla Nunez','Ben Whitaker'])) when '520' then upper(demo.pick(array['Luis Ortega','Hannah Kim'])) else 'DEREK SLOAN' end;
    grp := case code when '1' then 'HOUSE ACCOUNT' when '410' then 'SUMMIT REP GROUP' when '520' then 'RIDGELINE SALES' else 'BLUEWATER MARKETING' end;
    hq := next_num::text; next_num := next_num + 1; chain_tier := demo.pick(tiers); chain_carrier := demo.chance(0.5);
    insert into demo.customers (customer_no, name, chain, is_hq, city, state, country, code, rep, grp, owner, tier, size, own_carrier)
      values (hq, r.chain || ' - ' || r.city, r.chain, true, r.city, r.state, 'US', code, rep, grp, owner, chain_tier, 'A', chain_carrier);
    foreach nm in array r.branches loop
      insert into demo.customers (customer_no, name, bill_to, chain, branch_of, city, state, country, code, rep, grp, owner, tier, size, own_carrier)
        values (next_num::text, r.chain || ' - ' || split_part(nm, '|', 1), hq, r.chain, hq, split_part(nm, '|', 1), split_part(nm, '|', 2), 'US', code, rep, grp, owner, chain_tier, demo.pick(array['B','B','C']), chain_carrier);
      next_num := next_num + 1;
    end loop;
  end loop;
  -- Fifty-two independents.
  for i in 1..52 loop
    loop nm := demo.pick(regions) || ' ' || demo.pick(kinds); exit when not (nm = any(used)); end loop; used := used || nm;
    select t.city, t.state into c from (values ('Amarillo','TX'),('Lubbock','TX'),('Odessa','TX'),('Laredo','TX'),('Beaumont','TX'),('Tyler','TX'),('El Paso','TX'),('Corpus Christi','TX'),('Tulsa','OK'),('Lawton','OK'),('Shreveport','LA'),('Lafayette','LA'),('Fort Smith','AR'),('Texarkana','AR'),('Denver','CO'),('Grand Junction','CO'),('Billings','MT'),('Missoula','MT'),('Boise','ID'),('Spokane','WA'),('Yakima','WA'),('Medford','OR'),('Reno','NV'),('Salt Lake City','UT'),('Casper','WY'),('Albuquerque','NM'),('Phoenix','AZ'),('Fresno','CA'),('Bakersfield','CA'),('Toledo','OH'),('Akron','OH'),('Erie','PA'),('Gary','IN'),('Rockford','IL'),('Green Bay','WI'),('Des Moines','IA'),('Omaha','NE'),('Sioux Falls','SD'),('Fargo','ND'),('Jacksonville','FL'),('Mobile','AL'),('Chattanooga','TN'),('Kansas City','MO')) as t(city, state) order by random() limit 1;
    x := random(); code := case when x < 0.42 then '1' when x < 0.66 then '410' when x < 0.86 then '520' else '630' end;
    owner := demo.pick(owners);
    rep := case code when '1' then 'HOUSE - ' || upper(owner) when '410' then upper(demo.pick(array['Carla Nunez','Ben Whitaker'])) when '520' then upper(demo.pick(array['Luis Ortega','Hannah Kim'])) else 'DEREK SLOAN' end;
    grp := case code when '1' then 'HOUSE ACCOUNT' when '410' then 'SUMMIT REP GROUP' when '520' then 'RIDGELINE SALES' else 'BLUEWATER MARKETING' end;
    insert into demo.customers (customer_no, name, city, state, country, code, rep, grp, owner, tier, size, own_carrier)
      values (next_num::text, nm, c.city, c.state, 'US', code, rep, grp, owner, demo.pick(tiers), demo.pick(array['A','B','B','C','C','C','D','D']), demo.chance(0.3));
    next_num := next_num + 1;
  end loop;
  -- Canada and Latin America.
  for r in select * from (values ('Northern Fleet Supply','Calgary','AB','CA'),('Kootenay Truck & Trailer','Cranbrook','BC','CA'),('Maple Diesel','Winnipeg','MB','CA'),('Ontario Heavy Duty','Mississauga','ON','CA'),
                                ('Transportes del Norte Refacciones','Monterrey','NL','MX'),('Refacciones Bajio','Leon','GT','MX'),('Andina Camiones','Santiago','RM','CL'),('Caribe Fleet Parts','Bogota','DC','CO')) as t(name, city, state, country) loop
    code := case when r.country = 'CA' then '630' else '1' end; owner := case when r.country = 'CA' then demo.pick(owners) else 'Owen' end;
    insert into demo.customers (customer_no, name, city, state, country, code, rep, grp, owner, tier, size, own_carrier)
      values (next_num::text, r.name, r.city, r.state, r.country, code, case when code = '1' then 'HOUSE - ' || upper(owner) else 'DEREK SLOAN' end, case when code = '1' then 'HOUSE ACCOUNT' else 'BLUEWATER MARKETING' end, owner, demo.pick(array['DEALER','PERFORMANC']), demo.pick(array['B','C']), true);
    next_num := next_num + 1;
  end loop;
  -- Life stages, so Today has something to say.
  for r in select cu.customer_no, row_number() over (order by cu.customer_no) as rn, count(*) over () as total from demo.customers cu where cu.chain is null and cu.country = 'US' loop
    update demo.customers cu set lifecycle = case when r.rn <= 4 then 'dormant' when r.rn <= 8 then 'churned' when r.rn <= 12 then 'slipping' when r.rn <= 16 then 'growing' when r.rn > r.total - 5 then 'new' else 'steady' end,
      blocked = case when r.rn in (17, 18) then 'All' else '' end,
      code = case when r.rn in (19, 20) then 'CLOSED' else cu.code end, rep = case when r.rn in (19, 20) then 'HOUSE - CLOSED' else cu.rep end, grp = case when r.rn in (19, 20) then 'HOUSE ACCOUNT' else cu.grp end,
      owner = case when r.rn between 41 and 44 then null else cu.owner end
    where cu.customer_no = r.customer_no;
  end loop;
  update demo.customers set lifecycle = 'churned' where code = 'CLOSED';
  -- New accounts get newer numbers, like a real master; spaced so they cannot collide.
  for r in select cu.customer_no, row_number() over (order by cu.customer_no) as rn from demo.customers cu where cu.lifecycle = 'new' loop
    update demo.customers set customer_no = (20000 + r.rn * 113 + demo.ri(0, 90))::text where customer_no = r.customer_no;
  end loop;

  insert into public.bc_customers (customer_no, name, bill_to_customer_no, chain_name, salesperson_code, city, state, blocked, lifetime_sales, rep_group, salesperson_name, loaded_at, country_region_code)
  select cu.customer_no, cu.name, cu.bill_to, case when cu.country = 'US' then (case when cu.state = any(array['TX','OK','LA','AR','NM','CO','MT','WY','UT','ID','WA','OR','NV','AZ','CA']) then 'WEST' else 'EAST' end) when cu.country = 'CA' then 'CANADA' else 'EXPORT' end,
         cu.code, cu.city, cu.state, cu.blocked, 0, cu.grp, cu.rep, now(), cu.country
  from demo.customers cu;

  -- Parts -------------------------------------------------------------------
  for r in select dia, deg, la, lb, fin from (values (4),(5),(6),(7),(8)) as vd(dia), (values (45),(90)) as vg(deg), (values (12,12),(18,18),(18,24),(24,24),(12,18),(20,20),(24,30),(16,16)) as vl(la, lb), (values ('A'),('C'),('SA'),('SC')) as vf(fin) loop
    continue when not demo.chance(0.19);
    cost := round(((14 + r.dia * 4 + (r.la + r.lb) * 0.35) * case when r.fin like '%C' then 1.9 else 1 end)::numeric, 2);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('L' || r.dia || r.deg || '-' || r.la || r.lb || r.fin, r.dia || '" ' || r.deg || ' DEG ELBOW ' || r.la || '" X ' || r.lb || '" ' || case r.fin when 'A' then 'ALUMINIZED' when 'C' then 'CHROME' when 'SA' then 'ALUMINIZED SLIP' else 'CHROME SLIP' end,
              'ELBOWS', case when r.fin like '%C' then 'CHROME' else 'PIPE' end, 'elbow', case when r.fin like '%C' then 'CHROME' else 'PIPE' end, cost, round(cost / 0.28, 2), 'Prod. Order', case when r.fin like '%C' then 'CHROME' else 'BEND CELL' end, case when r.fin like '%C' then 'V1010' else '' end, case when r.fin like '%C' then '3W' when demo.chance(0.6) then '1W' else '' end, 4, 24);
  end loop;
  for r in select dia, len, st, fin from (values (5),(6),(7),(8)) as vd(dia), (values (36),(48),(60),(72),(84),(96),(108),(120)) as vl(len), (values ('S'),('M'),('K'),('W')) as vs(st), (values ('A'),('C')) as vf(fin) loop
    continue when not demo.chance(0.16);
    cost := round(((40 + r.dia * 6 + r.len * 0.9) * case when r.fin = 'C' then 1.8 else 1 end)::numeric, 2);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('S' || r.dia || '-' || r.len || r.st || r.fin, r.dia || '" X ' || r.len || '" ' || case r.st when 'S' then 'STRAIGHT CUT' when 'M' then 'MITER CUT' when 'K' then 'CURVED' else 'WEST COAST TURNOUT' end || ' STACK ' || case when r.fin = 'C' then 'CHROME' else 'ALUMINIZED' end,
              'STACKS', case when r.fin = 'C' then 'CHROME' else 'PIPE' end, 'stack', case when r.fin = 'C' then 'CHROME' else 'PIPE' end, cost, round(cost / 0.30, 2), 'Prod. Order', case when r.fin = 'C' then 'CHROME' else 'CUT CELL' end, case when r.fin = 'C' then 'V1010' else '' end, case when r.fin = 'C' then '3W' when demo.chance(0.6) then '1W' else '' end, 2, 10);
  end loop;
  for r in select dia, len from (values (3),(4),(5),(6)) as vd(dia), (values (24),(36),(48),(60),(120)) as vl(len) loop
    continue when not demo.chance(0.75);
    cost := round((8 + r.dia * 3 + r.len * 0.45)::numeric, 2);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('P' || r.dia || '-' || r.len || 'A', r.dia || '" X ' || r.len || '" STRAIGHT PIPE ALUMINIZED', 'PIPE', 'PIPE', 'pipe', 'PIPE', cost, round(cost / 0.22, 2), 'Prod. Order', 'CUT CELL', '', '1W', 5, 40);
  end loop;
  for i in 0..11 loop
    cost := demo.ri(70, 220);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('M-' || (1005 + i * 5), 'MUFFLER ' || demo.pick(array['OVAL','ROUND']) || ' ' || demo.pick(array['24','30','36']) || '" BODY ' || demo.pick(array['4','5']) || '" IN/OUT', 'MUFFLERS', 'MUFFLER', 'muffler', 'MUFFLER', cost, round(cost / 0.45, 2),
              case when i < 8 then 'Purchase' else 'Prod. Order' end, case when i < 8 then '' else 'WELD CELL' end, case when i < 8 then 'V1050' else '' end, case when i < 8 then '5W' else '2W' end, 2, 8);
  end loop;
  for r in select dia, ct from (values ('3'),('3.5'),('4'),('5'),('6')) as vd(dia), (values ('B'),('W'),('V')) as vk(ct) loop
    cost := round((3 + r.dia::numeric * 1.4 + case when r.ct = 'V' then 4 else 0 end)::numeric, 2);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('CL-' || replace(r.dia, '.', '') || r.ct, r.dia || '" ' || case r.ct when 'B' then 'BAND' when 'W' then 'WIDE BAND' else 'V-BAND' end || ' CLAMP', 'CLAMPS', 'CLAMPS', 'clamp', 'CLAMPS', cost, round(cost / 0.40, 2), 'Purchase', '', 'V1030', '4W', 20, 120);
  end loop;
  for r in select dia, len from (values (3),(4),(5)) as vd(dia), (values (18),(24),(36)) as vl(len) loop
    cost := round((12 + r.dia * 4 + r.len * 0.5)::numeric, 2);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('FL-' || r.dia || '-' || r.len, r.dia || '" X ' || r.len || '" FLEX PIPE STAINLESS', 'FLEX', 'FLEX', 'flex', 'FLEX', cost, round(cost / 0.50, 2), 'Purchase', '', 'V1040', '6W', 6, 30);
  end loop;
  for i in 1..6 loop
    cost := demo.ri(18, 45);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('HS-' || (100 + i * 10), 'HEAT SHIELD ' || demo.pick(array['4','5','6']) || '" ' || demo.pick(array['36','48','60']) || '" STAINLESS', 'ACCESSORY', 'ACCESS', 'shield', 'ACCESS', cost, round(cost / 0.38, 2), 'Prod. Order', 'WELD CELL', '', '2W', 4, 20);
    cost := demo.ri(6, 22);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('RB-' || (30 + i * 5) || 'ZN', demo.pick(array['RAIN CAP','MOUNTING BRACKET','STACK BRACKET']) || ' ' || demo.pick(array['5','6','7','8']) || '" ZINC', 'ACCESSORY', 'ACCESS', 'bracket', 'ACCESS', cost, round(cost / 0.45, 2), 'Purchase', '', 'V1070', '4W', 10, 60);
  end loop;
  for i in 1..5 loop
    cost := demo.ri(380, 1100);
    insert into demo.items (item_no, description, category, posting, family, product_group, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('K-' || (200 + i), demo.pick(array['DUAL','SINGLE']) || ' STACK KIT ' || demo.pick(array['6','7','8']) || '" ' || demo.pick(array['CHROME','ALUMINIZED']), 'KITS', 'KITS', 'kit', 'KIT', cost, round(cost / 0.42, 2), 'Assembly', 'ASSEMBLY', '', '', 1, 4);
  end loop;
  for i in 1..15 loop
    cost := demo.ri(60, 900);
    insert into demo.items (item_no, description, category, posting, family, product_group, made_to_order, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('CU-' || (4000 + i * 7), 'CUSTOM ' || demo.pick(array['ELBOW','STACK','Y-PIPE','EXTENSION','TURNOUT']) || ' PER DRAWING ' || demo.ri(1000, 9999), demo.pick(array['ELBOWS','STACKS','PIPE']), 'PIPE', 'custom', 'CUSTOM', true, cost, round(cost / 0.34, 2), 'Prod. Order', demo.pick(array['BEND CELL','WELD CELL','CUT CELL']), '', case when demo.chance(0.5) then '' else '2W' end, 1, 6);
  end loop;
  for i in 1..4 loop
    cost := demo.ri(90, 400);
    insert into demo.items (item_no, description, category, posting, family, product_group, proprietary, cost, price, replenishment, work_center, vendor_no, lead, qlo, qhi)
      values ('PR-' || (7000 + i * 11), 'PROPRIETARY ' || demo.pick(array['MANIFOLD ADAPTER','STACK','BRACKET SET']) || ' DWG ' || demo.ri(100, 999), demo.pick(array['ELBOWS','STACKS','ACCESSORY']), 'PIPE', 'proprietary', 'PROPRIETAR', true, cost, round(cost / 0.30, 2), 'Prod. Order', 'WELD CELL', '', '2W', 2, 12);
  end loop;
  -- Stock figures the item master carries.
  for it in select im.item_no, im.family, im.made_to_order, im.replenishment from demo.items im loop
    n := case it.family when 'clamp' then 400 when 'flex' then 120 when 'bracket' then 200 when 'pipe' then 90 when 'elbow' then 40 when 'stack' then 18 when 'muffler' then 25 when 'shield' then 30 when 'kit' then 6 when 'proprietary' then 10 else 0 end;
    k := case when it.made_to_order then 0 else greatest(0, round(demo.gauss(n, n * 0.6)))::int end;
    update demo.items set qoh_gr = k, qoh = k + case when not it.made_to_order and demo.chance(0.3) then demo.ri(1, greatest(1, n / 5)) else 0 end,
      on_prod = case when it.replenishment = 'Prod. Order' and demo.chance(0.35) then (array[25,50,100,150])[demo.ri(1,4)] else 0 end,
      on_purch = case when it.replenishment = 'Purchase' and demo.chance(0.4) then (array[100,200,500])[demo.ri(1,3)] else 0 end,
      shelf = substr('ABCDEFG', demo.ri(1, 7), 1) || '-' || demo.ri(1, 24), blocked = demo.chance(0.03)
    where item_no = it.item_no;
  end loop;
  update demo.items set bin = shelf || '-' || demo.ri(1, 6);
  insert into public.items (item_no, description, category, unit_cost, unit_price, standard_cost, updated_at, product_group)
  select im.item_no, im.description, im.category, im.cost, im.price, im.cost, now(), im.product_group from demo.items im;

  -- Accounts, agencies, reps as JSON records ------------------------------
  for c in select * from demo.customers cu where cu.branch_of is null order by cu.customer_no loop
    owner := coalesce(c.owner, 'Unassigned');
    select jsonb_agg(jsonb_build_object('id', 'ct_' || demo.hex(16), 'name', p.name, 'title', demo.pick(titles), 'email', lower(regexp_replace(p.name, '[^A-Za-z]+', '.', 'g')) || '@example.com', 'phone', demo.phone(), 'location', '', 'primary', p.i = 1)) into contacts
      from (select g.i, demo.person() as name from generate_series(1, demo.ri(1, 3)) as g(i)) p;
    insert into public.records (id, owner, data, created_at, updated_at) values (next_id::text, owner, jsonb_build_object(
      'category', 'Account Management', 'title', case when c.is_hq then c.chain || ' (ROLLED UP)' else c.name end, 'customerNum', c.customer_no, 'accountOwner', owner,
      'salesRep', case when c.code = '1' then '' else c.rep end, 'address', demo.ri(100, 9900) || ' ' || demo.pick(array['Industrial','Commerce','Frontage','Mill','Freight','Depot']) || ' ' || demo.pick(array['Rd','Blvd','Dr','Pkwy']), 'city', c.city, 'state', c.state,
      'phone', demo.phone(), 'email', contacts -> 0 ->> 'email', 'houseAccount', c.code = '1', 'strategies', '[]'::jsonb, 'buyingGroups', case when c.chain is null then '[]'::jsonb else jsonb_build_array(c.chain) end,
      'details', '', 'notes', '', 'isRolledUp', c.is_hq, 'completed', false, 'contacts', contacts,
      'noteLog', coalesce((select jsonb_agg(jsonb_build_object('id', 'nl_' || demo.hex(16), 'author', case when owner = 'Unassigned' then 'Owen' else owner end, 'text', demo.pick(notes), 'createdAt', (now() - (demo.ri(3, 200) || ' days')::interval))) from generate_series(1, case when demo.chance(0.6) then demo.ri(1, 3) else 0 end)), '[]'::jsonb),
      'nextSteps', case when c.lifecycle = 'churned' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', 'ns_' || demo.hex(16), 'title', demo.pick(steps), 'dueDate', (today + due_days[demo.ri(1, 15)])::text, 'completed', false, 'owner', case when owner = 'Unassigned' then 'Owen' else owner end, 'addedBy', case when owner = 'Unassigned' then 'Owen' else owner end, 'addedAt', now() - (demo.ri(1, 30) || ' days')::interval)) from generate_series(1, case when demo.chance(0.55) then demo.ri(1, 2) else 0 end)), '[]'::jsonb) end,
      'locations', coalesce((select jsonb_agg(jsonb_build_object('id', 'loc_' || demo.hex(16), 'navNum', br.customer_no, 'customerNum', br.customer_no, 'address', br.city || ', ' || br.state, 'contactName', demo.person(), 'contactTitle', 'Branch Manager', 'email', '', 'phone', '', 'addedBy', 'import', 'sourceName', br.name)) from demo.customers br where br.branch_of = c.customer_no), '[]'::jsonb),
      'openOrders', '[]'::jsonb, 'openOrdersUpdatedAt', null, 'stat2025', 0, 'stat2026YTD', 0), now() - (demo.ri(200, 900) || ' days')::interval, now());
    update demo.customers set account_id = next_id::text where customer_no = c.customer_no or branch_of = c.customer_no;
    next_id := next_id + 1;
  end loop;
  for r in select * from (values ('6001','Summit Rep Group','Texas and the Gulf', array['Carla Nunez','Ben Whitaker']), ('6002','Ridgeline Sales Associates','Mountain West', array['Luis Ortega','Hannah Kim']), ('6003','Bluewater Marketing','Great Lakes and Canada', array['Derek Sloan'])) as t(id, name, territory, reps) loop
    insert into public.records (id, owner, data, created_at, updated_at) values (r.id, 'Owen', jsonb_build_object('category', 'Channel', 'title', r.name, 'email', 'hello@' || lower(regexp_replace(r.name, '[^A-Za-z]+', '', 'g')) || '.example.com', 'phone', demo.phone(), 'website', '', 'address', '', 'territory', r.territory, 'notes', '', 'completed', false, 'contacts', '[]'::jsonb, 'noteLog', '[]'::jsonb, 'nextSteps', '[]'::jsonb), now(), now());
    i := 0;
    foreach nm in array r.reps loop
      insert into public.records (id, owner, data, created_at, updated_at) values ('5' || substr(r.id, 2) || i, 'Owen', jsonb_build_object('category', 'Sales Rep', 'title', nm, 'email', lower(regexp_replace(nm, '[^A-Za-z]+', '.', 'g')) || '@example.com', 'phone', demo.phone(), 'territory', r.territory, 'company', r.name, 'address', '', 'notes', '', 'parentChannelId', r.id, 'linkedAccountIds', '[]'::jsonb, 'completed', false, 'contacts', '[]'::jsonb, 'noteLog', '[]'::jsonb, 'nextSteps', '[]'::jsonb), now(), now());
      i := i + 1;
    end loop;
  end loop;

  -- Baskets and the order rhythm of every customer-part pair ---------------
  for c in select * from demo.customers cu loop
    n := case c.size when 'A' then demo.ri(22, 36) when 'B' then demo.ri(11, 22) when 'C' then demo.ri(5, 11) else demo.ri(1, 4) end;
    insert into demo.baskets (customer_no, item_no) select c.customer_no, im.item_no from demo.items im where not im.made_to_order and not im.proprietary order by random() limit n;
    if c.size <> 'D' and demo.chance(0.5) then insert into demo.baskets (customer_no, item_no) select c.customer_no, im.item_no from demo.items im where im.made_to_order order by random() limit 1; end if;
  end loop;
  -- Proprietary parts belong to one big customer each.
  i := 0;
  for it in select im.item_no from demo.items im where im.proprietary order by im.item_no loop
    insert into demo.baskets (customer_no, item_no) select cu.customer_no, it.item_no from demo.customers cu where cu.size = 'A' order by cu.customer_no offset i limit 1; i := i + 1;
  end loop;
  update demo.baskets bk set cadence = case when q.rx < 0.25 then 'clockwork' when q.rx < 0.6 then 'predictable' when q.rx < 0.85 then 'random' else 'oneoff' end
    from (select b2.customer_no as cn, b2.item_no as itn, random() as rx from demo.baskets b2) q where q.cn = bk.customer_no and q.itn = bk.item_no;
  update demo.baskets set mean_gap = case cadence when 'clockwork' then demo.ri(21, 45) when 'predictable' then demo.ri(30, 75) when 'random' then demo.ri(60, 200) else 0 end;
  update demo.baskets set sd_gap = case cadence when 'clockwork' then mean_gap * 0.1 when 'predictable' then mean_gap * 0.3 else mean_gap * 0.9 end;

  -- Ship lines: walk each pair's rhythm from its start to its end -----------
  for b in select bk.*, im.qlo, im.qhi, cu.lifecycle, cu.blocked from demo.baskets bk join demo.items im on im.item_no = bk.item_no join demo.customers cu on cu.customer_no = bk.customer_no loop
    start_day := case when b.lifecycle = 'new' then today - demo.ri(20, 150) else first_ledger + demo.ri(0, 240) end;
    end_day := case when b.lifecycle = 'churned' then today - demo.ri(200, 330) when b.lifecycle = 'dormant' then today - demo.ri(75, 130) when b.blocked <> '' then today - demo.ri(120, 300) else today - 1 end;
    day := start_day + demo.ri(0, case when b.cadence = 'oneoff' then 500 else b.mean_gap end);
    n := 0;
    while day <= end_day and n < 400 loop
      if not (extract(month from day) >= 11 and demo.chance(0.35)) then
        x := case when b.lifecycle = 'growing' and extract(year from day)::int = yr then 1.35 when b.lifecycle = 'slipping' and extract(year from day)::int = yr then 0.55 else 1 end;
        insert into demo.ship_lines (customer_no, item_no, day, qty) values (b.customer_no, b.item_no, day, greatest(1, round(demo.gauss((b.qlo + b.qhi) / 2.0, (b.qhi - b.qlo) / 4.0) * x))::int);
      end if;
      exit when b.cadence = 'oneoff';
      day := day + greatest(3, round(demo.gauss(b.mean_gap, b.sd_gap)))::int;
      n := n + 1;
    end loop;
  end loop;
  -- Same day, same customer: one shipment, one customer PO.
  update demo.ship_lines l set doc = 'PS' || lpad((300000 + g.rn)::text, 6, '0'), po = 'PO-' || (41000 + g.rn)
    from (select z.customer_no, z.day, row_number() over (order by z.day, z.customer_no) as rn from (select distinct customer_no, day from demo.ship_lines) z) g
    where g.customer_no = l.customer_no and g.day = l.day;
  update demo.ship_lines l set unit = round((im.price * (1 - case cu.tier when 'JOBBER' then 0.29 when 'DEALER' then 0.44 when 'PERFORMANC' then 0.48 else 0.523 end) * demo.gauss(1, 0.02))::numeric, 2)
    from demo.items im, demo.customers cu where im.item_no = l.item_no and cu.customer_no = l.customer_no;
  update demo.ship_lines l set amount = round(l.unit * l.qty, 2), cost = round(im.cost * l.qty, 2) from demo.items im where im.item_no = l.item_no;

  -- The item ledger: sales lines with negative quantities, the odd return.
  insert into public.sku_transactions (id, entry_no, account_id, customer_num, item_no, posting_date, document_no, document_type, quantity, sales_amount, cost_amount, external_doc_no, batch_id, first_batch_id, imported_at)
  select gen_random_uuid(), (entry + row_number() over (order by l.day, l.id))::text, cu.account_id, l.customer_no, l.item_no, l.day, l.doc, 'Sales Shipment', -l.qty, l.amount, l.cost, l.po, 'imp_seed_ledger', 'imp_seed_ledger', now()
  from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no where l.day >= first_item;
  select count(*) into n from public.sku_transactions; entry := entry + n + 1;
  insert into public.sku_transactions (id, entry_no, account_id, customer_num, item_no, posting_date, document_no, document_type, quantity, sales_amount, cost_amount, external_doc_no, batch_id, first_batch_id, imported_at)
  select gen_random_uuid(), (entry + row_number() over (order by l.id))::text, cu.account_id, l.customer_no, l.item_no, l.day + demo.ri(10, 30), 'PR' || substr(l.doc, 3), 'Sales Return Receipt', least(l.qty, 2), -round(l.unit * least(l.qty, 2), 2), -round(im.cost * least(l.qty, 2), 2), l.po, 'imp_seed_ledger', 'imp_seed_ledger', now()
  from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no join demo.items im on im.item_no = l.item_no where l.day >= first_item and l.day + 30 < today and demo.chance(0.004);

  -- The customer ledger and the invoice headers ----------------------------
  for s in select l.customer_no, l.day, l.doc, l.po, sum(l.amount) as total, cu.own_carrier, cu.bill_to, cu.name, cu.country, cu.code, cu.tier, cu.city, cu.state
           from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no group by l.customer_no, l.day, l.doc, l.po, cu.own_carrier, cu.bill_to, cu.name, cu.country, cu.code, cu.tier, cu.city, cu.state order by l.day, l.customer_no loop
    freight := case when s.own_carrier then 0 when s.total >= (case extract(year from s.day)::int when yr then 1800 when yr - 1 then 1700 when yr - 2 then 1600 else 1500 end) then 0 else round(least(220, 38 + s.total * 0.025), 2) end;
    amount := round(s.total + freight, 2); age := today - s.day; open := age < 30 or demo.chance(0.04);
    docnum := 'PSI' || lpad(inv_seq::text, 6, '0'); inv_seq := inv_seq + 1; billto := coalesce(s.bill_to, s.customer_no);
    insert into public.customer_ledger (entry_no, posting_date, document_type, document_no, customer_no, sell_to_customer_no, external_doc_no, customer_name, description, customer_posting_group, salesperson_code, currency_code, original_amount, amount, remaining_amount, sales_amount, due_date, closed_at_date, is_open, on_hold, reversed, source_code, loaded_at)
      values (cl_seq, s.day, 'Invoice', docnum, billto, s.customer_no, s.po, s.name, 'Invoice ' || docnum, case when s.country = 'US' then 'DOMESTIC' else 'FOREIGN' end, s.code, '', amount, amount, case when open then amount else 0 end, amount, s.day + 30, case when open then null else s.day + demo.ri(18, 45) end, open, '', false, 'SALES', now());
    cl_seq := cl_seq + 1;
    insert into public.invoices (invoice_no, customer_no, customer_name, bill_to_customer_no, posting_date, document_date, due_date, order_date, shipment_date, order_no, quote_no, external_doc_no, amount, amount_incl_tax, remaining_amount, salesperson_code, order_taken_by, price_group, disc_group, posting_group, payment_terms, shipment_method, shipping_agent, location_code, sell_to_city, sell_to_state, sell_to_zip, ship_to_name, ship_to_zip, ship_to_country, country_code, contact_name, email, phone, closed, corrective, currency_code, user_id, batch_id, first_batch_id, imported_at)
      values (docnum, s.customer_no, s.name, billto, s.day, s.day, s.day + 30, s.day - demo.ri(2, 9), s.day, 'SO' || so_seq, '', s.po, amount, amount, case when open then amount else 0 end, s.code, 'JORDAN', s.tier, '', case when s.country = 'US' then 'DOMESTIC' else 'FOREIGN' end, 'NET30', case when s.own_carrier then 'CUSTOMER' else 'GROUND' end, case when s.own_carrier then '' else demo.pick(array['XPO','UPS','FEDEX','SAIA']) end, 'MAIN', s.city, s.state, '', s.name, '', s.country, s.country, '', '', '', not open, false, '', 'NAV\JORDAN', 'imp_seed_invoices', 'imp_seed_invoices', now());
    so_seq := so_seq + 1;
    if not open then
      insert into public.customer_ledger (entry_no, posting_date, document_type, document_no, customer_no, sell_to_customer_no, external_doc_no, customer_name, description, customer_posting_group, salesperson_code, currency_code, original_amount, amount, remaining_amount, sales_amount, due_date, closed_at_date, is_open, on_hold, reversed, source_code, loaded_at)
        values (cl_seq, s.day + demo.ri(18, 45), 'Payment', 'PMT' || lpad(cl_seq::text, 6, '0'), billto, s.customer_no, '', s.name, 'Payment ' || docnum, case when s.country = 'US' then 'DOMESTIC' else 'FOREIGN' end, s.code, '', -amount, -amount, 0, 0, null, null, false, '', false, 'CASHRCPT', now());
      cl_seq := cl_seq + 1;
    end if;
    if demo.chance(0.015) and s.day + 20 < today then
      cm := -round(amount * (0.1 + random() * 0.3)::numeric, 2);
      insert into public.customer_ledger (entry_no, posting_date, document_type, document_no, customer_no, sell_to_customer_no, external_doc_no, customer_name, description, customer_posting_group, salesperson_code, currency_code, original_amount, amount, remaining_amount, sales_amount, due_date, closed_at_date, is_open, on_hold, reversed, source_code, loaded_at)
        values (cl_seq, s.day + demo.ri(5, 20), 'Credit Memo', 'PCM' || lpad(cl_seq::text, 6, '0'), billto, s.customer_no, s.po, s.name, 'Credit against ' || docnum, case when s.country = 'US' then 'DOMESTIC' else 'FOREIGN' end, s.code, '', cm, cm, 0, cm, null, s.day + 20, false, '', false, 'SALES', now());
      cl_seq := cl_seq + 1;
    end if;
  end loop;

  -- Stats the legacy JSON carries, and lifetime sales on the customer master.
  update public.records rec set data = rec.data || jsonb_build_object('stat2025', coalesce(t.prior, 0), 'stat2026YTD', coalesce(t.cur, 0))
    from (select cu.account_id, sum(l.amount) filter (where extract(year from l.day)::int = yr - 1) as prior, sum(l.amount) filter (where extract(year from l.day)::int = yr) as cur
          from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no group by cu.account_id) t
    where rec.id = t.account_id;
  update demo.customers cu set lifetime = coalesce((select sum(l.amount) from demo.ship_lines l where l.customer_no = cu.customer_no), 0);
  update public.bc_customers bc set lifetime_sales = cu.lifetime from demo.customers cu where cu.customer_no = bc.customer_no;

  -- Deals -------------------------------------------------------------------
  -- Delivering: window open, parts shipping, more expected.
  for acct in select rec.id, rec.data, cu.customer_no, cu.tier from public.records rec join demo.customers cu on cu.account_id = rec.id and cu.branch_of is null
              where rec.data ->> 'category' = 'Account Management' and cu.lifecycle in ('steady','new','growing','slipping') and cu.blocked = '' and cu.size <> 'D' order by random() limit 6 loop
    start_day := today - demo.ri(30, 90);
    select coalesce(jsonb_agg(jsonb_build_object('id', 'li_' || demo.hex(16), 'itemNo', p.item_no, 'qty', p.qty, 'desc', im.description, 'unitPrice', p.unit)), '[]'::jsonb), coalesce(sum(p.tot), 0) into scope, delivered
      from (select l.item_no, min(l.qty) as qty, min(l.unit) as unit, sum(l.amount) as tot from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no
            where cu.account_id = acct.id and l.day between start_day and today group by l.item_no order by min(l.id) limit demo.ri(3, 7)) p join demo.items im on im.item_no = p.item_no;
    continue when delivered = 0;
    value := round(delivered / (0.3 + random() * 0.45)::numeric, 2); remaining := round(value - delivered, 2);
    insert into public.records (id, owner, data, created_at, updated_at) values (next_deal::text, acct.data ->> 'accountOwner', jsonb_build_object(
      'category', 'Open Opportunities', 'title', demo.pick(deal_titles), 'linkedAccountId', acct.id, 'accountName', acct.data ->> 'title', 'customerNum', acct.customer_no, 'oppOwner', case when acct.data ->> 'accountOwner' = 'Unassigned' then 'Owen' else acct.data ->> 'accountOwner' end, 'accountOwner', acct.data ->> 'accountOwner', 'salesRep', acct.data ->> 'salesRep',
      'oppType', demo.pick(array['New Business','Upsell','Reactivation','Renewal']), 'oppDescription', demo.pick(array['Buyer confirmed quantities on the call.','Waiting on their fleet manager to sign off.','Replaces a competitor part on the same trucks.','']),
      'buyerContactId', acct.data -> 'contacts' -> 0 ->> 'id', 'scopeItems', scope, 'quotes', '[]'::jsonb, 'noteLog', '[]'::jsonb, 'nextSteps', '[]'::jsonb, 'stageHistory', '[]'::jsonb, 'completed', false, 'lastContact', (today - demo.ri(1, 20))::text,
      'dateCreated', start_day::text, 'revenuePotential', value, 'dealConfidence', case when demo.chance(0.6) then (array['50','60','70','80','90'])[demo.ri(1,5)] else '' end,
      'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', round(remaining * 0.6, 2), 'expectedDate', (today + demo.ri(7, 30))::text, 'dateBasis', 'customer', 'holdup', '', 'quoteId', null, 'itemLines', demo.relines((select jsonb_agg(z.v order by z.i) from jsonb_array_elements(scope) with ordinality as z(v, i) where z.i <= 3))),
                                         jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', round(remaining * 0.4, 2), 'expectedDate', (today + demo.ri(31, 70))::text, 'dateBasis', 'estimate', 'holdup', '', 'quoteId', null, 'itemLines', '[]'::jsonb))), now(), now());
    next_deal := next_deal + 1;
  end loop;
  -- Kept: window closed, delivered at or above 95%.
  for acct in select rec.id, rec.data, cu.customer_no from public.records rec join demo.customers cu on cu.account_id = rec.id and cu.branch_of is null
              where rec.data ->> 'category' = 'Account Management' and cu.lifecycle in ('steady','growing','slipping') and cu.blocked = '' and cu.size in ('A','B')
                and not exists (select 1 from public.records dd where dd.data ->> 'linkedAccountId' = rec.id) order by random() limit 4 loop
    start_day := today - demo.ri(150, 240); end_day := today - demo.ri(45, 90);
    select coalesce(jsonb_agg(jsonb_build_object('id', 'li_' || demo.hex(16), 'itemNo', p.item_no, 'qty', p.qty, 'desc', im.description, 'unitPrice', p.unit)), '[]'::jsonb), coalesce(sum(p.tot), 0) into scope, delivered
      from (select l.item_no, min(l.qty) as qty, min(l.unit) as unit, sum(l.amount) as tot from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no
            where cu.account_id = acct.id and l.day between start_day and end_day group by l.item_no order by min(l.id) limit demo.ri(4, 8)) p join demo.items im on im.item_no = p.item_no;
    continue when delivered < 2500;
    value := round(delivered * 0.97, 2);
    insert into public.records (id, owner, data, created_at, updated_at) values (next_deal::text, acct.data ->> 'accountOwner', jsonb_build_object(
      'category', 'Open Opportunities', 'title', demo.pick(deal_titles), 'linkedAccountId', acct.id, 'accountName', acct.data ->> 'title', 'customerNum', acct.customer_no, 'oppOwner', case when acct.data ->> 'accountOwner' = 'Unassigned' then 'Owen' else acct.data ->> 'accountOwner' end, 'accountOwner', acct.data ->> 'accountOwner', 'salesRep', acct.data ->> 'salesRep',
      'oppType', demo.pick(array['Upsell','Renewal']), 'oppDescription', '', 'buyerContactId', acct.data -> 'contacts' -> 0 ->> 'id', 'scopeItems', scope, 'quotes', '[]'::jsonb, 'noteLog', '[]'::jsonb, 'nextSteps', '[]'::jsonb, 'stageHistory', '[]'::jsonb, 'completed', false, 'lastContact', end_day::text,
      'dateCreated', start_day::text, 'revenuePotential', value, 'dealConfidence', '90',
      'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', value, 'expectedDate', end_day::text, 'dateBasis', 'customer', 'holdup', '', 'quoteId', null, 'itemLines', demo.relines((select jsonb_agg(z.v order by z.i) from jsonb_array_elements(scope) with ordinality as z(v, i) where z.i <= 2))))), now(), now());
    next_deal := next_deal + 1;
  end loop;
  -- Quoted (5), promised (4, one with no buyer), window closed short (2), pushed, broken, two operations-sized, one legacy-shaped.
  i := 0;
  for acct in select rec.id, rec.data, cu.customer_no, cu.tier from public.records rec join demo.customers cu on cu.account_id = rec.id and cu.branch_of is null
              where rec.data ->> 'category' = 'Account Management' and cu.lifecycle in ('steady','new','growing') and cu.blocked = '' and cu.size <> 'D'
                and not exists (select 1 from public.records dd where dd.data ->> 'linkedAccountId' = rec.id) order by random() limit 16 loop
    i := i + 1;
    disc := case acct.tier when 'JOBBER' then 0.29 when 'DEALER' then 0.44 when 'PERFORMANC' then 0.48 else 0.523 end;
    select coalesce(jsonb_agg(jsonb_build_object('id', 'li_' || demo.hex(16), 'itemNo', im.item_no, 'qty', demo.ri(im.qlo, im.qhi), 'desc', im.description, 'unitPrice', round(im.price * (1 - disc), 2))), '[]'::jsonb) into scope
      from (select im2.* from demo.baskets bk join demo.items im2 on im2.item_no = bk.item_no where bk.customer_no = acct.customer_no and not im2.made_to_order order by random() limit demo.ri(2, 5)) im;
    select coalesce(sum((e ->> 'qty')::numeric * (e ->> 'unitPrice')::numeric), 0) into value from jsonb_array_elements(scope) e;
    res := jsonb_build_object('category', 'Open Opportunities', 'linkedAccountId', acct.id, 'accountName', acct.data ->> 'title', 'customerNum', acct.customer_no, 'oppOwner', case when acct.data ->> 'accountOwner' = 'Unassigned' then 'Owen' else acct.data ->> 'accountOwner' end, 'accountOwner', acct.data ->> 'accountOwner', 'salesRep', acct.data ->> 'salesRep',
      'oppType', demo.pick(array['New Business','Upsell','Reactivation','Renewal']), 'oppDescription', '', 'buyerContactId', acct.data -> 'contacts' -> 0 ->> 'id', 'quotes', '[]'::jsonb, 'noteLog', '[]'::jsonb, 'nextSteps', '[]'::jsonb, 'stageHistory', '[]'::jsonb, 'completed', false, 'lastContact', (today - demo.ri(1, 20))::text);
    if i <= 5 then       -- quoted: parts this customer has never bought (a restatement of their cadence would read as delivered), with the quote on file
      select coalesce(jsonb_agg(jsonb_build_object('id', 'li_' || demo.hex(16), 'itemNo', im.item_no, 'qty', demo.ri(im.qlo, im.qhi) * 2, 'desc', im.description, 'unitPrice', round(im.price * (1 - disc), 2))), '[]'::jsonb) into scope
        from (select im2.* from demo.items im2 where not im2.made_to_order and not im2.proprietary and not im2.blocked
                and not exists (select 1 from demo.baskets bk where bk.customer_no = acct.customer_no and bk.item_no = im2.item_no) order by random() limit demo.ri(2, 5)) im;
      select round(coalesce(sum((e ->> 'qty')::numeric * (e ->> 'unitPrice')::numeric), 0) * demo.ri(2, 4), 2) into value from jsonb_array_elements(scope) e;
      qmeta := demo.quote_meta(next_deal::text);
      res := res || jsonb_build_object('title', demo.pick(deal_titles), 'dateCreated', (today - demo.ri(5, 40))::text, 'revenuePotential', value, 'dealConfidence', case when demo.chance(0.5) then (array['40','50','60'])[demo.ri(1,3)] else '' end, 'scopeItems', scope, 'quotes', qmeta,
        'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', value, 'expectedDate', (today + demo.ri(10, 45))::text, 'dateBasis', case when demo.chance(0.5) then 'customer' else 'estimate' end, 'holdup', '', 'quoteId', qmeta -> 0 ->> 'id', 'itemLines', demo.relines(scope))));
    elsif i <= 9 then    -- promised
      res := res || jsonb_build_object('title', demo.pick(deal_titles), 'dateCreated', (today - demo.ri(2, 25))::text, 'revenuePotential', demo.ri(8, 60) * 1000, 'dealConfidence', '', 'scopeItems', '[]'::jsonb, 'upcomingOrders', '[]'::jsonb, 'buyerContactId', case when i = 6 then null else acct.data -> 'contacts' -> 0 ->> 'id' end);
    elsif i <= 11 then   -- the window closed short, no answer yet
      start_day := today - demo.ri(90, 140); end_day := today - demo.ri(20, 45);
      select coalesce(sum(l.amount), 0) into delivered from demo.ship_lines l join demo.customers cu on cu.customer_no = l.customer_no where cu.account_id = acct.id and l.day between start_day and end_day and l.item_no in (select e ->> 'itemNo' from jsonb_array_elements(scope) e);
      value := round(greatest(delivered * 2.2, 15000), 2);
      res := res || jsonb_build_object('title', demo.pick(deal_titles), 'dateCreated', start_day::text, 'revenuePotential', value, 'dealConfidence', '70', 'scopeItems', scope,
        'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', value, 'expectedDate', end_day::text, 'dateBasis', 'customer', 'holdup', '', 'quoteId', null, 'itemLines', demo.relines(scope))));
    elsif i = 12 then    -- pushed
      res := res || jsonb_build_object('title', 'Stack order slipped to next quarter', 'dateCreated', (today - 120)::text, 'revenuePotential', 42000, 'dealConfidence', '50', 'scopeItems', scope,
        'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', 42000, 'expectedDate', (today - 30)::text, 'dateBasis', 'customer', 'holdup', '', 'quoteId', null, 'itemLines', demo.relines(scope))), 'commitmentOutcome', 'pushed', 'commitmentOutcomeAt', (now() - interval '12 days'));
    elsif i = 13 then    -- broken
      res := res || jsonb_build_object('title', 'Muffler program lost on price', 'dateCreated', (today - 160)::text, 'revenuePotential', 27500, 'dealConfidence', '20', 'scopeItems', '[]'::jsonb,
        'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', 27500, 'expectedDate', (today - 50)::text, 'dateBasis', 'estimate', 'holdup', '', 'quoteId', null, 'itemLines', '[]'::jsonb)), 'commitmentOutcome', 'broken', 'commitmentOutcomeAt', (now() - interval '40 days'));
    elsif i <= 15 then   -- operations-sized, customer-given dates, part lines
      select coalesce(jsonb_agg(jsonb_build_object('id', 'li_' || demo.hex(16), 'itemNo', im.item_no, 'qty', demo.ri(20, 80), 'desc', im.description, 'unitPrice', round(im.price * (1 - disc), 2))), '[]'::jsonb) into scope
        from (select im2.* from demo.items im2 where im2.family in ('stack','elbow') and not im2.made_to_order order by random() limit 6) im;
      select coalesce(sum((e ->> 'qty')::numeric * (e ->> 'unitPrice')::numeric), 0) into value from jsonb_array_elements(scope) e;
      value := round(greatest(90000, value * 3), 2);
      qmeta := demo.quote_meta(next_deal::text);
      res := res || jsonb_build_object('title', case when i = 14 then 'Fleet-wide chrome stack refit' else 'Annual elbow supply agreement' end, 'dateCreated', (today - demo.ri(10, 40))::text, 'revenuePotential', value, 'dealConfidence', '75', 'scopeItems', scope, 'quotes', qmeta,
        'upcomingOrders', jsonb_build_array(jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', round(value * 0.5, 2), 'expectedDate', (today + demo.ri(15, 35))::text, 'dateBasis', 'customer', 'holdup', '', 'quoteId', qmeta -> 0 ->> 'id', 'itemLines', demo.relines((select jsonb_agg(z.v order by z.i) from jsonb_array_elements(scope) with ordinality as z(v, i) where z.i <= 4))),
                                           jsonb_build_object('id', 'uo_' || demo.hex(16), 'amount', round(value * 0.5, 2), 'expectedDate', (today + demo.ri(50, 80))::text, 'dateBasis', 'customer', 'holdup', '', 'quoteId', qmeta -> 0 ->> 'id', 'itemLines', demo.relines((select jsonb_agg(z.v order by z.i) from jsonb_array_elements(scope) with ordinality as z(v, i) where z.i > 2)))));
    else                 -- legacy-shaped: a stage and a probability, no confidence
      res := res || jsonb_build_object('title', 'Legacy pursuit from the old pipeline', 'dateCreated', (today - 210)::text, 'revenuePotential', 18000, 'stage', 'Negotiation', 'probability', 75, 'closeDate', (today + 20)::text, 'dealConfidence', '', 'scopeItems', '[]'::jsonb, 'upcomingOrders', '[]'::jsonb);
    end if;
    insert into public.records (id, owner, data, created_at, updated_at) values (next_deal::text, res ->> 'oppOwner', res, now(), now());
    next_deal := next_deal + 1;
  end loop;

  -- The Jet open order book ---------------------------------------------------
  -- 134 orders. Yesterday: the six lowest-numbered had not shipped yet; the six highest did not exist. 128 orders each day.
  k := 481200;
  for i in 1..134 loop
    select * into c from demo.customers cu where cu.blocked = '' and cu.code <> 'CLOSED' and cu.lifecycle not in ('churned','dormant') order by random() limit 1;
    day := case when demo.chance(0.06) then today when demo.chance(0.36) then today - demo.ri(1, 26) else today + demo.ri(1, 42) end;
    is_partial := demo.chance(0.4);
    disc := case c.tier when 'JOBBER' then 0.29 when 'DEALER' then 0.44 when 'PERFORMANC' then 0.48 else 0.523 end;
    insert into demo.jet_orders (doc, customer_no, ship, taken, partial, po, agent, in_today, in_yesterday)
      values (k::text, c.customer_no, day, day - demo.ri(3, 21), is_partial, 'PO-' || demo.ri(48000, 49999), case when c.own_carrier then 'CUSTOMER PICKUP' else demo.pick(array['XPO','UPS','FEDEX','SAIA']) end, i <= 128, i > 6);
    insert into demo.jet_lines (doc, pos, item_no, qty, outstanding, unit)
      select k::text, row_number() over (order by q.item_no), q.item_no, q.qty,
             case when is_partial and demo.chance(0.3) then greatest(1, q.qty - demo.ri(1, greatest(1, q.qty - 1))) else q.qty end,
             round(im.price * (1 - disc), 2)
      from (select pool.item_no, demo.ri(im2.qlo, im2.qhi) as qty
            from (select u.item_no from (select bk.item_no from demo.baskets bk where bk.customer_no = c.customer_no
                                        union
                                        select im3.item_no from demo.items im3 where im3.made_to_order and demo.chance(0.3)) u
                  order by random() limit demo.ri(1, 6)) pool
            join demo.items im2 on im2.item_no = pool.item_no) q
      join demo.items im on im.item_no = q.item_no;
    k := k + 1;
  end loop;
  -- Make the shelf genuinely short on some of the parts in demand.
  for it in select jl.item_no, sum(jl.outstanding) as demand from demo.jet_lines jl join demo.jet_orders jo on jo.doc = jl.doc join demo.items im on im.item_no = jl.item_no where jo.in_today and not im.made_to_order group by jl.item_no loop
    if demo.chance(0.28) then
      k := greatest(0, floor(it.demand * (0.2 + random() * 0.6)))::int;
      update demo.items set qoh_gr = k, qoh = k + case when demo.chance(0.4) then demo.ri(1, 20) else 0 end where item_no = it.item_no;
    end if;
  end loop;

  -- The item master, through the same function the Items upload uses.
  select jsonb_agg(jsonb_build_object('item_no', im.item_no, 'description', im.description, 'search_description', im.description, 'item_category_code', im.category, 'product_group_code', im.product_group, 'inventory_posting_group', im.posting, 'uom', 'PCS',
    'qoh', im.qoh::text, 'qoh_gr', im.qoh_gr::text, 'on_sales_order', '0', 'on_purch_order', im.on_purch::text, 'on_prod_order', im.on_prod::text, 'unit_cost', im.cost::text, 'unit_price', im.price::text, 'sales_qty_year', demo.ri(0, 900)::text, 'sales_amount', '',
    'center_line_radius', case when im.family = 'elbow' then demo.ri(6, 12)::text else '' end, 'lead_time_calculation', im.lead, 'replenishment_system', im.replenishment, 'work_center', im.work_center, 'shelf_no', im.shelf, 'vendor_no', im.vendor_no,
    'made_to_order', case when im.made_to_order then 'Yes' else 'No' end, 'available_online', 'No', 'substitutes_exist', 'No', 'catalog_item', '', 'blocked', case when im.blocked then 'Yes' else 'No' end, 'last_modified', (today - demo.ri(1, 120))::text)) into jrows from demo.items im;
  sha := encode(extensions.digest(jrows::text, 'sha256'), 'hex');
  perform public.gr_item_master_import(jrows, 'Items.xlsx', sha, now(), 'upload', gen_random_uuid()::text);

  -- Jet snapshots, yesterday then today, through the real import function.
  for r in select * from (values (false, 1), (true, 0)) as t(is_today, back) order by back desc loop
    select jsonb_agg(jsonb_build_object('document_no', jo.doc, 'line_no', jl.pos, 'customer_no', cu.customer_no, 'customer_name', cu.name, 'salesperson_code', cu.code, 'order_status', demo.pick(array['Released','Released','Open']), 'location_code', 'MAIN', 'shelf_no', im.shelf, 'bin_code', im.bin,
      'order_taken_on', jo.taken::text, 'shipment_date', jo.ship::text, 'item_no', im.item_no, 'item_description', im.description, 'item_category', im.category, 'product_group', im.product_group, 'quantity', jl.qty, 'outstanding_qty', jl.outstanding, 'uom', 'PCS',
      'unit_price', jl.unit, 'unit_cost', im.cost, 'outstanding_amount', round(jl.outstanding * jl.unit, 2), 'qoh', greatest(0, im.qoh + r.back * 4), 'qoh_gr', greatest(0, im.qoh_gr + r.back * 4), 'partial', jo.partial, 'replenishment', im.replenishment, 'work_center', im.work_center,
      'external_document', jo.po, 'shipping_agent', jo.agent, 'payment_terms', 'NET30', 'blocked', false, 'ship_to_country_region_code', cu.country, 'sell_to_country_region_code', cu.country) order by jo.doc, jl.pos) into jrows
      from demo.jet_orders jo join demo.jet_lines jl on jl.doc = jo.doc join demo.customers cu on cu.customer_no = jo.customer_no join demo.items im on im.item_no = jl.item_no
      where (r.is_today and jo.in_today) or (not r.is_today and jo.in_yesterday);
    sha := encode(extensions.digest(jrows::text, 'sha256'), 'hex');
    perform public.gr_wh_import(jrows, 'Open Sales Lines ' || (today - r.back)::text || '.xlsx', sha, (today - r.back)::timestamptz + interval '11 hours', 'upload', gen_random_uuid()::text);
  end loop;

  -- Open orders on each account, the way the backlog import writes them.
  update public.records rec set data = rec.data || jsonb_build_object('openOrders', t.orders, 'openOrdersUpdatedAt', now())
    from (select cu.account_id, jsonb_agg(jsonb_build_object('orderNum', jo.doc, 'extDocNum', jo.po, 'quoteNum', '', 'amount', jt.total::text, 'outstandingAmount', jt.outstanding::text, 'orderDate', jo.taken::text, 'shipmentDate', jo.ship::text, 'partial', jo.partial, 'completelyShipped', false) order by jo.ship) as orders
          from demo.jet_orders jo join demo.customers cu on cu.customer_no = jo.customer_no
          join (select jl.doc, round(sum(jl.qty * jl.unit), 2) as total, round(sum(jl.outstanding * jl.unit), 2) as outstanding from demo.jet_lines jl group by jl.doc) jt on jt.doc = jo.doc
          where jo.in_today group by cu.account_id) t
    where rec.id = t.account_id;

  -- Activity the reps logged recently.
  insert into public.account_events (id, account_id, commitment_id, contact_id, kind, outcome, note, item_nos, amount, source, actor_email, actor_name, reason, at, request_id, event_id)
  select 'ev_' || demo.hex(16), cu.account_id, null, null, kk.kind, case when kk.kind = 'voicemail' then 'no answer' else demo.pick(array['reached','reached','callback']) end,
         demo.pick(array['Went over open backorders.','Sent the updated price sheet.','Asked for the Q4 forecast.','Left a message about the chrome lead time.','Stopped by with the new catalog.']), '{}'::text[], null, 'ui',
         lower(coalesce(cu.owner, 'Owen')) || '@grcrm.demo', coalesce(cu.owner, 'Owen'), null, now() - (demo.ri(1, 60) || ' days')::interval, null, null
  from demo.customers cu cross join lateral (select demo.pick(array['called','called','emailed','emailed','met','voicemail']) as kind from generate_series(1, demo.ri(1, 4))) kk
  where cu.branch_of is null and cu.lifecycle <> 'churned' and demo.chance(0.65);

  insert into public.import_batches (id, kind, label, file_name, imported_at, imported_by, counts, undoable) values
    ('imp_seed_ledger', 'ledger', 'Item ledger', 'Item Ledger Entries ' || today || '.xlsx', now() - interval '3 hours', 'Owen', jsonb_build_object('lines', (select count(*) from public.sku_transactions), 'matched', (select count(*) from public.sku_transactions), 'unmatched', 0, 'errors', 0), false),
    ('imp_seed_custledger', 'customer_ledger', 'Customer ledger', 'Customer Ledger Entries ' || today || '.xlsx', now() - interval '3 hours', 'Owen', jsonb_build_object('entries', (select count(*) from public.customer_ledger), 'matched', (select count(*) from public.customer_ledger), 'unmatched', 0, 'errors', 0), false),
    ('imp_seed_invoices', 'invoices', 'Posted invoices', 'Posted Sales Invoices ' || today || '.xlsx', now() - interval '2 hours', 'Owen', jsonb_build_object('invoices', (select count(*) from public.invoices), 'matched', (select count(*) from public.invoices), 'unmatched', 0), false),
    ('imp_seed_backlog', 'backlog', 'Open sales orders', 'Sales Orders ' || today || '.xlsx', now() - interval '2 hours', 'Owen', jsonb_build_object('order_lines', (select count(*) from demo.jet_orders jo where jo.in_today), 'accounts', 40, 'cleared', 3, 'errors', 0), false);

  select round(1.2 * coalesce(sum(cl.amount), 0) / 10000) * 10000 into goal from public.customer_ledger cl where cl.document_type in ('Invoice','Credit Memo') and extract(year from cl.posting_date)::int = yr - 1;
  insert into public.revenue_goals (year, scope, goal, set_by, notes, updated_at) values (yr, 'company', goal, 'Owen', '120% of last year', now());

  return jsonb_build_object('customers', (select count(*) from demo.customers), 'items', (select count(*) from demo.items), 'accounts', (select count(*) from public.accounts), 'deals', (select count(*) from public.commitments),
    'item_lines', (select count(*) from public.sku_transactions), 'ledger_entries', (select count(*) from public.customer_ledger), 'invoices', (select count(*) from public.invoices), 'jet_lines_today', (select count(*) from demo.jet_lines jl join demo.jet_orders jo on jo.doc = jl.doc where jo.in_today),
    'events', (select count(*) from public.account_events), 'goal', goal, 'mirror_failures', (select count(*) from public.mirror_failures),
    'revenue_by_year', (select jsonb_object_agg(t.y, t.v) from (select extract(year from cl.posting_date)::int as y, round(sum(cl.amount)) as v from public.customer_ledger cl where cl.document_type in ('Invoice','Credit Memo') group by 1) t));
end $body$;
