-- 0019 The warehouse: where the stock actually is, and how it got there.
--
-- Until now the only warehouse fact in the database was nl.stock: one row
-- per part with an on-hand figure and a shelf and bin label. That figure is
-- what the ERP's item master says, and the parts pages, the ERP allocation
-- view (nl.open_line_allocation, migration 0010) and the supply forecast all
-- read it. It stays the authoritative number. Nothing here changes its
-- meaning or its columns.
--
-- What this migration adds is the state around it:
--
--   nl.locations       the buildings stock sits in (MAIN, EAST, WEST). The
--                      ERP export's Location Code column already says MAIN
--                      and EAST.
--   nl.stock_bins      one row per part per location: zone, aisle, shelf,
--                      bin, quantity, when it was last counted.
--   nl.stock_opening   the balance each part had at each location on the day
--                      the ledger starts. Written once, by the seed or an
--                      opening-balance load, and then left alone.
--   nl.stock_moves     an append-only ledger: every receipt, shipment,
--                      adjustment, transfer and count correction, signed.
--   nl.count_sessions  a cycle count of one zone on one day, and its lines.
--   nl.shipments       orders picked and packed but not yet collected.
--   nl.transfers       stock moving from one location to another.
--
-- THE AGREEMENT RULE. Three things say how much of a part there is, and all
-- three have to say the same thing:
--
--   1. nl.stock.on_hand                          the item master
--   2. sum of nl.stock_bins.quantity             the shelves
--   3. opening balance + sum of nl.stock_moves   the ledger
--
-- Every write function below moves all three in the same transaction, per
-- location, so they cannot come apart. nl.warehouse_drift() returns any part
-- where they disagree, and the tests require it to be empty. This is the
-- same idea as nl.delivery_drift() in migration 0008: a stored figure is
-- only trustworthy if something independently recomputes it and complains.
--
-- STOCK IN TRANSIT stays on the origin location's books until the transfer
-- is received. That is a choice, not an accident: it keeps the sum of the
-- locations equal to the item master at every moment, with no fourth place
-- for stock to hide. nl.receive_transfer writes the transfer_out at the
-- origin and the transfer_in at the destination in the same transaction, so
-- the item master never changes when stock moves between our own buildings.

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------

