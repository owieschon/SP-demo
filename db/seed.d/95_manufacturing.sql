-- 95 The manufacturing world: units, work centres, labour, machines, capital,
-- overhead pools, the material master, and a bill of materials and a routing
-- for every part the plant actually makes.
--
-- Migrations 0035 and 0036 added the tables and the two roll-ups. This file
-- fills them for the catalogue that db/seed.sql already generated, which is
-- the constraint that shapes everything here: the part numbers, the
-- families, the descriptions and the costs already exist and are read by
-- half the app, so nothing may be invented that contradicts them.
--
-- HOW THE PARTS LIST IS WORKED OUT. The catalogue's part numbers are built
-- from a grammar (db/seed.sql, nl_seed.build_catalog), and so are the
-- descriptions: '4" X 48" PIPE ALUMINIZED PLAIN', '6" 45 DEG ELBOW 10" X 12"
-- CHROME', 'HEAT SHIELD 5" X 24" PERFORATED STAINLESS'. So the description
-- is the drawing: the diameter, the length, the legs and the grade are read
-- back out of it with a regular expression, and the bill of materials
-- follows from the geometry. A 4 inch by 48 inch aluminized pipe takes four
-- feet of 4 inch 16 gauge aluminized tube, because that is what it is.
--
-- HOW THE METAL PRICE IS SET. The item cards already carry a cost, and that
-- cost is the one the rest of the app reads. If the metal price were
-- invented at face value the rolled cost would land nowhere near it, and the
-- variance report would be noise rather than a finding. So the price per
-- pound is calibrated backwards from the catalogue: the wages, the machine
-- rates and the overhead pools are set at plausible figures first, the world
-- is measured, and then the price per pound is moved once so that the median
-- rolled cost sits on the median item card cost. Everything after that is
-- spread: parts heavy in machine time come out above their card, parts that
-- are mostly metal come out below it, which is the finding a plant gets the
-- first time it rolls standard cost properly. db/seed.d/50_cost_and_pricing
-- builds its cost history backwards from the item card for the same reason.
--
-- WHAT IS DELIBERATELY INCONSISTENT. The ERP's replenishment word and the
-- shape derived from the parts list disagree on purpose for two groups of
-- parts, because that disagreement is the point of deriving the shape at
-- all:
--
--   * chrome parts the ERP calls 'Purchase' that the plant actually plates
--     itself, so they have a routing and no parts list: shape 'processed'
--   * custom parts the ERP calls 'Assembly' that are welded from tube, so
--     they have both: shape 'manufactured'
--
-- A test asserts that those are the only two disagreements in the world.
--
-- Everything is keyed off nl_seed.u / ri / chance / pick, like db/seed.sql,
-- so the same day builds the same plant locally and on the server.

-- ---------------------------------------------------------------------------
-- The generator's own bookkeeping. The app never reads these.
-- ---------------------------------------------------------------------------

-- Every part the plant makes, with its geometry read back out of its
-- description and the material it therefore needs.
create table if not exists nl_seed.mfg_part (
  item_no      text primary key,
  family       text not null,
  replenishment text not null,
  chrome       boolean not null,
  stainless    boolean not null,
  grade        text not null,          -- AL, S409, S304
  dia          numeric(8, 3) not null,
  length_in    numeric(9, 3) not null, -- tube inches the part needs
  sheet_sqft   numeric(9, 4) not null default 0,
  tube_item    text,
  sheet_item   text,
  gauge        int not null,
  plated       boolean not null default false,
  polished     boolean not null default false,
  welded       boolean not null default false,
  bent         boolean not null default false,
  formed       boolean not null default false,
  shape_note   text not null default ''
);

-- The material master this file invents, before it is written to nl.items.
create table if not exists nl_seed.mfg_material (
  item_no     text primary key,
  description text not null,
  category    text not null,
  family      text not null,
  kind        text not null,
  uom         text not null,
  unit_cost   numeric(12, 2) not null,
  list_price  numeric(12, 2) not null,
  vendor_role text not null default 'steel',   -- which vendor supplies it
  lead_time   text not null default '',
  grade       text not null default '',
  gauge       text not null default '',
  od_in       numeric(8, 3),
  wall_in     numeric(8, 4),
  thickness_in numeric(8, 4),
  width_in    numeric(8, 3),
  length_in   numeric(9, 3),
  density     numeric(8, 5),
  stock_base  int not null default 0
);

create or replace function nl_seed.extra_95_manufacturing() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today      date := (select today from nl_seed.settings);
  v_first_year int  := (select first_year from nl_seed.settings);
  v_scale      double precision := (select scale from nl_seed.settings);
  v_vendors    text[];
  v_steel      text[];
  v_plater     text;
  v_hardware   text[];
  -- The price per pound the calibration pass moves.
  v_per_lb     numeric := 1.15;
  v_factor     numeric;
  v_round      int;
  v_open_note  text := 'Opening standard cost, where this history starts';
