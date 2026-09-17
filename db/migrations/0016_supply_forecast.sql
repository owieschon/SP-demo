-- 0016 The late-order forecast: which customer orders will ship late, by how
-- many days, because of which incoming supply order, and who to call.
--
-- 0010 brought in the ERP's open SALES lines every morning and handed on-hand
-- stock to the oldest ship date first. That answers "is there stock for it
-- today", not "when will there be". This migration adds the other side of the
-- book, the same way: two more ERP reports, staged and applied through the
-- same snapshot workflow.
--
--   open_sales_lines        what customers are waiting for   (0010)
--   open_purchase_lines     what vendors owe us              (here)
--   open_production_orders  what the shop floor owes us      (here)
--
-- With both sides in one place the projection becomes arithmetic:
-- time-phased netting per part. Supply events (on hand today, then each
-- purchase line and production order on its due date) are given to demand
-- events (open sales lines in ship-date order) in order, and the date at
-- which cumulative supply first covers cumulative demand through a line is
-- that line's availability date. Details and query plans in
-- docs/supply-forecast.md.
--
-- What this file adds:
--   * lead-time helpers that read the ERP's date formulas ('3W', '10D')
--   * live tables and snapshot tables for the two supply reports
--   * nl.stage_export and nl.decide_export generalized over the three kinds
--   * nl.supply_changes: day over day for supply, per kind
--   * nl.open_line_projection: the projection, one row per open sales line
--   * four aggregates: by vendor, by work center, by customer, promise moves
--   * nl.available_to_promise: can we ship this quantity by this date
--   * the sample export generators the demo downloads and the seed applies
--   * the 'order_line_projected_late' automation trigger

-- ---------------------------------------------------------------------------
-- Constants and lead times
-- ---------------------------------------------------------------------------

-- A supply order whose due date has already passed is late but still coming.
-- The projection treats it as arriving this many days from today, and flags
-- it, rather than pretending it landed on its due date.
create function nl.overdue_supply_days() returns int
language sql immutable
set search_path = ''
as $$ select 3 $$;

/*
 * The ERP writes lead times as date formulas on the item and vendor cards:
 * '3W' is three weeks, '10D' ten days, '2M' two months, '1Y' a year. A plain
 * number means days. Anything else (a blank card, free text) reads as null,
 * so the caller can fall back to something else.
 */
create function nl.lead_time_days(p_formula text) returns int
language sql immutable
set search_path = ''
as $$
  select case
    when p_formula is null then null
    when btrim(p_formula) ~ '^[0-9]+$' then btrim(p_formula)::int
    when btrim(upper(p_formula)) ~ '^[0-9]+ *D$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int
    when btrim(upper(p_formula)) ~ '^[0-9]+ *W$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int * 7
    when btrim(upper(p_formula)) ~ '^[0-9]+ *M$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int * 30
    when btrim(upper(p_formula)) ~ '^[0-9]+ *Y$' then (regexp_replace(p_formula, '[^0-9]', '', 'g'))::int * 365
    else null
  end
$$;

-- What to assume when neither the item nor its vendor names a lead time.
-- Bought parts take longest, an assembly is quickest.
create function nl.default_lead_days(p_replenishment text) returns int
language sql immutable
set search_path = ''
as $$
  select case p_replenishment when 'Purchase' then 28 when 'Assembly' then 7 else 14 end
$$;

-- How long it would take to get one part if it were ordered or scheduled
-- today: the item card's lead time, then its vendor's, then the default.
create function nl.item_lead_days(p_item_no text) returns int
language sql stable
set search_path = ''
as $$
  select coalesce(nl.lead_time_days(i.lead_time),
                  nl.lead_time_days(v.lead_time),
                  nl.default_lead_days(i.replenishment))
  from nl.items i
  left join nl.vendors v on v.vendor_no = i.vendor_no
  where i.item_no = p_item_no
$$;

-- ---------------------------------------------------------------------------
-- Three reports instead of one
-- ---------------------------------------------------------------------------

alter table nl.export_snapshots drop constraint export_snapshots_kind_check;
alter table nl.export_snapshots add constraint export_snapshots_kind_check
  check (kind in ('open_sales_lines', 'open_purchase_lines', 'open_production_orders'));

-- Purchase order lines as the ERP exports them: one row per part still
-- outstanding on a purchase order. Keyed on the ERP's natural key.
create table nl.export_snapshot_purchase_lines (
  snapshot_id    bigint not null references nl.export_snapshots (id) on delete cascade,
  document_no    text not null,
  line_no        int not null check (line_no > 0),
  row_no         int not null,                  -- where it sat in the file (header = row 1)
  vendor_no      text not null references nl.vendors (vendor_no),
  item_no        text not null references nl.items (item_no),
  description    text not null default '',
  -- When the vendor now says it will arrive, and what they promised first.
  due_date       date not null,
  promised_date  date,
  quantity       int not null check (quantity > 0),
  location_code  text not null default '',
  primary key (snapshot_id, document_no, line_no)
);

create index export_snapshot_purchase_lines_item_idx on nl.export_snapshot_purchase_lines (item_no);
create index export_snapshot_purchase_lines_vendor_idx on nl.export_snapshot_purchase_lines (vendor_no);

-- Production orders: one row per order still owed by the shop floor.
create table nl.export_snapshot_production_orders (
  snapshot_id bigint not null references nl.export_snapshots (id) on delete cascade,
  order_no    text not null,
  row_no      int not null,
  item_no     text not null references nl.items (item_no),
  work_center text not null default '',
  status      text not null default '',         -- ERP value, verbatim: Released, Firm Planned
  due_date    date not null,
  quantity    int not null check (quantity > 0), -- remaining quantity
  primary key (snapshot_id, order_no)
);

create index export_snapshot_production_orders_item_idx on nl.export_snapshot_production_orders (item_no);

-- The live tables: what is on order from vendors and from the shop floor, as
-- of the current snapshot of each kind.
create table nl.open_purchase_lines (
  document_no      text not null,
  line_no          int not null,
  vendor_no        text not null references nl.vendors (vendor_no),
  item_no          text not null references nl.items (item_no),
  description      text not null default '',
  due_date         date not null,
  promised_date    date,
  quantity         int not null check (quantity > 0),
  location_code    text not null default '',
  -- The day this line first appeared in an applied export. An update never moves it.
  first_seen_on    date not null,
  last_snapshot_id bigint not null references nl.export_snapshots (id),
  primary key (document_no, line_no)
);

-- The projection walks a part's supply in due-date order and sums the
-- quantity, so this index is that walk, carrying what it adds up.
create index open_purchase_lines_supply_idx
  on nl.open_purchase_lines (item_no, due_date, document_no, line_no) include (quantity);
create index open_purchase_lines_vendor_idx on nl.open_purchase_lines (vendor_no);
create index open_purchase_lines_snapshot_idx on nl.open_purchase_lines (last_snapshot_id);

create table nl.open_production_orders (
  order_no         text primary key,
  item_no          text not null references nl.items (item_no),
  work_center      text not null default '',
  status           text not null default '',
  due_date         date not null,
  quantity         int not null check (quantity > 0),
  first_seen_on    date not null,
  last_snapshot_id bigint not null references nl.export_snapshots (id)
);

create index open_production_orders_supply_idx
  on nl.open_production_orders (item_no, due_date, order_no) include (quantity);
create index open_production_orders_wc_idx on nl.open_production_orders (work_center);
create index open_production_orders_snapshot_idx on nl.open_production_orders (last_snapshot_id);

-- ---------------------------------------------------------------------------
-- Staging, for any of the three kinds
-- ---------------------------------------------------------------------------

-- The app has already read the file, worked out which of the three reports
-- it is, refused it if it is none of them, and split its rows into good
-- lines and rows with problems. This stores both, works out whether a person
-- must look at it first, and never touches a live table.
--
-- p_kind decides which shape p_lines holds:
--   open_sales_lines        row_no, document_no, line_no, customer_no, item_no, description,
--                           ship_date, quantity, unit_price, line_amount, location_code
--   open_purchase_lines     row_no, document_no, line_no, vendor_no, item_no, description,
--                           due_date, promised_date, quantity, location_code
--   open_production_orders  row_no, order_no, item_no, work_center, status, due_date, quantity
--
-- p_errors is the same for every kind:
--   row_no, document_no, line_no, reasons, raw
drop function nl.stage_export(text, text, text[], jsonb, jsonb, text);