create table nl.locations (
  code       text primary key check (code ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name       text not null,
  city       text not null default '',
  state      text not null default '',
  is_default boolean not null default false,
  active     boolean not null default true
);

comment on table nl.locations is
  'Buildings that hold stock. The ERP export names them in its Location Code column.';

-- At most one default location.
create unique index locations_one_default_idx on nl.locations (is_default) where is_default;

-- ---------------------------------------------------------------------------
-- Bins: the part, the building, the shelf, the quantity
-- ---------------------------------------------------------------------------

create table nl.stock_bins (
  item_no       text not null references nl.items (item_no) on delete cascade,
  location_code text not null references nl.locations (code),
  zone          text not null default '',
  aisle         text not null default '',
  shelf         text not null default '',
  bin           text not null default '',
  quantity      int not null default 0 check (quantity >= 0),
  -- The last cycle count that looked at this bin, posted or not.
  counted_on    date,
  updated_at    timestamptz not null default nl.now_ms(),
  primary key (item_no, location_code)
);

comment on table nl.stock_bins is
  'Where a part sits, per location. The sum over a part equals nl.stock.on_hand (see nl.warehouse_drift).';

-- A pick list walks a location in bin order; a cycle count takes one zone.
create index stock_bins_walk_idx on nl.stock_bins (location_code, zone, aisle, shelf, bin);
create index stock_bins_location_item_idx on nl.stock_bins (location_code, item_no);

create trigger stock_bins_touch before update on nl.stock_bins
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The ledger's starting point
-- ---------------------------------------------------------------------------

create table nl.stock_opening (
  item_no       text not null references nl.items (item_no) on delete cascade,
  location_code text not null references nl.locations (code),
  opened_on     date not null,
  quantity      int not null check (quantity >= 0),
  primary key (item_no, location_code)
);

comment on table nl.stock_opening is
  'What a part had at a location on the day the ledger starts. A missing row means zero. Written by the seed or an opening-balance load, never by the app.';

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create table nl.stock_moves (
  id            bigint generated always as identity (start with 9001) primary key,
  item_no       text not null references nl.items (item_no),
  location_code text not null references nl.locations (code),
  moved_at      timestamptz not null default now(),
  kind          text not null check (kind in ('receipt', 'shipment', 'adjustment',
                                              'transfer_out', 'transfer_in', 'count')),
  -- Signed: what it did to the quantity at this location.
  quantity      int not null check (quantity <> 0),
  -- The paper it came from: an invoice number, a purchase or production
  -- order, a transfer number, a count session. Blank when there is none.
  reference     text not null default '',
  reason        text check (reason in ('damaged', 'miscount', 'found', 'scrap', 'returned to stock')),
  -- Who did it, or null when the ERP or the nightly load did.
  actor         int references nl.users (id),
  note          text not null default '',
  -- A receipt never takes stock away and a shipment never adds it. An
  -- adjustment and a count go either way, which is the point of them.
  constraint stock_moves_sign_matches_kind check (
    case kind
      when 'receipt'      then quantity > 0
      when 'shipment'     then quantity < 0
      when 'transfer_out' then quantity < 0
      when 'transfer_in'  then quantity > 0
      else true
    end),
  -- Only the two kinds a person chooses carry a reason, and they always do.
  constraint stock_moves_reason_where_it_belongs check (
    (kind in ('adjustment', 'count')) = (reason is not null))
);

comment on table nl.stock_moves is
  'Append-only stock ledger. Nobody updates or deletes a row: a mistake is corrected by another move.';

-- "The last N moves for this part": one index range, newest first.
create index stock_moves_item_idx on nl.stock_moves (item_no, moved_at desc, id desc);
-- "Moves at this location today": the same shape, by building.
create index stock_moves_location_idx on nl.stock_moves (location_code, moved_at desc, id desc);
-- "What did invoice SI700123 take off the shelf?"
create index stock_moves_reference_idx on nl.stock_moves (reference) where reference <> '';
create index stock_moves_actor_idx on nl.stock_moves (actor);

-- ---------------------------------------------------------------------------
-- Cycle counts
-- ---------------------------------------------------------------------------

create table nl.count_sessions (
  id            bigint generated always as identity (start with 3001) primary key,
  session_no    text not null unique,
  location_code text not null references nl.locations (code),
  zone          text not null,
  due_on        date not null,
  counted_on    date,
  counted_by    int references nl.users (id),
  status        text not null default 'open' check (status in ('open', 'posted', 'cancelled')),
  posted_at     timestamptz,
  posted_by     int references nl.users (id),
  note          text not null default '',
  updated_at    timestamptz not null default nl.now_ms(),
  constraint count_sessions_posted_has_a_name
    check (status <> 'posted' or (posted_by is not null and posted_at is not null))
);

comment on table nl.count_sessions is
  'One cycle count of one zone. Posting it turns each variance into a count move and moves the stock by exactly that variance.';

create index count_sessions_due_idx on nl.count_sessions (status, due_on);
create index count_sessions_location_idx on nl.count_sessions (location_code, zone);
create index count_sessions_counted_by_idx on nl.count_sessions (counted_by);
create index count_sessions_posted_by_idx on nl.count_sessions (posted_by);

create trigger count_sessions_touch before update on nl.count_sessions
  for each row execute function nl.touch_updated_at();

create table nl.count_lines (
  session_id   bigint not null references nl.count_sessions (id) on delete cascade,
  line_no      int not null check (line_no > 0),
  item_no      text not null references nl.items (item_no),
  bin          text not null default '',
  -- What the system said when the sheet was printed.
  expected_qty int not null check (expected_qty >= 0),
  -- What the person found. Null until they have been to the bin.
  counted_qty  int check (counted_qty >= 0),
  -- Stored rather than derived in a view: it is read far more often than it
  -- is written, and a generated column cannot drift from its inputs.
  variance     int generated always as (counted_qty - expected_qty) stored,
  reason       text check (reason in ('damaged', 'miscount', 'found', 'scrap', 'returned to stock')),
  note         text not null default '',
  primary key (session_id, line_no),
  -- A part appears once on a count sheet.
  unique (session_id, item_no)
);

create index count_lines_item_idx on nl.count_lines (item_no);

-- ---------------------------------------------------------------------------
-- Shipments: picked and packed, not yet collected
-- ---------------------------------------------------------------------------

create table nl.shipments (
  shipment_no   text primary key,
  customer_no   text not null references nl.customers (customer_no),
  location_code text not null references nl.locations (code),
  carrier       text not null check (carrier in ('LTL', 'parcel', 'customer pickup', 'our truck')),
  status        text not null check (status in ('picking', 'packed', 'awaiting carrier', 'shipped')),
  -- The earliest promised ship date on its lines: the pick queue's order.
  promised_on   date,
  packed_by     int references nl.users (id),
  packed_at     timestamptz,
  shipped_at    timestamptz,
  tracking      text not null default '',
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default nl.now_ms(),
  -- Anything past picking was packed by somebody, at a time.
  constraint shipments_packed_has_a_name
    check (status = 'picking' or (packed_by is not null and packed_at is not null)),
  constraint shipments_shipped_has_a_time
    check (status <> 'shipped' or shipped_at is not null)
);

comment on table nl.shipments is
  'A pick, pack and hand-over in progress: picking -> packed -> awaiting carrier -> shipped. Shipping writes one shipment move per line.';

create index shipments_queue_idx on nl.shipments (status, promised_on, shipment_no);
create index shipments_customer_idx on nl.shipments (customer_no);
create index shipments_shipped_idx on nl.shipments (shipped_at desc);
create index shipments_packed_by_idx on nl.shipments (packed_by);

create trigger shipments_touch before update on nl.shipments
  for each row execute function nl.touch_updated_at();

-- A pick line. document_no and order_line_no name the open order line it
-- came from when there is one, but there is no foreign key on purpose: the
-- daily ERP export replaces nl.open_order_lines wholesale (migration 0010),
-- and a shipped line disappears from it while the shipment stays here.
create table nl.shipment_lines (
  shipment_no   text not null references nl.shipments (shipment_no) on delete cascade,
  line_no       int not null check (line_no > 0),
  document_no   text not null default '',
  order_line_no int,
  item_no       text not null references nl.items (item_no),
  quantity      int not null check (quantity > 0),
  bin           text not null default '',
  primary key (shipment_no, line_no)
);

create index shipment_lines_item_idx on nl.shipment_lines (item_no);
create index shipment_lines_order_idx on nl.shipment_lines (document_no, order_line_no);

-- ---------------------------------------------------------------------------
-- Transfers between our own locations
-- ---------------------------------------------------------------------------

create table nl.transfers (
  transfer_no   text primary key,
  from_location text not null references nl.locations (code),
  to_location   text not null references nl.locations (code),
  status        text not null check (status in ('in transit', 'received', 'cancelled')),
  sent_on       date not null,
  expected_on   date not null,
  received_on   date,
  sent_by       int references nl.users (id),
  received_by   int references nl.users (id),
  note          text not null default '',
  updated_at    timestamptz not null default nl.now_ms(),
  constraint transfers_two_places check (from_location <> to_location),
  constraint transfers_received_has_a_name
    check (status <> 'received' or (received_on is not null and received_by is not null))
);

comment on table nl.transfers is
  'Stock moving between our own locations. In transit stock still counts at the origin: the moves are written when the transfer is received.';

create index transfers_status_idx on nl.transfers (status, expected_on);
create index transfers_from_idx on nl.transfers (from_location);
create index transfers_to_idx on nl.transfers (to_location);
create index transfers_sent_by_idx on nl.transfers (sent_by);
create index transfers_received_by_idx on nl.transfers (received_by);

create trigger transfers_touch before update on nl.transfers
  for each row execute function nl.touch_updated_at();

create table nl.transfer_lines (
  transfer_no text not null references nl.transfers (transfer_no) on delete cascade,
  line_no     int not null check (line_no > 0),
  item_no     text not null references nl.items (item_no),
  quantity    int not null check (quantity > 0),
  from_bin    text not null default '',
  to_bin      text not null default '',
  primary key (transfer_no, line_no)
);

create index transfer_lines_item_idx on nl.transfer_lines (item_no);

-- ---------------------------------------------------------------------------
-- The drift check
-- ---------------------------------------------------------------------------

-- Every part where the item master, the shelves and the ledger disagree.
-- Always empty; the tests say so and the nightly job can report it.
--
--   scope 'item'      nl.stock.on_hand against the sum of the bins and the
--                     sum of the ledger, for the whole part.
--   scope 'location'  the bin quantity at one location against the ledger at
--                     that location. master_on_hand is null: the item master
--                     does not know about locations.
create function nl.warehouse_drift()
returns table (
  scope          text,
  item_no        text,
  location_code  text,
  master_on_hand bigint,
  bin_total      bigint,
  ledger_total   bigint
)
language sql stable
set search_path = ''
as $$
  with bins as (
    select b.item_no, b.location_code, b.quantity::bigint as quantity
    from nl.stock_bins b
  ),
  ledger as (
    -- Opening balance plus every move, per part and location. A part and
    -- location can appear in one and not the other, so this is a full join.
    select coalesce(o.item_no, m.item_no)             as item_no,
           coalesce(o.location_code, m.location_code) as location_code,
           coalesce(o.quantity, 0) + coalesce(m.moved, 0) as total
    from (select item_no, location_code, quantity from nl.stock_opening) o
    full join (
      select item_no, location_code, sum(quantity)::bigint as moved
      from nl.stock_moves
      group by item_no, location_code
    ) m on m.item_no = o.item_no and m.location_code = o.location_code
  ),
  per_item as (
    select
      i.item_no,
      coalesce(s.on_hand, 0)::bigint as master_on_hand,
      coalesce((select sum(b.quantity) from bins b where b.item_no = i.item_no), 0)::bigint as bin_total,
      coalesce((select sum(l.total) from ledger l where l.item_no = i.item_no), 0)::bigint as ledger_total
    from nl.items i
    left join nl.stock s on s.item_no = i.item_no
  ),
  per_location as (
    select
      coalesce(b.item_no, l.item_no)             as item_no,
      coalesce(b.location_code, l.location_code) as location_code,
      coalesce(b.quantity, 0)::bigint            as bin_total,
      coalesce(l.total, 0)::bigint               as ledger_total
    from bins b
    full join ledger l on l.item_no = b.item_no and l.location_code = b.location_code
  )
  select 'item', p.item_no, '', p.master_on_hand, p.bin_total, p.ledger_total
  from per_item p
  where p.master_on_hand <> p.bin_total or p.master_on_hand <> p.ledger_total
  union all
  select 'location', q.item_no, q.location_code, null, q.bin_total, q.ledger_total
  from per_location q
  where q.bin_total <> q.ledger_total
$$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- One row per part: what the item master says, where it is, how much of it
-- open orders have already claimed (nl.open_line_allocation, migration
-- 0010), and what is left.
create view nl.stock_position with (security_invoker = true) as
select
  i.item_no,
  coalesce(s.on_hand, 0)             as on_hand,
  coalesce(s.on_production_order, 0) as on_production_order,
  coalesce(s.on_purchase_order, 0)   as on_purchase_order,
  -- {"MAIN": 120, "EAST": 30}
  coalesce(b.by_location, '{}'::jsonb) as by_location,
  coalesce(b.location_count, 0)::int   as location_count,
  coalesce(a.allocated, 0)::int        as allocated,
  coalesce(s.on_hand, 0) - coalesce(a.allocated, 0) as available
from nl.items i
left join nl.stock s on s.item_no = i.item_no
left join (
  select item_no, jsonb_object_agg(location_code, quantity) as by_location, count(*) as location_count
  from nl.stock_bins
  group by item_no
) b on b.item_no = i.item_no
left join (
  select item_no, sum(allocated) as allocated
  from nl.open_line_allocation
  group by item_no
) a on a.item_no = i.item_no;

-- The six figures the warehouse page opens with, always six rows even when
-- a bucket is empty. Value is inventory value at standard cost: one rule for
-- all six, which is what a warehouse measures itself in.
create view nl.warehouse_today with (security_invoker = true) as
with params as materialized (
  select nl.today() as today
),
shipment_buckets as (
  select
    case s.status
      when 'picking' then 'to_pick'
      when 'packed' then 'packed'
      when 'awaiting carrier' then 'awaiting_carrier'
      else 'shipped_today'
    end as bucket,
    count(distinct s.shipment_no)                    as documents,
    count(l.line_no)                                 as lines,
    coalesce(sum(l.quantity), 0)                     as quantity,
    coalesce(sum(l.quantity * i.unit_cost), 0)       as value
  from nl.shipments s
  cross join params p
  left join nl.shipment_lines l on l.shipment_no = s.shipment_no
  left join nl.items i on i.item_no = l.item_no
  where s.status in ('picking', 'packed', 'awaiting carrier')
     or (s.status = 'shipped' and (s.shipped_at at time zone 'America/Chicago')::date = p.today)
  group by 1
),
transit as (
  select
    'in_transit' as bucket,
    count(distinct t.transfer_no)              as documents,
    count(l.line_no)                           as lines,
    coalesce(sum(l.quantity), 0)               as quantity,
    coalesce(sum(l.quantity * i.unit_cost), 0) as value
  from nl.transfers t
  left join nl.transfer_lines l on l.transfer_no = t.transfer_no
  left join nl.items i on i.item_no = l.item_no
  where t.status = 'in transit'
),
counts_due as (
  select
    'counts_due' as bucket,
    count(distinct c.id)                           as documents,
    count(l.line_no)                               as lines,
    coalesce(sum(l.expected_qty), 0)               as quantity,
    coalesce(sum(l.expected_qty * i.unit_cost), 0) as value
  from nl.count_sessions c
  cross join params p
  left join nl.count_lines l on l.session_id = c.id
  left join nl.items i on i.item_no = l.item_no
  where c.status = 'open' and c.due_on <= p.today
),
gathered as (
  select * from shipment_buckets
  union all select * from transit
  union all select * from counts_due
)
select
  b.sort,
  b.bucket,
  coalesce(g.documents, 0)::bigint as documents,
  coalesce(g.lines, 0)::bigint     as lines,
  coalesce(g.quantity, 0)::bigint  as quantity,
  round(coalesce(g.value, 0), 2)   as value
from (values (1, 'to_pick'), (2, 'packed'), (3, 'awaiting_carrier'),
             (4, 'shipped_today'), (5, 'in_transit'), (6, 'counts_due')) as b(sort, bucket)
left join gathered g on g.bucket = b.bucket;

-- The ledger with the names filled in, for the last month. The page adds its
-- own order and limit; the index on (item_no, moved_at desc) and the one on
-- (location_code, moved_at desc) are what make either cheap.
create view nl.stock_moves_recent with (security_invoker = true) as
select
  m.id,
  m.item_no,
  i.description,
  m.location_code,
  loc.name as location_name,
  m.moved_at,
  (m.moved_at at time zone 'America/Chicago')::date as moved_on,
  m.kind,
  m.quantity,
  m.reference,
  m.reason,
  m.actor,
  u.full_name as actor_name,
  m.note
from nl.stock_moves m
join nl.items i on i.item_no = m.item_no
join nl.locations loc on loc.code = m.location_code
left join nl.users u on u.id = m.actor
where m.moved_at >= ((select nl.today()) - 30)::timestamptz;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Correct one bin by hand, with a reason. Writes the move, moves the bin and
-- moves nl.stock.on_hand, all in this transaction, so the three never come
-- apart. p_expected_updated_at is optional: pass the bin row's version to be
-- told (409) when somebody else touched the bin since the page was loaded.
create function nl.post_stock_adjustment(
  p_item_no             text,
  p_location_code       text,
  p_quantity            int,
  p_reason              text,
  p_request_id          text,
  p_note                text default '',
  p_expected_updated_at timestamptz default null,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_bin     nl.stock_bins;
  v_loc     nl.locations;
  v_note    text := trim(coalesce(p_note, ''));
  v_before  int;
  v_after   int;
  v_on_hand int;
  v_move_id bigint;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'post_stock_adjustment');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can correct stock.' using errcode = 'NL403';
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'An adjustment moves the count up or down, so it cannot be zero.' using errcode = 'NL422';
  end if;
  if abs(p_quantity) > 100000 then
    raise exception 'That is a bigger correction than any bin holds. Check the number.' using errcode = 'NL422';
  end if;
  if p_reason is null or p_reason not in ('damaged', 'miscount', 'found', 'scrap', 'returned to stock') then
    raise exception 'An adjustment needs a reason: damaged, miscount, found, scrap or returned to stock.'
      using errcode = 'NL422';
  end if;
  if length(v_note) > 500 then
    raise exception 'Keep the note under 500 characters.' using errcode = 'NL422';
  end if;

  select * into v_loc from nl.locations where code = p_location_code;
  if not found then
    raise exception 'Location % does not exist.', coalesce(p_location_code, 'empty') using errcode = 'NL404';
  end if;
  if not v_loc.active then
    raise exception 'Location % is closed, so nothing can be booked to it.', p_location_code using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.items where item_no = p_item_no) then
    raise exception 'Part % does not exist.', coalesce(p_item_no, 'empty') using errcode = 'NL404';
  end if;

  -- Lock the bin so two corrections on it cannot interleave.
  select * into v_bin from nl.stock_bins
   where item_no = p_item_no and location_code = p_location_code
     for update;
  if found then
    if p_expected_updated_at is not null and v_bin.updated_at is distinct from p_expected_updated_at then
      raise exception 'That bin changed since the page was loaded. Reload and try again.' using errcode = 'NL409';
    end if;
    v_before := v_bin.quantity;
  else
    if p_quantity < 0 then
      raise exception 'Part % is not stocked at %, so there is nothing to take off it.', p_item_no, p_location_code
        using errcode = 'NL422';
    end if;
    v_before := 0;
  end if;

  v_after := v_before + p_quantity;
  if v_after < 0 then
    raise exception 'That would leave % pieces of % at %. The bin holds %.',
      v_after, p_item_no, p_location_code, v_before using errcode = 'NL422';
  end if;

  insert into nl.stock_moves (item_no, location_code, kind, quantity, reason, actor, note)
  values (p_item_no, p_location_code, 'adjustment', p_quantity, p_reason, v_actor.id, v_note)
  returning id into v_move_id;

  insert into nl.stock_bins (item_no, location_code, quantity)
  values (p_item_no, p_location_code, v_after)
  on conflict (item_no, location_code) do update set quantity = v_after;

  update nl.stock
     set on_hand = on_hand + p_quantity,
         as_of = nl.today()
   where item_no = p_item_no
  returning on_hand into v_on_hand;
  if not found then
    raise exception 'Part % has no stock record in the item master.', p_item_no using errcode = 'NL404';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'post_stock_adjustment', 'stock_bin',
          p_item_no || '@' || p_location_code, p_request_id,
          jsonb_build_object('item_no', p_item_no, 'location_code', p_location_code,
                             'quantity', p_quantity, 'reason', p_reason,
                             'bin_before', v_before, 'bin_after', v_after,
                             'on_hand', v_on_hand, 'move_id', v_move_id, 'note', v_note));

  v_result := jsonb_build_object(
    'move_id', v_move_id,
    'item_no', p_item_no,
    'location_code', p_location_code,
    'quantity', p_quantity,
    'bin_quantity', v_after,
    'on_hand', v_on_hand,
    'updated_at', (select updated_at from nl.stock_bins
                    where item_no = p_item_no and location_code = p_location_code));
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Post a cycle count: every counted line with a variance becomes one count
-- move, and the bin and the item master move by exactly that variance. Lines
-- that came out right still stamp the bin as counted today.
create function nl.post_count_session(
  p_session_id          bigint,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_session    nl.count_sessions;
  v_line       record;
  v_bin_qty    int;
  v_after      int;
  v_reason     text;
  v_counted    int := 0;
  v_moves      int := 0;
  v_net        int := 0;
  v_counted_on date;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'post_count_session');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can post a count.' using errcode = 'NL403';
  end if;

  select * into v_session from nl.count_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Count session % does not exist.', coalesce(p_session_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Count % is already %.', v_session.session_no, v_session.status using errcode = 'NL422';
  end if;
  if v_session.updated_at is distinct from p_expected_updated_at then
    raise exception 'Count % changed since the page was loaded. Reload and post it again.', v_session.session_no
      using errcode = 'NL409';
  end if;

  select count(*) into v_counted from nl.count_lines
   where session_id = p_session_id and counted_qty is not null;
  if v_counted = 0 then
    raise exception 'Nothing on count % has been counted yet.', v_session.session_no using errcode = 'NL422';
  end if;

  v_counted_on := coalesce(v_session.counted_on, nl.today());

  -- One line at a time, in sheet order, so a refusal names the part that
  -- caused it and the whole posting rolls back together.
  for v_line in
    select l.line_no, l.item_no, l.variance, l.reason, l.note
    from nl.count_lines l
    where l.session_id = p_session_id and l.counted_qty is not null
    order by l.line_no
  loop
    select quantity into v_bin_qty from nl.stock_bins
     where item_no = v_line.item_no and location_code = v_session.location_code
       for update;
    if not found then
      if v_line.variance < 0 then
        raise exception 'Part % is not stocked at %, so it cannot come up short.',
          v_line.item_no, v_session.location_code using errcode = 'NL422';
      end if;
      v_bin_qty := 0;
    end if;

    if v_line.variance = 0 then
      -- Counted and correct: only the "last counted" stamp changes.
      update nl.stock_bins set counted_on = v_counted_on
       where item_no = v_line.item_no and location_code = v_session.location_code;
      continue;
    end if;

    v_after := v_bin_qty + v_line.variance;
    if v_after < 0 then
      raise exception 'Counting % at % would leave % pieces. The bin holds %.',
        v_line.item_no, v_session.location_code, v_after, v_bin_qty using errcode = 'NL422';
    end if;

    -- More than the sheet said is stock somebody found; less is a miscount,
    -- unless the counter said what actually happened to it.
    v_reason := coalesce(v_line.reason, case when v_line.variance > 0 then 'found' else 'miscount' end);

    insert into nl.stock_moves (item_no, location_code, kind, quantity, reference, reason, actor, note)
    values (v_line.item_no, v_session.location_code, 'count', v_line.variance,
            v_session.session_no, v_reason, v_actor.id, v_line.note);

    insert into nl.stock_bins (item_no, location_code, quantity, counted_on)
    values (v_line.item_no, v_session.location_code, v_after, v_counted_on)
    on conflict (item_no, location_code) do update
      set quantity = v_after, counted_on = v_counted_on;

    update nl.stock
       set on_hand = on_hand + v_line.variance,
           as_of = nl.today()
     where item_no = v_line.item_no;
    if not found then
      raise exception 'Part % has no stock record in the item master.', v_line.item_no using errcode = 'NL404';
    end if;

    v_moves := v_moves + 1;
    v_net := v_net + v_line.variance;
  end loop;

  update nl.count_sessions
     set status = 'posted',
         posted_at = now(),
         posted_by = v_actor.id,
         counted_on = v_counted_on,
         counted_by = coalesce(counted_by, v_actor.id)
   where id = p_session_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Count % changed while it was being posted. Reload and try again.', v_session.session_no
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'post_count_session', 'count_session', p_session_id::text, p_request_id,
          jsonb_build_object('session_no', v_session.session_no,
                             'location_code', v_session.location_code,
                             'zone', v_session.zone,
                             'lines_counted', v_counted,
                             'moves', v_moves,
                             'net_change', v_net));

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'session_no', v_session.session_no,
    'lines_counted', v_counted,
    'moves', v_moves,
    'net_change', v_net,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Move a shipment one step along: picking -> packed -> awaiting carrier ->