begin
  -- Which vendors supply what. The catalogue already put most parts with a
  -- vendor; these are chosen from the same list so no new vendor appears.
  select array_agg(vendor_no order by vendor_no) into v_vendors from nl.vendors;
  if v_vendors is null or cardinality(v_vendors) < 6 then
    return;   -- a world with no vendors is a world with no plant to model
  end if;

  -- Hold the roll-up triggers off for the length of this file. Everything
  -- below is a bulk load, and step 16 measures the whole catalogue itself,
  -- three times, because calibrating the metal price means measure, move one
  -- number, measure again. Without this, the statement that moves the number
  -- re-measures the catalogue as a side effect of the measure that follows
  -- it, and the file spends nine full passes where three will do. Turned off
  -- again at the end of the file, and transaction local either way, so it
  -- cannot escape the build.
  perform set_config('nl.suspend_rollup', 'on', true);
  v_steel := array[v_vendors[1], v_vendors[2], v_vendors[3]];
  v_plater := v_vendors[4];
  v_hardware := array[v_vendors[5], v_vendors[6]];

  -- -------------------------------------------------------------------------
  -- 1. Units of measure
  -- -------------------------------------------------------------------------
  insert into nl.uoms (code, name, kind, decimals) values
    ('EA',   'Each',         'count',  0),
    ('BOX',  'Box',          'count',  0),
    ('PLT',  'Pallet',       'count',  0),
    ('SHT',  'Sheet',        'count',  0),
    ('COIL', 'Coil',         'count',  0),
    ('FT',   'Foot',         'length', 2),
    ('IN',   'Inch',         'length', 2),
    ('SQFT', 'Square foot',  'area',   3),
    ('LB',   'Pound',        'weight', 3),
    ('CF',   'Cubic foot',   'volume', 2),
    ('HR',   'Hour',         'count',  2)
  on conflict (code) do nothing;

  -- The house conversions: true for everything, everywhere.
  insert into nl.uom_conversions (item_no, from_uom, to_uom, factor, note) values
    (null, 'FT', 'IN', 12, 'Twelve inches to the foot'),
    (null, 'IN', 'FT', 0.083333, 'One inch is a twelfth of a foot')
  on conflict do nothing;

  -- -------------------------------------------------------------------------
  -- 2. Labour: classes, and what an hour of each truly costs
  --
  -- The wage is not the cost. Benefits run 26% of wages here, the employer's
  -- payroll taxes 9.15%, and the plant pays 2,080 hours to get about 1,930
  -- on the floor, which is a factor of 1.078. So a 26.40 fabricator costs
  -- 38.46 an hour, and the part page shows both numbers.
  -- -------------------------------------------------------------------------
  insert into nl.labor_classes (code, name, description, department) values
    ('FAB A',    'Fabricator A',     'Sets up and runs benders and formers', 'Fabrication'),
    ('FAB B',    'Fabricator B',     'Runs saws and secondary operations',   'Fabrication'),
    ('WELD A',   'Welder A',         'Certified to the shop weld procedure', 'Fabrication'),
    ('FINISH',   'Finisher',         'Polishing, buffing and touch up',      'Finishing'),
    ('INSPECT',  'Inspector',        'First article and final inspection',   'Quality'),
    ('ASSEMBLE', 'Assembler',        'Kitting and sub assembly',             'Assembly'),
    ('PACK',     'Shipping handler', 'Packing, banding and labelling',       'Packing')
  on conflict (code) do nothing;

  -- Three revisions, so the timeline has something to show: the start of the
  -- history, a catch-up in the middle, and this year's.
  insert into nl.labor_rates (labor_class, effective_from, base_wage, fringe_pct, payroll_tax_pct, pto_factor, note)
  select
    c.code,
    make_date(y.yr, 1, 1),
    round((c.wage * y.mult)::numeric, 4),
    y.fringe,
    0.0915,
    1.078,
    y.note
  from (values
    ('FAB A', 26.40), ('FAB B', 22.10), ('WELD A', 29.75), ('FINISH', 21.60),
    ('INSPECT', 27.30), ('ASSEMBLE', 20.40), ('PACK', 18.75)
  ) as c(code, wage)
  cross join (values
    (v_first_year, 0.780, 0.2200, 'Where the wage history starts'),
    (v_first_year + 3, 0.905, 0.2450, 'Market catch up after the hiring squeeze'),
    (extract(year from v_today)::int, 1.000, 0.2600, 'Current year')
  ) as y(yr, mult, fringe, note)
  on conflict (labor_class, effective_from) do nothing;

  -- -------------------------------------------------------------------------
  -- 3. Work centres. The four strings the item master already uses
  -- ('BEND CELL', 'CUT CELL', 'WELD CELL', 'ASSEMBLY') are in here, which a
  -- test checks, along with the four the routings add.
  -- -------------------------------------------------------------------------
  insert into nl.work_centers
    (code, name, department, shifts, hours_per_day, days_per_week, efficiency, labor_class, fallback_rate, note)
  values
    ('CUT CELL',    'Cut and saw cell',    'Fabrication', 2, 8,   5, 0.850, 'FAB B',    32.00,
      'Two saws: a tube laser for volume and a cold saw for odd lengths'),
    ('BEND CELL',   'Mandrel bend cell',   'Fabrication', 2, 8,   5, 0.820, 'FAB A',    38.00,
      'Two mandrel benders, large and small'),
    ('FORM CELL',   'End forming cell',    'Fabrication', 1, 8,   5, 0.800, 'FAB A',    38.00,
      'Expands and swages ends so joints slip together'),
    ('WELD CELL',   'Weld cell',           'Fabrication', 2, 8,   5, 0.780, 'WELD A',   43.00,
      'One robotic cell and two hand booths'),
    ('POLISH CELL', 'Polish and buff',     'Finishing',   1, 8,   5, 0.750, 'FINISH',   31.00,
      'Where a chrome part earns its price'),
    ('INSPECT',     'Inspection',          'Quality',     1, 8,   5, 0.900, 'INSPECT',  39.00,
      'First article and final inspection'),
    ('ASSEMBLY',    'Assembly and kitting','Assembly',    1, 8,   5, 0.880, 'ASSEMBLE', 29.00,
      'Kits and sub assemblies'),
    ('PACK',        'Pack and ship',       'Packing',     1, 8.5, 5, 0.920, 'PACK',     27.00,
      'Cartons, banding and the wrap line')
  on conflict (code) do nothing;

  -- -------------------------------------------------------------------------
  -- 4. Capital, and the machine hour rates that come out of it
  --
  -- Nobody types a machine hour rate here. It is what the machine cost,
  -- spread straight line over its life and over the hours the plant expects
  -- to run it, plus maintenance, plus the power it draws, plus tooling, plus
  -- the floor it stands on. So the robotic weld cell costs about fourteen
  -- dollars an hour in depreciation alone and a hand booth costs under two,
  -- which is exactly why a part routed through the robot costs more per
  -- minute and the breakdown can say so.
  -- -------------------------------------------------------------------------
  insert into nl.capital_assets
    (asset_no, name, kind, acquired_on, acquisition_cost, useful_life_years, salvage_value,
     expected_annual_hours, work_center, floor_space_sqft, power_kw, note)
  values
    ('CA-001', 'Tube laser saw',            'machine', v_today - 1480, 285000, 12, 20000, 3600, 'CUT CELL',    420, 18.0, ''),
    ('CA-002', 'Cold saw',                  'machine', v_today - 3260, 48000,  15, 3000,  2600, 'CUT CELL',    120, 5.5,  ''),
    ('CA-003', 'Mandrel bender, large',     'machine', v_today - 2190, 410000, 15, 35000, 3200, 'BEND CELL',   650, 34.0, ''),
    ('CA-004', 'Mandrel bender, small',     'machine', v_today - 4015, 165000, 15, 12000, 3000, 'BEND CELL',   380, 22.0, ''),
    ('CA-005', 'End former',                'machine', v_today - 2555, 96000,  12, 6000,  1900, 'FORM CELL',   210, 11.0, ''),
    ('CA-006', 'Robotic weld cell',         'machine', v_today - 1095, 520000, 10, 40000, 3400, 'WELD CELL',   700, 46.0,
      'Bought to take the repeat elbow work off the hand booths'),
    ('CA-007', 'Weld booth one',            'machine', v_today - 3650, 38000,  12, 2500,  2400, 'WELD CELL',   160, 9.0,  ''),
    ('CA-008', 'Weld booth two',            'machine', v_today - 3650, 21000,  12, 1500,  2200, 'WELD CELL',   160, 9.0,  ''),
    ('CA-009', 'Polishing lathe',           'machine', v_today - 1825, 74000,  12, 5000,  2000, 'POLISH CELL', 240, 14.0, ''),
    ('CA-010', 'Buffing station',           'machine', v_today - 2920, 32000,  10, 2000,  1800, 'POLISH CELL', 150, 7.5,  ''),
    ('CA-011', 'Measuring arm',             'machine', v_today - 730,  88000,  8,  5000,  1500, 'INSPECT',      90, 1.2,  ''),
    ('CA-012', 'Strap and wrap line',       'machine', v_today - 2190, 27000,  10, 1500,  2200, 'PACK',        180, 4.0,  ''),
    ('CA-013', 'Assembly benches and jigs', 'fixture', v_today - 3285, 34000,  10, 2000,  2000, 'ASSEMBLY',    320, 1.0,  '')
  on conflict (asset_no) do nothing;

  insert into nl.machines
    (code, name, work_center, asset_no, maintenance_per_hour, energy_kw, energy_rate_per_kwh,
     tooling_per_hour, tooling_per_piece, floor_space_sqft, floor_rate_per_sqft_year, note)
  values
    ('SAW-LASER', 'Tube laser saw',        'CUT CELL',    'CA-001', 3.40, 18.0, 0.1150, 1.80, 0.0000, 420, 4.00, ''),
    ('SAW-COLD',  'Cold saw',              'CUT CELL',    'CA-002', 0.90, 5.5,  0.1150, 0.35, 0.0000, 120, 4.00, ''),
    ('BEND-LG',   'Mandrel bender, large', 'BEND CELL',   'CA-003', 5.20, 34.0, 0.1150, 2.40, 0.0400, 650, 4.00,
      'The large bender carries a mandrel set per diameter, so tooling is charged per piece as well as per hour'),
    ('BEND-SM',   'Mandrel bender, small', 'BEND CELL',   'CA-004', 2.80, 22.0, 0.1150, 1.60, 0.0300, 380, 4.00, ''),
    ('FORM-1',    'End former',            'FORM CELL',   'CA-005', 1.60, 11.0, 0.1150, 0.80, 0.0000, 210, 4.00, ''),
    ('WELD-ROBOT','Robotic weld cell',     'WELD CELL',   'CA-006', 7.50, 46.0, 0.1150, 3.20, 0.0000, 700, 4.00, ''),
    ('WELD-1',    'Weld booth one',        'WELD CELL',   'CA-007', 1.10, 9.0,  0.1150, 0.90, 0.0000, 160, 4.00, ''),
    ('WELD-2',    'Weld booth two',        'WELD CELL',   'CA-008', 1.10, 9.0,  0.1150, 0.90, 0.0000, 160, 4.00, ''),
    ('POLISH-1',  'Polishing lathe',       'POLISH CELL', 'CA-009', 2.30, 14.0, 0.1150, 2.80, 0.0000, 240, 4.00, ''),
    ('BUFF-1',    'Buffing station',       'POLISH CELL', 'CA-010', 1.40, 7.5,  0.1150, 1.90, 0.0000, 150, 4.00, ''),
    ('CMM-1',     'Measuring arm',         'INSPECT',     'CA-011', 1.90, 1.2,  0.1150, 0.00, 0.0000,  90, 4.00, ''),
    ('PACK-1',    'Strap and wrap line',   'PACK',        'CA-012', 0.60, 4.0,  0.1150, 0.10, 0.0000, 180, 4.00, ''),
    ('BENCH-1',   'Assembly bench',        'ASSEMBLY',    'CA-013', 0.30, 1.0,  0.1150, 0.05, 0.0000, 320, 4.00, '')
  on conflict (code) do nothing;

  -- -------------------------------------------------------------------------
  -- 5. Overhead pools
  --
  -- Five pools, four different drivers, because which driver is right is
  -- exactly what a plant argues about and the argument belongs in data. The
  -- amounts are a year of indirect cost; the driver quantity is how much of
  -- the driver the plant used in that year. The rate is one over the other.
  -- -------------------------------------------------------------------------
  insert into nl.overhead_pools (code, name, department, driver, note) values
    ('PLANT_FIXED',   'Rent, insurance and utilities',     '',            'machine hours',
      'Absorbed on machine hours: the building exists to hold the machines'),
    ('SUPERVISION',   'Supervision and scheduling',        'Fabrication', 'labor hours',
      'A supervisor watches people, so it follows labour'),
    ('QUALITY',       'Quality department',                '',            'labor hours', ''),
    ('MATL_HANDLING', 'Receiving and materials handling',  '',            'material value',
      'Handling cost tracks the value and bulk of what is moved, not the hours spent on it'),
    ('FLOOR_SPACE',   'Fabrication floor space',           'Fabrication', 'floor space',
      'Charged per square foot per year and absorbed by the share of the year a machine is running')
  on conflict (code) do nothing;

  -- One period per year, including the one that covers today.
  insert into nl.overhead_pool_periods (pool_code, period_start, period_end, amount, driver_quantity, note)
  select
    p.code,
    make_date(y.yr, 1, 1),
    make_date(y.yr, 12, 31),
    round((p.amount * y.mult)::numeric, 2),
    round((p.driver_qty * y.mult)::numeric, 4),
    ''
  from (values
    ('PLANT_FIXED',   420000, 34000),
    ('SUPERVISION',   285000, 42000),
    ('QUALITY',       148000, 42000),
    ('MATL_HANDLING', 310000, 7400000),
    ('FLOOR_SPACE',    96000, 24000)
  ) as p(code, amount, driver_qty)
  cross join (values
    (extract(year from v_today)::int - 2, 0.90, 0.95),
    (extract(year from v_today)::int - 1, 0.95, 0.98),
    (extract(year from v_today)::int,     1.00, 1.00)
  ) as y(yr, mult, qty_mult)
  on conflict (pool_code, period_start) do nothing;

  -- -------------------------------------------------------------------------
  -- 6. The material master
  --
  -- Tube is stocked by the foot, sheet by the square foot, wire and compound
  -- by the pound, gas by the cubic foot, and everything else each. Weight is
  -- derived from the gauge and the geometry (nl.item_material), never typed,
  -- and the cost per foot is the weight per foot times the price per pound,
  -- which is the one number the calibration pass at the end moves.
  -- -------------------------------------------------------------------------
  delete from nl_seed.mfg_material;

  -- Tube: every diameter the catalogue's part numbers use, in the gauges
  -- that go with them, in the three grades the descriptions name.
  insert into nl_seed.mfg_material
    (item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time,
     grade, gauge, od_in, wall_in, length_in, density, stock_base)
  select
    'RM-TU-' || lpad((d.dia * 100)::int::text, 4, '0') || '-' || g.ga || '-' || m.grade,
    'TUBE ' || d.dia || '" ' || g.ga || 'GA ' || m.label || ' 20FT',
    'RAW', 'tube', 'raw material', 'FT',
    -- Provisional: the calibration pass moves it once, at the end.
    round((m.density * pi() * (d.dia - g.wall) * g.wall * 12 * v_per_lb * m.price_mult)::numeric, 2),
    round((m.density * pi() * (d.dia - g.wall) * g.wall * 12 * v_per_lb * m.price_mult * 2.4)::numeric, 2),
    'steel',
    (array['3W', '4W', '2W', '6W'])[1 + nl_seed.ri(0, 3, 'mfg.tube.lead|' || d.dia || g.ga || m.grade)],
    m.grade, g.ga || 'GA', d.dia, g.wall, 240, m.density,
    nl_seed.ri(200, 2400, 'mfg.tube.stock|' || d.dia || g.ga || m.grade)
  from (values (2.5), (3.0), (3.5), (4.0), (4.5), (5.0), (5.5), (6.0), (6.5), (7.0), (8.0), (9.0), (10.0))
    as d(dia)
  cross join (values (16, 0.0598), (14, 0.0747), (12, 0.1046)) as g(ga, wall)
  cross join (values ('AL', 'ALUMINIZED', 0.28300, 1.00),
                     ('S409', 'STAINLESS 409', 0.28300, 1.35),
                     ('S304', 'STAINLESS 304', 0.28900, 2.26)) as m(grade, label, density, price_mult);

  -- Sheet, by the square foot.
  insert into nl_seed.mfg_material
    (item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time,
     grade, gauge, thickness_in, width_in, length_in, density, stock_base)
  select
    'RM-SH-' || g.ga || '-' || m.grade,
    'SHEET ' || g.ga || 'GA ' || m.label || ' 4X10',
    'RAW', 'sheet', 'raw material', 'SQFT',
    round((m.density * g.thick * 144 * v_per_lb * m.price_mult)::numeric, 2),
    round((m.density * g.thick * 144 * v_per_lb * m.price_mult * 2.4)::numeric, 2),
    'steel', '4W',
    m.grade, g.ga || 'GA', g.thick, 48, 120, m.density,
    nl_seed.ri(150, 900, 'mfg.sheet.stock|' || g.ga || m.grade)
  from (values (16, 0.0598), (14, 0.0747), (11, 0.1196)) as g(ga, thick)
  cross join (values ('AL', 'ALUMINIZED', 0.28300, 1.00),
                     ('S409', 'STAINLESS 409', 0.28300, 1.35)) as m(grade, label, density, price_mult);

  -- Bought components: flanges, u-bolts, gaskets, muffler internals,
  -- bracket blanks and hardware.
  insert into nl_seed.mfg_material
    (item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time, grade, stock_base)
  select * from (values
    ('CP-HW-B38', 'BOLT 3/8-16 X 1 1/4 ZINC',        'COMPONENTS', 'hardware', 'component', 'EA', 0.18, 0.55, 'hardware', '2W', 'ZINC', 8000),
    ('CP-HW-N38', 'NUT 3/8-16 FLANGE ZINC',          'COMPONENTS', 'hardware', 'component', 'EA', 0.09, 0.30, 'hardware', '2W', 'ZINC', 9000),
    ('CP-HW-W38', 'WASHER 3/8 ZINC',                 'COMPONENTS', 'hardware', 'component', 'EA', 0.04, 0.15, 'hardware', '2W', 'ZINC', 12000),
    ('CS-WIRE-AL','WELD WIRE 0.035 ALUMINIZED',      'CONSUMABLES','consumable','consumable','LB', 2.80, 6.20, 'steel',    '1W', 'AL',   900),
    ('CS-WIRE-SS','WELD WIRE 0.035 STAINLESS 308',   'CONSUMABLES','consumable','consumable','LB', 6.40, 14.00,'steel',    '2W', 'S304', 400),
    ('CS-GAS-AR75','SHIELDING GAS ARGON 75 CO2 25',  'CONSUMABLES','consumable','consumable','CF', 0.40, 0.95, 'hardware', '1W', '',     2500),
    ('CS-ABR-40', 'ABRASIVE DISC 40 GRIT',           'CONSUMABLES','consumable','consumable','EA', 1.20, 3.10, 'hardware', '1W', '',     1800),
    ('CS-ABR-80', 'ABRASIVE DISC 80 GRIT',           'CONSUMABLES','consumable','consumable','EA', 1.35, 3.40, 'hardware', '1W', '',     1600),
    ('CS-POLISH', 'POLISHING COMPOUND',              'CONSUMABLES','consumable','consumable','LB', 6.50, 15.00,'hardware', '2W', '',     300),
    ('PK-CTN-S',  'CARTON SMALL 24X6X6',             'PACKAGING',  'packaging','packaging', 'EA', 0.85, 2.10, 'hardware', '1W', '',     4000),
    ('PK-CTN-M',  'CARTON MEDIUM 48X8X8',            'PACKAGING',  'packaging','packaging', 'EA', 1.40, 3.40, 'hardware', '1W', '',     3000),
    ('PK-CTN-L',  'CARTON LARGE 96X10X10',           'PACKAGING',  'packaging','packaging', 'EA', 2.60, 6.20, 'hardware', '1W', '',     1500),
    ('PK-PLT-48', 'PALLET 48X48 HEAT TREATED',       'PACKAGING',  'packaging','packaging', 'EA', 11.50, 26.00,'hardware', '2W', '',     600),
    ('PK-BAND',   'STEEL BANDING 1/2 INCH',          'PACKAGING',  'packaging','packaging', 'FT', 0.04, 0.12, 'hardware', '1W', '',     20000),
    ('PK-WRAP',   'STRETCH WRAP 18 INCH',            'PACKAGING',  'packaging','packaging', 'FT', 0.02, 0.07, 'hardware', '1W', '',     30000),
    ('PK-LBL',    'SHIPPING AND PART LABEL',         'PACKAGING',  'packaging','packaging', 'EA', 0.03, 0.10, 'hardware', '1W', '',     25000)
  ) as t(item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time, grade, stock_base);

  -- Flanges, u-bolts and gaskets, one per diameter the catalogue uses.
  insert into nl_seed.mfg_material
    (item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time, grade, od_in, stock_base)
  select
    p.prefix || lpad((d.dia * 100)::int::text, 4, '0'),
    p.label || ' ' || d.dia || '" ' || p.grade,
    'COMPONENTS', 'hardware', 'component', 'EA',
    round((p.base + d.dia * p.per_inch)::numeric, 2),
    round(((p.base + d.dia * p.per_inch) * 2.6)::numeric, 2),
    'hardware',
    (array['3W', '4W', '2W'])[1 + nl_seed.ri(0, 2, 'mfg.comp.lead|' || p.prefix || d.dia)],
    p.grade, d.dia,
    nl_seed.ri(150, 1800, 'mfg.comp.stock|' || p.prefix || d.dia)
  from (values ('CP-FLG-', 'FLANGE', 'ZINC', 2.90, 1.20),
               ('CP-UBT-', 'U-BOLT', 'ZINC', 1.80, 0.60),
               ('CP-GSK-', 'GASKET', 'GRAPHITE', 1.10, 0.35)) as p(prefix, label, grade, base, per_inch)
  cross join (values (3.0), (3.5), (4.0), (4.5), (5.0), (5.5), (6.0), (7.0), (8.0)) as d(dia);

  -- Muffler internals: a perforated tube by the foot and a baffle set.
  insert into nl_seed.mfg_material
    (item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time, grade, od_in, stock_base)
  select
    'CP-PTU-' || lpad((d.dia * 100)::int::text, 4, '0'),
    'PERFORATED TUBE ' || d.dia || '" ALUMINIZED',
    'COMPONENTS', 'hardware', 'component', 'FT',
    round((2.60 + d.dia * 0.55)::numeric, 2),
    round(((2.60 + d.dia * 0.55) * 2.5)::numeric, 2),
    'steel', '5W', 'AL', d.dia,
    nl_seed.ri(100, 700, 'mfg.ptu.stock|' || d.dia)
  from (values (4.0), (5.0), (6.0)) as d(dia);

  insert into nl_seed.mfg_material
    (item_no, description, category, family, kind, uom, unit_cost, list_price, vendor_role, lead_time, grade, od_in, stock_base)
  select
    'CP-BAF-' || lpad((d.dia * 100)::int::text, 4, '0'),
    'MUFFLER BAFFLE SET ' || d.dia || '" BODY',
    'COMPONENTS', 'hardware', 'component', 'EA',
    round((3.40 + d.dia * 0.28)::numeric, 2),
    round(((3.40 + d.dia * 0.28) * 2.5)::numeric, 2),
    'steel', '6W', 'AL', d.dia,
    nl_seed.ri(60, 400, 'mfg.baf.stock|' || d.dia)
  from (values (10.0), (11.0), (12.0), (13.0)) as d(dia);

  -- -------------------------------------------------------------------------
  -- 7. The material master goes into nl.items
  --
  -- These are real parts on the item master, not a side table: they are
  -- bought, stocked, counted and consumed like anything else. What makes
  -- them different is their kind, and that they are not sellable, so no SKU
  -- is created for them.
  -- -------------------------------------------------------------------------
  insert into nl.items
    (item_no, description, category, family, product_group, unit_cost, list_price, replenishment,
     work_center, vendor_no, lead_time, made_to_order, proprietary, blocked, kind,
     reorder_point, safety_stock, non_stock)
  select
    m.item_no, m.description, m.category, m.family,
    case when m.category = 'RAW' then 'RAW' else 'ACCESSORY' end,
    m.unit_cost, m.list_price, 'Purchase', '',
    case m.vendor_role
      when 'steel' then v_steel[1 + nl_seed.ri(0, 2, 'mfg.vendor|' || m.item_no)]
      else v_hardware[1 + nl_seed.ri(0, 1, 'mfg.vendor|' || m.item_no)]
    end,
    m.lead_time, false, false, false, m.kind,
    greatest(20, round(m.stock_base * 0.35))::int,
    greatest(10, round(m.stock_base * 0.15))::int,
    false
  from nl_seed.mfg_material m
  on conflict (item_no) do nothing;

  -- The physical facts, so weight is derived rather than asserted.
  insert into nl.item_material
    (item_no, grade, gauge, od_in, wall_in, thickness_in, width_in, length_in, finish, density_lb_in3, note)
  select m.item_no, m.grade, m.gauge, m.od_in, m.wall_in, m.thickness_in, m.width_in, m.length_in,
         case when m.grade like 'S%' then 'MILL' else 'ALUMINIZED' end,
         m.density, ''
  from nl_seed.mfg_material m
  where m.density is not null or m.od_in is not null
  on conflict (item_no) do nothing;

  -- A sheet is bought as a sheet and used by the square foot, and a banding
  -- coil is bought as a coil and used by the foot. Those conversions belong
  -- to the part, not to the house.
  insert into nl.uom_conversions (item_no, from_uom, to_uom, factor, note)
  select m.item_no, 'SHT', 'SQFT', 40, 'A 4 by 10 sheet is forty square feet'
  from nl_seed.mfg_material m where m.family = 'sheet'
  on conflict do nothing;

  insert into nl.uom_conversions (item_no, from_uom, to_uom, factor, note) values
    ('PK-BAND', 'COIL', 'FT', 2200, 'A coil of half inch banding runs about 2,200 feet'),
    ('PK-WRAP', 'COIL', 'FT', 1500, 'A roll of stretch wrap is about 1,500 feet')
  on conflict do nothing;

  -- Muffler shells: a phantom sub assembly. It is welded from sheet and it
  -- is never stocked or sold on its own, so its parts list is exploded into
  -- the muffler above it. Having one in the world is the point: it is what
  -- makes the roll-up's pass-through behaviour visible.
  insert into nl.items
    (item_no, description, category, family, product_group, unit_cost, list_price, replenishment,
     work_center, vendor_no, lead_time, made_to_order, proprietary, blocked, kind, phantom, non_stock)
  select
    'WP-SHELL-' || lpad((d.dia * 100)::int::text, 4, '0'),
    'MUFFLER SHELL ' || d.dia || '" WELDED, PHANTOM',
    'WIP', 'wip', 'RAW',
    0, 0, 'Prod. Order', 'WELD CELL', null, '', false, false, false,
    'work in progress', true, true
  from (values (10.0), (11.0), (12.0), (13.0)) as d(dia)
  on conflict (item_no) do nothing;

  -- Stock, bins and an opening balance for everything this file added, so
  -- the item master, the shelves and the stock ledger still say the same
  -- number (nl.warehouse_drift stays empty). Material lives at the main
  -- plant, because that is where it is consumed.
  insert into nl.stock (item_no, on_hand, on_production_order, on_purchase_order, shelf, bin, as_of)
  select
    m.item_no,
    m.stock_base,
    0,
    -- Nothing on order, deliberately. The daily ERP sample
    -- (nl.sample_open_purchase_lines) does not carry purchase orders for raw
    -- material, so a figure here would be a quantity with no order behind it:
    -- exactly the drift the supply seed test exists to catch, and exactly the
    -- lie a buyer would find first. Material shows what is on hand.
    0,
    s.shelf,
    s.shelf || '-' || nl_seed.ri(1, 6, 'mfg.bin|' || m.item_no),
    v_today
  from nl_seed.mfg_material m
  cross join lateral (
    select case m.category
             when 'RAW' then 'R-' || nl_seed.ri(1, 12, 'mfg.shelf|' || m.item_no)
             when 'COMPONENTS' then 'C-' || nl_seed.ri(1, 20, 'mfg.shelf|' || m.item_no)
             else 'S-' || nl_seed.ri(1, 10, 'mfg.shelf|' || m.item_no)
           end as shelf
  ) s
  on conflict (item_no) do nothing;

  insert into nl.stock_bins (item_no, location_code, zone, aisle, shelf, bin, quantity, counted_on)
  select
    s.item_no, 'MAIN',
    case when m.category = 'RAW' and m.family = 'tube' then 'PIPE RACK'
         when m.category = 'COMPONENTS' then 'SMALL PARTS'
         else 'BULK' end,
    split_part(s.shelf, '-', 1),
    s.shelf,
    s.bin,
    s.on_hand,
    null
  from nl.stock s
  join nl_seed.mfg_material m on m.item_no = s.item_no
  on conflict (item_no, location_code) do nothing;

  insert into nl.stock_opening (item_no, location_code, opened_on, quantity)
  select b.item_no, b.location_code, v_today - 90, b.quantity
  from nl.stock_bins b
  join nl_seed.mfg_material m on m.item_no = b.item_no
  on conflict (item_no, location_code) do nothing;

  -- -------------------------------------------------------------------------
  -- 8. Kinds and flags on the parts that were already there
  -- -------------------------------------------------------------------------
  -- The catalogue's own raw material (RW-) is sold to fab shops, so it is on
  -- the item master as a finished good. It is raw material all the same.
  update nl.items set kind = 'raw material' where family = 'raw' and kind <> 'raw material';

  -- A custom part is configured to order by definition: it is made from a
  -- drawing the customer sent.
  update nl.items set configured_to_order = true
   where family = 'custom' and not configured_to_order;

  -- A proprietary part belongs to one account, and a few of them are made
  -- from material that account supplies.
  update nl.items set customer_supplied = true
   where proprietary and nl_seed.chance(0.25, 'mfg.cust.supplied|' || item_no);

  -- A handful of bulky bought parts are drop shipped from the vendor: they
  -- never touch our dock.
  update nl.items set drop_shipped = true
   where replenishment = 'Purchase' and family = 'muffler'
     and nl_seed.chance(0.12, 'mfg.dropship|' || item_no);

  -- -------------------------------------------------------------------------
  -- 9. SKUs: the sellable unit on top of a part
  --
  -- Every sellable part gets an each. Small parts that ship by the box get a
  -- box SKU as well, with a pack quantity and a barcode, and the clamps that
  -- move by the pallet get a pallet.
  -- -------------------------------------------------------------------------
  insert into nl.skus (sku_code, item_no, pack_quantity, uom, is_default, barcode,
                       weight_lb, length_in, width_in, height_in, sellable, note)
  select
    i.item_no, i.item_no, 1, 'EA', true,
    -- A 12 digit invented barcode, keyed so it never moves.
    lpad((400000000000 + nl_seed.ri(1, 99999999, 'mfg.barcode|' || i.item_no))::text, 12, '0'),
    round(w.weight::numeric, 3),
    round(w.long::numeric, 2), round(w.wide::numeric, 2), round(w.wide::numeric, 2),
    not i.blocked,
    ''
  from nl.items i
  cross join lateral (
    select
      case i.family
        when 'pipe' then 2.2 + i.unit_cost * 0.12
        when 'elbow' then 1.8 + i.unit_cost * 0.10
        when 'stack' then 3.0 + i.unit_cost * 0.10
        when 'muffler' then 18.0
        when 'clamp' then 0.8
        when 'flex' then 2.4
        when 'shield' then 1.5
        when 'bracket' then 0.9
        when 'kit' then 26.0
        else 2.0
      end as weight,
      case when i.description ~ 'X ([0-9]+)"'
           then least(150, greatest(6, (regexp_match(i.description, 'X ([0-9]+)"'))[1]::numeric + 4))
           else 14 end as long,
      case when i.description ~ '^([0-9.]+)"'
           then least(24, greatest(3, (regexp_match(i.description, '^([0-9.]+)"'))[1]::numeric + 1))
           else 6 end as wide
  ) w
  where i.kind = 'finished good'
  on conflict (sku_code) do nothing;

  -- Box and pallet SKUs for the parts that actually ship that way.
  insert into nl.skus (sku_code, item_no, pack_quantity, uom, is_default, barcode,
                       weight_lb, length_in, width_in, height_in, sellable, note)
  select
    i.item_no || p.suffix, i.item_no, p.qty, p.uom, false,
    lpad((410000000000 + nl_seed.ri(1, 99999999, 'mfg.barcode' || p.suffix || '|' || i.item_no))::text, 12, '0'),
    round((s.weight_lb * p.qty * 1.06)::numeric, 3),
    p.long, p.wide, p.high, true, p.note
  from nl.items i
  join nl.skus s on s.item_no = i.item_no and s.is_default
  cross join (values ('-BX10', 10, 'BOX', 26.0, 14.0, 10.0, 'The box the pick face is stocked in'),
                     ('-PLT', 200, 'PLT', 48.0, 48.0, 42.0, 'Pallet quantity, for a distributor order')
             ) as p(suffix, qty, uom, long, wide, high, note)
  where i.family in ('clamp', 'bracket')
    and not i.blocked
    -- Not every small part is boxed, and only the busiest go by the pallet.
    and (p.suffix = '-BX10' or nl_seed.chance(0.25, 'mfg.pallet|' || i.item_no))
  on conflict (sku_code) do nothing;

  -- A few parts the catalogue superseded: discontinued, with a replacement.
  update nl.skus s
     set discontinued = true,
         replaced_by = (select s2.sku_code from nl.skus s2
                         join nl.items i2 on i2.item_no = s2.item_no
                        where i2.family = (select i3.family from nl.items i3 where i3.item_no = s.item_no)
                          and s2.sku_code <> s.sku_code and s2.is_default and not s2.discontinued
                        order by s2.sku_code limit 1)
   where s.is_default
     and exists (select 1 from nl.items i where i.item_no = s.item_no and i.blocked)
     and nl_seed.chance(0.2, 'mfg.superseded|' || s.sku_code);
  -- A replacement that could not be found leaves the SKU live, because a
  -- discontinued SKU with nowhere to point is worse than no flag at all.
  update nl.skus set discontinued = false where discontinued and replaced_by is null;

  -- -------------------------------------------------------------------------
  -- 10. What the plant makes, and what each part is therefore made of
  --
  -- The geometry is read back out of the description, which the catalogue
  -- built from its own grammar. Where a description carries no dimensions (a
  -- custom part made from a drawing, a proprietary part) the part falls back
  -- to a four inch body of a nominal length, which is what the shop would
  -- quote before the drawing arrives.
  -- -------------------------------------------------------------------------
  delete from nl_seed.mfg_part;

  insert into nl_seed.mfg_part
    (item_no, family, replenishment, chrome, stainless, grade, dia, length_in, sheet_sqft,
     gauge, plated, polished, welded, bent, formed, shape_note)
  select
    i.item_no,
    i.family,
    i.replenishment,
    i.description like '%CHROME%',
    i.description like '%STAINLESS%',
    case when i.description like '%STAINLESS 304%' then 'S304'
         when i.description like '%STAINLESS%' then 'S409'
         else 'AL' end,
    g.dia,
    g.tube_in,
    g.sheet_sqft,
    case when g.dia <= 4 then 16 when g.dia <= 6 then 14 else 12 end,
    -- A chrome part is plated outside, after everything else is done to it.
    i.description like '%CHROME%',
    -- Chrome and stainless are polished; aluminized is not.
    i.description like '%CHROME%' or i.description like '%STAINLESS%',
    i.family in ('elbow', 'stack', 'muffler', 'shield', 'custom', 'proprietary'),
    i.family = 'elbow'
      or (i.family = 'stack' and i.description ~ '(MITER|CURVED|TURNOUT|BULL HAULER|REDUCER)'),
    i.description like '%EXPANDED%' or i.description like '%SLIP%',
    ''
  from nl.items i
  cross join lateral (
    select
      -- Diameter: the first inch figure in the description, however it is
      -- written, and four inches when there is none.
      coalesce(
        (regexp_match(i.description, '^([0-9]+(?:\.[0-9]+)?)"'))[1]::numeric,
        (regexp_match(i.description, 'HEAT SHIELD ([0-9]+(?:\.[0-9]+)?)"'))[1]::numeric,
        (regexp_match(i.description, 'MUFFLER [A-Z]+ ([0-9]+)"'))[1]::numeric,
        4) as dia,
      -- Tube inches: an elbow is its two legs plus a bend allowance, a pipe
      -- or a stack is its length, a shield and a muffler are sheet and take
      -- no tube of their own.
      case
        when i.family = 'elbow' then
          coalesce((regexp_match(i.description, 'ELBOW ([0-9]+)" X ([0-9]+)"'))[1]::numeric, 10)
          + coalesce((regexp_match(i.description, 'ELBOW ([0-9]+)" X ([0-9]+)"'))[2]::numeric, 12)
          -- A mandrel bend eats a length of tube proportional to the radius
          -- and the angle it turns through.
          + coalesce(
              (regexp_match(i.description, '" ([0-9]+) DEG'))[1]::numeric / 90
              * coalesce((regexp_match(i.description, '^([0-9]+(?:\.[0-9]+)?)"'))[1]::numeric, 4) * 1.6,
              4)
        when i.family in ('pipe', 'stack') then
          coalesce((regexp_match(i.description, 'X ([0-9]+)"'))[1]::numeric, 36)
        when i.family = 'muffler' then
          -- Inlet and outlet necks.
          coalesce((regexp_match(i.description, '([0-9]+)" IN/OUT'))[1]::numeric, 5) * 2
        when i.family = 'custom' then 30
        when i.family = 'proprietary' then 24
        else 0
      end as tube_in,
      -- Sheet, in square feet: a shield wraps rather more than half the
      -- circumference, a muffler body wraps all of it.
      case
        when i.family = 'shield' then
          pi() * coalesce((regexp_match(i.description, 'HEAT SHIELD ([0-9]+(?:\.[0-9]+)?)"'))[1]::numeric, 5)
          * coalesce((regexp_match(i.description, 'X ([0-9]+)"'))[1]::numeric, 24) * 0.58 / 144
        when i.family = 'muffler' then
          pi() * coalesce((regexp_match(i.description, 'MUFFLER [A-Z]+ ([0-9]+)"'))[1]::numeric, 12)
          * coalesce((regexp_match(i.description, 'X ([0-9]+)"'))[1]::numeric, 36) * 1.08 / 144
        else 0
      end as sheet_sqft
  ) g
  where i.replenishment in ('Prod. Order', 'Assembly')
    and i.family <> 'kit';

  -- Which tube and which sheet each part actually pulls: the nearest
  -- diameter the material master stocks, in the part's own grade and the
  -- gauge that goes with its diameter.
  update nl_seed.mfg_part p
     set tube_item = (
           select m.item_no
           from nl_seed.mfg_material m
           where m.family = 'tube' and m.grade = p.grade
             and m.gauge = p.gauge || 'GA'
           order by abs(m.od_in - p.dia), m.item_no
           limit 1)
   where p.length_in > 0;

  update nl_seed.mfg_part p
     set sheet_item = (
           select m.item_no
           from nl_seed.mfg_material m
           where m.family = 'sheet'
             and m.grade = case when p.grade = 'S304' then 'S409' else p.grade end
             and m.gauge = case when p.family = 'muffler' then '14GA' else '16GA' end
           limit 1)
   where p.sheet_sqft > 0;

  -- -------------------------------------------------------------------------
  -- 11. Bills of material
  -- -------------------------------------------------------------------------

  -- Line 10: the tube or the sheet the part is cut from. Scrap is on the
  -- material line, where it belongs: a saw cut and a bend lose metal.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, is_phantom, operation_seq, reference_note)
  select
    p.item_no, 10, p.tube_item,
    round((p.length_in / 12)::numeric, 5), 'FT',
    case when p.bent then 0.045 else 0.025 end,
    false, 10,
    'Cut from ' || p.length_in || ' inches of tube'
  from nl_seed.mfg_part p
  where p.tube_item is not null and p.length_in > 0
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    p.item_no, 20, p.sheet_item,
    round(p.sheet_sqft::numeric, 5), 'SQFT', 0.09, 10,
    'Blanked from sheet, with the drop allowed for'
  from nl_seed.mfg_part p
  where p.sheet_item is not null and p.sheet_sqft > 0
    -- A muffler's body comes through its phantom shell, not straight off
    -- the sheet.
    and p.family <> 'muffler'
  on conflict (parent_item, line_no) do nothing;

  -- A muffler is a phantom shell, a perforated tube, a baffle set and two
  -- necks. Four levels of tree: kit, muffler, shell, sheet.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 20,
         'WP-SHELL-' || lpad((round(least(13, greatest(10, p.dia))) * 100)::int::text, 4, '0'),
         1, 'EA', 0, 10, 'The welded shell, a phantom: its own parts list explodes into this one'
  from nl_seed.mfg_part p
  where p.family = 'muffler'
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 30,
         'CP-PTU-' || lpad((round(least(6, greatest(4, p.length_in / 2))) * 100)::int::text, 4, '0'),
         round((p.length_in / 12 * 1.4)::numeric, 5), 'FT', 0.02, 20, 'Perforated inner tube'
  from nl_seed.mfg_part p
  where p.family = 'muffler'
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 40,
         'CP-BAF-' || lpad((round(least(13, greatest(10, p.dia))) * 100)::int::text, 4, '0'),
         1, 'EA', 0, 20, 'Baffle set'
  from nl_seed.mfg_part p
  where p.family = 'muffler'
  on conflict (parent_item, line_no) do nothing;

  -- The phantom shell's own parts list: sheet and wire.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    w.item_no, 10, 'RM-SH-14-AL',
    round((pi() * d.dia * 34 * 1.08 / 144)::numeric, 5), 'SQFT', 0.11, 10,
    'Body wrap, rolled and seam welded'
  from (values (10.0), (11.0), (12.0), (13.0)) as d(dia)
  cross join lateral (select 'WP-SHELL-' || lpad((d.dia * 100)::int::text, 4, '0') as item_no) w
  where exists (select 1 from nl.items i where i.item_no = w.item_no)
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select w.item_no, 20, 'CS-WIRE-AL', 0.14, 'LB', 0, 10, 'Seam weld'
  from (values (10.0), (11.0), (12.0), (13.0)) as d(dia)
  cross join lateral (select 'WP-SHELL-' || lpad((d.dia * 100)::int::text, 4, '0') as item_no) w
  where exists (select 1 from nl.items i where i.item_no = w.item_no)
  on conflict (parent_item, line_no) do nothing;

  -- Flanges and gaskets, on the parts that join to a manifold.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    p.item_no, 50,
    (select m.item_no from nl_seed.mfg_material m
      where m.family = 'hardware' and m.item_no like 'CP-FLG-%'
      order by abs(m.od_in - p.dia), m.item_no limit 1),
    1, 'EA', 0, 20, 'Welded flange'
  from nl_seed.mfg_part p
  where p.family in ('elbow', 'custom', 'proprietary')
    and nl_seed.chance(0.35, 'mfg.flange|' || p.item_no)
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    p.item_no, 55,
    (select m.item_no from nl_seed.mfg_material m
      where m.item_no like 'CP-GSK-%'
      order by abs(m.od_in - p.dia), m.item_no limit 1),
    1, 'EA', 0, 20, 'Joint gasket, shipped with the part'
  from nl_seed.mfg_part p
  where exists (select 1 from nl.bom_lines b where b.parent_item = p.item_no and b.line_no = 50)
  on conflict (parent_item, line_no) do nothing;

  -- Welding wire and shielding gas, on everything that is welded.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    p.item_no, 60,
    case when p.stainless then 'CS-WIRE-SS' else 'CS-WIRE-AL' end,
    round((0.03 + p.dia * 0.012)::numeric, 5), 'LB', 0, 20, 'Weld wire'
  from nl_seed.mfg_part p
  where p.welded
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 65, 'CS-GAS-AR75', round((0.8 + p.dia * 0.25)::numeric, 5), 'CF', 0, 20, 'Shielding gas'
  from nl_seed.mfg_part p
  where p.welded
  on conflict (parent_item, line_no) do nothing;

  -- Abrasives and compound, on everything that is polished.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 70, 'CS-ABR-80', round((0.04 + p.dia * 0.008)::numeric, 5), 'EA', 0, 30, 'Abrasive'
  from nl_seed.mfg_part p
  where p.polished
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 75, 'CS-POLISH', round((0.01 + p.dia * 0.003)::numeric, 5), 'LB', 0, 30, 'Polishing compound'
  from nl_seed.mfg_part p
  where p.polished
  on conflict (parent_item, line_no) do nothing;

  -- Packaging. A long part is banded and wrapped; a short one goes in a
  -- carton. Everything gets a label.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    p.item_no, 80,
    case when p.length_in > 72 or p.family = 'muffler' then 'PK-BAND'
         when p.length_in > 40 then 'PK-CTN-L'
         when p.length_in > 20 then 'PK-CTN-M'
         else 'PK-CTN-S' end,
    case when p.length_in > 72 or p.family = 'muffler' then 6 else 1 end,
    case when p.length_in > 72 or p.family = 'muffler' then 'FT' else 'EA' end,
    0, 90, 'Packaging'
  from nl_seed.mfg_part p
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select p.item_no, 85, 'PK-LBL', 1, 'EA', 0, 90, 'Part and shipping label'
  from nl_seed.mfg_part p
  on conflict (parent_item, line_no) do nothing;

  -- A substitute: where a part calls for 409 stainless tube, the shop may
  -- run 304 instead when 409 is short. It is an alternate for line 10, so it
  -- is never costed and never counted: the primary is what the standard
  -- says, and buying both would buy the part twice.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, is_substitute, substitute_for,
     operation_seq, reference_note)
  select
    p.item_no, 11,
    replace(p.tube_item, '-S409', '-S304'),
    round((p.length_in / 12)::numeric, 5), 'FT', 0.045, true, primary_line.id, 10,
    'Alternate: 304 may be run when 409 is short, with the price difference approved'
  from nl_seed.mfg_part p
  join nl.bom_lines primary_line
    on primary_line.parent_item = p.item_no and primary_line.line_no = 10
  where p.grade = 'S409' and p.tube_item is not null
    and exists (select 1 from nl.items i where i.item_no = replace(p.tube_item, '-S409', '-S304'))
    and nl_seed.chance(0.3, 'mfg.substitute|' || p.item_no)
  on conflict (parent_item, line_no) do nothing;

  -- Kits: two to four finished parts of the same diameter, a carton, a
  -- pallet on the big ones, and a label.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select
    k.item_no,
    10 + c.n * 10,
    c.child_item,
    case when c.n = 1 and k.dual then 2 else 1 end,
    'EA', 0, 10,
    'Part ' || c.n || ' of the kit'
  from (
    select
      i.item_no,
      i.description like 'DUAL%' as dual,
      coalesce((regexp_match(i.description, 'KIT ([0-9]+)"'))[1]::numeric, 6) as dia,
      case when i.description like '%CHROME%' then 'CHROME' else 'PIPE' end as grp,
      1 + nl_seed.ri(1, 3, 'mfg.kit.parts|' || i.item_no) as parts
    from nl.items i
    where i.family = 'kit'
  ) k
  cross join lateral (
    -- The kit's parts: stacks, elbows and clamps of the right diameter,
    -- picked in a fixed order so the kit is the same every build.
    select row_number() over (order by pick.item_no) as n, pick.item_no as child_item
    from (
      select i2.item_no
      from nl.items i2
      where i2.family in ('stack', 'elbow', 'clamp')
        and not i2.blocked
        and i2.description like (k.dia::int || '"%') is not false
        and i2.description ~ ('^' || k.dia::int || '(\.0)?"')
      order by nl_seed.u('mfg.kit.pick|' || k.item_no || '|' || i2.item_no)
      limit 4
    ) pick
  ) c
  where c.n <= k.parts
  on conflict (parent_item, line_no) do nothing;

  -- Some kits carry a muffler, which is what makes the tree four levels
  -- deep: kit, muffler, phantom shell, sheet. A trace that crosses three
  -- levels needs a tree that has three, and this is the one that has them.
  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select k.item_no, 60, m.item_no, 1, 'EA', 0, 10, 'The muffler that goes with the kit'
  from nl.items k
  cross join lateral (
    select i2.item_no
    from nl.items i2
    where i2.family = 'muffler'
      and exists (select 1 from nl.bom_lines b2 where b2.parent_item = i2.item_no)
    order by nl_seed.u('mfg.kit.muffler|' || k.item_no || '|' || i2.item_no)
    limit 1
  ) m
  where k.family = 'kit'
    and exists (select 1 from nl.bom_lines b where b.parent_item = k.item_no)
    and nl_seed.chance(0.45, 'mfg.kit.has.muffler|' || k.item_no)
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select i.item_no, 80, 'PK-CTN-L', 1, 'EA', 0, 20, 'Kit carton'
  from nl.items i
  where i.family = 'kit'
    and exists (select 1 from nl.bom_lines b where b.parent_item = i.item_no)
  on conflict (parent_item, line_no) do nothing;

  insert into nl.bom_lines
    (parent_item, line_no, child_item, quantity_per, uom, scrap_pct, operation_seq, reference_note)
  select i.item_no, 85, 'PK-LBL', 2, 'EA', 0, 20, 'Kit label and parts list'
  from nl.items i
  where i.family = 'kit'
    and exists (select 1 from nl.bom_lines b where b.parent_item = i.item_no)
  on conflict (parent_item, line_no) do nothing;

  -- -------------------------------------------------------------------------
  -- 12. Routings
  --
  -- Seven kinds of step, in sequence: cut, bend, form, weld, polish, plate
  -- outside, inspect, pack. A part gets the steps its shape needs and no
  -- others. Setup is amortized over a standard lot, which is why a part that
  -- runs in twenties costs more a piece than the same part run in hundreds.
  -- -------------------------------------------------------------------------

  -- 10 Cut to length. Everything that starts as tube.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, crew_size, note)
  select
    p.item_no, 10, 'CUT CELL', 'Cut to length',
    case when p.dia >= 7 then 9 else 6 end,
    round((0.28 + p.length_in * 0.004)::numeric, 4),
    240, 30,
    case when p.family in ('custom', 'proprietary') then 10 else 25 end,
    0.995,
    -- Volume runs go on the laser; odd diameters and short runs on the cold saw.
    case when p.family in ('custom', 'proprietary') then 'SAW-COLD' else 'SAW-LASER' end,
    1, ''
  from nl_seed.mfg_part p
  where p.length_in > 0
  on conflict (item_no, seq) do nothing;

  -- 15 Blank from sheet, for the shields.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, crew_size, note)
  select
    p.item_no, 15, 'CUT CELL', 'Blank and shear from sheet',
    12, round((0.5 + p.sheet_sqft * 0.35)::numeric, 4), 240, 30, 25, 0.985, 'SAW-LASER', 1, ''
  from nl_seed.mfg_part p
  where p.sheet_sqft > 0 and p.family <> 'muffler'
  on conflict (item_no, seq) do nothing;

  -- 20 Bend. The large bender takes the big diameters and carries a mandrel
  -- set per size, which is why its tooling is charged per piece as well.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    p.item_no, 20, 'BEND CELL',
    'Mandrel bend' || case when p.dia >= 7 then ', large bender' else '' end,
    case when p.dia >= 7 then 34 else 22 end,
    round((0.9 + p.dia * 0.22)::numeric, 4),
    480, 30,
    case when p.family in ('custom', 'proprietary') then 10 else 25 end,
    -- A bend is where a piece is most likely to be lost, and it is lost
    -- after the metal has been paid for.
    case when p.dia >= 7 then 0.965 else 0.980 end,
    case when p.dia >= 7 then 'BEND-LG' else 'BEND-SM' end,
    'FAB A', 1, ''
  from nl_seed.mfg_part p
  where p.bent
  on conflict (item_no, seq) do nothing;

  -- 25 Form the ends, where the part slips into another one.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, crew_size, note)
  select
    p.item_no, 25, 'FORM CELL', 'Expand end to slip fit',
    14, round((0.45 + p.dia * 0.09)::numeric, 4), 300, 30, 25, 0.990, 'FORM-1', 1, ''
  from nl_seed.mfg_part p
  where p.formed
  on conflict (item_no, seq) do nothing;

  -- 30 Weld. The robot takes the repeat work; the hand booths take the rest.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    p.item_no, 30, 'WELD CELL',
    case when p.family in ('custom', 'proprietary') then 'Weld to the drawing' else 'Weld and seam' end,
    case when p.family in ('custom', 'proprietary') then 42 else 18 end,
    round((1.4 + p.dia * 0.38)::numeric, 4),
    600, 45,
    case when p.family in ('custom', 'proprietary') then 5 else 25 end,
    0.975,
    case when p.family in ('custom', 'proprietary') then 'WELD-1' else 'WELD-ROBOT' end,
    'WELD A', 1, ''
  from nl_seed.mfg_part p
  where p.welded
  on conflict (item_no, seq) do nothing;

  -- 40 Polish, for chrome and stainless. Slow, hand work, and the reason a
  -- chrome part carries the price it does.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    p.item_no, 40, 'POLISH CELL', 'Polish and buff to a plating finish',
    8, round((2.2 + p.dia * 0.55 + p.length_in * 0.02)::numeric, 4), 720, 45, 15,
    -- A piece lost here has had everything done to it already.
    0.985, 'POLISH-1', 'FINISH', 1, ''
  from nl_seed.mfg_part p
  where p.polished
  on conflict (item_no, seq) do nothing;

  -- 50 Plating, outside. The one step the plant does not do itself.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, is_outside, vendor_no,
     outside_lead_time, outside_price_per_piece, outside_minimum_charge, note)
  select
    p.item_no, 50, null, 'Triple chrome plate, outside',
    0, 0, 0, 0, 25, 0.990, true, v_plater,
    (array['5D', '5D', '7D', '10D'])[1 + nl_seed.ri(0, 3, 'mfg.plate.lead|' || p.item_no)],
    round((3.20 + p.dia * 1.15 + p.length_in * 0.055)::numeric, 4),
    180.00,
    'Priced per piece with a minimum per rack'
  from nl_seed.mfg_part p
  where p.plated
  on conflict (item_no, seq) do nothing;

  -- 60 Inspect. An inspection is an operation with time and money in it, not
  -- an assumption inside overhead.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class,
     crew_size, is_inspection, note)
  select
    p.item_no, 60, 'INSPECT',
    case when p.family in ('custom', 'proprietary') then 'First article and final inspection'
         else 'Final inspection' end,
    case when p.family in ('custom', 'proprietary') then 25 else 3 end,
    round((0.6 + p.dia * 0.06)::numeric, 4), 180, 20,
    case when p.family in ('custom', 'proprietary') then 5 else 25 end,
    0.998,
    case when p.family in ('custom', 'proprietary') then 'CMM-1' else null end,
    'INSPECT', 1, true, ''
  from nl_seed.mfg_part p
  where p.family in ('custom', 'proprietary') or p.plated or p.welded
  on conflict (item_no, seq) do nothing;

  -- 90 Pack.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    p.item_no, 90, 'PACK', 'Pack, band and label',
    2, round((0.35 + p.length_in * 0.003)::numeric, 4), 120, 15, 25, 1.000,
    'PACK-1', 'PACK', 1, ''
  from nl_seed.mfg_part p
  on conflict (item_no, seq) do nothing;

  -- The phantom shells have their own routing: roll and seam weld.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select i.item_no, 10, 'FORM CELL', 'Roll the body wrap', 16, 1.1, 300, 30, 25, 0.985,
         'FORM-1', 'FAB A', 1, ''
  from nl.items i where i.item_no like 'WP-SHELL-%'
  on conflict (item_no, seq) do nothing;

  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select i.item_no, 20, 'WELD CELL', 'Seam weld the shell', 12, 2.4, 480, 30, 25, 0.980,
         'WELD-ROBOT', 'WELD A', 1, ''
  from nl.items i where i.item_no like 'WP-SHELL-%'
  on conflict (item_no, seq) do nothing;

  -- Kits: assemble and pack, and nothing else. A kit has a parts list and no
  -- fabrication step, which is why its derived shape is 'kitted' rather than
  -- 'manufactured', and why it agrees with the ERP's word 'Assembly'.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select i.item_no, 10, 'ASSEMBLY', 'Pick, check and kit', 4, 3.2, 240, 20, 10, 0.998,
         'BENCH-1', 'ASSEMBLE', 1, ''
  from nl.items i
  where i.family = 'kit' and exists (select 1 from nl.bom_lines b where b.parent_item = i.item_no)
  on conflict (item_no, seq) do nothing;

  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select i.item_no, 90, 'PACK', 'Box and label the kit', 3, 1.8, 120, 15, 10, 1.000,
         'PACK-1', 'PACK', 1, ''
  from nl.items i
  where i.family = 'kit' and exists (select 1 from nl.bom_lines b where b.parent_item = i.item_no)
  on conflict (item_no, seq) do nothing;

  -- A catch-all fabrication step, for any part the ERP says we make whose
  -- description carried no geometry to work from. Without it such a part
  -- would end up with a parts list of packaging and a routing of nothing but
  -- packing, and the derived shape would call it an assembly while the ERP
  -- called it a production order: a disagreement that means nothing except
  -- that this file could not read its description. Other seed files add
  -- parts too, so this has to hold for parts nobody here has seen.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    p.item_no, 30, 'WELD CELL', 'Fabricate to the drawing', 30, 6.5, 480, 45, 10, 0.980,
    'WELD-1', 'WELD A', 1,
    'A part the ERP says we make, with no dimensions in its description to route from'
  from nl_seed.mfg_part p
  where not exists (
    select 1 from nl.routing_operations r
    where r.item_no = p.item_no
      and (r.is_outside or r.work_center not in ('ASSEMBLY', 'PACK')))
  on conflict (item_no, seq) do nothing;

  -- -------------------------------------------------------------------------
  -- 13. The two deliberate disagreements with the ERP's word
  -- -------------------------------------------------------------------------

  -- Chrome parts the ERP calls 'Purchase' that the plant actually polishes
  -- and sends out for plating. A routing and no parts list, so the derived
  -- shape is 'processed' and the part page says the ERP disagrees.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    i.item_no, 40, 'POLISH CELL', 'Polish a bought part before plating',
    8, round((1.8 + coalesce((regexp_match(i.description, '^([0-9.]+)"'))[1]::numeric, 4) * 0.5)::numeric, 4),
    720, 45, 15, 0.985, 'BUFF-1', 'FINISH', 1,
    'The ERP calls this part a purchase, and it is: we buy it plain and finish it here'
  from nl.items i
  where i.replenishment = 'Purchase' and i.product_group = 'CHROME' and not i.blocked
    and nl_seed.chance(0.22, 'mfg.plated.bought|' || i.item_no)
  on conflict (item_no, seq) do nothing;

  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, is_outside, vendor_no,
     outside_lead_time, outside_price_per_piece, outside_minimum_charge, note)
  select
    i.item_no, 50, null, 'Triple chrome plate, outside', 0, 0, 0, 0, 25, 0.990, true, v_plater,
    '7D',
    round((3.20 + coalesce((regexp_match(i.description, '^([0-9.]+)"'))[1]::numeric, 4) * 1.15)::numeric, 4),
    180.00, ''
  from nl.items i
  where exists (select 1 from nl.routing_operations r where r.item_no = i.item_no and r.seq = 40)
    and i.replenishment = 'Purchase'
  on conflict (item_no, seq) do nothing;

  -- Raw material the ERP calls 'Purchase' that we cut down from a mill
  -- length before selling it. Same disagreement, different reason.
  insert into nl.routing_operations
    (item_no, seq, work_center, description, setup_minutes, run_minutes_per_piece,
     queue_minutes, move_minutes, standard_lot_size, yield_pct, machine, labor_class, crew_size, note)
  select
    i.item_no, 10, 'CUT CELL', 'Cut a mill length down to a stock length',
    5, 0.6, 240, 30, 20, 0.995, 'SAW-COLD', 'FAB B', 1,
    'Bought in mill lengths and cut here, so the ERP calls it a purchase and the floor cuts it'
  from nl.items i
  where i.family = 'raw' and not i.blocked
    and nl_seed.chance(0.18, 'mfg.raw.cut|' || i.item_no)
  on conflict (item_no, seq) do nothing;

  -- -------------------------------------------------------------------------
  -- 14. Sourcing: the parts that can be got more than one way
  --
  -- This is what replaces a make-or-buy field. A part with two rows is not
  -- contradicting itself: it says buy it in ones and twos, make it in
  -- twenty-fives, and here is the vendor and the cell for each.
  -- -------------------------------------------------------------------------

  -- Every part gets the source that matches what it is today, at priority 1.
  insert into nl.item_sources
    (item_no, source_kind, vendor_no, work_center, priority, min_qty, max_qty, cost_basis,
     unit_price, lead_time, effective_from, note)
  select
    i.item_no,
    case i.replenishment when 'Purchase' then 'purchase' when 'Assembly' then 'assemble' else 'produce' end,
    case when i.replenishment = 'Purchase' then coalesce(i.vendor_no, v_steel[1]) end,
    case when i.replenishment <> 'Purchase' then coalesce(nullif(i.work_center, ''), 'WELD CELL') end,
    1, null, null,
    case when i.replenishment = 'Purchase' then 'vendor price' else 'rolled cost' end,
    case when i.replenishment = 'Purchase' then i.unit_cost end,
    i.lead_time,
    make_date(v_first_year, 1, 1),
    'The way this part is got today'
  from nl.items i
  where i.replenishment <> 'Purchase' or i.vendor_no is not null;

  -- Then the genuinely mixed ones: bought in small quantities from a vendor
  -- who stocks them, made here when the order is big enough to pay for a
  -- setup. A third of the elbows and stacks the plant makes are like this.
  insert into nl.item_sources
    (item_no, source_kind, vendor_no, work_center, priority, min_qty, max_qty, cost_basis,
     unit_price, lead_time, effective_from, note)
  select
    i.item_no, 'purchase', coalesce(i.vendor_no, v_steel[2]), null, 2, null, 24, 'vendor price',
    round((i.unit_cost * 1.18)::numeric, 2),
    '2W', make_date(v_first_year, 1, 1),
    'Buy it under two dozen: the setup costs more than the mark up'
  from nl.items i
  where i.replenishment = 'Prod. Order' and i.family in ('elbow', 'stack')
    and not i.blocked
    and nl_seed.chance(0.33, 'mfg.mixed|' || i.item_no)
  on conflict do nothing;

  -- And the ones where the plating could go to a second shop when the first
  -- one is backed up.
  insert into nl.item_sources
    (item_no, source_kind, vendor_no, priority, min_qty, cost_basis, unit_price, lead_time,
     effective_from, note)
  select
    r.item_no, 'outside process', v_vendors[7], 3, 1, 'outside process price',
    round((r.outside_price_per_piece * 1.22)::numeric, 4), '3D',
    make_date(v_first_year, 1, 1),
    'A second plater: dearer, quicker, used when the first one is backed up'
  from nl.routing_operations r
  where r.is_outside and cardinality(v_vendors) >= 7
    and nl_seed.chance(0.2, 'mfg.second.plater|' || r.item_no)
  on conflict do nothing;

  -- A handful of parts are transferred from the east distribution center
  -- rather than made again at the plant.
  insert into nl.item_sources
    (item_no, source_kind, from_location, priority, min_qty, max_qty, cost_basis, lead_time,
     effective_from, note)
  select
    i.item_no, 'transfer', 'EAST', 4, 1, 48, 'standard cost', '4D', make_date(v_first_year, 1, 1),
    'Pull from the east center when it has them, rather than schedule a run'
  from nl.items i
  where i.family in ('clamp', 'bracket') and not i.blocked
    and nl_seed.chance(0.08, 'mfg.transfer.source|' || i.item_no)
  on conflict do nothing;

  -- -------------------------------------------------------------------------
  -- 15. Planning policy, which is a different question from sourcing
  -- -------------------------------------------------------------------------
  insert into nl.item_planning
    (item_no, demand_policy, lot_sizing, min_order_qty, order_multiple, max_order_qty, planning_days, note)
  select
    i.item_no,
    case
      when i.made_to_order or i.family = 'custom' then 'make to order'
      when i.kind in ('raw material', 'consumable', 'packaging') then 'reorder point'
      when i.reorder_point is not null then 'make to stock'
      else 'planned'
    end,
    case
      when i.made_to_order or i.family = 'custom' then 'lot for lot'
      when i.kind = 'raw material' then 'maximum quantity'
      else 'fixed order quantity'
    end,
    case
      when i.kind = 'raw material' then greatest(40, coalesce(i.reorder_point, 100))
      when i.made_to_order then 1
      else (array[5, 10, 25, 50])[1 + nl_seed.ri(0, 3, 'mfg.moq|' || i.item_no)]
    end,
    case when i.kind in ('raw material', 'packaging') then 10 else 5 end,
    case when i.kind = 'raw material' then greatest(400, coalesce(i.reorder_point, 100) * 4) end,
    case when i.made_to_order then 30 else 90 end,
    ''
  from nl.items i
  on conflict (item_no) do nothing;

  -- -------------------------------------------------------------------------
  -- 15b. The vendor relationship, and what the mills actually did
  --
  -- The material master this file invents is the bottom of every bill of
  -- materials in the plant, so it is what decides a made part's promise
  -- date. Migration 0036 gets those days from nl.lead_time_for() (0032),
  -- which prefers the ninetieth percentile of real receipts over anything
  -- written on a card. Without receipts for these parts that rule would
  -- always fall through to the item card and the roll-up would be quoting a
  -- date formula with extra steps. So the mills get a history.
  --
  -- The quote and the observed median are deliberately different numbers,
  -- for the same reason db/seed.d/91_pricing_depth separates them: the gap
  -- between what a vendor says and what a vendor does is the finding, and a
  -- world where they agree hides it. Mill tube runs late, the hardware
  -- shops run close to their quote.
  -- -------------------------------------------------------------------------
  insert into nl.vendor_items
    (vendor_no, item_no, is_primary, vendor_item_no, quoted_lead_days, quoted_on,
     quote_reference, min_order_qty, order_multiple, unit_cost, status, status_note)
  select
    i.vendor_no,
    i.item_no,
    true,
    'V' || substr(md5(i.item_no), 1, 8),
    -- What they quote: the item card's formula, which is what a buyer was
    -- told when the part was set up.
    greatest(2, coalesce(nl.lead_time_days(i.lead_time), 21)),
    v_today - nl_seed.ri(60, 500, 'mfg.quote.on|' || i.item_no),
    'Mill quote ' || to_char(v_today - nl_seed.ri(60, 500, 'mfg.quote.on|' || i.item_no), 'YYYY-MM'),
    case when i.kind = 'raw material' then 40 else 25 end,
    case when i.kind = 'raw material' then 10 else 5 end,
    i.unit_cost,
    -- One bought component sits on allocation, so a made part above it
    -- comes out with a date the roll-up refuses to call promisable. That is
    -- the case nl.item_lead_rolled.can_promise exists for.
    case when nl_seed.chance(0.04, 'mfg.alloc|' || i.item_no) then 'allocation' else 'active' end,
    case when nl_seed.chance(0.04, 'mfg.alloc|' || i.item_no)
         then 'On allocation: the mill is rationing this gauge, so no date is promised'
         else '' end
  from nl.items i
  join nl_seed.mfg_material m on m.item_no = i.item_no
  where i.vendor_no is not null
  on conflict (vendor_no, item_no) do nothing;

  -- Between four and fourteen receipts each, which straddles
  -- nl.promise_min_receipts(): most of these parts earn an observed figure
  -- and a few are still too thin for one and fall back to the quote, which
  -- is what the basis column is for.
  insert into nl.purchase_receipts (document_no, line_no, vendor_no, item_no,
                                    ordered_on, promised_on, received_on, quantity, unit_cost)
  select
    'PO2' || lpad(((row_number() over (order by d.item_no, d.n)) + 70000)::text, 6, '0'),
    1,
    d.vendor_no,
    d.item_no,
    d.ordered_on,
    d.ordered_on + d.quoted_days,
    d.ordered_on + d.actual_days,
    d.quantity,
    d.unit_cost
  from (
    select
      vi.vendor_no,
      vi.item_no,
      g.n,
      vi.quoted_lead_days as quoted_days,
      v_today - nl_seed.ri(20, 900, 'mfg.pr.when|' || vi.item_no || '|' || g.n) as ordered_on,
      -- A one-sided tail: steel runs a fifth to a half past its quote, the
      -- hardware shops land on it. u cubed keeps most receipts near the
      -- middle and sends a few a long way out, which is the shape a late
      -- delivery actually has.
      greatest(1, round(
        vi.quoted_lead_days
        * (1 + (case when i.kind = 'raw material' then 0.45 else 0.12 end)
               * power(nl_seed.u('mfg.pr.tail|' || vi.item_no || '|' || g.n), 3))
        + nl_seed.gauss(0, 1.5, 'mfg.pr.jitter|' || vi.item_no || '|' || g.n)
      )::int) as actual_days,
      vi.order_multiple * nl_seed.ri(1, 6, 'mfg.pr.qty|' || vi.item_no || '|' || g.n) as quantity,
      coalesce(vi.unit_cost, 1.00) as unit_cost
    from nl.vendor_items vi
    join nl.items i on i.item_no = vi.item_no
    join nl_seed.mfg_material m on m.item_no = vi.item_no
    cross join lateral generate_series(
      1, greatest(1, round(nl_seed.ri(4, 14, 'mfg.pr.count|' || vi.item_no) * v_scale)::int)) as g(n)
  ) d
  on conflict (document_no, line_no) do nothing;

  -- -------------------------------------------------------------------------
  -- 16. Measure everything, calibrate the metal price, measure again
  --
  -- The first pass is the roll-up doing its job on the provisional metal
  -- price. Then the one free variable is moved so the middle of the
  -- catalogue lands on the middle of the item cards, and the second pass
  -- settles it. After this the triggers keep both roll-ups current on their
  -- own, and nl.rollup_drift() proves it.
  -- -------------------------------------------------------------------------
  perform nl.measure_all_items();

  -- Two rounds, because moving the metal price moves the scrap allowance
  -- with it (a scrapped piece carries its metal away), so one round lands
  -- close and the second settles it.
  --
  -- The families that count are the ones whose geometry is read out of the
  -- description and is therefore real: pipe, elbows, stacks and shields. A
  -- custom part's card cost is a price somebody quoted off a drawing, and a
  -- bought part's rolled cost is its purchase cost by construction, so
  -- neither says anything about whether the metal price is right.
  for v_round in 1 .. 2 loop
    select
      case
        when coalesce(m.material, 0) <= 0 then 1
        else greatest(0.05, least(8.0, (m.card - m.conversion) / m.material))
      end
    into v_factor
    from (
      select
        percentile_cont(0.5) within group (order by c.card_cost)             as card,
        percentile_cont(0.5) within group (order by c.material + c.component
                                                    + c.packaging)          as material,
        percentile_cont(0.5) within group (order by c.labor + c.machine + c.overhead
                                                    + c.outside + c.scrap)  as conversion
      from nl.item_cost_rolled c
      join nl.items i on i.item_no = c.item_no
      where c.levels > 0 and c.card_cost > 0
        and i.family in ('pipe', 'elbow', 'stack', 'shield')
    ) m;

    -- Move the metal, the bought components and the consumables together,
    -- so the relative prices of the material master stay as they were set.
    update nl.items i
       set unit_cost = greatest(0.01, round((i.unit_cost * v_factor)::numeric, 2)),
           list_price = greatest(0.02, round((i.list_price * v_factor)::numeric, 2))
     where exists (select 1 from nl_seed.mfg_material m2 where m2.item_no = i.item_no);

    -- That update fired the roll-up triggers, which re-measured every part
    -- above the material. Measure the lot again anyway, so nothing depends
    -- on the trigger having caught every path during a build.
    perform nl.measure_all_items();
  end loop;

  -- -------------------------------------------------------------------------
  -- 17. Cost history for the parts this file added
  --
  -- Every part in the world has a cost timeline (db/seed.d/50), and a test
  -- requires the newest row on it to equal the item card. These parts were
  -- added after that file ran, so they get their opening row here, after the
  -- calibration has settled their cost. A bought part's row names the vendor
  -- it came from; a part we make carries no vendor, which is the same rule
  -- 50 follows.
  -- -------------------------------------------------------------------------
  insert into nl.item_costs (item_no, vendor_no, effective_from, unit_cost, source, note)
  select
    i.item_no,
    case when i.replenishment = 'Purchase' then i.vendor_no end,
    make_date(v_first_year, 1, 1),
    i.unit_cost,
    case when i.replenishment = 'Purchase' then 'vendor quote' else 'standard revision' end,
    v_open_note
  from nl.items i
  where not exists (select 1 from nl.item_costs c where c.item_no = i.item_no)
  on conflict (item_no, effective_from) do nothing;

  -- The triggers take over from here. Nothing above changed a cost or a
  -- lead time after the last measure: step 17 writes each new part's
  -- opening cost row at the figure already on its card, which the roll-up
  -- reads through the same view either way.
  perform set_config('nl.suspend_rollup', 'off', true);
end $$;
