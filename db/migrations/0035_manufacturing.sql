-- 0035 What a part is made of, what it costs to make and how long it takes.
--
-- Until now the item master said three words about how a part is replenished
-- ('Prod. Order', 'Purchase', 'Assembly'), carried one cost number and one
-- lead-time formula, and that was the whole manufacturing model. A buyer
-- could not ask what a part is made of; a quote could not say why a part
-- costs what it costs; a promise date was a guess with a formula on it.
--
-- This migration adds the taxonomy underneath those three words:
--
--   Things        nl.uoms, nl.uom_conversions, nl.skus, nl.item_material,
--                 nl.items.kind and the orthogonal item flags
--   Structure     nl.bom_lines (any depth), nl.item_sources, nl.item_planning
--   Places and
--   people        nl.work_centers, nl.labor_classes, nl.labor_rates,
--                 nl.capital_assets, nl.machines
--   Process       nl.routing_operations
--   Money         nl.overhead_pools, nl.overhead_pool_periods and the
--                 absorption rates derived from them
--   Answers       nl.item_cost_rolled, nl.item_lead_rolled (kept current by
--                 triggers), nl.item_cost_rollup, nl.item_lead_time_rollup,
--                 nl.item_where_used, nl.item_truth
--
-- THREE DECISIONS WORTH READING BEFORE THE CODE. docs/manufacturing.md has
-- the long version of each.
--
-- 1. THE VERB IS NOT STORED ON THE PART. A part is not "a make part" or "a
--    buy part": one part can be bought under 25 pieces, made above 25, and
--    plated outside either way. So make, buy and assemble are not a field.
--    nl.item_supply_shape DERIVES a shape from what the part actually has (a
--    bill of materials, a routing, both, neither) and writes a sentence a
--    person can read. nl.item_sources is the list of ways the part can be
--    got, each with its own quantity band, party and lead time. The ERP's
--    nl.items.replenishment stays exactly as exported, because that is the
--    field we import and other code reads; where the derived shape and the
--    ERP's word disagree, the part page says so rather than overwriting it.
--
-- 2. THE ROLL-UPS ARE KEPT CURRENT, NOT RECOMPUTED. True cost and true lead
--    time have to be knowable at an instant, for the desk agent answering a
--    customer mid-reply. A recursive roll-up per request cannot do that at
--    11,400 parts. So nl.item_cost_rolled and nl.item_lead_rolled store the
--    answer, statement-level triggers on exactly the things that can change
--    it re-measure the parts affected AND every part above them in the tree,
--    and nl.rollup_drift() recomputes from scratch and complains if the
--    stored answer differs. This is the same pattern as
--    nl.commitment_delivery in migration 0008, which keeps delivered value
--    current the same way and is checked by nl.delivery_drift(). It is the
--    house style for a figure that is read constantly and changes rarely.
--
-- 3. COST IS A BREAKDOWN, NOT A NUMBER. Eight elements, each its own column
--    and its own line on the page: material, purchased components, labour at
--    a loaded rate (wage plus fringe plus payroll tax plus paid time off),
--    machine time whose hourly rate is derived from what the machine cost
--    and how long it will last, absorbed overhead through the driver each
--    pool names, outside processing, a scrap allowance costed at the stage
--    where the piece is lost, and packaging. Nothing is folded into a single
--    "burden" figure, because the whole point is being able to say which
--    part of the cost is which.
--
-- Nothing in this file overwrites nl.items.unit_cost. The rolled cost sits
-- beside the item card's cost and the difference is reported. An ERP that
-- rolls standard cost into the item master does it on purpose, on a date, as
-- an act; guessing at it from a demo would be dishonest.

-- ---------------------------------------------------------------------------
-- Units of measure
-- ---------------------------------------------------------------------------

create table nl.uoms (
  code     text primary key check (code ~ '^[A-Z]{2,6}$'),
  name     text not null,
  -- What the unit measures. A conversion only makes sense inside one kind,
  -- except through an item's own weight or length (see nl.uom_conversions).
  kind     text not null check (kind in ('count', 'length', 'weight', 'area', 'volume')),
  decimals int not null default 0 check (decimals between 0 and 4)
);

comment on table nl.uoms is
  'Units the business buys, makes, stocks and sells in. EA is the base count unit.';

-- How many of the "from" unit make one of the "to" unit. A null item_no is
-- the house conversion (12 IN to the FT, always); a row with an item_no
-- overrides it for that part, which is how a 20 foot stick of tube and a 10
-- foot stick of the same grade can both be bought by the stick.
create table nl.uom_conversions (
  id       bigint generated always as identity primary key,
  item_no  text references nl.items (item_no) on delete cascade,
  from_uom text not null references nl.uoms (code),
  to_uom   text not null references nl.uoms (code),
  factor   numeric(16, 6) not null check (factor > 0),
  note     text not null default '',
  constraint uom_conversions_two_units check (from_uom <> to_uom)
);

-- One conversion per direction per part, and one house conversion per
-- direction. coalesce in the index because null is not equal to null.
create unique index uom_conversions_one_idx
  on nl.uom_conversions (coalesce(item_no, ''), from_uom, to_uom);
create index uom_conversions_item_idx on nl.uom_conversions (item_no);

-- How many "from" units make one "to" unit for this part: the part's own
-- conversion, then the house one, then 1 when the units are the same, then
-- null, which means the caller asked for a conversion nobody has defined.
create function nl.uom_factor(p_item_no text, p_from_uom text, p_to_uom text)
returns numeric
language sql stable
set search_path = ''
as $$
  select case when p_from_uom = p_to_uom then 1::numeric else coalesce(
    (select c.factor from nl.uom_conversions c
      where c.item_no = p_item_no and c.from_uom = p_from_uom and c.to_uom = p_to_uom),
    (select c.factor from nl.uom_conversions c
      where c.item_no is null and c.from_uom = p_from_uom and c.to_uom = p_to_uom))
  end
$$;

-- ---------------------------------------------------------------------------
-- What kind of thing each part is, and the flags that are not about kind
-- ---------------------------------------------------------------------------