-- shipped. p_to_status is the step the person clicked; anything but the next
-- one is refused, so a stale page cannot skip packing. Shipping writes one
-- shipment move per line and takes the pieces out of the bin they were
-- picked from.
create function nl.advance_shipment(
  p_shipment_no         text,
  p_to_status           text,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_tracking            text default null,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_ship       nl.shipments;
  v_next       text;
  v_line       record;
  v_bin_qty    int;
  v_moves      int := 0;
  v_pieces     int := 0;
  v_tracking   text := trim(coalesce(p_tracking, ''));
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'advance_shipment');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can move a shipment along.' using errcode = 'NL403';
  end if;

  if p_to_status is null or p_to_status not in ('picking', 'packed', 'awaiting carrier', 'shipped') then
    raise exception 'A shipment is picking, packed, awaiting carrier or shipped, not %.',
      coalesce(p_to_status, 'empty') using errcode = 'NL422';
  end if;
  if length(v_tracking) > 60 then
    raise exception 'Keep the tracking number under 60 characters.' using errcode = 'NL422';
  end if;

  select * into v_ship from nl.shipments where shipment_no = p_shipment_no for update;
  if not found then
    raise exception 'Shipment % does not exist.', coalesce(p_shipment_no, 'empty') using errcode = 'NL404';
  end if;
  if v_ship.updated_at is distinct from p_expected_updated_at then
    raise exception 'Shipment % changed since the page was loaded. Reload and try again.', p_shipment_no
      using errcode = 'NL409';
  end if;
  if v_ship.status = 'shipped' then
    raise exception 'Shipment % has already gone.', p_shipment_no using errcode = 'NL422';
  end if;

  v_next := case v_ship.status
              when 'picking' then 'packed'
              when 'packed' then 'awaiting carrier'
              else 'shipped'
            end;
  if p_to_status <> v_next then
    raise exception 'Shipment % is %, so the next step is %, not %.',
      p_shipment_no, v_ship.status, v_next, p_to_status using errcode = 'NL422';
  end if;

  if v_next = 'shipped' then
    if not exists (select 1 from nl.shipment_lines where shipment_no = p_shipment_no) then
      raise exception 'Shipment % has no lines, so there is nothing to ship.', p_shipment_no using errcode = 'NL422';
    end if;

    for v_line in
      select l.line_no, l.item_no, l.quantity
      from nl.shipment_lines l
      where l.shipment_no = p_shipment_no
      order by l.line_no
    loop
      select quantity into v_bin_qty from nl.stock_bins
       where item_no = v_line.item_no and location_code = v_ship.location_code
         for update;
      if not found or v_bin_qty < v_line.quantity then
        raise exception '% at % holds % pieces; line % needs %.',
          v_line.item_no, v_ship.location_code, coalesce(v_bin_qty, 0), v_line.line_no, v_line.quantity
          using errcode = 'NL422';
      end if;

      insert into nl.stock_moves (item_no, location_code, kind, quantity, reference, actor)
      values (v_line.item_no, v_ship.location_code, 'shipment', -v_line.quantity, p_shipment_no, v_actor.id);

      update nl.stock_bins set quantity = v_bin_qty - v_line.quantity
       where item_no = v_line.item_no and location_code = v_ship.location_code;

      update nl.stock
         set on_hand = on_hand - v_line.quantity,
             as_of = nl.today()
       where item_no = v_line.item_no;
      if not found then
        raise exception 'Part % has no stock record in the item master.', v_line.item_no using errcode = 'NL404';
      end if;

      v_moves := v_moves + 1;
      v_pieces := v_pieces + v_line.quantity;
    end loop;
  end if;

  update nl.shipments
     set status = v_next,
         packed_by = case when v_next = 'packed' then v_actor.id else packed_by end,
         packed_at = case when v_next = 'packed' then now() else packed_at end,
         shipped_at = case when v_next = 'shipped' then now() else shipped_at end,
         tracking = case when v_tracking = '' then tracking else v_tracking end
   where shipment_no = p_shipment_no
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Shipment % changed while it was being moved along. Reload and try again.', p_shipment_no
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'advance_shipment', 'shipment', p_shipment_no, p_request_id,
          jsonb_build_object('from_status', v_ship.status, 'to_status', v_next,
                             'location_code', v_ship.location_code,
                             'moves', v_moves, 'pieces', v_pieces,
                             'tracking', nullif(v_tracking, '')));

  v_result := jsonb_build_object(
    'shipment_no', p_shipment_no,
    'status', v_next,
    'moves', v_moves,
    'pieces', v_pieces,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Book a transfer in at the destination. Both halves are written here: the
-- transfer_out at the origin and the transfer_in at the destination, in one
-- transaction. nl.stock.on_hand does not move, because the stock never left
-- the company, only the building.
create function nl.receive_transfer(
  p_transfer_no         text,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_transfer   nl.transfers;
  v_line       record;
  v_from_qty   int;
  v_to_qty     int;
  v_zone       text;
  v_lines      int := 0;
  v_pieces     int := 0;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'receive_transfer');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can receive a transfer.' using errcode = 'NL403';
  end if;

  select * into v_transfer from nl.transfers where transfer_no = p_transfer_no for update;
  if not found then
    raise exception 'Transfer % does not exist.', coalesce(p_transfer_no, 'empty') using errcode = 'NL404';
  end if;
  if v_transfer.updated_at is distinct from p_expected_updated_at then
    raise exception 'Transfer % changed since the page was loaded. Reload and try again.', p_transfer_no
      using errcode = 'NL409';
  end if;
  if v_transfer.status <> 'in transit' then
    raise exception 'Transfer % is %, so it cannot be received.', p_transfer_no, v_transfer.status
      using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.transfer_lines where transfer_no = p_transfer_no) then
    raise exception 'Transfer % has no lines.', p_transfer_no using errcode = 'NL422';
  end if;

  for v_line in
    select l.line_no, l.item_no, l.quantity, l.to_bin
    from nl.transfer_lines l
    where l.transfer_no = p_transfer_no
    order by l.line_no
  loop
    select quantity, zone into v_from_qty, v_zone from nl.stock_bins
     where item_no = v_line.item_no and location_code = v_transfer.from_location
       for update;
    if not found or v_from_qty < v_line.quantity then
      raise exception '% at % holds % pieces; line % moves %.',
        v_line.item_no, v_transfer.from_location, coalesce(v_from_qty, 0), v_line.line_no, v_line.quantity
        using errcode = 'NL422';
    end if;

    select quantity into v_to_qty from nl.stock_bins
     where item_no = v_line.item_no and location_code = v_transfer.to_location
       for update;
    v_to_qty := coalesce(v_to_qty, 0);

    insert into nl.stock_moves (item_no, location_code, kind, quantity, reference, actor)
    values (v_line.item_no, v_transfer.from_location, 'transfer_out', -v_line.quantity, p_transfer_no, v_actor.id),
           (v_line.item_no, v_transfer.to_location, 'transfer_in', v_line.quantity, p_transfer_no, v_actor.id);

    update nl.stock_bins set quantity = v_from_qty - v_line.quantity
     where item_no = v_line.item_no and location_code = v_transfer.from_location;

    -- The destination may never have stocked this part; then the transfer
    -- line's to_bin is where it goes, in the same zone it came from.
    insert into nl.stock_bins (item_no, location_code, zone, aisle, shelf, bin, quantity)
    values (v_line.item_no, v_transfer.to_location, coalesce(v_zone, ''),
            split_part(v_line.to_bin, '-', 1),
            case when v_line.to_bin = '' then ''
                 else split_part(v_line.to_bin, '-', 1) || '-' || split_part(v_line.to_bin, '-', 2) end,
            v_line.to_bin, v_to_qty + v_line.quantity)
    on conflict (item_no, location_code) do update set quantity = v_to_qty + v_line.quantity;

    v_lines := v_lines + 1;
    v_pieces := v_pieces + v_line.quantity;
  end loop;

  update nl.transfers
     set status = 'received',
         received_on = nl.today(),
         received_by = v_actor.id
   where transfer_no = p_transfer_no
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Transfer % changed while it was being received. Reload and try again.', p_transfer_no
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'receive_transfer', 'transfer', p_transfer_no, p_request_id,
          jsonb_build_object('from_location', v_transfer.from_location,
                             'to_location', v_transfer.to_location,
                             'lines', v_lines, 'pieces', v_pieces));

  v_result := jsonb_build_object(
    'transfer_no', p_transfer_no,
    'status', 'received',
    'lines', v_lines,
    'pieces', v_pieces,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.locations enable row level security;
alter table nl.stock_bins enable row level security;
alter table nl.stock_opening enable row level security;
alter table nl.stock_moves enable row level security;
alter table nl.count_sessions enable row level security;
alter table nl.count_lines enable row level security;
alter table nl.shipments enable row level security;
alter table nl.shipment_lines enable row level security;
alter table nl.transfers enable row level security;
alter table nl.transfer_lines enable row level security;

-- Everyone signed in can look at all of it. Account managers need to answer
-- "is it on the shelf" without being able to change anything.
create policy locations_read on nl.locations for select to nl_app, nl_readonly using (true);
create policy stock_bins_read on nl.stock_bins for select to nl_app, nl_readonly using (true);
create policy stock_opening_read on nl.stock_opening for select to nl_app, nl_readonly using (true);
create policy stock_moves_read on nl.stock_moves for select to nl_app using (true);
create policy count_sessions_read on nl.count_sessions for select to nl_app using (true);
create policy count_lines_read on nl.count_lines for select to nl_app using (true);
create policy shipments_read on nl.shipments for select to nl_app using (true);
create policy shipment_lines_read on nl.shipment_lines for select to nl_app using (true);
create policy transfers_read on nl.transfers for select to nl_app using (true);
create policy transfer_lines_read on nl.transfer_lines for select to nl_app using (true);

-- Only the people who run the warehouse write. The functions above check the
-- same rule first and say so in plain English; these policies are the
-- backstop, and they are what stops a write that goes around the functions.
create policy stock_bins_write on nl.stock_bins for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy stock_bins_change on nl.stock_bins for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));

