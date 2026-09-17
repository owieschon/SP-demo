-- 60 The warehouse: locations, bins, ninety days of stock ledger, cycle
-- counts, shipments on the dock and transfers between buildings.
--
-- Migration 0019 added the tables. This file fills them, and the one rule it
-- has to obey is the agreement rule: for every part, the sum of the bins and
-- the sum of the ledger both have to equal nl.stock.on_hand, which the item
-- master owns and the parts pages, the ERP allocation view and the supply
-- forecast all read. nl.warehouse_drift() is the check, and a test requires
-- it to be empty after a build.
--
-- The ledger is built backwards, which is the only way to land on an exact
-- figure:
--
--   1. split each part's on_hand across one or two locations and bins. That
--      is the CURRENT state, and it is exact by construction.
--   2. write the history that is already known: a shipment move for every
--      invoice line of the last 90 days, a return for every credit memo
--      line that sent pieces back, a shipment move for every shipment this
--      file marks as gone today, the two halves of the transfer that has
--      been received, and a count move for every posted count variance.
--   3. add a few adjustments with reasons, because a real warehouse has
--      damage and scrap.
--   4. work out what each bin must have STARTED with: opening balance plus
--      everything above has to come to today's quantity. Whatever is left
--      over is split between the opening balance and a handful of receipts
--      (purchase orders for bought parts, production orders for made ones).
--
-- So the ledger is not an approximation that happens to be close. It is the
-- current figure minus its own history, which is why it ties out to the
-- piece.
--
-- Everything is keyed off nl_seed.u / ri / chance, like db/seed.sql, so the
-- same day builds the same warehouse locally and on the server. Counts are
-- scaled by nl_seed.settings.scale and dates are relative to
-- nl_seed.settings.today.

-- ---------------------------------------------------------------------------
-- The generator's own bookkeeping. The app never reads these.
-- ---------------------------------------------------------------------------

-- Which open order becomes which shipment, so the pick lines can be written
-- after the shipment headers exist.
create table if not exists nl_seed.wh_pick (
  shipment_no   text primary key,
  document_no   text not null,
  location_code text not null,
  status        text not null,
  packed_by     int,
  packed_at     timestamptz,
  shipped_at    timestamptz
);

-- One row per bin: today's quantity, the moves already written against it,
-- and the opening balance and receipts that make the two agree.
create table if not exists nl_seed.wh_balance (
  item_no       text not null,
  location_code text not null,
  quantity      int not null,        -- what the bin holds today
  net_moves     int not null,        -- sum of the moves written so far
  need          int not null default 0,
  opening       int not null default 0,
  receipts      int not null default 0,
  lots          int not null default 1,
  primary key (item_no, location_code)
);

-- ---------------------------------------------------------------------------
-- The build
-- ---------------------------------------------------------------------------

create or replace function nl_seed.extra_60_warehouse() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today   date := (select today from nl_seed.settings);
  v_scale   double precision := (select scale from nl_seed.settings);
  -- The ledger covers the last 90 days. Before that there is only an
  -- opening balance.
  v_from    date := (select today from nl_seed.settings) - 90;
  v_ships   int;
  v_zone_a  text;
  v_zone_b  text;
  v_zone_c  text;