-- The kind decides which cost element a part contributes when it appears in
-- somebody else's bill of materials: tube is material, a bought flange is a
-- component, a carton is packaging. It is not the same question as how the
-- part is replenished, and it is not the same question as any of the flags
-- below it.
alter table nl.items
  add column kind text not null default 'finished good'
    check (kind in ('raw material', 'component', 'work in progress', 'finished good',
                    'consumable', 'packaging', 'outside processed')),
  -- Each of these answers a different question, so none of them is folded
  -- into the kind or into the supply shape:
  --   demand policy         is it made because stock ran down, or because
  --                         somebody ordered it? (nl.items.made_to_order,
  --                         from 0002, is the ERP's own flag and stays)
  add column configured_to_order boolean not null default false,
  add column phantom             boolean not null default false,
  add column consignment         boolean not null default false,
  add column customer_supplied   boolean not null default false,
  add column drop_shipped        boolean not null default false,
  add column non_stock           boolean not null default false,
  add column service_only        boolean not null default false;

comment on column nl.items.kind is
  'What the part is, which decides its cost element in a parent bill of materials. Not the same as replenishment.';
comment on column nl.items.phantom is
  'A pass-through assembly that is never stocked: its bill of materials is exploded into its parent.';

-- Parts already in the book that are material rather than finished goods.
-- On a fresh build this runs against an empty table and the seed sets the
-- kind itself; on a database that already has the book it fixes it in place.
update nl.items set kind = 'raw material' where family = 'raw';

-- The physical facts of a part, where it has any. A separate table rather
-- than a dozen mostly-null columns on the item master: only material and
-- some components have a grade and a gauge, and nl.items is shaped like the
-- ERP's export on purpose.
create table nl.item_material (
  item_no        text primary key references nl.items (item_no) on delete cascade,
  grade          text not null default '',   -- ALUMINIZED, 409, 304, ZINC PLATED
  gauge          text not null default '',   -- 16GA, 14GA, 11GA
  od_in          numeric(8, 3),              -- outside diameter of tube
  wall_in        numeric(8, 4),              -- wall thickness, from the gauge
  thickness_in   numeric(8, 4),              -- sheet thickness
  width_in       numeric(8, 3),
  length_in      numeric(9, 3),
  finish         text not null default '',
  density_lb_in3 numeric(8, 5),              -- 0.283 for steel, 0.289 for 304
  -- Weight is derived, never typed: a tube's is its wall volume, a sheet's
  -- is its thickness times its area. A part with no geometry has no weight
  -- here, and its SKU carries a weighed figure instead.
  unit_weight_lb numeric(12, 4) generated always as (
    case
      when density_lb_in3 is not null and od_in is not null and wall_in is not null and length_in is not null
        then round(density_lb_in3 * pi()::numeric * (od_in - wall_in) * wall_in * length_in, 4)
      when density_lb_in3 is not null and thickness_in is not null
           and width_in is not null and length_in is not null
        then round(density_lb_in3 * thickness_in * width_in * length_in, 4)
    end) stored,
  note           text not null default ''
);

comment on table nl.item_material is
  'Grade, gauge and geometry, for the parts that have them. Weight is derived from density and geometry.';

-- ---------------------------------------------------------------------------
-- SKUs: the sellable unit on top of a part
-- ---------------------------------------------------------------------------

-- One part can be sold several ways: one piece, a box of ten, a pallet of a
-- hundred. Sales history keys on the part number, not on the SKU, because
-- the ERP's invoice export does; this table does not change that and nothing
-- was migrated. It makes the relationship explicit so the order desk can say
-- "that is sold by the box of 10" without guessing.
create table nl.skus (
  sku_code      text primary key check (sku_code ~ '^[A-Z0-9][A-Z0-9.-]{2,29}$'),
  item_no       text not null references nl.items (item_no) on delete cascade,
  pack_quantity int not null default 1 check (pack_quantity > 0),
  uom           text not null references nl.uoms (code),
  -- The default selling unit for the part: what a quote uses when nobody
  -- said otherwise.
  is_default    boolean not null default false,
  barcode       text check (barcode ~ '^[0-9]{12,14}$'),
  -- Shipping facts. Freight needs weight and dimensions; the invoice ledger
  -- has neither, which is why freight in 0018 is priced off the subtotal.
  weight_lb     numeric(10, 3) check (weight_lb >= 0),
  length_in     numeric(8, 2) check (length_in >= 0),
  width_in      numeric(8, 2) check (width_in >= 0),
  height_in     numeric(8, 2) check (height_in >= 0),
  sellable      boolean not null default true,
  discontinued  boolean not null default false,
  replaced_by   text references nl.skus (sku_code),
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default nl.now_ms(),
  constraint skus_replacement_is_not_itself check (replaced_by is distinct from sku_code),
  -- A discontinued SKU may name its replacement; a live one may not.
  constraint skus_replacement_only_when_discontinued
    check (replaced_by is null or discontinued)
);

create index skus_item_idx on nl.skus (item_no);
create index skus_barcode_idx on nl.skus (barcode) where barcode is not null;
create index skus_replaced_by_idx on nl.skus (replaced_by);
-- One default SKU per part.
create unique index skus_one_default_idx on nl.skus (item_no) where is_default;

create trigger skus_touch before update on nl.skus
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Work centres, labour and machines
-- ---------------------------------------------------------------------------

-- The cells on the floor. The strings already sitting in
-- nl.items.work_center ('BEND CELL', 'CUT CELL', 'WELD CELL', 'ASSEMBLY')
-- resolve to these; a test proves every one of them does. There is no
-- foreign key on nl.items.work_center because a bought part's work centre is
-- the empty string, and a foreign key cannot say "empty or a real one".
create table nl.work_centers (
  code          text primary key check (code ~ '^[A-Z][A-Z0-9 ]{1,23}$'),
  name          text not null,
  department    text not null default '',      -- which overhead pools reach it
  shifts        int not null default 1 check (shifts between 1 and 3),
  hours_per_day numeric(5, 2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  days_per_week int not null default 5 check (days_per_week between 1 and 7),
  -- How much of the clock turns into product. 0.85 means a nominal hour
  -- yields 51 minutes; it stretches cost and lead time together.
  efficiency    numeric(4, 3) not null default 0.85 check (efficiency > 0 and efficiency <= 2),
  -- The labour class an operation at this cell uses when it names none.
  labor_class   text,
  -- A flat hourly rate for a cell with no class, no machine and no pools
  -- configured. It is the fallback, not the model: the roll-up prefers the
  -- loaded labour rate and the derived machine rate every time.
  fallback_rate numeric(10, 4) check (fallback_rate >= 0),
  active        boolean not null default true,
  note          text not null default ''
);

comment on table nl.work_centers is
  'Cells on the floor. nl.items.work_center holds these codes (or the empty string for a bought part).';

-- Hours a cell can sell in a week, before anything is scheduled into it.
-- The load board (nl.work_center_load) measures against this.
create view nl.work_center_capacity with (security_invoker = true) as
select
  w.code,
  w.name,
  w.department,
  w.shifts,
  w.hours_per_day,
  w.days_per_week,
  w.efficiency,
  round(w.hours_per_day * w.shifts, 2)                                    as hours_per_day_all_shifts,
  round(w.hours_per_day * w.shifts * w.days_per_week, 2)                  as nominal_hours_per_week,
  round(w.hours_per_day * w.shifts * w.days_per_week * w.efficiency, 2)   as effective_hours_per_week,
  round(w.hours_per_day * w.shifts * w.days_per_week * 52 * w.efficiency, 1) as effective_hours_per_year,
  w.active
from nl.work_centers w;

create table nl.labor_classes (
  code        text primary key check (code ~ '^[A-Z][A-Z0-9 ]{1,19}$'),
  name        text not null,
  description text not null default '',
  department  text not null default ''
);

alter table nl.work_centers
  add constraint work_centers_labor_class_fkey
  foreign key (labor_class) references nl.labor_classes (code);

-- What an hour of a labour class costs, from when. The wage is not the cost:
-- benefits, the employer's payroll taxes and paid time off all ride on it,
-- and the gap between the wage and the loaded rate is usually a third. Both
-- numbers are shown on the part page, because that gap is the point.
--
--   loaded = base_wage * (1 + fringe_pct + payroll_tax_pct) * pto_factor
--
-- pto_factor is paid hours per productive hour: 2,080 paid hours against
-- 1,930 on the floor is 1.078.
create table nl.labor_rates (
  labor_class     text not null references nl.labor_classes (code) on delete cascade,
  effective_from  date not null,
  base_wage       numeric(10, 4) not null check (base_wage >= 0),
  fringe_pct      numeric(6, 4) not null default 0 check (fringe_pct >= 0 and fringe_pct < 1),
  payroll_tax_pct numeric(6, 4) not null default 0 check (payroll_tax_pct >= 0 and payroll_tax_pct < 1),
  pto_factor      numeric(6, 4) not null default 1 check (pto_factor >= 1 and pto_factor < 2),
  note            text not null default '',
  primary key (labor_class, effective_from)
);

-- The lookup nl.labor_rate_on() makes, carrying every column it reads.
create index labor_rates_lookup_idx
  on nl.labor_rates (labor_class, effective_from desc)
  include (base_wage, fringe_pct, payroll_tax_pct, pto_factor);

-- Each rate revision with the wage, the loaded rate and the gap between them.
create view nl.labor_rate_timeline with (security_invoker = true) as
select
  r.labor_class,
  c.name as labor_class_name,
  r.effective_from,
  (lead(r.effective_from) over w - 1) as effective_to,
  lead(r.effective_from) over w is null as is_current,
  r.base_wage,
  r.fringe_pct,
  r.payroll_tax_pct,
  r.pto_factor,
  round(r.base_wage * (1 + r.fringe_pct + r.payroll_tax_pct) * r.pto_factor, 4) as loaded_rate,
  round(r.base_wage * ((1 + r.fringe_pct + r.payroll_tax_pct) * r.pto_factor - 1), 4) as load_amount
from nl.labor_rates r
join nl.labor_classes c on c.code = r.labor_class
window w as (partition by r.labor_class order by r.effective_from);

-- The rate in force for a class on a date. A date before the history starts
-- reads the oldest revision, so a caller never gets an empty answer.
create function nl.labor_rate_on(p_labor_class text, p_on_date date)
returns table (base_wage numeric, loaded_rate numeric)
language sql stable
set search_path = ''
as $$
  select r.base_wage,
         round(r.base_wage * (1 + r.fringe_pct + r.payroll_tax_pct) * r.pto_factor, 4)
  from nl.labor_rates r
  where r.labor_class = p_labor_class
  order by (r.effective_from <= coalesce(p_on_date, nl.today())) desc, r.effective_from desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Capital, and the machine hour rate that comes out of it
-- ---------------------------------------------------------------------------

-- A machine, a press, a fixture or a building, with what it cost and how
-- long it is expected to earn. A machine hour rate is not typed in here: it
-- is derived, so "why does this part cost more per minute" has an answer
-- made of purchase price, useful life and expected running hours rather than
-- somebody's estimate.
--
-- Straight line depreciation only. It is the method a standard cost roll-up
-- uses, it is the one a reader can check in their head, and the alternatives
-- (declining balance, units of production) would change the cost of a part
-- with the age of the machine, which is not what a standard cost is for.
create table nl.capital_assets (
  asset_no              text primary key check (asset_no ~ '^[A-Z]{2}-[0-9]{3,6}$'),
  name                  text not null,
  kind                  text not null check (kind in ('machine', 'tooling', 'fixture', 'building', 'vehicle')),
  acquired_on           date not null,
  acquisition_cost      numeric(14, 2) not null check (acquisition_cost >= 0),
  useful_life_years     int not null check (useful_life_years between 1 and 60),
  salvage_value         numeric(14, 2) not null default 0 check (salvage_value >= 0),
  depreciation_method   text not null default 'straight line' check (depreciation_method = 'straight line'),
  -- What the plant expects to run it: the denominator of the hourly rate.
  expected_annual_hours numeric(9, 2) check (expected_annual_hours > 0),
  work_center           text references nl.work_centers (code),
  floor_space_sqft      numeric(9, 2) check (floor_space_sqft >= 0),
  power_kw              numeric(9, 3) check (power_kw >= 0),
  note                  text not null default '',
  constraint capital_assets_salvage_under_cost check (salvage_value <= acquisition_cost)
);

create index capital_assets_wc_idx on nl.capital_assets (work_center);

comment on table nl.capital_assets is
  'What the plant bought and how long it earns. Machine hour rates derive from these, so capital lands in the cost of goods sold rather than only in a fixed-cost line.';

-- The depreciable base spread over the life, and per expected hour. This is
-- how capital gets into the cost of everything sold: an hour on a machine
-- carries its share of what the machine cost.
create view nl.asset_depreciation with (security_invoker = true) as
select
  a.asset_no,
  a.name,
  a.kind,
  a.work_center,
  a.acquired_on,
  a.acquisition_cost,
  a.salvage_value,
  a.useful_life_years,
  a.expected_annual_hours,
  (a.acquisition_cost - a.salvage_value) as depreciable_base,
  round((a.acquisition_cost - a.salvage_value) / a.useful_life_years, 2) as annual_depreciation,
  case when a.expected_annual_hours > 0
       then round((a.acquisition_cost - a.salvage_value) / a.useful_life_years / a.expected_annual_hours, 4)
  end as depreciation_per_hour,
  (a.acquired_on + (a.useful_life_years || ' years')::interval)::date as fully_depreciated_on,
  greatest(0, least(
    (a.acquisition_cost - a.salvage_value),
    round((a.acquisition_cost - a.salvage_value) / a.useful_life_years
          * (((select nl.today()) - a.acquired_on) / 365.0)::numeric, 2))) as accumulated_to_date
from nl.capital_assets a;

create table nl.machines (
  code                     text primary key check (code ~ '^[A-Z][A-Z0-9 -]{1,19}$'),
  name                     text not null,
  work_center              text not null references nl.work_centers (code),
  asset_no                 text references nl.capital_assets (asset_no),
  -- Everything an hour on this machine costs besides depreciation. Each is
  -- its own number so the machine hour rate can be read apart rather than
  -- argued with.
  maintenance_per_hour     numeric(10, 4) not null default 0 check (maintenance_per_hour >= 0),
  energy_kw                numeric(9, 3) not null default 0 check (energy_kw >= 0),
  energy_rate_per_kwh      numeric(8, 4) not null default 0 check (energy_rate_per_kwh >= 0),
  tooling_per_hour         numeric(10, 4) not null default 0 check (tooling_per_hour >= 0),
  tooling_per_piece        numeric(10, 4) not null default 0 check (tooling_per_piece >= 0),
  floor_space_sqft         numeric(9, 2) not null default 0 check (floor_space_sqft >= 0),
  floor_rate_per_sqft_year numeric(8, 4) not null default 0 check (floor_rate_per_sqft_year >= 0),
  active                   boolean not null default true,
  note                     text not null default ''
);

create index machines_wc_idx on nl.machines (work_center);
create index machines_asset_idx on nl.machines (asset_no);

-- What an hour on each machine costs, component by component. The roll-up
-- reads machine_rate; the part page shows the five numbers behind it.
create view nl.machine_hour_rate with (security_invoker = true) as
select
  m.code,
  m.name,
  m.work_center,
  m.asset_no,
  coalesce(d.depreciation_per_hour, 0)                             as depreciation_per_hour,
  m.maintenance_per_hour,
  round(m.energy_kw * m.energy_rate_per_kwh, 4)                    as energy_per_hour,
  m.tooling_per_hour,
  m.tooling_per_piece,
  m.floor_space_sqft,
  m.floor_rate_per_sqft_year,
  case when d.expected_annual_hours > 0
       then round(m.floor_space_sqft * m.floor_rate_per_sqft_year / d.expected_annual_hours, 4)
       else 0 end                                                  as floor_per_hour,
  round(coalesce(d.depreciation_per_hour, 0)
        + m.maintenance_per_hour
        + m.energy_kw * m.energy_rate_per_kwh
        + m.tooling_per_hour
        + case when d.expected_annual_hours > 0
               then m.floor_space_sqft * m.floor_rate_per_sqft_year / d.expected_annual_hours
               else 0 end, 4)                                      as machine_rate,
  m.active
from nl.machines m
left join nl.asset_depreciation d on d.asset_no = m.asset_no;

-- ---------------------------------------------------------------------------
-- Overhead pools and absorption
-- ---------------------------------------------------------------------------

-- Rent, utilities, insurance, IT, supervision, quality and materials
-- handling are real money that no part carries on its own. Standard costing
-- with absorption puts them on parts through a driver: the more of the
-- driver a part uses, the more of the pool it carries.
--
-- Which driver is the right one is exactly what a real plant argues about,
-- which is why the driver is data on the pool and not a rule in the code.
-- An empty department means the pool reaches every cell in the plant.
create table nl.overhead_pools (
  code        text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name        text not null,
  department  text not null default '',
  driver      text not null check (driver in ('labor hours', 'machine hours', 'floor space', 'material value')),
  note        text not null default ''
);

comment on table nl.overhead_pools is
  'Indirect cost pools absorbed onto parts through a driver. The driver is data because a real plant argues about it.';

-- What a pool held in a period, and how much of its driver the plant used in
-- that period. The rate is one divided by the other.
create table nl.overhead_pool_periods (
  pool_code       text not null references nl.overhead_pools (code) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  amount          numeric(14, 2) not null check (amount >= 0),
  -- Hours for an hours driver, square feet for floor space, dollars of
  -- material for material value.
  driver_quantity numeric(16, 4) not null check (driver_quantity > 0),
  note            text not null default '',
  primary key (pool_code, period_start),
  constraint overhead_pool_periods_window check (period_end >= period_start)
);

-- The rate per driver unit, per pool and period. A material value pool's
-- rate is a fraction of material cost; the others are dollars per hour or
-- per square foot per period.
create view nl.overhead_rates with (security_invoker = true) as
select
  p.code,
  p.name,
  p.department,
  p.driver,
  d.period_start,
  d.period_end,
  d.amount,
  d.driver_quantity,
  round(d.amount / d.driver_quantity, 6) as rate,
  (d.period_start <= (select nl.today()) and d.period_end >= (select nl.today())) as is_current
from nl.overhead_pools p
join nl.overhead_pool_periods d on d.pool_code = p.code;

-- The pools in force today, which is what the roll-up absorbs. One row per
-- pool: the newest period that covers today, else the newest there is, so a
-- pool whose period has lapsed still absorbs at its last known rate rather
-- than silently becoming free.
create view nl.overhead_rates_current with (security_invoker = true) as
select r.code, r.name, r.department, r.driver, r.rate, r.period_start, r.period_end, r.is_current
from (
  select r.*,
         row_number() over (partition by r.code order by r.is_current desc, r.period_start desc) as pick
  from nl.overhead_rates r
) r
where r.pick = 1;

-- ---------------------------------------------------------------------------
-- Bills of material
-- ---------------------------------------------------------------------------

create table nl.bom_lines (
  id             bigint generated always as identity (start with 5001) primary key,
  parent_item    text not null references nl.items (item_no) on delete cascade,
  line_no        int not null check (line_no > 0),
  child_item     text not null references nl.items (item_no),
  -- How much of the child one of the parent needs, before scrap.
  quantity_per   numeric(14, 5) not null check (quantity_per > 0),
  uom            text not null references nl.uoms (code),
  -- What is lost turning the child into the parent: a 2% scrap on tube means
  -- 1.02 pieces are needed for every one that comes out.
  scrap_pct      numeric(6, 4) not null default 0 check (scrap_pct >= 0 and scrap_pct < 0.9),
  effective_from date,
  effective_to   date,
  -- An alternate the shop may use instead of the primary line. A substitute
  -- is never added to the cost or to the material need: the primary is what
  -- the standard says, and counting both would double the part.
  is_substitute  boolean not null default false,
  substitute_for bigint references nl.bom_lines (id) on delete cascade,
  -- Force a pass-through even where the child item is not flagged phantom.
  is_phantom     boolean not null default false,
  -- The routing step that consumes it, for backflushing. Null means the
  -- first step.
  operation_seq  int,
  reference_note text not null default '',
  constraint bom_lines_not_itself check (parent_item <> child_item),
  constraint bom_lines_window check (effective_to is null or effective_from is null
                                     or effective_to >= effective_from),
  constraint bom_lines_substitute_points_somewhere
    check (is_substitute = (substitute_for is not null)),
  unique (parent_item, line_no)
);

comment on table nl.bom_lines is
  'One level of one bill of materials. Any depth: a child with its own lines explodes. A substitute line is an alternate and is never costed.';

-- The explosion walks down by parent, carrying what it multiplies.
create index bom_lines_parent_idx
  on nl.bom_lines (parent_item, line_no)
  include (child_item, quantity_per, scrap_pct, is_substitute);
-- Where-used walks up by child, and is the index the roll-up triggers use to
-- find everything above a part that changed.
create index bom_lines_child_idx
  on nl.bom_lines (child_item)
  include (parent_item, quantity_per, scrap_pct, is_substitute);
create index bom_lines_substitute_idx on nl.bom_lines (substitute_for);

-- A bill of materials cannot contain itself, at any depth. The walk stops at
-- 32 levels whatever happens, so bad data cannot hang a transaction, and the
-- insert or update that would close the loop is refused with the chain in
-- the message.
create function nl.bom_cycle_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_path text[];
begin
  -- Walk up from the new line's parent looking for the child. If the child
  -- is already above the parent, adding this line closes a loop.
  with recursive up (item_no, path, depth) as (
    select new.parent_item, array[new.parent_item], 0
    union all
    select b.parent_item, u.path || b.parent_item, u.depth + 1
    from up u
    join nl.bom_lines b on b.child_item = u.item_no
    where u.depth < 32 and not b.parent_item = any (u.path)
  )
  select u.path into v_path
  from up u
  where u.item_no = new.child_item
  limit 1;

  if v_path is not null then
    raise exception '% is already above % in a bill of materials (%), so it cannot also be below it.',
      new.child_item, new.parent_item, array_to_string(v_path, ' -> ')
      using errcode = 'NL422';
  end if;
  return new;
end $$;

create trigger bom_lines_no_cycles
  before insert or update of parent_item, child_item on nl.bom_lines
  for each row execute function nl.bom_cycle_guard();

-- ---------------------------------------------------------------------------
-- Routings
-- ---------------------------------------------------------------------------

create table nl.routing_operations (
  id                      bigint generated always as identity (start with 6001) primary key,
  item_no                 text not null references nl.items (item_no) on delete cascade,
  seq                     int not null check (seq > 0),
  work_center             text references nl.work_centers (code),
  description             text not null,
  -- Time. Setup is paid once per lot and amortized over standard_lot_size;
  -- run is per piece; queue and move are waiting, so they add lead time and
  -- no cost at all.
  setup_minutes           numeric(10, 3) not null default 0 check (setup_minutes >= 0),
  run_minutes_per_piece   numeric(10, 4) not null default 0 check (run_minutes_per_piece >= 0),
  queue_minutes           numeric(10, 3) not null default 0 check (queue_minutes >= 0),
  move_minutes            numeric(10, 3) not null default 0 check (move_minutes >= 0),
  standard_lot_size       int not null default 1 check (standard_lot_size > 0),
  -- What comes out good. 0.97 means three pieces in a hundred are lost HERE,
  -- carrying everything spent up to here with them, which is what makes a
  -- late operation's scrap expensive.
  yield_pct               numeric(6, 4) not null default 1 check (yield_pct > 0.5 and yield_pct <= 1),
  labor_class             text references nl.labor_classes (code),
  machine                 text references nl.machines (code),
  crew_size               numeric(5, 2) not null default 1 check (crew_size > 0 and crew_size <= 12),
  -- Paid above the loaded rate: a cell that runs Saturdays to keep up.
  overtime_premium        numeric(5, 4) not null default 0 check (overtime_premium >= 0 and overtime_premium < 1),
  -- Paid to move one lot up the queue. Its own line in the breakdown,
  -- because it is a decision and not a cost of the part.
  expedite_premium        numeric(10, 4) not null default 0 check (expedite_premium >= 0),
  -- An inspection is an operation with time and a cost like any other, not
  -- an assumption inside overhead.
  is_inspection           boolean not null default false,
  -- Sent out and back: plating, coating, heat treat.
  is_outside              boolean not null default false,
  vendor_no               text references nl.vendors (vendor_no),
  outside_lead_time       text not null default '',          -- ERP date formula: 5D, 2W
  outside_price_per_piece numeric(12, 4) check (outside_price_per_piece >= 0),
  outside_minimum_charge  numeric(12, 2) check (outside_minimum_charge >= 0),
  effective_from          date,
  effective_to            date,
  note                    text not null default '',
  unique (item_no, seq),
  -- An outside step names its vendor and its price and sits at no cell. An
  -- inside step sits at a cell.
  constraint routing_operations_outside_has_a_vendor
    check (not is_outside or (vendor_no is not null and outside_price_per_piece is not null)),
  constraint routing_operations_inside_has_a_cell
    check (is_outside or work_center is not null),
  constraint routing_operations_window
    check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

comment on table nl.routing_operations is
  'The steps that turn children into a parent, in sequence. Queue and move minutes buy lead time and no cost; setup is amortized over the standard lot.';

-- The roll-up reads a part's operations in sequence, carrying everything it
-- costs with them.
create index routing_operations_item_idx
  on nl.routing_operations (item_no, seq)
  include (work_center, setup_minutes, run_minutes_per_piece, yield_pct, machine, labor_class);
-- The triggers find every part affected when a cell, a class, a machine or a
-- vendor changes.
create index routing_operations_wc_idx on nl.routing_operations (work_center);
create index routing_operations_machine_idx on nl.routing_operations (machine);
create index routing_operations_labor_idx on nl.routing_operations (labor_class);
create index routing_operations_vendor_idx on nl.routing_operations (vendor_no);

-- ---------------------------------------------------------------------------
-- Sourcing: a list, not a value
-- ---------------------------------------------------------------------------

-- "Buy it under 25 pieces, make it above 25." "Make it here unless the
-- plater is quicker." Neither of those can be said with one word on the item
-- card, and both are ordinary. So the ways of getting a part are a list,
-- each row with its own quantity band, party, cost basis and lead time, and
-- a priority that says which one the planner reaches for first.
create table nl.item_sources (
  id             bigint generated always as identity (start with 7001) primary key,
  item_no        text not null references nl.items (item_no) on delete cascade,
  -- Null means any location.
  location_code  text references nl.locations (code),
  source_kind    text not null check (source_kind in
                   ('purchase', 'produce', 'assemble', 'outside process', 'transfer', 'drop ship')),
  vendor_no      text references nl.vendors (vendor_no),
  work_center    text references nl.work_centers (code),
  from_location  text references nl.locations (code),
  -- 1 is tried first.
  priority       int not null default 1 check (priority between 1 and 99),
  min_qty        numeric(12, 3) check (min_qty >= 0),
  max_qty        numeric(12, 3) check (max_qty > 0),
  cost_basis     text not null default 'standard cost'
                   check (cost_basis in ('vendor price', 'standard cost', 'rolled cost', 'outside process price')),
  unit_price     numeric(12, 4) check (unit_price >= 0),     -- what this source charges, where it charges
  lead_time      text not null default '',                    -- ERP date formula
  effective_from date,
  effective_to   date,
  note           text not null default '',
  constraint item_sources_band check (max_qty is null or min_qty is null or max_qty >= min_qty),
  constraint item_sources_window check (effective_to is null or effective_from is null
                                        or effective_to >= effective_from),
  -- The party has to match the kind, or the row says nothing.
  constraint item_sources_party_matches_kind check (
    case source_kind
      when 'purchase'        then vendor_no is not null
      when 'drop ship'       then vendor_no is not null
      when 'outside process' then vendor_no is not null
      when 'produce'         then work_center is not null
      when 'assemble'        then work_center is not null
      when 'transfer'        then from_location is not null
    end)
);

comment on table nl.item_sources is
  'Every way a part can be got, with the quantity band it applies to. This is what replaces a make-or-buy field.';

create index item_sources_item_idx on nl.item_sources (item_no, priority);
create index item_sources_vendor_idx on nl.item_sources (vendor_no);
create index item_sources_wc_idx on nl.item_sources (work_center);

-- Planning policy, which is a different question from sourcing: sourcing
-- says where a piece comes from, planning says when and how many to ask for.
-- nl.items.reorder_point and nl.items.safety_stock (migration 0015) stay
-- where they are; this table holds the rest of the rule.
create table nl.item_planning (
  item_no          text primary key references nl.items (item_no) on delete cascade,
  demand_policy    text not null default 'reorder point'
                     check (demand_policy in ('make to stock', 'make to order', 'reorder point',
                                              'planned', 'non-stock')),
  lot_sizing       text not null default 'lot for lot'
                     check (lot_sizing in ('lot for lot', 'fixed order quantity', 'maximum quantity')),
  min_order_qty    numeric(12, 3) check (min_order_qty >= 0),
  order_multiple   numeric(12, 3) check (order_multiple > 0),
  max_order_qty    numeric(12, 3) check (max_order_qty > 0),
  planning_days    int check (planning_days between 1 and 365),
  note             text not null default '',
  constraint item_planning_band check (max_order_qty is null or min_order_qty is null
                                       or max_order_qty >= min_order_qty)
);

-- ---------------------------------------------------------------------------
-- The derived supply shape
-- ---------------------------------------------------------------------------

-- What a part IS, worked out from what it has rather than from a field
-- somebody typed:
--
--   a parts list and a fabrication step  manufactured
--   a parts list, and only assembly or
--   packing steps, or no steps at all    assembled (or kitted)
--   a fabrication step and no parts
--   list                                 processed: something was done to
--                                        material we did not buy finished
--   neither                              purchased
--
-- Assembly and packing are steps too, so "has a routing" is not the test
-- that separates making from assembling. What separates them is whether
-- metal is cut, bent, welded, polished or sent out: a kit that is picked,
-- boxed and labelled has a routing and is still a kit.
--
-- The sentence is the point. A part page says "Assembled from 3 made parts,
-- 7 bought parts and one plating step" and nobody has to read the table.
create view nl.item_supply_shape with (security_invoker = true) as
with counted as (
  select
    i.item_no,
    i.family,
    i.kind,
    i.replenishment,
    i.phantom,
    coalesce(b.lines, 0)          as bom_lines,
    coalesce(b.made_children, 0)  as made_children,
    coalesce(b.bought_children, 0) as bought_children,
    coalesce(b.packaging_children, 0) as packaging_children,
    coalesce(r.operations, 0)         as operations,
    coalesce(r.inside_steps, 0)       as inside_steps,
    coalesce(r.outside_steps, 0)      as outside_steps,
    coalesce(r.fabrication_steps, 0)  as fabrication_steps,
    r.cells
  from nl.items i
  left join (
    select
      b.parent_item,
      count(*)::int as lines,
      count(*) filter (where c.made)::int as made_children,
      count(*) filter (where not c.made and c.kind <> 'packaging')::int as bought_children,
      count(*) filter (where c.kind = 'packaging')::int as packaging_children
    from nl.bom_lines b
    join lateral (
      select ci.kind,
             exists (select 1 from nl.bom_lines b2 where b2.parent_item = ci.item_no and not b2.is_substitute)
             or exists (select 1 from nl.routing_operations r2 where r2.item_no = ci.item_no) as made
      from nl.items ci where ci.item_no = b.child_item
    ) c on true
    where not b.is_substitute
    group by b.parent_item
  ) b on b.parent_item = i.item_no
  left join (
    select
      r.item_no,
      count(*)::int as operations,
      count(*) filter (where not r.is_outside)::int as inside_steps,
      count(*) filter (where r.is_outside)::int as outside_steps,
      -- Steps that change the metal, as opposed to picking, boxing and
      -- labelling. This is what decides making from assembling.
      count(*) filter (where r.is_outside
                          or coalesce(r.work_center, '') not in ('ASSEMBLY', 'PACK'))::int as fabrication_steps,
      string_agg(distinct r.work_center, ', ' order by r.work_center)
        filter (where r.work_center is not null) as cells
    from nl.routing_operations r
    group by r.item_no
  ) r on r.item_no = i.item_no
),
shaped as (
  select
    c.*,
    case
      when c.bom_lines > 0 and c.fabrication_steps > 0 then 'manufactured'
      when c.bom_lines > 0 and c.family = 'kit' then 'kitted'
      when c.bom_lines > 0 then 'assembled'
      when c.fabrication_steps > 0 then 'processed'
      else 'purchased'
    end as shape
  from counted c
)
select
  s.item_no,
  s.shape,
  s.kind,
  s.replenishment,
  s.phantom,
  s.bom_lines,
  s.made_children,
  s.bought_children,
  s.packaging_children,
  s.operations,
  s.inside_steps,
  s.outside_steps,
  s.fabrication_steps,
  s.cells,
  -- The ERP's own word for the same part. Where the two disagree the part
  -- page says so; nothing here overwrites the import.
  case s.shape
    when 'manufactured' then 'Prod. Order'
    when 'processed'    then 'Prod. Order'
    when 'assembled'    then 'Assembly'
    when 'kitted'       then 'Assembly'
    else 'Purchase'
  end as shape_implies,
  (case s.shape
     when 'manufactured' then 'Prod. Order'
     when 'processed'    then 'Prod. Order'
     when 'assembled'    then 'Assembly'
     when 'kitted'       then 'Assembly'
     else 'Purchase'
   end = s.replenishment) as agrees_with_erp,
  -- One readable line.
  case s.shape
    when 'purchased' then 'Bought finished, with no parts list and no steps of ours.'
    else
      initcap(s.shape) || ' '
      || case when s.bom_lines > 0 then
           'from ' || concat_ws(', ',
             nullif(s.made_children, 0) || ' made ' || case when s.made_children = 1 then 'part' else 'parts' end,
             nullif(s.bought_children, 0) || ' bought ' || case when s.bought_children = 1 then 'part' else 'parts' end,
             nullif(s.packaging_children, 0) || ' packaging ' || case when s.packaging_children = 1 then 'item' else 'items' end)
         else 'from material' end
      || case when s.inside_steps > 0
              then ' through ' || s.inside_steps || ' ' || case when s.inside_steps = 1 then 'step' else 'steps' end
                   || coalesce(' at ' || s.cells, '')
              else '' end
      || case when s.outside_steps > 0
              then case when s.inside_steps > 0 then ' and ' else ' with ' end
                   || s.outside_steps || ' outside ' || case when s.outside_steps = 1 then 'step' else 'steps' end
              else '' end
      || '.'
  end as sentence
from shaped s;

-- ---------------------------------------------------------------------------
-- Effective operations, with the cell's facts already joined on
-- ---------------------------------------------------------------------------

-- The operations in force today, carrying the cell's efficiency, department,
-- default labour class and fallback rate, so the cost views below do not
-- each repeat the join. Efficiency stretches both time and money: a cell
-- that yields 51 minutes an hour takes longer and costs more for the same
-- work, which is exactly what it does on the floor.
create view nl.routing_operations_effective with (security_invoker = true) as
select
  o.id,
  o.item_no,
  o.seq,
  o.work_center,
  o.description,
  o.setup_minutes,
  o.run_minutes_per_piece,
  o.queue_minutes,
  o.move_minutes,
  o.standard_lot_size,
  o.yield_pct,
  o.labor_class,
  o.machine,
  o.crew_size,
  o.overtime_premium,
  o.expedite_premium,
  o.is_inspection,
  o.is_outside,
  o.vendor_no,
  o.outside_lead_time,
  o.outside_price_per_piece,
  o.outside_minimum_charge,
  coalesce(w.department, '')      as department,
  coalesce(w.efficiency, 1)       as efficiency,
  w.labor_class                   as wc_labor_class,
  w.fallback_rate                 as fallback_rate,
  coalesce(w.hours_per_day, 8)    as hours_per_day,
  coalesce(w.shifts, 1)           as shifts
from nl.routing_operations o
left join nl.work_centers w on w.code = o.work_center
where (o.effective_from is null or o.effective_from <= (select nl.today()))
  and (o.effective_to is null or o.effective_to >= (select nl.today()));

-- ---------------------------------------------------------------------------
-- The cost of one level: what a part's OWN operations and own purchase cost
-- ---------------------------------------------------------------------------

-- The material cost basis for one part. This is the seam where landed cost
-- plugs in: the pricing work on another branch adds inbound freight, duty
-- and broker fees to a purchased part's cost, and when it lands this view is
-- replaced (and the roll-ups re-measured) and every rolled cost in the
-- database picks it up. Until then the basis is the cost timeline from 0018,
-- falling back to the item card.
create view nl.material_cost_basis with (security_invoker = true) as
select
  i.item_no,
  coalesce(c.unit_cost, i.unit_cost) as unit_cost,
  case when c.unit_cost is null then 'item card' else 'cost timeline' end as basis
from nl.items i
left join lateral (
  select c.unit_cost
  from nl.item_costs c
  where c.item_no = i.item_no
    and c.effective_from <= (select nl.today())
  order by c.effective_from desc
  limit 1
) c on true;

comment on view nl.material_cost_basis is
  'What a purchased piece of this part costs. The single seam for landed cost: replace this view and re-measure.';

/*
 * Every line of one part's OWN cost per piece: the cost that belongs to this
 * level of the tree and no other. Eight elements:
 *
 *   material    a purchased raw or consumable part's own purchase cost
 *   component   a purchased component or finished part's own purchase cost
 *   packaging   a purchased packaging part's own purchase cost
 *   labor       operation time at the loaded labour rate, times the crew
 *   machine     operation time at the derived machine hour rate, plus tooling
 *   overhead    each pool that reaches the operation, through its own driver
 *   outside     an outside step's price per piece
 *   scrap       what a yield below 100% throws away, costed at the operation
 *               where it is lost, so a late scrap costs more than an early one
 *
 * A part with a bill of materials has no material of its own: its material
 * comes from its children, and rolling that up is nl.measure_item_cost()'s
 * job. A part with no bill of materials is a leaf, and its own cost is what
 * it costs to buy, whatever its routing then does to it.
 *
 * This is a view rather than a function so the measure pass can compute
 * thousands of parts in one statement. nl.item_own_cost_lines() below is the
 * same thing for one part.
 */
create view nl.item_own_cost_lines with (security_invoker = true) as
-- 1. A leaf's purchase cost, in the element its kind decides.
select
  i.item_no,
  case i.kind
    when 'packaging' then 'packaging'
    when 'raw material' then 'material'
    when 'consumable' then 'material'
    else 'component'
  end                                  as element,
  0                                    as seq,
  coalesce(i.vendor_no, '')            as source,
  'Bought at ' || mb.basis || ' cost'  as detail,
  round(mb.unit_cost, 4)               as amount
from nl.items i
join nl.material_cost_basis mb on mb.item_no = i.item_no
where mb.unit_cost > 0
  and not exists (
    select 1 from nl.bom_lines b
    where b.parent_item = i.item_no and not b.is_substitute
      and (b.effective_from is null or b.effective_from <= (select nl.today()))
      and (b.effective_to is null or b.effective_to >= (select nl.today())))

union all

-- 2. Labour: minutes at the loaded rate, times the crew, plus any overtime
-- premium. Queue and move are not in here: waiting costs time, not wages.
select
  o.item_no,
  'labor',
  o.seq,
  coalesce(o.work_center, ''),
  o.description || ' at ' || coalesce(lc.code, o.work_center, 'the cell')
    || ': ' || round(t.labor_minutes, 3) || ' min'
    || case when o.crew_size <> 1 then ' x ' || o.crew_size || ' crew' else '' end
    || ' at ' || round(coalesce(lr.loaded_rate, o.fallback_rate, 0), 2) || '/hr loaded'
    || case when coalesce(lr.base_wage, 0) > 0 then ' (' || round(lr.base_wage, 2) || '/hr wage)' else '' end,
  round(t.labor_minutes / 60 * o.crew_size * coalesce(lr.loaded_rate, o.fallback_rate, 0)
        * (1 + o.overtime_premium), 4)
from nl.routing_operations_effective o
cross join lateral (
  select (o.setup_minutes / o.standard_lot_size + o.run_minutes_per_piece) / o.efficiency as labor_minutes
) t
left join nl.labor_classes lc on lc.code = coalesce(o.labor_class, o.wc_labor_class)
left join lateral nl.labor_rate_on(coalesce(o.labor_class, o.wc_labor_class), (select nl.today())) lr on true
where not o.is_outside
  and round(t.labor_minutes / 60 * o.crew_size * coalesce(lr.loaded_rate, o.fallback_rate, 0)
            * (1 + o.overtime_premium), 4) > 0

union all

-- 3. Machine time: the same minutes at the machine hour rate, which is
-- depreciation plus maintenance plus energy plus tooling plus floor space,
-- and then tooling charged per piece.
select
  o.item_no,
  'machine',
  o.seq,
  o.machine,
  o.description || ' on ' || mr.name || ': ' || round(t.machine_minutes, 3) || ' min at '
    || round(mr.machine_rate, 2) || '/hr (' || round(mr.depreciation_per_hour, 2) || ' of it capital)'
    || case when mr.tooling_per_piece > 0 then ' plus ' || round(mr.tooling_per_piece, 4) || ' tooling a piece' else '' end,
  round(t.machine_minutes / 60 * mr.machine_rate + mr.tooling_per_piece, 4)
from nl.routing_operations_effective o
join nl.machine_hour_rate mr on mr.code = o.machine
cross join lateral (
  select (o.setup_minutes / o.standard_lot_size + o.run_minutes_per_piece) / o.efficiency as machine_minutes
) t
where not o.is_outside
  and round(t.machine_minutes / 60 * mr.machine_rate + mr.tooling_per_piece, 4) > 0

union all

-- 4. Overhead, through whichever driver each pool names. A pool with no
-- department reaches every cell.
select
  o.item_no,
  'overhead',
  o.seq,
  p.code,
  p.name || ' absorbed on ' || p.driver || ' at ' || round(p.rate, 4)
    || case p.driver
         when 'labor hours' then ' an hour'
         when 'machine hours' then ' an hour'
         when 'floor space' then ' a square foot'
         else ' a dollar' end,
  round(a.amount, 4)
from nl.routing_operations_effective o
join nl.overhead_rates_current p
  on p.department = '' or p.department = o.department
cross join lateral (
  select (o.setup_minutes / o.standard_lot_size + o.run_minutes_per_piece) / o.efficiency / 60 as hours
) t
left join nl.machine_hour_rate mr on mr.code = o.machine
left join nl.asset_depreciation ad on ad.asset_no = mr.asset_no
cross join lateral (
  select case p.driver
    when 'labor hours'   then t.hours * o.crew_size * p.rate
    when 'machine hours' then case when o.machine is null then 0 else t.hours * p.rate end
    -- Dollars a square foot a period, times this machine's floor, times the
    -- share of its year this operation uses.
    when 'floor space'   then case when mr.code is null or coalesce(ad.expected_annual_hours, 0) = 0 then 0
                                   else mr.floor_space_sqft * p.rate * t.hours / ad.expected_annual_hours end
    else 0
  end as amount
) a
where not o.is_outside and a.amount > 0

union all

-- 5. Outside processing: what the plater charges for one piece.
select
  o.item_no,
  'outside',
  o.seq,
  o.vendor_no,
  o.description || ' outside at ' || coalesce(v.name, o.vendor_no)
    || ': ' || round(o.outside_price_per_piece, 4) || ' a piece'
    || case when o.outside_lead_time <> '' then ', ' || o.outside_lead_time || ' turnaround' else '' end,
  round(o.outside_price_per_piece, 4)
from nl.routing_operations_effective o
left join nl.vendors v on v.vendor_no = o.vendor_no
where o.is_outside and o.outside_price_per_piece > 0

union all

-- 6. Overhead that absorbs on material value rather than on hours, charged
-- where the material is actually bought.
--
-- Receiving, unloading, counting, putting away and carrying the money tied
-- up in a rack of tube is real cost, and it follows the value and bulk of
-- what came in rather than the hours anybody spent. So a pool with a
-- material value driver absorbs a percentage of what a piece costs to buy.
--
-- It is charged on the part that was BOUGHT, not on the parent it ends up
-- in, which is what stops it being absorbed twice on the way up a tree: a
-- made part has no purchase cost of its own, so it adds nothing here and
-- simply carries what its children absorbed. Only plant-wide pools apply,
-- for the same reason: material is received at the dock, before it belongs
-- to any department.
select
  i.item_no,
  'overhead',
  0,
  p.code,
  p.name || ' absorbed on material value at ' || round(p.rate * 100, 3) || '% of purchase cost',
  round(mb.unit_cost * p.rate, 4)
from nl.items i
join nl.material_cost_basis mb on mb.item_no = i.item_no
join nl.overhead_rates_current p on p.driver = 'material value' and p.department = ''
where mb.unit_cost > 0
  and round(mb.unit_cost * p.rate, 4) > 0
  and not exists (
    select 1 from nl.bom_lines b
    where b.parent_item = i.item_no and not b.is_substitute
      and (b.effective_from is null or b.effective_from <= (select nl.today()))
      and (b.effective_to is null or b.effective_to >= (select nl.today())))

union all

-- 7. Expediting, where an operation carries a premium. Its own element, not
-- folded into overhead, because it is a decision somebody made rather than
-- part of what the part costs to make.
select
  o.item_no,
  'expedite',
  o.seq,
  coalesce(o.work_center, o.vendor_no, ''),
  'Expediting premium on ' || o.description,
  round(o.expedite_premium, 4)
from nl.routing_operations_effective o
where o.expedite_premium > 0;

comment on view nl.item_own_cost_lines is
  'Every line of one part''s own cost per piece, before anything below it in the tree. The scrap allowance is not here: it depends on everything spent up to the operation that loses the piece, so migration 0036 adds it during the roll-up.';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.uoms enable row level security;
alter table nl.uom_conversions enable row level security;
alter table nl.item_material enable row level security;
alter table nl.skus enable row level security;
alter table nl.work_centers enable row level security;
alter table nl.labor_classes enable row level security;
alter table nl.labor_rates enable row level security;
alter table nl.capital_assets enable row level security;
alter table nl.machines enable row level security;
alter table nl.overhead_pools enable row level security;
alter table nl.overhead_pool_periods enable row level security;
alter table nl.bom_lines enable row level security;
alter table nl.routing_operations enable row level security;
alter table nl.item_sources enable row level security;
alter table nl.item_planning enable row level security;

-- All of it is about parts, process and policy rather than about people, so
-- the read-only role the assistant's SQL tool uses may read every table
-- here. Nothing in this file is written from the app: the seed and the
-- imports fill these tables.
create policy uoms_read on nl.uoms for select to nl_app, nl_readonly using (true);
create policy uom_conversions_read on nl.uom_conversions for select to nl_app, nl_readonly using (true);
create policy item_material_read on nl.item_material for select to nl_app, nl_readonly using (true);
create policy skus_read on nl.skus for select to nl_app, nl_readonly using (true);
create policy work_centers_read on nl.work_centers for select to nl_app, nl_readonly using (true);
create policy labor_classes_read on nl.labor_classes for select to nl_app, nl_readonly using (true);
create policy labor_rates_read on nl.labor_rates for select to nl_app, nl_readonly using (true);
create policy capital_assets_read on nl.capital_assets for select to nl_app, nl_readonly using (true);
create policy machines_read on nl.machines for select to nl_app, nl_readonly using (true);
create policy overhead_pools_read on nl.overhead_pools for select to nl_app, nl_readonly using (true);
create policy overhead_pool_periods_read on nl.overhead_pool_periods for select to nl_app, nl_readonly using (true);
create policy bom_lines_read on nl.bom_lines for select to nl_app, nl_readonly using (true);
create policy routing_operations_read on nl.routing_operations for select to nl_app, nl_readonly using (true);
create policy item_sources_read on nl.item_sources for select to nl_app, nl_readonly using (true);
create policy item_planning_read on nl.item_planning for select to nl_app, nl_readonly using (true);

grant select on nl.uoms, nl.uom_conversions, nl.item_material, nl.skus, nl.work_centers,
  nl.labor_classes, nl.labor_rates, nl.capital_assets, nl.machines, nl.overhead_pools,
  nl.overhead_pool_periods, nl.bom_lines, nl.routing_operations, nl.item_sources, nl.item_planning
to nl_app, nl_readonly;

grant select on nl.work_center_capacity, nl.labor_rate_timeline, nl.asset_depreciation,
  nl.machine_hour_rate, nl.overhead_rates, nl.overhead_rates_current, nl.item_supply_shape,
  nl.material_cost_basis, nl.routing_operations_effective, nl.item_own_cost_lines
to nl_app, nl_readonly;

grant execute on function
  nl.uom_factor(text, text, text),
  nl.labor_rate_on(text, date)
to nl_app, nl_readonly;

-- The cycle guard runs as the writer, so it needs no grant of its own.
revoke execute on function nl.bom_cycle_guard() from public;