-- The ledger is append-only: there is an insert policy and no other, and no
-- update or delete grant below, so a posted move can never be edited away.
create policy stock_moves_write on nl.stock_moves for insert to nl_app
  with check ((select nl.can_run_imports())
              and (actor is null or actor = (select nl.current_user_id())));

create policy count_sessions_change on nl.count_sessions for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));
create policy shipments_change on nl.shipments for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));
create policy transfers_change on nl.transfers for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));

-- nl.stock keeps the meaning and the columns it had in 0002. What it did not
-- have was any way for the app to change it; the warehouse writes need one,
-- and only on the two columns they touch.
create policy stock_warehouse_update on nl.stock for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));

grant select on nl.locations, nl.stock_bins, nl.stock_opening, nl.stock_moves,
  nl.count_sessions, nl.count_lines, nl.shipments, nl.shipment_lines,
  nl.transfers, nl.transfer_lines to nl_app;
grant insert (item_no, location_code, zone, aisle, shelf, bin, quantity, counted_on)
  on nl.stock_bins to nl_app;
grant insert (item_no, location_code, kind, quantity, reference, reason, actor, note)
  on nl.stock_moves to nl_app;
grant update (quantity, counted_on, updated_at) on nl.stock_bins to nl_app;
grant update (status, counted_on, counted_by, posted_at, posted_by, updated_at)
  on nl.count_sessions to nl_app;
grant update (status, packed_by, packed_at, shipped_at, tracking, updated_at) on nl.shipments to nl_app;
grant update (status, received_on, received_by, updated_at) on nl.transfers to nl_app;
grant update (on_hand, as_of) on nl.stock to nl_app;

grant select on nl.stock_position, nl.warehouse_today, nl.stock_moves_recent to nl_app;

-- The read-only role the assistant's SQL tool uses gets the business facts:
-- where parts are and how many. It does not get the ledger, the counts, the
-- shipments or the transfers, because every one of those names a person, and
-- so it does not get nl.warehouse_today or nl.warehouse_drift either, both
-- of which read those tables as the caller.
grant select on nl.locations, nl.stock_bins, nl.stock_opening to nl_readonly;
grant select on nl.stock_position to nl_readonly;

grant execute on function
  nl.warehouse_drift(),
  nl.post_stock_adjustment(text, text, int, text, text, text, timestamptz, text),
  nl.post_count_session(bigint, timestamptz, text, text),
  nl.advance_shipment(text, text, timestamptz, text, text, text),
  nl.receive_transfer(text, timestamptz, text, text)
to nl_app;