create function nl.stage_export(
  p_file_name       text,
  p_content_hash    text,
  p_ignored_columns text[],
  p_lines           jsonb,
  p_errors          jsonb,
  p_request_id      text,
  p_kind            text default 'open_sales_lines'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_existing   record;
  v_line_count int;
  v_err_count  int;
  v_live_rows  int;
  v_total_qty  bigint;
  v_total_val  numeric(14, 2);
  v_last_due   date;
  v_reasons    jsonb := '[]'::jsonb;
  v_id         bigint;
  v_status     text;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'stage_export');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();
  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can load an ERP export.' using errcode = 'NL403';
  end if;

  if p_kind is null or p_kind not in ('open_sales_lines', 'open_purchase_lines', 'open_production_orders') then
    raise exception 'Unknown report %.', coalesce(p_kind, 'empty') using errcode = 'NL422';
  end if;
  if p_file_name is null or length(trim(p_file_name)) = 0 or length(p_file_name) > 255 then
    raise exception 'A staged file needs a name of 1 to 255 characters.' using errcode = 'NL422';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'The file fingerprint must be a SHA-256 in hex.' using errcode = 'NL422';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_typeof(p_errors) is distinct from 'array' then
    raise exception 'Lines and errors must be JSON arrays.' using errcode = 'NL422';
  end if;

  -- The same data twice is recognized, not loaded twice. The app checks this
  -- before calling; this is the guard for two uploads racing each other.
  select s.id, s.staged_at, u.full_name into v_existing
  from nl.export_snapshots s
  join nl.users u on u.id = s.staged_by
  where s.kind = p_kind and s.content_hash = p_content_hash;
  if found then
    raise exception 'This data was already loaded on % by % (snapshot %).',
      to_char(v_existing.staged_at at time zone 'America/Chicago', 'Mon DD'), v_existing.full_name, v_existing.id
      using errcode = 'NL409';
  end if;

  v_line_count := jsonb_array_length(p_lines);
  v_err_count := jsonb_array_length(p_errors);
  if v_line_count + v_err_count = 0 then
    raise exception 'The file has no data rows, so there is nothing to stage.' using errcode = 'NL422';
  end if;

  insert into nl.export_snapshots (kind, file_name, content_hash, status, row_count, line_count, error_count,
                                   total_quantity, total_value, ignored_columns, staged_by)
  values (p_kind, trim(p_file_name), p_content_hash, 'staged', v_line_count + v_err_count,
          v_line_count, v_err_count, 0, 0, coalesce(p_ignored_columns, '{}'), v_actor.id)
  returning id into v_id;

  if p_kind = 'open_sales_lines' then
    insert into nl.export_snapshot_lines (snapshot_id, document_no, line_no, row_no, customer_no, item_no,
                                          description, ship_date, quantity, unit_price, line_amount, location_code)
    select v_id, l.document_no, l.line_no, l.row_no, l.customer_no, l.item_no,
           coalesce(l.description, ''), l.ship_date, l.quantity, l.unit_price, l.line_amount,
           coalesce(l.location_code, '')
    from jsonb_to_recordset(p_lines) as l (
      row_no int, document_no text, line_no int, customer_no text, item_no text, description text,
      ship_date date, quantity int, unit_price numeric, line_amount numeric, location_code text);

    select coalesce(sum(quantity), 0), coalesce(sum(round(quantity * unit_price, 2)), 0), max(ship_date)
      into v_total_qty, v_total_val, v_last_due
    from nl.export_snapshot_lines where snapshot_id = v_id;
  elsif p_kind = 'open_purchase_lines' then
    insert into nl.export_snapshot_purchase_lines (snapshot_id, document_no, line_no, row_no, vendor_no, item_no,
                                                   description, due_date, promised_date, quantity, location_code)
    select v_id, l.document_no, l.line_no, l.row_no, l.vendor_no, l.item_no,
           coalesce(l.description, ''), l.due_date, l.promised_date, l.quantity, coalesce(l.location_code, '')
    from jsonb_to_recordset(p_lines) as l (
      row_no int, document_no text, line_no int, vendor_no text, item_no text, description text,
      due_date date, promised_date date, quantity int, location_code text);

    -- A supply order is worth what the parts on it cost us.
    select coalesce(sum(l.quantity), 0), coalesce(sum(round(l.quantity * i.unit_cost, 2)), 0), max(l.due_date)
      into v_total_qty, v_total_val, v_last_due
    from nl.export_snapshot_purchase_lines l
    join nl.items i on i.item_no = l.item_no
    where l.snapshot_id = v_id;
  else
    insert into nl.export_snapshot_production_orders (snapshot_id, order_no, row_no, item_no, work_center,
                                                      status, due_date, quantity)
    select v_id, l.order_no, l.row_no, l.item_no, coalesce(l.work_center, ''), coalesce(l.status, ''),
           l.due_date, l.quantity
    from jsonb_to_recordset(p_lines) as l (
      row_no int, order_no text, item_no text, work_center text, status text, due_date date, quantity int);

    select coalesce(sum(l.quantity), 0), coalesce(sum(round(l.quantity * i.unit_cost, 2)), 0), max(l.due_date)
      into v_total_qty, v_total_val, v_last_due
    from nl.export_snapshot_production_orders l
    join nl.items i on i.item_no = l.item_no
    where l.snapshot_id = v_id;
  end if;

  update nl.export_snapshots
     set total_quantity = v_total_qty,
         total_value = v_total_val
   where id = v_id;

  -- Why a person should look before this goes live. Every check compares the
  -- file with the live data OF THE SAME KIND.
  select row_count into v_live_rows
  from nl.export_snapshots
  where kind = p_kind and is_current;
  if v_live_rows is not null and v_line_count + v_err_count < v_live_rows * nl.partial_export_ratio() then
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'partial',
      'message', format('This file has %s lines; the live data came from a file with %s. '
                        'Under %s%% of the last export usually means the export was cut short.',
                        v_line_count + v_err_count, v_live_rows, round(nl.partial_export_ratio() * 100)));
  end if;

  if v_last_due is not null and v_last_due < nl.today() then
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'stale',
      'message', format('Every %s is before today (the latest is %s). This looks like an old export.',
                        case p_kind when 'open_sales_lines' then 'ship date' else 'due date' end,
                        to_char(v_last_due, 'Mon DD, YYYY')));
  end if;

  if v_err_count > 0 then
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'row_errors',
      'message', format('%s of %s rows failed a check. Releasing loads the other %s and leaves these out.',
                        v_err_count, v_line_count + v_err_count, v_line_count));
  end if;

  insert into nl.export_snapshot_errors (snapshot_id, row_no, document_no, line_no, reasons, raw)
  select v_id, e.row_no, coalesce(e.document_no, ''), coalesce(e.line_no, ''),
         array(select jsonb_array_elements_text(e.reasons)), coalesce(e.raw, '{}')
  from jsonb_to_recordset(p_errors) as e (row_no int, document_no text, line_no text, reasons jsonb, raw jsonb);

  v_status := case when jsonb_array_length(v_reasons) > 0 then 'held' else 'staged' end;

  update nl.export_snapshots
     set status = v_status,
         hold_reasons = v_reasons
   where id = v_id
  returning updated_at into v_updated_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'import', 'stage_export', 'export_snapshot', v_id::text, p_request_id,
          jsonb_build_object(
            'kind', p_kind,
            'file_name', trim(p_file_name),
            'content_hash', p_content_hash,
            'status', v_status,
            'lines', v_line_count,
            'errors', v_err_count,
            'hold_reasons', v_reasons));

  v_result := jsonb_build_object(
    'snapshot_id', v_id,
    'kind', p_kind,
    'status', v_status,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Apply a staged snapshot (one with no hold reasons), or release a held one
-- with a note. Both make it the current snapshot OF ITS KIND. Operations or
-- admin only. The three kinds differ only in which tables the apply step
-- reads and writes.
create or replace function nl.decide_export(
  p_snapshot_id         bigint,
  p_decision            text,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_note                text default null,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_snap       nl.export_snapshots;
  v_current    bigint;
  v_summary    jsonb;
  v_added      int;
  v_changed    int;
  v_removed    int;
  v_note       text := nullif(trim(coalesce(p_note, '')), '');
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  if p_decision is null or p_decision not in ('apply', 'release', 'discard') then
    raise exception 'A decision is apply, release or discard, not %.', coalesce(p_decision, 'empty')
      using errcode = 'NL422';
  end if;

  v_replay := nl.claim_request(p_request_id, p_decision || '_export');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  -- Field rule: only the people who run imports decide what goes live.
  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can % an ERP export.', p_decision using errcode = 'NL403';
  end if;

  -- Lock the snapshot row so two decisions on it cannot interleave.
  select * into v_snap from nl.export_snapshots where id = p_snapshot_id for update;
  if not found then
    raise exception 'Snapshot % does not exist.', p_snapshot_id using errcode = 'NL404';
  end if;

  -- Optimistic lock: the person decided on the version they were looking at.
  if v_snap.updated_at is distinct from p_expected_updated_at then
    raise exception 'Snapshot % changed since it was loaded. Reload it and decide again.', p_snapshot_id
      using errcode = 'NL409';
  end if;

  if v_snap.status in ('applied', 'discarded') then
    raise exception 'Snapshot % is already %.', p_snapshot_id, v_snap.status using errcode = 'NL422';
  end if;
  if p_decision = 'apply' and v_snap.status = 'held' then
    raise exception 'Snapshot % is held. Release it with a note, or discard it.', p_snapshot_id
      using errcode = 'NL422';
  end if;
  if p_decision = 'release' and v_snap.status <> 'held' then
    raise exception 'Snapshot % is not held; apply it instead.', p_snapshot_id using errcode = 'NL422';
  end if;
  if p_decision = 'release' and (v_note is null or length(v_note) < 3) then
    raise exception 'Releasing a held snapshot needs a note saying why.' using errcode = 'NL422';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'Keep the note under 500 characters.' using errcode = 'NL422';
  end if;

  if p_decision in ('apply', 'release') then
    -- Newer data of the same kind may already be live; an older file must
    -- never replace it.
    select id into v_current from nl.export_snapshots where kind = v_snap.kind and is_current;
    if v_current is not null and v_current > v_snap.id then
      raise exception 'Snapshot % is older than the live data (snapshot %), so it cannot be applied.',
        p_snapshot_id, v_current
        using errcode = 'NL422';
    end if;

    if v_snap.kind = 'open_sales_lines' then
      -- What applying will do, measured against the live table before it changes.
      select count(*) filter (where o.document_no is null),
             count(*) filter (where o.document_no is not null
                                and (l.customer_no, l.item_no, l.description, l.ship_date, l.quantity,
                                     l.unit_price, l.line_amount, l.location_code)
                                    is distinct from
                                    (o.customer_no, o.item_no, o.description, o.ship_date, o.quantity,
                                     o.unit_price, o.line_amount, o.location_code))
        into v_added, v_changed
      from nl.export_snapshot_lines l
      left join nl.open_order_lines o on o.document_no = l.document_no and o.line_no = l.line_no
      where l.snapshot_id = p_snapshot_id;

      -- Lines that are no longer in the export shipped or were cancelled.
      delete from nl.open_order_lines o
      where not exists (
        select 1 from nl.export_snapshot_lines l
        where l.snapshot_id = p_snapshot_id
          and l.document_no = o.document_no
          and l.line_no = o.line_no);
      get diagnostics v_removed = row_count;

      -- Upsert on the natural key. first_seen_on is only set when a line is
      -- inserted, so an update never moves it.
      insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, description, ship_date,
                                       quantity, unit_price, line_amount, location_code,
                                       first_seen_on, last_snapshot_id)
      select l.document_no, l.line_no, l.customer_no, l.item_no, l.description, l.ship_date,
             l.quantity, l.unit_price, l.line_amount, l.location_code,
             nl.today(), p_snapshot_id
      from nl.export_snapshot_lines l
      where l.snapshot_id = p_snapshot_id
      on conflict (document_no, line_no) do update
        set customer_no      = excluded.customer_no,
            item_no          = excluded.item_no,
            description      = excluded.description,
            ship_date        = excluded.ship_date,
            quantity         = excluded.quantity,
            unit_price       = excluded.unit_price,
            line_amount      = excluded.line_amount,
            location_code    = excluded.location_code,
            last_snapshot_id = excluded.last_snapshot_id;

      -- Keep today's allocation with the snapshot, so tomorrow can be compared
      -- with today even after the stock has changed.
      update nl.export_snapshot_lines l
         set allocated = a.allocated,
             short = a.short
        from nl.open_line_allocation a
       where l.snapshot_id = p_snapshot_id
         and a.document_no = l.document_no
         and a.line_no = l.line_no;

    elsif v_snap.kind = 'open_purchase_lines' then
      select count(*) filter (where o.document_no is null),
             count(*) filter (where o.document_no is not null
                                and (l.vendor_no, l.item_no, l.description, l.due_date, l.promised_date,
                                     l.quantity, l.location_code)
                                    is distinct from
                                    (o.vendor_no, o.item_no, o.description, o.due_date, o.promised_date,
                                     o.quantity, o.location_code))
        into v_added, v_changed
      from nl.export_snapshot_purchase_lines l
      left join nl.open_purchase_lines o on o.document_no = l.document_no and o.line_no = l.line_no
      where l.snapshot_id = p_snapshot_id;

      -- A line that is gone from the export was received or cancelled.
      delete from nl.open_purchase_lines o
      where not exists (
        select 1 from nl.export_snapshot_purchase_lines l
        where l.snapshot_id = p_snapshot_id
          and l.document_no = o.document_no
          and l.line_no = o.line_no);
      get diagnostics v_removed = row_count;

      insert into nl.open_purchase_lines (document_no, line_no, vendor_no, item_no, description, due_date,
                                          promised_date, quantity, location_code, first_seen_on, last_snapshot_id)
      select l.document_no, l.line_no, l.vendor_no, l.item_no, l.description, l.due_date,
             l.promised_date, l.quantity, l.location_code, nl.today(), p_snapshot_id
      from nl.export_snapshot_purchase_lines l
      where l.snapshot_id = p_snapshot_id
      on conflict (document_no, line_no) do update
        set vendor_no        = excluded.vendor_no,
            item_no          = excluded.item_no,
            description      = excluded.description,
            due_date         = excluded.due_date,
            promised_date    = excluded.promised_date,
            quantity         = excluded.quantity,
            location_code    = excluded.location_code,
            last_snapshot_id = excluded.last_snapshot_id;

    else
      select count(*) filter (where o.order_no is null),
             count(*) filter (where o.order_no is not null
                                and (l.item_no, l.work_center, l.status, l.due_date, l.quantity)
                                    is distinct from
                                    (o.item_no, o.work_center, o.status, o.due_date, o.quantity))
        into v_added, v_changed
      from nl.export_snapshot_production_orders l
      left join nl.open_production_orders o on o.order_no = l.order_no
      where l.snapshot_id = p_snapshot_id;

      delete from nl.open_production_orders o
      where not exists (
        select 1 from nl.export_snapshot_production_orders l
        where l.snapshot_id = p_snapshot_id and l.order_no = o.order_no);
      get diagnostics v_removed = row_count;

      insert into nl.open_production_orders (order_no, item_no, work_center, status, due_date, quantity,
                                             first_seen_on, last_snapshot_id)
      select l.order_no, l.item_no, l.work_center, l.status, l.due_date, l.quantity,
             nl.today(), p_snapshot_id
      from nl.export_snapshot_production_orders l
      where l.snapshot_id = p_snapshot_id
      on conflict (order_no) do update
        set item_no          = excluded.item_no,
            work_center      = excluded.work_center,
            status           = excluded.status,
            due_date         = excluded.due_date,
            quantity         = excluded.quantity,
            last_snapshot_id = excluded.last_snapshot_id;
    end if;

    v_summary := jsonb_build_object('added', v_added, 'changed', v_changed, 'removed', v_removed);

    -- Hand "current" over. Two statements, because the unique index allows
    -- only one current snapshot per kind at any moment.
    update nl.export_snapshots set is_current = false where kind = v_snap.kind and is_current;
    update nl.export_snapshots
       set status = 'applied', is_current = true, apply_summary = v_summary,
           decided_by = v_actor.id, decided_at = now(), decision_note = v_note
     where id = p_snapshot_id
    returning updated_at into v_updated_at;
  else
    update nl.export_snapshots
       set status = 'discarded', decided_by = v_actor.id, decided_at = now(), decision_note = v_note
     where id = p_snapshot_id
    returning updated_at into v_updated_at;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, p_decision || '_export', 'export_snapshot', p_snapshot_id::text, p_request_id,
          jsonb_build_object(
            'kind', v_snap.kind,
            'from_status', v_snap.status,
            'hold_reasons', v_snap.hold_reasons,
            'note', v_note,
            'summary', v_summary));

  v_result := jsonb_build_object(
    'snapshot_id', p_snapshot_id,
    'decision', p_decision,
    'summary', v_summary,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Day over day
-- ---------------------------------------------------------------------------

-- 0010's day-over-day view read "the current snapshot" without saying which
-- kind, which was unambiguous while there was only one. Same columns, same
-- meaning, now pinned to the sales export.
create or replace view nl.open_line_changes with (security_invoker = true) as
with cur as (
  select id from nl.export_snapshots where kind = 'open_sales_lines' and is_current
),
prev as (
  select max(s.id) as id
  from nl.export_snapshots s, cur
  where s.status = 'applied' and s.id < cur.id and s.kind = 'open_sales_lines'
),
c as (
  select l.* from nl.export_snapshot_lines l join cur on l.snapshot_id = cur.id
),
p as (
  select l.* from nl.export_snapshot_lines l join prev on l.snapshot_id = prev.id
)
select
  case
    when p.document_no is null then 'new'
    when c.document_no is null then 'shipped'
    else 'newly_short'
  end as change,
  coalesce(c.document_no, p.document_no) as document_no,
  coalesce(c.line_no, p.line_no) as line_no,
  coalesce(c.customer_no, p.customer_no) as customer_no,
  coalesce(c.item_no, p.item_no) as item_no,
  coalesce(c.ship_date, p.ship_date) as ship_date,
  coalesce(c.quantity, p.quantity) as quantity,
  c.short as short_now,
  p.short as short_before,
  c.snapshot_id as current_snapshot_id,
  p.snapshot_id as previous_snapshot_id
from c
full join p on p.document_no = c.document_no and p.line_no = c.line_no
where p.document_no is null
   or c.document_no is null
   or (c.short > 0 and p.short = 0);

-- The same idea for supply, over both supply kinds at once. A supply order is
--   new        in the current snapshot only (someone bought or scheduled it)
--   received   in the previous snapshot only (it landed, or was cancelled)
--   due_later  in both, with a due date that moved out (the interesting one)
--   due_sooner in both, with a due date that moved in
-- days_moved is positive when the date moved later.
create view nl.supply_changes with (security_invoker = true) as
with kinds as (
  select * from (values ('open_purchase_lines'), ('open_production_orders')) as k(kind)
),
pairs as (
  select k.kind,
         (select s.id from nl.export_snapshots s where s.kind = k.kind and s.is_current) as current_id,
         (select max(s.id) from nl.export_snapshots s
          where s.kind = k.kind and s.status = 'applied'
            and s.id < (select c.id from nl.export_snapshots c where c.kind = k.kind and c.is_current)) as previous_id
  from kinds k
),
lines as (
  select p.kind, p.current_id, p.previous_id,
         l.snapshot_id, l.document_no, l.line_no::text as line_no, l.item_no, l.vendor_no as party,
         l.due_date, l.quantity
  from pairs p
  join nl.export_snapshot_purchase_lines l on l.snapshot_id in (p.current_id, p.previous_id)
  where p.kind = 'open_purchase_lines'
  union all
  select p.kind, p.current_id, p.previous_id,
         o.snapshot_id, o.order_no, '' as line_no, o.item_no, o.work_center as party,
         o.due_date, o.quantity
  from pairs p
  join nl.export_snapshot_production_orders o on o.snapshot_id in (p.current_id, p.previous_id)
  where p.kind = 'open_production_orders'
),
joined as (
  select coalesce(c.kind, x.kind) as kind,
         coalesce(c.document_no, x.document_no) as document_no,
         coalesce(c.line_no, x.line_no) as line_no,
         coalesce(c.item_no, x.item_no) as item_no,
         coalesce(c.party, x.party) as party,
         coalesce(c.quantity, x.quantity) as quantity,
         c.due_date as due_now,
         x.due_date as due_before,
         coalesce(c.current_id, x.current_id) as current_snapshot_id,
         coalesce(c.previous_id, x.previous_id) as previous_snapshot_id
  from (select * from lines where snapshot_id = current_id) c
  full join (select * from lines where snapshot_id = previous_id) x
    on x.kind = c.kind and x.document_no = c.document_no and x.line_no = c.line_no
)
select
  j.kind,
  case
    when j.due_before is null then 'new'
    when j.due_now is null then 'received'
    when j.due_now > j.due_before then 'due_later'
    else 'due_sooner'
  end as change,
  j.document_no,
  nullif(j.line_no, '')::int as line_no,
  j.item_no,
  j.party,
  j.quantity,
  j.due_now,
  j.due_before,
  j.due_now - j.due_before as days_moved,
  j.current_snapshot_id,
  j.previous_snapshot_id
from joined j
where j.due_before is null
   or j.due_now is null
   or j.due_now <> j.due_before;

-- ---------------------------------------------------------------------------
-- The projection
-- ---------------------------------------------------------------------------

/*
 * One row per open sales line: when the parts for it will be there, when it
 * will ship, how late that is, and which supply order decides it.
 *
 * Time-phased netting, per part:
 *
 *   demand    open sales lines in ship-date order (then document, then line).
 *             demand_through is the running sum of quantity: everything this
 *             line and the lines before it ask for.
 *   supply    on hand at today, then every open purchase line and production
 *             order at its due date. A supply order that is already past due
 *             is late but still coming, so it counts nl.overdue_supply_days()
 *             from today and is flagged. covers_from and covers_to are the
 *             running sum before and after each event, so the events cut the
 *             part's supply into ranges: (0, 20], (20, 45], (45, 70] ...
 *
 * A line's availability date is the date of the one supply event whose range
 * contains demand_through. That is the range join below: exactly one event
 * can match, and a line asking for more than the part's total supply matches
 * none, which is what 'no_supply' means.
 *
 *   projected ship date = the later of the promised ship date and the
 *                         availability date (a line does not ship early)
 *   days late           = projected ship date - promised ship date
 *
 * Status, exactly one per line, checked in this order:
 *   past_due             the promised date has already passed (covered_now
 *                        says whether the stock is on the shelf right now)
 *   no_supply            nothing on hand or on order reaches this line
 *   on_time              the parts are there by the promised date
 *   late_supply_overdue  the supply order that covers it is itself past due
 *   late_waiting_supply  the supply order that covers it lands too late
 */
create view nl.open_line_projection with (security_invoker = true) as
with params as materialized (
  select nl.today() as today, nl.overdue_supply_days() as slip
),
demand as (
  select
    l.document_no, l.line_no, l.customer_no, l.item_no, l.description, l.ship_date,
    l.quantity, l.unit_price, l.first_seen_on,
    sum(l.quantity) over (partition by l.item_no
                          order by l.ship_date, l.document_no, l.line_no
                          rows unbounded preceding) as demand_through
  from nl.open_order_lines l
),
-- Only the parts somebody is waiting for: the supply side is read for these
-- and no others.
wanted as (
  select distinct item_no from nl.open_order_lines
),
supply as (
  select w.item_no, p.today as available_on, s.on_hand as quantity,
         'stock'::text as source, null::text as document_no, null::text as vendor_no,
         null::text as work_center, null::date as due_date, false as overdue, 0 as ord
  from wanted w
  join nl.stock s on s.item_no = w.item_no
  cross join params p
  where s.on_hand > 0
  union all
  select l.item_no,
         case when l.due_date < p.today then p.today + p.slip else l.due_date end,
         l.quantity, 'purchase', l.document_no, l.vendor_no, null, l.due_date,
         l.due_date < p.today, 1
  from nl.open_purchase_lines l
  join wanted w on w.item_no = l.item_no
  cross join params p
  union all
  select o.item_no,
         case when o.due_date < p.today then p.today + p.slip else o.due_date end,
         o.quantity, 'production', o.order_no, null, o.work_center, o.due_date,
         o.due_date < p.today, 2
  from nl.open_production_orders o
  join wanted w on w.item_no = o.item_no
  cross join params p
),
events as (
  select s.*,
         sum(s.quantity) over w - s.quantity as covers_from,
         sum(s.quantity) over w as covers_to
  from supply s
  window w as (partition by s.item_no
               order by s.available_on, s.ord, s.document_no nulls first
               rows unbounded preceding)
),
measured as (
  select
    d.document_no, d.line_no, d.customer_no, cu.owner_id as customer_owner_id,
    d.item_no, d.description, d.ship_date, d.quantity, d.unit_price,
    round(d.quantity * d.unit_price, 2) as open_value,
    d.first_seen_on, d.demand_through,
    e.available_on as availability_date,
    e.source as supply_source,
    e.document_no as supply_document,
    e.vendor_no as supply_vendor_no,
    e.work_center as supply_work_center,
    e.due_date as supply_due_date,
    coalesce(e.overdue, false) as supply_overdue,
    -- What it would take to get this part if it were ordered or scheduled
    -- today: the item card's lead time, then its vendor's, then the house
    -- default for a bought or a made part. A line nothing covers is shown
    -- this date and projected on it.
    p.today + coalesce(nl.lead_time_days(i.lead_time),
                       nl.lead_time_days(v.lead_time),
                       nl.default_lead_days(i.replenishment)) as earliest_if_ordered_today,
    p.today as today
  from demand d
  join nl.customers cu on cu.customer_no = d.customer_no
  join nl.items i on i.item_no = d.item_no
  left join nl.vendors v on v.vendor_no = i.vendor_no
  cross join params p
  left join events e
    on e.item_no = d.item_no
   and d.demand_through > e.covers_from
   and d.demand_through <= e.covers_to
),
shipped as (
  select m.*,
    greatest(m.ship_date, coalesce(m.availability_date, m.earliest_if_ordered_today)) as projected_ship_date,
    (m.availability_date is not null and m.availability_date <= m.today) as covered_now
  from measured m
)
select
  s.document_no,
  s.line_no,
  s.customer_no,
  s.customer_owner_id,
  s.item_no,
  s.description,
  s.ship_date,
  s.quantity,
  s.unit_price,
  s.open_value,
  s.first_seen_on,
  s.demand_through,
  s.availability_date,
  s.earliest_if_ordered_today,
  s.projected_ship_date,
  s.projected_ship_date - s.ship_date as days_late,
  case
    when s.ship_date < s.today then 'past_due'
    when s.availability_date is null then 'no_supply'
    when s.availability_date <= s.ship_date then 'on_time'
    when s.supply_overdue then 'late_supply_overdue'
    else 'late_waiting_supply'
  end as status,
  s.covered_now,
  s.supply_source,
  s.supply_document,
  s.supply_vendor_no,
  s.supply_work_center,
  s.supply_due_date,
  s.supply_overdue,
  s.today
from shipped s;

-- ---------------------------------------------------------------------------
-- The aggregates: who to call
-- ---------------------------------------------------------------------------

-- A buyer's call sheet: the vendors whose late purchase orders hold up
-- customer orders, and how many dollars are waiting on each one.
create view nl.forecast_by_vendor with (security_invoker = true) as
select
  p.supply_vendor_no as vendor_no,
  ve.name as vendor_name,
  ve.city,
  ve.state,
  ve.lead_time,
  count(*)::int as late_lines,
  count(distinct p.customer_no)::int as customers,
  count(distinct p.supply_document)::int as purchase_orders,
  count(distinct p.supply_document) filter (where p.supply_overdue)::int as overdue_purchase_orders,
  sum(p.open_value) as value_waiting,
  min(p.supply_due_date) as first_due,
  max(p.supply_due_date) as last_due,
  max(p.days_late)::int as worst_days_late
from nl.open_line_projection p
join nl.vendors ve on ve.vendor_no = p.supply_vendor_no
where p.days_late > 0 and p.supply_source = 'purchase'
group by 1, 2, 3, 4, 5;

-- The production backlog: which work centers hold up customer orders.
create view nl.forecast_by_work_center with (security_invoker = true) as
select
  p.supply_work_center as work_center,
  count(*)::int as late_lines,
  count(distinct p.customer_no)::int as customers,
  count(distinct p.supply_document)::int as production_orders,
  count(distinct p.supply_document) filter (where p.supply_overdue)::int as overdue_production_orders,
  sum(p.open_value) as value_waiting,
  min(p.supply_due_date) as first_due,
  max(p.supply_due_date) as last_due,
  max(p.days_late)::int as worst_days_late
from nl.open_line_projection p
where p.days_late > 0 and p.supply_source = 'production'
group by 1;

-- Who to call, and who owns the account.
create view nl.forecast_by_customer with (security_invoker = true) as
select
  p.customer_no,
  cu.name as customer_name,
  cu.owner_id,
  count(*)::int as late_lines,
  count(*) filter (where p.status = 'no_supply')::int as no_supply_lines,
  sum(p.open_value) as value_late,
  max(p.days_late)::int as worst_days_late,
  min(p.ship_date) as earliest_promise,
  min(p.projected_ship_date) as earliest_projected
from nl.open_line_projection p
join nl.customers cu on cu.customer_no = p.customer_no
where p.days_late > 0
group by 1, 2, 3;

-- Promises that moved: open sales lines whose ship date changed from one
-- applied export to the next. The history is the snapshot lines themselves,
-- so this is measured, not logged.
create view nl.promise_moves with (security_invoker = true) as
with history as (
  select l.document_no, l.line_no, l.snapshot_id, l.ship_date,
         lag(l.ship_date) over (partition by l.document_no, l.line_no order by l.snapshot_id) as previous_date
  from nl.export_snapshot_lines l
  join nl.export_snapshots s on s.id = l.snapshot_id
  where s.kind = 'open_sales_lines' and s.status = 'applied'
),
moves as (
  select document_no, line_no,
         count(*) filter (where previous_date is not null and ship_date <> previous_date)::int as moves,
         max(case when previous_date is not null and ship_date <> previous_date
                  then ship_date - previous_date end)::int as biggest_move_days,
         min(ship_date) as first_promised,
         sum(case when previous_date is not null then ship_date - previous_date else 0 end)::int as days_moved
  from history
  group by document_no, line_no
)
select
  o.document_no,
  o.line_no,
  o.customer_no,
  cu.name as customer_name,
  cu.owner_id,
  o.item_no,
  o.ship_date as current_promise,
  m.first_promised,
  m.moves,
  m.biggest_move_days,
  m.days_moved,
  round(o.quantity * o.unit_price, 2) as open_value,
  o.first_seen_on
from moves m
join nl.open_order_lines o on o.document_no = m.document_no and o.line_no = m.line_no
join nl.customers cu on cu.customer_no = o.customer_no
where m.moves > 0;

-- ---------------------------------------------------------------------------
-- Can we ship it?
-- ---------------------------------------------------------------------------

/*
 * Available to promise, for one part, one quantity and one date. The same
 * netting as the projection, asked forwards: what is on hand, how much of it
 * earlier open lines have already been promised, what is coming in when, and
 * therefore whether this quantity can be there by that date.
 *
 * "Already promised" counts the open sales lines for the part that are due on
 * or before the date asked about: a new order takes its place behind them.
 *
 * Returns, as JSON:
 *   on_hand, promised_earlier, free_now   pieces
 *   needed_through                        promised_earlier + the quantity asked for
 *   can_meet                              true when the quantity is there by the date
 *   earliest_date, earliest_basis         'stock', 'supply' or 'lead_time'
 *   covering                              the supply order that decides the date
 *   incoming                              the part's open supply, in date order
 */
create function nl.available_to_promise(p_item_no text, p_quantity int, p_needed_by date)
returns jsonb
language sql stable
set search_path = ''
as $$
with params as (
  select nl.today() as today, nl.overdue_supply_days() as slip,
         coalesce(p_needed_by, nl.today()) as needed_by,
         greatest(coalesce(p_quantity, 1), 1) as want
),
item as (
  select i.item_no, i.description, i.replenishment, i.work_center, i.vendor_no,
         coalesce(s.on_hand, 0) as on_hand,
         nl.item_lead_days(i.item_no) as lead_days
  from nl.items i
  left join nl.stock s on s.item_no = i.item_no
  where i.item_no = p_item_no
),
-- What earlier promises already claim: open lines for this part due on or
-- before the date asked about.
claimed as (
  select coalesce(sum(l.quantity), 0)::int as promised_earlier
  from nl.open_order_lines l, params p
  where l.item_no = p_item_no and l.ship_date <= p.needed_by
),
supply as (
  select p.today as available_on, i.on_hand as quantity, 'stock'::text as source,
         null::text as document_no, null::text as party, null::date as due_date, false as overdue, 0 as ord
  from item i, params p
  where i.on_hand > 0
  union all
  select case when l.due_date < p.today then p.today + p.slip else l.due_date end,
         l.quantity, 'purchase', l.document_no, l.vendor_no, l.due_date, l.due_date < p.today, 1
  from nl.open_purchase_lines l, params p
  where l.item_no = p_item_no
  union all
  select case when o.due_date < p.today then p.today + p.slip else o.due_date end,
         o.quantity, 'production', o.order_no, o.work_center, o.due_date, o.due_date < p.today, 2
  from nl.open_production_orders o, params p
  where o.item_no = p_item_no
),
events as (
  select s.*,
         sum(s.quantity) over w - s.quantity as covers_from,
         sum(s.quantity) over w as covers_to
  from supply s
  window w as (order by s.available_on, s.ord, s.document_no nulls first rows unbounded preceding)
),
-- The one event that reaches the quantity asked for, behind the earlier promises.
covering as (
  select e.*
  from events e, claimed c, params p
  where c.promised_earlier + p.want > e.covers_from
    and c.promised_earlier + p.want <= e.covers_to
)
select jsonb_build_object(
  'item_no', i.item_no,
  'description', i.description,
  'quantity', p.want,
  'needed_by', p.needed_by,
  'today', p.today,
  'on_hand', i.on_hand,
  'promised_earlier', c.promised_earlier,
  'free_now', greatest(i.on_hand - c.promised_earlier, 0),
  'needed_through', c.promised_earlier + p.want,
  'lead_days', i.lead_days,
  'replenishment', i.replenishment,
  'earliest_date', coalesce((select available_on from covering), p.today + i.lead_days),
  'earliest_basis', case
     when (select source from covering) = 'stock' then 'stock'
     when (select source from covering) is not null then 'supply'
     else 'lead_time' end,
  'can_meet', coalesce((select available_on from covering), p.today + i.lead_days) <= p.needed_by,
  'covering', (select jsonb_build_object('source', source, 'document_no', document_no, 'party', party,
                                         'due_date', due_date, 'available_on', available_on,
                                         'overdue', overdue, 'quantity', quantity)
               from covering),
  'incoming', coalesce((select jsonb_agg(jsonb_build_object(
                                 'source', e.source, 'document_no', e.document_no, 'party', e.party,
                                 'due_date', e.due_date, 'available_on', e.available_on,
                                 'quantity', e.quantity, 'overdue', e.overdue, 'covers_to', e.covers_to)
                               order by e.available_on, e.ord, e.document_no)
                        from events e where e.source <> 'stock'), '[]'::jsonb))
from item i, claimed c, params p
$$;

-- ---------------------------------------------------------------------------
-- The automation trigger
-- ---------------------------------------------------------------------------

-- 'order_line_projected_late': a line this projection says will ship late.
-- The rule's source query lives in app/src/lib/server/automation/sources.ts.
alter table nl.automation_rules drop constraint automation_rules_trigger_check;
alter table nl.automation_rules add constraint automation_rules_trigger_check
  check (trigger in ('window_closed_short', 'commitment_behind_pace', 'account_gone_quiet',
                     'order_line_at_risk', 'order_line_projected_late'));

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.export_snapshot_purchase_lines enable row level security;
alter table nl.export_snapshot_production_orders enable row level security;
alter table nl.open_purchase_lines enable row level security;
alter table nl.open_production_orders enable row level security;

-- Everyone on the team can look; only operations and admins write, as in 0010.
create policy export_snapshot_purchase_lines_read on nl.export_snapshot_purchase_lines
  for select to nl_app using (true);
create policy export_snapshot_purchase_lines_insert on nl.export_snapshot_purchase_lines
  for insert to nl_app with check ((select nl.can_run_imports()));
create policy export_snapshot_production_orders_read on nl.export_snapshot_production_orders
  for select to nl_app using (true);
create policy export_snapshot_production_orders_insert on nl.export_snapshot_production_orders
  for insert to nl_app with check ((select nl.can_run_imports()));

create policy open_purchase_lines_read on nl.open_purchase_lines
  for select to nl_app, nl_readonly using (true);
create policy open_purchase_lines_insert on nl.open_purchase_lines
  for insert to nl_app with check ((select nl.can_run_imports()));
create policy open_purchase_lines_update on nl.open_purchase_lines
  for update to nl_app using ((select nl.can_run_imports())) with check ((select nl.can_run_imports()));
create policy open_purchase_lines_delete on nl.open_purchase_lines
  for delete to nl_app using ((select nl.can_run_imports()));

create policy open_production_orders_read on nl.open_production_orders
  for select to nl_app, nl_readonly using (true);
create policy open_production_orders_insert on nl.open_production_orders
  for insert to nl_app with check ((select nl.can_run_imports()));
create policy open_production_orders_update on nl.open_production_orders
  for update to nl_app using ((select nl.can_run_imports())) with check ((select nl.can_run_imports()));
create policy open_production_orders_delete on nl.open_production_orders
  for delete to nl_app using ((select nl.can_run_imports()));

grant select, insert on nl.export_snapshot_purchase_lines, nl.export_snapshot_production_orders to nl_app;
grant select, insert, delete on nl.open_purchase_lines, nl.open_production_orders to nl_app;
grant update (vendor_no, item_no, description, due_date, promised_date, quantity, location_code,
              last_snapshot_id) on nl.open_purchase_lines to nl_app;
grant update (item_no, work_center, status, due_date, quantity, last_snapshot_id)
  on nl.open_production_orders to nl_app;

grant select on nl.supply_changes, nl.open_line_projection, nl.forecast_by_vendor,
  nl.forecast_by_work_center, nl.forecast_by_customer, nl.promise_moves to nl_app;

-- The supply book and the projection hold no people, so the read-only role
-- may read them too.
grant select on nl.open_purchase_lines, nl.open_production_orders, nl.open_line_projection,
  nl.forecast_by_vendor, nl.forecast_by_work_center to nl_readonly;

grant execute on function
  nl.overdue_supply_days(),
  nl.lead_time_days(text),
  nl.default_lead_days(text),
  nl.item_lead_days(text),
  nl.available_to_promise(text, int, date)
to nl_app, nl_readonly;

grant execute on function
  nl.stage_export(text, text, text[], jsonb, jsonb, text, text)
to nl_app;

-- ---------------------------------------------------------------------------
-- The sample exports
-- ---------------------------------------------------------------------------

/*
 * Northline has no ERP to export from, so the demo makes the three reports
 * from whatever world the database holds. These functions are that stand-in.
 * They live in the schema, not in the app, because two callers need exactly
 * the same rows: the operations page (which offers the files for download,
 * app/src/lib/server/exports/samples.ts) and the seed (which applies
 * yesterday's and the day before's files, db/seed.d/40_supply.sql), so a
 * fresh world already has a forecast and the demo can upload today's file.
 *
 * Every random choice is a hash of a label, never random(): the same world on
 * the same day always produces the same file, here and in JavaScript, so the
 * fingerprint of a downloaded file matches the snapshot the seed applied and
 * the workflow says "this data was already loaded".
 */

-- A number in [0, 1) from a label: the top 48 bits of its SHA-256, scaled.
-- The same arithmetic as draw() in app/src/lib/server/exports/samples.ts.
create function nl.sample_draw(p_label text) returns double precision
language sql immutable
set search_path = ''
as $$
  select ('x' || encode(substr(sha256(convert_to(p_label, 'UTF8')), 1, 6), 'hex'))::bit(48)::bigint::double precision
         / 281474976710656::double precision
$$;

-- The next weekday on or after a date: the warehouse does not ship on weekends.
create function nl.sample_weekday(p_day date) returns date
language sql immutable
set search_path = ''
as $$
  select case extract(isodow from p_day) when 6 then p_day + 2 when 7 then p_day + 1 else p_day end
$$;

/*
 * The open sales lines export for one day.
 *
 * The model: every weekday some orders are entered, each with a few lines,
 * promised a few weeks out. One order in five is pushed out a few days
 * before it was due; one in six leaves late. An order is open on day D when
 * it was entered by D and has not left before it. Because an order's facts
 * depend only on its own labels and not on D, yesterday's file and today's
 * describe the same orders: today's has lost the ones that shipped, gained
 * the ones entered today, and shows the few lines changed today.
 */
create function nl.sample_open_sales_lines(p_day date)
returns table (
  row_no        int,
  document_no   text,
  line_no       int,
  customer_no   text,
  item_no       text,
  description   text,
  ship_date     date,
  quantity      int,
  unit_price    numeric,
  location_code text
)
language sql stable
set search_path = ''
as $$
with clock as materialized (
  select nl.today() as today
),
-- Customers who bought in the last six months and can still order, with the
-- parts each one bought in the last year. Numbered in customer order, so a
-- keyed draw picks the same customer everywhere.
book as (
  select (row_number() over (order by c.customer_no) - 1)::int as idx,
         c.customer_no, pg.discount, b.item_nos
  from nl.customers c
  join nl.price_groups pg on pg.code = c.price_group
  cross join clock k
  cross join lateral (
    select array_agg(it.item_no order by it.item_no) as item_nos
    from nl.items it
    where not it.blocked and it.list_price > 0
      and exists (
        select 1 from nl.invoice_lines l
        where l.item_no = it.item_no and l.customer_no = c.customer_no
          and l.posted_on >= k.today - 365 and l.quantity > 0)
  ) b
  where not c.blocked and not c.closed
    and b.item_nos is not null
    and exists (
      select 1 from nl.invoices i
      where i.customer_no = c.customer_no and i.doc_type = 'invoice'
        and i.posted_on >= k.today - 180)
),
size as (
  select count(*)::double precision as customers from book
),
-- The book's size sets the order rate: about three open lines per active
-- customer, with orders open about 25 days on average and 2.5 lines each,
-- entered on five days out of seven.
rate as (
  select (least(1500::double precision, greatest(60::double precision, s.customers * 3)) / (2.5 * 25))
         / (5::double precision / 7) as per_day
  from size s
),
-- Late orders can stay open for months, so look back 150 days.
days as (
  select (p_day - 150 + g)::date as entered
  from generate_series(0, 150) as g
),
day_orders as (
  select d.entered,
         (floor(r.per_day)
          + case when nl.sample_draw('orders|' || to_char(d.entered, 'YYYY-MM-DD'))
                      < r.per_day - floor(r.per_day) then 1 else 0 end)::int as n_orders
  from days d
  cross join rate r
  where extract(isodow from d.entered) < 6
),
orders as (
  select o.entered, n.n, 'order|' || to_char(o.entered, 'YYYY-MM-DD') || '|' || n.n as key
  from day_orders o
  cross join lateral generate_series(1, o.n_orders) as n(n)
),
-- Who ordered, and when it was first promised. Document numbers grow with
-- the entry date, as the ERP's do.
placed as (
  select o.entered, o.key, b.customer_no, b.discount, b.item_nos,
         'SO' || lpad((300000 + (o.entered - date '2020-01-01') * 100 + o.n)::text, 6, '0') as document_no,
         nl.sample_weekday(o.entered + (3 + floor(nl.sample_draw(o.key || '|lead') * 43)::int)) as first_promise
  from orders o
  cross join size s
  join book b on b.idx = floor(nl.sample_draw(o.key || '|customer') * s.customers)::int
),
-- One order in five is pushed out a few days before it was due to ship. The
-- push is always decided before the old date, so an earlier file never
-- thinks the order already left.
pushed as (
  select p.*,
         case
           when nl.sample_draw(p.key || '|push') < 0.2::double precision
                and p.first_promise - (1 + floor(nl.sample_draw(p.key || '|push.day') * 3)::int) <= p_day
           then nl.sample_weekday(p.first_promise + (3 + floor(nl.sample_draw(p.key || '|push.days') * 12)::int))
           else p.first_promise
         end as promise
  from placed p
),
-- One order in six runs late, by up to three weeks.
open_orders as (
  select q.*,
         case when nl.sample_draw(q.key || '|late') < 1::double precision / 6
              then 2 + floor(nl.sample_draw(q.key || '|late.days') * 20)::int
              else 0 end as late_days
  from pushed q
),
order_lines as (
  select o.*, l.l,
         o.item_nos[1 + floor(nl.sample_draw(o.key || '|' || l.l || '|item') * cardinality(o.item_nos))::int] as item_no
  from open_orders o
  cross join lateral generate_series(1, 1 + floor(nl.sample_draw(o.key || '|lines') * 4)::int) as l(l)
  where o.promise + o.late_days >= p_day
),
-- A line whose part was already on the order is dropped: the buyer would
-- have added the quantity to the first line instead.
first_use as (
  select x.*
  from (select ol.*, row_number() over (partition by ol.key, ol.item_no order by ol.l) as rn from order_lines ol) x
  where x.rn = 1
),
priced as (
  select
    f.document_no,
    (f.l * 10000)::int as line_no,
    f.customer_no,
    f.item_no,
    it.description,
    f.promise as ship_date,
    -- Buyers change quantities in the first days after ordering. From the
    -- day of the change on, every file shows the new quantity.
    greatest(1,
      (coalesce(qr.lo, 1) + floor(nl.sample_draw(f.key || '|' || f.l || '|qty')
                                  * (coalesce(qr.hi, 10) - coalesce(qr.lo, 1) + 1))::int)
      + case
          when f.entered + (1 + floor(nl.sample_draw(f.key || '|' || f.l || '|change.day') * 3)::int) <= p_day
               and nl.sample_draw(f.key || '|' || f.l || '|change') < 0.3::double precision
          then -3 + floor(nl.sample_draw(f.key || '|' || f.l || '|change.qty') * 10)::int
          else 0
        end)::int as quantity,
    -- The customer's price group discount off list, rounded to cents the
    -- same way JavaScript's cents() rounds.
    (floor((it.list_price::double precision * (1 - f.discount::double precision)
            + 2.220446049250313e-16) * 100 + 0.5) / 100)::numeric(12, 2) as unit_price,
    case when nl.sample_draw(f.key || '|loc') < 0.8::double precision then 'MAIN' else 'EAST' end as location_code,
    nl.sample_draw('note|' || f.document_no) as note_draw
  from first_use f
  join nl.items it on it.item_no = f.item_no
  -- How many pieces a line asks for, by kind of part.
  left join (values ('clamp', 10, 100), ('bracket', 4, 40), ('flex', 2, 20), ('pipe', 2, 24), ('raw', 5, 50),
                    ('elbow', 1, 8), ('stack', 1, 6), ('muffler', 1, 6), ('shield', 1, 8), ('kit', 1, 3),
                    ('proprietary', 1, 10), ('custom', 1, 4)) as qr(family, lo, hi)
    on qr.family = it.family
)
select
  (row_number() over (order by p.document_no collate "C", p.line_no))::int as row_no,
  p.document_no,
  p.line_no,
  p.customer_no,
  p.item_no,
  -- Now and then the first line carries a note from the buyer, commas,
  -- quotes and all, so the file exercises the CSV reader.
  case when p.line_no = 10000 and p.note_draw < 0.1::double precision
       then p.description || ', "EXPEDITE" per buyer'
       else p.description end as description,
  p.ship_date,
  p.quantity,
  p.unit_price,
  p.location_code
from priced p
order by p.document_no collate "C", p.line_no
$$;

/*
 * The open purchase lines export for one day.
 *
 * The item master says how many pieces of each bought part are on purchase
 * order (nl.stock.on_purchase_order), so that is the quantity these lines
 * add up to: one to three lines per part, from its vendor, due over the next
 * two to ten weeks, with about one part in six already past due because the
 * vendor is late. Lines are grouped into purchase orders by vendor and the
 * week they were first promised, the way a buyer orders.
 *
 * Three things make the file differ from day to day: a line ordered today,
 * a line received today, and a vendor moving an expected receipt date out
 * (the promised date keeps what they said first).
 */
create function nl.sample_open_purchase_lines(p_day date)
returns table (
  row_no        int,
  document_no   text,
  line_no       int,
  vendor_no     text,
  item_no       text,
  description   text,
  due_date      date,
  promised_date date,
  quantity      int,
  location_code text
)
language sql stable
set search_path = ''
as $$
with clock as materialized (
  select nl.today() as today
),
parts as (
  select i.item_no, i.description, i.vendor_no, s.on_purchase_order as on_order, k.today,
         coalesce(nl.lead_time_days(v.lead_time), nl.lead_time_days(i.lead_time), 21) as lead_days,
         least(1 + floor(nl.sample_draw('po|' || i.item_no || '|n') * 3)::int, s.on_purchase_order) as lines_open
  from nl.items i
  join nl.stock s on s.item_no = i.item_no
  join nl.vendors v on v.vendor_no = i.vendor_no
  cross join clock k
  where i.replenishment = 'Purchase' and s.on_purchase_order > 0
),
-- The open lines split the quantity the item master reports (the remainder
-- goes on the first line, so they add up to it exactly), plus, for one part
-- in eight, a line that landed today.
spread as (
  select p.item_no, p.description, p.vendor_no, p.today, p.lead_days, g.k, false as received,
         (p.on_order / p.lines_open + case when g.k = 1 then p.on_order % p.lines_open else 0 end)::int as quantity
  from parts p
  cross join lateral generate_series(1, p.lines_open) as g(k)
  union all
  select p.item_no, p.description, p.vendor_no, p.today, p.lead_days, 90 as k, true as received,
         greatest(1, p.on_order / 3)::int as quantity
  from parts p
  where nl.sample_draw('po.recv|' || p.item_no) < 0.12::double precision
),
dated as (
  select s.*,
         'po|' || s.item_no || '|' || s.k as key,
         case
           when s.received then s.today - floor(nl.sample_draw('po|' || s.item_no || '|' || s.k || '|got') * 6)::int
           when nl.sample_draw('po|' || s.item_no || '|' || s.k || '|late') < 0.15::double precision
             then s.today - (1 + floor(nl.sample_draw('po|' || s.item_no || '|' || s.k || '|late.days') * 21)::int)
           else s.today + (14 + floor(nl.sample_draw('po|' || s.item_no || '|' || s.k || '|due') * 57)::int)
         end as due_now,
         -- A vendor who moves a date out only does it once, a day or two ago.
         case
           when not s.received
                and nl.sample_draw('po|' || s.item_no || '|' || s.k || '|slip') < 0.12::double precision
           then 3 + floor(nl.sample_draw('po|' || s.item_no || '|' || s.k || '|slip.days') * 12)::int
           else 0
         end as slipped,
         s.today - floor(nl.sample_draw('po|' || s.item_no || '|' || s.k || '|slip.on') * 3)::int as slipped_on
  from spread s
),
ordered as (
  select d.*,
         -- What the vendor promised first, and when we placed the order: a
         -- lead time before the promised date, or, for an order promised far
         -- out, somewhere in the last six weeks. One order in twenty was
         -- placed today, which is what makes it "new" in today's file.
         d.due_now - d.slipped as promised,
         case
           when not d.received
                and nl.sample_draw(d.key || '|new') < 0.05::double precision then d.today
           else least(d.due_now - d.slipped - d.lead_days,
                      d.today - 1 - floor(nl.sample_draw(d.key || '|lag') * 45)::int)
         end as ordered_on,
         case when d.received then d.today else null::date end as received_on
  from dated d
),
-- One purchase order per vendor per week of first promise; the numbering
-- covers every line in the world, so a document keeps its number whichever
-- day is asked about.
numbered as (
  select o.*,
         dense_rank() over (order by o.vendor_no, to_char(o.promised, 'IYYY-IW')) as po_seq,
         row_number() over (partition by o.vendor_no, to_char(o.promised, 'IYYY-IW')
                            order by o.item_no, o.k) as po_line
  from ordered o
),
open_lines as (
  select 'PO-' || lpad((104000 + n.po_seq)::text, 6, '0') as document_no,
         (n.po_line * 10000)::int as line_no,
         n.vendor_no, n.item_no, n.description,
         -- Before the day the vendor moved it, the file showed the old date.
         case when n.slipped > 0 and p_day < n.slipped_on then n.promised else n.due_now end as due_date,
         n.promised as promised_date,
         n.quantity
  from numbered n
  where n.ordered_on <= p_day
    and (n.received_on is null or n.received_on > p_day)
)
select
  (row_number() over (order by l.document_no collate "C", l.line_no))::int as row_no,
  l.document_no, l.line_no, l.vendor_no, l.item_no, l.description,
  l.due_date, l.promised_date, l.quantity, 'MAIN'::text as location_code
from open_lines l
order by l.document_no collate "C", l.line_no
$$;

/*
 * The open production orders export for one day. The same idea as the
 * purchase lines: the quantity the item master says is on production order
 * (nl.stock.on_production_order) is split over one or two orders on the
 * part's work center, due over the next six weeks, with about one in eight
 * already past due. An order due inside two weeks is Released; further out
 * it may still be Firm Planned.
 */
create function nl.sample_open_production_orders(p_day date)
returns table (
  row_no      int,
  order_no    text,
  item_no     text,
  work_center text,
  status      text,
  due_date    date,
  quantity    int
)
language sql stable
set search_path = ''
as $$
with clock as materialized (
  select nl.today() as today
),
parts as (
  select i.item_no, i.work_center, s.on_production_order as on_order, k.today,
         least(1 + floor(nl.sample_draw('mo|' || i.item_no || '|n') * 2)::int, s.on_production_order) as orders_open
  from nl.items i
  join nl.stock s on s.item_no = i.item_no
  cross join clock k
  where i.replenishment = 'Prod. Order' and s.on_production_order > 0
),
spread as (
  select p.item_no, p.work_center, p.today, g.k, false as finished,
         (p.on_order / p.orders_open + case when g.k = 1 then p.on_order % p.orders_open else 0 end)::int as quantity
  from parts p
  cross join lateral generate_series(1, p.orders_open) as g(k)
  union all
  select p.item_no, p.work_center, p.today, 90 as k, true as finished,
         greatest(1, p.on_order / 3)::int as quantity
  from parts p
  where nl.sample_draw('mo.done|' || p.item_no) < 0.12::double precision
),
dated as (
  select s.*,
         'mo|' || s.item_no || '|' || s.k as key,
         case
           when s.finished then s.today - floor(nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|done') * 4)::int
           when nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|late') < 0.12::double precision
             then s.today - (1 + floor(nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|late.days') * 10)::int)
           else s.today + (3 + floor(nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|due') * 43)::int)
         end as due_now,
         case
           when not s.finished
                and nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|slip') < 0.1::double precision
           then 3 + floor(nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|slip.days') * 10)::int
           else 0
         end as slipped,
         s.today - floor(nl.sample_draw('mo|' || s.item_no || '|' || s.k || '|slip.on') * 3)::int as slipped_on
  from spread s
),
scheduled as (
  select d.*,
         -- When the planner wrote the order: a few weeks before it is due,
         -- or, for one due far out, somewhere in the last month. One in
         -- twenty was written today.
         case
           when not d.finished and nl.sample_draw(d.key || '|new') < 0.05::double precision then d.today
           else least(d.due_now - d.slipped - (5 + floor(nl.sample_draw(d.key || '|start') * 16)::int),
                      d.today - 1 - floor(nl.sample_draw(d.key || '|lag') * 30)::int)
         end as created_on,
         case when d.finished then d.today else null::date end as finished_on
  from dated d
),
numbered as (
  select s.*, row_number() over (order by s.item_no, s.k) as mo_seq
  from scheduled s
),
open_orders as (
  select 'MO-' || lpad((200000 + n.mo_seq)::text, 6, '0') as order_no,
         n.item_no, n.work_center, n.quantity, n.key,
         case when n.slipped > 0 and p_day < n.slipped_on then n.due_now - n.slipped else n.due_now end as due_date
  from numbered n
  where n.created_on <= p_day
    and (n.finished_on is null or n.finished_on > p_day)
)
select
  (row_number() over (order by o.order_no collate "C"))::int as row_no,
  o.order_no, o.item_no, o.work_center,
  case
    when o.due_date <= p_day + 14 then 'Released'
    when nl.sample_draw(o.key || '|status') < 0.5::double precision then 'Released'
    else 'Firm Planned'
  end as status,
  o.due_date, o.quantity
from open_orders o
order by o.order_no collate "C"
$$;

grant execute on function
  nl.sample_draw(text),
  nl.sample_weekday(date),
  nl.sample_open_sales_lines(date),
  nl.sample_open_purchase_lines(date),
  nl.sample_open_production_orders(date)
to nl_app;