begin
  -- -------------------------------------------------------------------------
  -- 1. The buildings
  -- -------------------------------------------------------------------------
  -- MAIN is the plant: nearly everything ships from there. EAST is a smaller
  -- distribution center that carries the fast movers. WEST is a forward
  -- stocking spot for the coast and holds very little. The ERP export's
  -- Location Code column already says MAIN and EAST.
  insert into nl.locations (code, name, city, state, is_default, active) values
    ('MAIN', 'Main plant and warehouse',  'Sandusky', 'OH', true,  true),
    ('EAST', 'East distribution center',  'Scranton', 'PA', false, true),
    ('WEST', 'West coast forward stock',  'Reno',     'NV', false, true);

  -- -------------------------------------------------------------------------
  -- 2. Bins: split every part's on-hand across one or two locations
  -- -------------------------------------------------------------------------
  -- The part keeps the shelf and bin the item master already gave it at its
  -- home location, so a part page and a pick list say the same thing. A
  -- second location gets its own shelf. The split is exact: the home bin
  -- takes on_hand minus whatever went to the second location.
  --
  -- A part that holds nothing but sold in the last 90 days still gets a bin,
  -- with zero in it. An empty bin is still that part's address, and the
  -- ledger needs somewhere to put the shipments that emptied it.
  insert into nl.stock_bins (item_no, location_code, zone, aisle, shelf, bin, quantity, counted_on)
  with base as (
    select
      i.item_no,
      s.on_hand,
      s.shelf,
      s.bin,
      -- Zones follow how the parts are handled, not how they are numbered:
      -- long steel goes on the pipe racks, chrome is worth stealing so it
      -- lives in a cage, small hardware is in bins on the pick face.
      case
        when i.product_group = 'CHROME' then 'CHROME CAGE'
        when i.family in ('pipe', 'elbow', 'stack', 'raw') then 'PIPE RACK'
        when i.family in ('clamp', 'bracket', 'shield') then 'SMALL PARTS'
        else 'BULK'
      end as zone,
      (array['MAIN', 'MAIN', 'MAIN', 'MAIN', 'MAIN', 'MAIN', 'MAIN', 'EAST', 'EAST', 'WEST'])
        [1 + floor(nl_seed.u('wh.home|' || i.item_no) * 10)::int] as home
    from nl.items i
    join nl.stock s on s.item_no = i.item_no
    where s.on_hand > 0
       or exists (select 1 from nl.invoice_lines il
                  where il.item_no = i.item_no and il.posted_on >= (select today from nl_seed.settings) - 90)
  ),
  split as (
    select
      b.*,
      -- About a third of the parts that hold enough to be worth splitting
      -- are stocked in two places.
      case
        when b.on_hand >= 6 and nl_seed.chance(0.32, 'wh.split|' || b.item_no)
          then greatest(1, round(b.on_hand * (0.15 + 0.25 * nl_seed.u('wh.share|' || b.item_no)))::int)
        else 0
      end as away_qty,
      case b.home
        when 'MAIN' then (array['EAST', 'EAST', 'EAST', 'WEST'])
                           [1 + floor(nl_seed.u('wh.away|' || b.item_no) * 4)::int]
        when 'EAST' then (array['MAIN', 'MAIN', 'MAIN', 'WEST'])
                           [1 + floor(nl_seed.u('wh.away|' || b.item_no) * 4)::int]
        else (array['MAIN', 'MAIN', 'MAIN', 'EAST'])
               [1 + floor(nl_seed.u('wh.away|' || b.item_no) * 4)::int]
      end as away
    from base b
  )
  select
    s.item_no,
    s.home,
    s.zone,
    split_part(s.shelf, '-', 1),
    s.shelf,
    s.bin,
    s.on_hand - s.away_qty,
    case when nl_seed.chance(0.55, 'wh.counted|' || s.item_no)
         then (select today from nl_seed.settings) - nl_seed.ri(4, 180, 'wh.counted.day|' || s.item_no)
    end
  from split s
  union all
  select
    s.item_no,
    s.away,
    s.zone,
    a.aisle,
    a.aisle || '-' || a.rack,
    a.aisle || '-' || a.rack || '-' || nl_seed.ri(1, 4, 'wh.away.bin|' || s.item_no),
    s.away_qty,
    case when nl_seed.chance(0.35, 'wh.away.counted|' || s.item_no)
         then (select today from nl_seed.settings) - nl_seed.ri(4, 180, 'wh.away.counted.day|' || s.item_no)
    end
  from split s
  cross join lateral (
    select substr('ABCDEFGH', nl_seed.ri(1, 8, 'wh.away.aisle|' || s.item_no), 1) as aisle,
           nl_seed.ri(1, 22, 'wh.away.rack|' || s.item_no) as rack
  ) a
  where s.away_qty > 0;

  -- -------------------------------------------------------------------------
  -- 3. Shipments on the dock
  -- -------------------------------------------------------------------------
  -- Built from the open order lines the current ERP export left behind, and
  -- only from orders that stock covers completely: a picker cannot pick what
  -- is not there. The shipment is booked to the first location that covers
  -- every line of the order, preferring the location the order itself names,
  -- so advancing it to shipped later always finds the pieces on the shelf.
  v_ships := greatest(8, round(70 * v_scale))::int;

  insert into nl_seed.wh_pick (shipment_no, document_no, location_code, status, packed_by, packed_at, shipped_at)
  with covered as (
    -- nl.open_line_allocation says whether stock covers the line;
    -- nl.open_order_lines carries the location the ERP asked for.
    select a.document_no, min(a.ship_date) as promised, max(o.location_code) as asked_for
    from nl.open_line_allocation a
    join nl.open_order_lines o on o.document_no = a.document_no and o.line_no = a.line_no
    group by a.document_no
    having bool_and(a.allocated = a.quantity)
       and count(*) between 1 and 6
       and min(a.ship_date) <= (select today from nl_seed.settings) + 10
  ),
  placed as (
    select
      c.document_no,
      c.promised,
      (select loc.code
       from nl.locations loc
       where loc.active
         and not exists (
           select 1
           from nl.open_order_lines o
           left join nl.stock_bins b on b.item_no = o.item_no and b.location_code = loc.code
           where o.document_no = c.document_no
             and coalesce(b.quantity, 0) < o.quantity)
       order by (loc.code = c.asked_for) desc, (loc.code = 'MAIN') desc, loc.code
       limit 1) as location_code
    from covered c
  ),
  chosen as (
    select p.*, row_number() over (order by nl_seed.u('wh.ship|' || p.document_no)) as pick_order
    from placed p
    where p.location_code is not null
  ),
  numbered as (
    select c.*, row_number() over (order by c.promised, c.document_no) as n
    from chosen c
    where c.pick_order <= v_ships
  )
  select
    'SH' || lpad((40000 + n.n)::text, 5, '0'),
    n.document_no,
    n.location_code,
    st.status,
    -- Anything past picking was packed by one of the warehouse crew.
    case when st.status <> 'picking'
         then (array[5, 6, 12])[nl_seed.ri(1, 3, 'wh.packer|' || n.document_no)] end,
    case when st.status <> 'picking'
         then ((select today from nl_seed.settings)::timestamp
               + make_interval(hours => nl_seed.ri(7, 13, 'wh.packed.h|' || n.document_no),
                               mins  => nl_seed.ri(0, 59, 'wh.packed.m|' || n.document_no)))::timestamptz end,
    case when st.status = 'shipped'
         then ((select today from nl_seed.settings)::timestamp
               + make_interval(hours => nl_seed.ri(14, 16, 'wh.shipped.h|' || n.document_no),
                               mins  => nl_seed.ri(0, 59, 'wh.shipped.m|' || n.document_no)))::timestamptz end
  from numbered n
  cross join lateral (
    -- Five slots, so a fresh world always has something in every status:
    -- two being picked, one packed, one waiting on the carrier, one gone.
    select (array['picking', 'picking', 'packed', 'awaiting carrier', 'shipped'])
             [1 + ((n.n - 1) % 5)] as status
  ) st;

  insert into nl.shipments (shipment_no, customer_no, location_code, carrier, status, promised_on,
                            packed_by, packed_at, shipped_at, tracking, note, created_at)
  select
    w.shipment_no,
    o.customer_no,
    w.location_code,
    -- A customer on its own carrier account collects or sends a truck; the
    -- rest go out on a pallet by freight, and small orders go parcel.
    case
      when c.ships_own_carrier then (array['customer pickup', 'customer pickup', 'our truck'])
                                      [nl_seed.ri(1, 3, 'wh.carrier|' || w.shipment_no)]
      when o.pieces <= 4 then (array['parcel', 'parcel', 'LTL'])
                                [nl_seed.ri(1, 3, 'wh.carrier|' || w.shipment_no)]
      else (array['LTL', 'LTL', 'LTL', 'our truck'])[nl_seed.ri(1, 4, 'wh.carrier|' || w.shipment_no)]
    end,
    w.status,
    o.promised,
    w.packed_by,
    w.packed_at,
    w.shipped_at,
    case when w.status in ('awaiting carrier', 'shipped') and not c.ships_own_carrier
         then 'NL' || lpad(nl_seed.ri(1000000, 9999999, 'wh.track|' || w.shipment_no)::text, 7, '0')
         else '' end,
    (array['Pallet and corner boards, chrome face wrapped.',
           'Buyer asked for a call before the truck comes.',
           'Two boxes, one long crate. Crate marked top load.',
           'Hold for the customer truck, they collect Thursdays.',
           'Freight quoted at the desk, shipping on their account.',
           'Banded to a skid, stacks stood upright.',
           'Check the packing list against the order, they had a short last month.',
           'Split from a bigger order, the rest is on back order.'])
      [nl_seed.ri(1, 8, 'wh.ship.note|' || w.shipment_no)],
    -- A shipment still being picked was released this morning.
    coalesce(w.packed_at - make_interval(hours => 2),
             (v_today::timestamp + make_interval(hours => 7, mins => 30))::timestamptz)
  from nl_seed.wh_pick w
  cross join lateral (
    select min(o2.customer_no) as customer_no, min(o2.ship_date) as promised, sum(o2.quantity) as pieces
    from nl.open_order_lines o2
    where o2.document_no = w.document_no
  ) o
  join nl.customers c on c.customer_no = o.customer_no;

  -- A picker walks the aisle once, so the lines are numbered in bin order.
  insert into nl.shipment_lines (shipment_no, line_no, document_no, order_line_no, item_no, quantity, bin)
  select
    w.shipment_no,
    row_number() over (partition by w.shipment_no order by b.zone, b.aisle, b.shelf, b.bin, o.line_no),
    o.document_no,
    o.line_no,
    o.item_no,
    o.quantity,
    coalesce(b.bin, '')
  from nl_seed.wh_pick w
  join nl.open_order_lines o on o.document_no = w.document_no
  left join nl.stock_bins b on b.item_no = o.item_no and b.location_code = w.location_code;

  -- Shipments that went out today have already come off the shelf.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, actor)
  select l.item_no, s.location_code, s.shipped_at, 'shipment', -l.quantity, s.shipment_no, s.packed_by
  from nl.shipments s
  join nl.shipment_lines l on l.shipment_no = s.shipment_no
  where s.status = 'shipped';

  -- -------------------------------------------------------------------------
  -- 4. Transfers between buildings
  -- -------------------------------------------------------------------------
  -- One came in a week and a half ago and has been booked; one left two days
  -- ago and is still on the truck. The received one moved parts that are
  -- stocked at both ends, because the destination bin has to exist today for
  -- the stock to be sitting in it now.
  insert into nl.transfers (transfer_no, from_location, to_location, status, sent_on, expected_on,
                            received_on, sent_by, received_by, note) values
    ('TR-00318', 'MAIN', 'EAST', 'received', v_today - 13, v_today - 10, v_today - 10, 5, 6,
     'Monthly top up of the fast movers so the east desk stops borrowing off the plant.'),
    ('TR-00319', 'MAIN', 'WEST', 'in transit', v_today - 2, v_today + 3, null, 5, null,
     'Forward stock for the coast. Driver has the manifest, expect it Monday.');

  insert into nl.transfer_lines (transfer_no, line_no, item_no, quantity, from_bin, to_bin)
  select 'TR-00318',
         row_number() over (order by x.item_no),
         x.item_no,
         x.qty,
         x.from_bin,
         x.to_bin
  from (
    select main.item_no,
           nl_seed.ri(2, 4, 'wh.tr318.qty|' || main.item_no) as qty,
           main.bin as from_bin,
           east.bin as to_bin,
           row_number() over (order by nl_seed.u('wh.tr318|' || main.item_no)) as n
    from nl.stock_bins main
    join nl.stock_bins east on east.item_no = main.item_no and east.location_code = 'EAST' and east.quantity >= 4
    where main.location_code = 'MAIN' and main.quantity >= 8
  ) x
  where x.n <= 4;

  insert into nl.transfer_lines (transfer_no, line_no, item_no, quantity, from_bin, to_bin)
  select 'TR-00319',
         row_number() over (order by x.item_no),
         x.item_no,
         x.qty,
         x.from_bin,
         -- The coast has no bin for these yet; receiving the transfer makes
         -- one at this address.
         'W-' || lpad(x.n::text, 2, '0') || '-1'
  from (
    select main.item_no,
           nl_seed.ri(2, 5, 'wh.tr319.qty|' || main.item_no) as qty,
           main.bin as from_bin,
           row_number() over (order by nl_seed.u('wh.tr319|' || main.item_no)) as n
    from nl.stock_bins main
    where main.location_code = 'MAIN' and main.quantity >= 10
  ) x
  where x.n <= 3;

  -- The received transfer's two halves. In transit stock still counts at the
  -- origin, so TR-00319 has written nothing yet: nl.receive_transfer writes
  -- both halves when somebody books it in.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, actor)
  select l.item_no, t.from_location,
         (t.received_on::timestamp + make_interval(hours => 9, mins => 20))::timestamptz,
         'transfer_out', -l.quantity, t.transfer_no, t.sent_by
  from nl.transfers t
  join nl.transfer_lines l on l.transfer_no = t.transfer_no
  where t.status = 'received'
  union all
  select l.item_no, t.to_location,
         (t.received_on::timestamp + make_interval(hours => 15, mins => 5))::timestamptz,
         'transfer_in', l.quantity, t.transfer_no, t.received_by
  from nl.transfers t
  join nl.transfer_lines l on l.transfer_no = t.transfer_no
  where t.status = 'received';

  -- -------------------------------------------------------------------------
  -- 5. Cycle counts
  -- -------------------------------------------------------------------------
  -- The three biggest zones at the plant, counted in turn: two are done and
  -- posted, the third is on the clipboard and due today.
  select zone into v_zone_a from nl.stock_bins
   where location_code = 'MAIN' group by zone order by count(*) desc, zone limit 1;
  select zone into v_zone_b from nl.stock_bins
   where location_code = 'MAIN' and zone <> coalesce(v_zone_a, '')
   group by zone order by count(*) desc, zone limit 1;
  select zone into v_zone_c from nl.stock_bins
   where location_code = 'MAIN' and zone not in (coalesce(v_zone_a, ''), coalesce(v_zone_b, ''))
   group by zone order by count(*) desc, zone limit 1;

  insert into nl.count_sessions (session_no, location_code, zone, due_on, counted_on, counted_by,
                                 status, posted_at, posted_by, note)
  select * from (values
    ('CC-2201', 'MAIN', v_zone_a, v_today - 24, v_today - 21, 12, 'posted',
     (v_today - 21)::timestamp + make_interval(hours => 16, mins => 10), 5,
     'Quarterly sweep of the racks. Two tags had been swapped at some point.'),
    ('CC-2202', 'MAIN', v_zone_b, v_today - 11, v_today - 9, 6, 'posted',
     (v_today - 9)::timestamp + make_interval(hours => 15, mins => 45), 5,
     'Counted after the bin move. Small hardware always reads a little light.'),
    ('CC-2203', 'MAIN', v_zone_c, v_today, v_today, 12, 'open', null, null,
     'Half counted before the truck came in. Finish the back wall and post it.')
  ) as s(session_no, location_code, zone, due_on, counted_on, counted_by, status, posted_at, posted_by, note)
  where s.zone is not null;

  -- Count sheets: up to a dozen parts a zone, in bin order. What the sheet
  -- said (expected) for a posted count is history, so it is drawn from the
  -- quantity the bin holds now; for the open count it IS the quantity the
  -- bin holds now, which is what the person is checking against.
  insert into nl.count_lines (session_id, line_no, item_no, bin, expected_qty, counted_qty, reason, note)
  select
    x.id,
    x.n,
    x.item_no,
    x.bin,
    x.expected_qty,
    case
      when x.status = 'posted' then greatest(0, x.expected_qty + x.variance)
      -- The open sheet: most lines counted, the back wall not yet.
      when nl_seed.chance(0.75, 'wh.cc.done|' || x.session_no || '|' || x.item_no)
        then greatest(0, x.expected_qty + x.variance)
    end,
    case
      when x.variance < 0 and nl_seed.chance(0.35, 'wh.cc.why|' || x.session_no || '|' || x.item_no)
        then (array['damaged', 'scrap'])[nl_seed.ri(1, 2, 'wh.cc.why2|' || x.session_no || '|' || x.item_no)]
    end,
    case
      when x.variance = 0 then ''
      when x.variance > 0 then (array['Found a second box behind the rack.',
                                      'Extra pieces on the top shelf, same part.',
                                      'Short shipment credit went back on the shelf and was never booked.'])
                                 [nl_seed.ri(1, 3, 'wh.cc.note|' || x.session_no || '|' || x.item_no)]
      else (array['Two pieces dented on the end, pulled out.',
                  'Sheet says more than the bin holds. Nothing else in the aisle.',
                  'One was cut down for a sample and never written off.'])
             [nl_seed.ri(1, 3, 'wh.cc.note|' || x.session_no || '|' || x.item_no)]
    end
  from (
    select
      c.id,
      c.session_no,
      c.status,
      b.item_no,
      b.bin,
      case when c.status = 'posted'
           then greatest(3, b.quantity + nl_seed.ri(-2, 4, 'wh.cc.exp|' || c.session_no || '|' || b.item_no))
           else b.quantity end as expected_qty,
      -- Most lines come out right. The rest are off by a piece or three.
      (array[0, 0, 0, 0, 0, 0, 0, -1, -2, -3, 1, 2])
        [nl_seed.ri(1, 12, 'wh.cc.var|' || c.session_no || '|' || b.item_no)] as variance,
      row_number() over (partition by c.id order by b.aisle, b.shelf, b.bin, b.item_no) as n
    from nl.count_sessions c
    join nl.stock_bins b on b.location_code = c.location_code and b.zone = c.zone
  ) x
  where x.n <= 12;

  -- A posted count's variances are already in the stock, so they are already
  -- in the ledger. More than the sheet said is stock somebody found; less is
  -- a miscount unless the counter wrote down what happened to it.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, reason, actor, note)
  select
    l.item_no,
    c.location_code,
    (c.counted_on::timestamp + make_interval(hours => 14, mins => l.line_no))::timestamptz,
    'count',
    l.variance,
    c.session_no,
    coalesce(l.reason, case when l.variance > 0 then 'found' else 'miscount' end),
    c.counted_by,
    l.note
  from nl.count_sessions c
  join nl.count_lines l on l.session_id = c.id
  where c.status = 'posted' and l.variance is not null and l.variance <> 0;

  -- -------------------------------------------------------------------------
  -- 6. The history that is already known: shipments and returns
  -- -------------------------------------------------------------------------
  -- Every invoice line of the last 90 days took pieces off a shelf. Which
  -- shelf is not on the invoice, so it is drawn from the part's own bins,
  -- weighted by how much each one holds: the big bin ships most of the time.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, actor)
  select
    il.item_no,
    pick.location_code,
    (il.posted_on::timestamp
     + make_interval(hours => nl_seed.ri(7, 16, 'wh.inv.h|' || il.invoice_no || '|' || il.line_no),
                     mins  => nl_seed.ri(0, 59, 'wh.inv.m|' || il.invoice_no || '|' || il.line_no)))::timestamptz,
    'shipment',
    -il.quantity,
    il.invoice_no,
    null
  from nl.invoice_lines il
  join nl.invoices inv on inv.invoice_no = il.invoice_no
  cross join lateral (
    select b.location_code
    from nl.stock_bins b
    where b.item_no = il.item_no
    order by nl_seed.u('wh.inv.loc|' || il.invoice_no || '|' || il.line_no || '|' || b.location_code)
             / greatest(b.quantity, 1)::double precision
    limit 1
  ) pick
  where inv.doc_type = 'invoice'
    and il.posted_on between v_from and v_today
    and il.quantity > 0;

  -- A credit memo with pieces on it is a return. The parts came back to the
  -- shelf they shipped from, which is the same weighted draw.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, reason, actor, note)
  select
    il.item_no,
    pick.location_code,
    (il.posted_on::timestamp
     + make_interval(hours => nl_seed.ri(8, 15, 'wh.cm.h|' || il.invoice_no || '|' || il.line_no),
                     mins  => nl_seed.ri(0, 59, 'wh.cm.m|' || il.invoice_no || '|' || il.line_no)))::timestamptz,
    'adjustment',
    -il.quantity,
    il.invoice_no,
    'returned to stock',
    null,
    'Return on credit memo ' || il.invoice_no || ', checked over and put away.'
  from nl.invoice_lines il
  join nl.invoices inv on inv.invoice_no = il.invoice_no
  cross join lateral (
    select b.location_code
    from nl.stock_bins b
    where b.item_no = il.item_no
    order by nl_seed.u('wh.cm.loc|' || il.invoice_no || '|' || il.line_no || '|' || b.location_code)
             / greatest(b.quantity, 1)::double precision
    limit 1
  ) pick
  where inv.doc_type = 'credit_memo'
    and il.posted_on between v_from and v_today
    and il.quantity < 0;

  -- -------------------------------------------------------------------------
  -- 7. A few corrections with reasons
  -- -------------------------------------------------------------------------
  -- Damage, scrap and the odd box found in the wrong aisle: about one bin in
  -- thirty has one of these in the window.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, reason, actor, note)
  select
    b.item_no,
    b.location_code,
    (v_from::timestamp
     + make_interval(days => nl_seed.ri(3, 88, 'wh.adj.day|' || b.item_no || '|' || b.location_code),
                     hours => nl_seed.ri(7, 16, 'wh.adj.h|' || b.item_no || '|' || b.location_code)))::timestamptz,
    'adjustment',
    a.quantity,
    '',
    a.reason,
    (array[5, 6, 12])[nl_seed.ri(1, 3, 'wh.adj.who|' || b.item_no || '|' || b.location_code)],
    a.note
  from nl.stock_bins b
  cross join lateral (
    select
      r.reason,
      case when r.reason = 'found' then nl_seed.ri(1, 3, 'wh.adj.up|' || b.item_no || '|' || b.location_code)
           else -nl_seed.ri(1, least(4, greatest(1, b.quantity)), 'wh.adj.down|' || b.item_no || '|' || b.location_code)
      end as quantity,
      case r.reason
        when 'damaged' then (array['Forklift caught the end of the bundle.',
                                   'Flange bent, not worth straightening.',
                                   'Chrome scratched through, cannot sell it as new.'])
                              [nl_seed.ri(1, 3, 'wh.adj.note|' || b.item_no || '|' || b.location_code)]
        when 'scrap'   then (array['Cut down for a fit check on a new build.',
                                   'Weld seam split on the press, scrapped it.',
                                   'Rusted through on the outside rack over winter.'])
                              [nl_seed.ri(1, 3, 'wh.adj.note|' || b.item_no || '|' || b.location_code)]
        else (array['Turned up in the wrong aisle, put back where it belongs.',
                    'Box behind the rack nobody had booked in.',
                    'Came back off a job and went onto the shelf.'])
               [nl_seed.ri(1, 3, 'wh.adj.note|' || b.item_no || '|' || b.location_code)]
      end as note
    from (
      select (array['damaged', 'damaged', 'scrap', 'found'])
               [nl_seed.ri(1, 4, 'wh.adj.reason|' || b.item_no || '|' || b.location_code)] as reason
    ) r
  ) a
  where nl_seed.chance(0.033, 'wh.adj|' || b.item_no || '|' || b.location_code)
    and a.quantity <> 0;

  -- -------------------------------------------------------------------------
  -- 8. Work backwards: opening balance and receipts
  -- -------------------------------------------------------------------------
  -- Every bin, and every bin the ledger has already written to, with today's
  -- quantity and the moves so far.
  insert into nl_seed.wh_balance (item_no, location_code, quantity, net_moves)
  select
    coalesce(b.item_no, m.item_no),
    coalesce(b.location_code, m.location_code),
    coalesce(b.quantity, 0),
    coalesce(m.moved, 0)
  from nl.stock_bins b
  full join (
    select item_no, location_code, sum(quantity)::int as moved
    from nl.stock_moves
    group by item_no, location_code
  ) m on m.item_no = b.item_no and m.location_code = b.location_code;

  -- A bin whose moves add up to MORE than it holds today would need to have
  -- started below zero, which is not a thing. That means something was
  -- written off in the window and never booked, so book it: one scrap for
  -- the difference, right at the start.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, reason, actor, note)
  select
    w.item_no,
    w.location_code,
    (v_from::timestamp + make_interval(days => 1, hours => 8))::timestamptz,
    'adjustment',
    w.quantity - w.net_moves,
    '',
    'scrap',
    5,
    'Opening write off: the shelf could not have held what the paperwork claimed.'
  from nl_seed.wh_balance w
  where w.quantity - w.net_moves < 0;

  update nl_seed.wh_balance w
     set net_moves = w.quantity,
         need = 0
   where w.quantity - w.net_moves < 0;

  -- What is left has to come from somewhere: part of it was already on the
  -- shelf 90 days ago, the rest arrived on a purchase or production order.
  update nl_seed.wh_balance w
     set need = w.quantity - w.net_moves
   where w.need = 0 and w.quantity - w.net_moves > 0;

  update nl_seed.wh_balance w
     set opening = round(w.need * (0.35 + 0.45 * nl_seed.u('wh.open|' || w.item_no || '|' || w.location_code)))::int
   where w.need > 0;

  update nl_seed.wh_balance w
     set receipts = w.need - w.opening,
         lots = case
                  when w.need - w.opening >= 400 then 4
                  when w.need - w.opening >= 150 then 3
                  when w.need - w.opening >= 40 then 2
                  else 1
                end
   where w.need > 0;

  -- The opening balance, stated for every bin including the empty ones, so
  -- the ledger can be read from a known starting point.
  insert into nl.stock_opening (item_no, location_code, opened_on, quantity)
  select w.item_no, w.location_code, v_from, w.opening
  from nl_seed.wh_balance w;

  -- The receipts, in one to four lots spread across the window. Bought parts
  -- arrive on a purchase order, made parts come off a production order.
  insert into nl.stock_moves (item_no, location_code, moved_at, kind, quantity, reference, actor, note)
  select
    w.item_no,
    w.location_code,
    (v_from::timestamp
     + make_interval(days => nl_seed.ri(2, 88, 'wh.rec.day|' || w.item_no || '|' || w.location_code || '|' || lot.j),
                     hours => nl_seed.ri(6, 15, 'wh.rec.h|' || w.item_no || '|' || w.location_code || '|' || lot.j)))::timestamptz,
    'receipt',
    lot.quantity,
    case when i.replenishment = 'Purchase'
         then 'PO-' || lpad((90000 + nl_seed.ri(1, 9000, 'wh.rec.po|' || w.item_no || '|' || lot.j))::text, 6, '0')
         else 'MO-' || lpad((150000 + nl_seed.ri(1, 9000, 'wh.rec.mo|' || w.item_no || '|' || lot.j))::text, 6, '0')
    end,
    null,
    ''
  from nl_seed.wh_balance w
  join nl.items i on i.item_no = w.item_no
  cross join lateral (
    select
      g.j,
      case when g.j < w.lots then w.receipts / w.lots
           else w.receipts - (w.lots - 1) * (w.receipts / w.lots) end as quantity
    from generate_series(1, w.lots) as g(j)
  ) lot
  where w.receipts > 0
    and lot.quantity > 0;

  -- The bookkeeping tables have done their job.
  delete from nl_seed.wh_pick;
  delete from nl_seed.wh_balance;
end $$;
