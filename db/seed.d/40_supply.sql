-- 40 The supply side of the book, and the first two days of ERP exports.
--
-- Migration 0016 added the two supply reports (open purchase lines, open
-- production orders) and the sample generators that stand in for the ERP.
-- This file uses them to give a fresh world a working late-order forecast:
--
--   * the export of the day before yesterday, for all three reports, staged
--     and applied, so day over day and "promise moved" have history;
--   * yesterday's export, for all three reports, staged and applied, so the
--     live tables hold a realistic book;
--   * nothing for today, so the demo still has something to upload: the
--     samples on the operations page are today's files.
--
-- Each snapshot is stored exactly as the app would have stored it, including
-- the file fingerprint the reader computes in JavaScript. That is why
-- uploading yesterday's sample on a fresh world says "this data was already
-- loaded" instead of quietly loading it twice.
--
-- The supply the generators produce is planned against demand (migration
-- 0022), so the item master is the derived side here: once the exports are
-- applied, nl.stock.on_purchase_order and on_production_order are set to the
-- quantities today's files hold, part by part. That is the invariant the
-- forecast tests check, and it is the direction a real ERP works in: the
-- flowfields on an item card are a sum of its open orders.

-- ---------------------------------------------------------------------------
-- The fingerprint a staged file carries
-- ---------------------------------------------------------------------------

/*
 * A stored snapshot, summed up: its fingerprint, how many rows it holds, and
 * what they add up to. It reads the rows that were just written rather than
 * asking the generator again, which halves the work the seed does (a supply
 * generator has to net demand against stock before it can answer, migration
 * 0022) and makes the fingerprint describe exactly what was stored.
 *
 * The fingerprint is the same SHA-256 that app/src/lib/server/exports/reader.ts
 * computes over a file: the rows in canonical form, sorted by the report's key
 * fields, as JSON. Neither the file name, nor the column order, nor the row
 * order, nor the way dates and numbers are written changes it; any changed
 * value does.
 *
 * The field names and their order are the profile's, so these lists have to
 * match app/src/lib/server/exports/profile.ts. A test compares this hash with
 * the one the reader computes for the same day's sample file
 * (app/src/lib/server/supply/seed.test.ts), which is what keeps them honest.
 */
create or replace function nl_seed.sample_export_summary(p_snapshot_id bigint, p_kind text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fields   text[];
  v_rows     text;
  v_count    int;
  v_quantity bigint;
  v_value    numeric(14, 2);
begin
  if p_kind = 'open_sales_lines' then
    v_fields := array['documentNo', 'lineNo', 'customerNo', 'itemNo', 'description',
                      'shipDate', 'quantity', 'unitPrice', 'lineAmount', 'locationCode'];
    select string_agg(r.row_json, ',' order by r.document_no collate "C", r.line_no),
           count(*)::int, coalesce(sum(r.quantity), 0)::bigint, coalesce(sum(r.value), 0)
      into v_rows, v_count, v_quantity, v_value
    from (
      select l.document_no, l.line_no, l.quantity, round(l.quantity * l.unit_price, 2) as value,
             '[' || array_to_string(array[
               to_json(l.document_no)::text,
               to_json(l.line_no::text)::text,
               to_json(l.customer_no)::text,
               to_json(l.item_no)::text,
               to_json(l.description)::text,
               to_json(to_char(l.ship_date, 'YYYY-MM-DD'))::text,
               to_json(l.quantity::text)::text,
               to_json(round(l.unit_price, 2)::text)::text,
               to_json(round(l.quantity * l.unit_price, 2)::text)::text,
               to_json(l.location_code)::text], ',') || ']' as row_json
      from nl.export_snapshot_lines l
      where l.snapshot_id = p_snapshot_id
    ) r;
  elsif p_kind = 'open_purchase_lines' then
    v_fields := array['documentNo', 'lineNo', 'vendorNo', 'itemNo', 'description',
                      'dueDate', 'promisedDate', 'quantity', 'locationCode'];
    select string_agg(r.row_json, ',' order by r.document_no collate "C", r.line_no),
           count(*)::int, coalesce(sum(r.quantity), 0)::bigint, coalesce(sum(r.value), 0)
      into v_rows, v_count, v_quantity, v_value
    from (
      -- A supply order is worth what the parts on it cost us.
      select l.document_no, l.line_no, l.quantity, round(l.quantity * i.unit_cost, 2) as value,
             '[' || array_to_string(array[
               to_json(l.document_no)::text,
               to_json(l.line_no::text)::text,
               to_json(l.vendor_no)::text,
               to_json(l.item_no)::text,
               to_json(l.description)::text,
               to_json(to_char(l.due_date, 'YYYY-MM-DD'))::text,
               to_json(to_char(l.promised_date, 'YYYY-MM-DD'))::text,
               to_json(l.quantity::text)::text,
               to_json(l.location_code)::text], ',') || ']' as row_json
      from nl.export_snapshot_purchase_lines l
      join nl.items i on i.item_no = l.item_no
      where l.snapshot_id = p_snapshot_id
    ) r;
  else
    v_fields := array['orderNo', 'itemNo', 'workCenter', 'status', 'dueDate', 'quantity'];
    select string_agg(r.row_json, ',' order by r.order_no collate "C"),
           count(*)::int, coalesce(sum(r.quantity), 0)::bigint, coalesce(sum(r.value), 0)
      into v_rows, v_count, v_quantity, v_value
    from (
      select o.order_no, o.quantity, round(o.quantity * i.unit_cost, 2) as value,
             '[' || array_to_string(array[
               to_json(o.order_no)::text,
               to_json(o.item_no)::text,
               to_json(o.work_center)::text,
               to_json(o.status)::text,
               to_json(to_char(o.due_date, 'YYYY-MM-DD'))::text,
               to_json(o.quantity::text)::text], ',') || ']' as row_json
      from nl.export_snapshot_production_orders o
      join nl.items i on i.item_no = o.item_no
      where o.snapshot_id = p_snapshot_id
    ) r;
  end if;

  return jsonb_build_object(
    'hash', encode(sha256(convert_to('{"profile":' || to_json(p_kind)::text
                                     || ',"fields":' || array_to_json(v_fields)::text
                                     || ',"rows":[' || coalesce(v_rows, '') || ']}', 'UTF8')), 'hex'),
    'rows', v_count,
    'quantity', v_quantity,
    'value', v_value);
end $$;

-- ---------------------------------------------------------------------------
-- Staging and applying a day's export, the way the app does it
-- ---------------------------------------------------------------------------

-- Store one day's sample export as a staged snapshot. No hold reasons: these
-- files are clean, complete and current on the day they were made.
create or replace function nl_seed.stage_sample_export(p_kind text, p_day date, p_user int) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id     bigint;
  v_name   text;
  v_sum    jsonb;
  v_staged timestamptz := (p_day + time '06:40') at time zone 'America/Chicago';
begin
  v_name := case p_kind
              when 'open_sales_lines' then 'open-sales-lines-'
              when 'open_purchase_lines' then 'open-purchase-lines-'
              else 'open-production-orders-'
            end || to_char(p_day, 'YYYY-MM-DD') || '.csv';

  -- The row goes in first so its lines have something to point at, then the
  -- fingerprint and the totals are read back off those lines. The table
  -- insists on a positive row count and a SHA-256 shaped fingerprint from the
  -- first moment, so both start as a stand-in: a hash of the file name, which
  -- is unique per report and day, and is replaced below.
  insert into nl.export_snapshots (kind, file_name, content_hash, status, row_count, line_count, error_count,
                                   total_quantity, total_value, staged_by, staged_at)
  values (p_kind, v_name, encode(sha256(convert_to(v_name, 'UTF8')), 'hex'), 'staged',
          1, 1, 0, 0, 0, p_user, v_staged)
  returning id into v_id;

  if p_kind = 'open_sales_lines' then
    insert into nl.export_snapshot_lines (snapshot_id, document_no, line_no, row_no, customer_no, item_no,
                                          description, ship_date, quantity, unit_price, line_amount, location_code)
    select v_id, s.document_no, s.line_no, s.row_no, s.customer_no, s.item_no, s.description, s.ship_date,
           s.quantity, s.unit_price, round(s.quantity * s.unit_price, 2), s.location_code
    from nl.sample_open_sales_lines(p_day) s;
  elsif p_kind = 'open_purchase_lines' then
    insert into nl.export_snapshot_purchase_lines (snapshot_id, document_no, line_no, row_no, vendor_no, item_no,
                                                   description, due_date, promised_date, quantity, location_code)
    select v_id, s.document_no, s.line_no, s.row_no, s.vendor_no, s.item_no, s.description, s.due_date,
           s.promised_date, s.quantity, s.location_code
    from nl.sample_open_purchase_lines(p_day) s;
  else
    insert into nl.export_snapshot_production_orders (snapshot_id, order_no, row_no, item_no, work_center,
                                                      status, due_date, quantity)
    select v_id, s.order_no, s.row_no, s.item_no, s.work_center, s.status, s.due_date, s.quantity
    from nl.sample_open_production_orders(p_day) s;
  end if;

  v_sum := nl_seed.sample_export_summary(v_id, p_kind);
  update nl.export_snapshots
     set content_hash = v_sum ->> 'hash',
         row_count = (v_sum ->> 'rows')::int,
         line_count = (v_sum ->> 'rows')::int,
         total_quantity = (v_sum ->> 'quantity')::bigint,
         total_value = (v_sum ->> 'value')::numeric
   where id = v_id;

  insert into nl.audit_log (at, actor_id, via, action, entity, entity_id, detail)
  select v_staged, p_user, 'seed', 'stage_export', 'export_snapshot', v_id::text,
         jsonb_build_object('kind', p_kind, 'file_name', v_name, 'status', 'staged',
                            'lines', e.line_count, 'errors', 0)
  from nl.export_snapshots e where e.id = v_id;

  return v_id;
end $$;

-- Apply a staged snapshot to the live table of its kind: the same three
-- steps nl.decide_export takes (remove what is gone, upsert the rest, keep
-- first_seen_on), with the day of the file as "today".
create or replace function nl_seed.apply_sample_export(p_id bigint) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_snap    nl.export_snapshots;
  v_day     date;
  v_added   int := 0;
  v_changed int := 0;
  v_removed int := 0;
begin
  select * into v_snap from nl.export_snapshots where id = p_id;
  v_day := (v_snap.staged_at at time zone 'America/Chicago')::date;

  if v_snap.kind = 'open_sales_lines' then
    select count(*) filter (where o.document_no is null),
           count(*) filter (where o.document_no is not null
                              and (l.item_no, l.ship_date, l.quantity) is distinct from
                                  (o.item_no, o.ship_date, o.quantity))
      into v_added, v_changed
    from nl.export_snapshot_lines l
    left join nl.open_order_lines o on o.document_no = l.document_no and o.line_no = l.line_no
    where l.snapshot_id = p_id;

    delete from nl.open_order_lines o
    where not exists (select 1 from nl.export_snapshot_lines l
                      where l.snapshot_id = p_id and l.document_no = o.document_no and l.line_no = o.line_no);
    get diagnostics v_removed = row_count;

    insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, description, ship_date,
                                     quantity, unit_price, line_amount, location_code,
                                     first_seen_on, last_snapshot_id)
    select l.document_no, l.line_no, l.customer_no, l.item_no, l.description, l.ship_date, l.quantity,
           l.unit_price, l.line_amount, l.location_code, v_day, p_id
    from nl.export_snapshot_lines l
    where l.snapshot_id = p_id
    on conflict (document_no, line_no) do update
      set customer_no = excluded.customer_no, item_no = excluded.item_no, description = excluded.description,
          ship_date = excluded.ship_date, quantity = excluded.quantity, unit_price = excluded.unit_price,
          line_amount = excluded.line_amount, location_code = excluded.location_code,
          last_snapshot_id = excluded.last_snapshot_id;

    -- What the allocation looked like on the day the file was applied.
    update nl.export_snapshot_lines l
       set allocated = a.allocated, short = a.short
      from nl.open_line_allocation a
     where l.snapshot_id = p_id and a.document_no = l.document_no and a.line_no = l.line_no;

  elsif v_snap.kind = 'open_purchase_lines' then
    select count(*) filter (where o.document_no is null),
           count(*) filter (where o.document_no is not null
                              and (l.item_no, l.due_date, l.quantity) is distinct from
                                  (o.item_no, o.due_date, o.quantity))
      into v_added, v_changed
    from nl.export_snapshot_purchase_lines l
    left join nl.open_purchase_lines o on o.document_no = l.document_no and o.line_no = l.line_no
    where l.snapshot_id = p_id;

    delete from nl.open_purchase_lines o
    where not exists (select 1 from nl.export_snapshot_purchase_lines l
                      where l.snapshot_id = p_id and l.document_no = o.document_no and l.line_no = o.line_no);
    get diagnostics v_removed = row_count;

    insert into nl.open_purchase_lines (document_no, line_no, vendor_no, item_no, description, due_date,
                                        promised_date, quantity, location_code, first_seen_on, last_snapshot_id)
    select l.document_no, l.line_no, l.vendor_no, l.item_no, l.description, l.due_date, l.promised_date,
           l.quantity, l.location_code, v_day, p_id
    from nl.export_snapshot_purchase_lines l
    where l.snapshot_id = p_id
    on conflict (document_no, line_no) do update
      set vendor_no = excluded.vendor_no, item_no = excluded.item_no, description = excluded.description,
          due_date = excluded.due_date, promised_date = excluded.promised_date, quantity = excluded.quantity,
          location_code = excluded.location_code, last_snapshot_id = excluded.last_snapshot_id;

  else
    select count(*) filter (where o.order_no is null),
           count(*) filter (where o.order_no is not null
                              and (l.item_no, l.due_date, l.quantity, l.status) is distinct from
                                  (o.item_no, o.due_date, o.quantity, o.status))
      into v_added, v_changed
    from nl.export_snapshot_production_orders l
    left join nl.open_production_orders o on o.order_no = l.order_no
    where l.snapshot_id = p_id;

    delete from nl.open_production_orders o
    where not exists (select 1 from nl.export_snapshot_production_orders l
                      where l.snapshot_id = p_id and l.order_no = o.order_no);
    get diagnostics v_removed = row_count;

    insert into nl.open_production_orders (order_no, item_no, work_center, status, due_date, quantity,
                                           first_seen_on, last_snapshot_id)
    select l.order_no, l.item_no, l.work_center, l.status, l.due_date, l.quantity, v_day, p_id
    from nl.export_snapshot_production_orders l
    where l.snapshot_id = p_id
    on conflict (order_no) do update
      set item_no = excluded.item_no, work_center = excluded.work_center, status = excluded.status,
          due_date = excluded.due_date, quantity = excluded.quantity, last_snapshot_id = excluded.last_snapshot_id;
  end if;

  update nl.export_snapshots set is_current = false where kind = v_snap.kind and is_current;
  update nl.export_snapshots
     set status = 'applied',
         is_current = true,
         apply_summary = jsonb_build_object('added', v_added, 'changed', v_changed, 'removed', v_removed),
         decided_by = staged_by,
         decided_at = staged_at + interval '18 minutes'
   where id = p_id;

  insert into nl.audit_log (at, actor_id, via, action, entity, entity_id, detail)
  select e.decided_at, e.staged_by, 'seed', 'apply_export', 'export_snapshot', e.id::text,
         jsonb_build_object('kind', e.kind, 'from_status', 'staged', 'summary', e.apply_summary)
  from nl.export_snapshots e where e.id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- What the world gets
-- ---------------------------------------------------------------------------

create or replace function nl_seed.extra_40_supply() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (select today from nl_seed.settings);
  -- Priya Raman, Operations Lead: she loads the morning exports.
  v_ops   int := 5;
  v_day   date;
  v_kind  text;
begin
  -- Two mornings, in order, so the day-over-day views have both sides and
  -- the live tables end on yesterday's file. Today's files are what the demo
  -- downloads and uploads.
  foreach v_day in array array[v_today - 2, v_today - 1] loop
    foreach v_kind in array array['open_sales_lines', 'open_purchase_lines', 'open_production_orders'] loop
      perform nl_seed.apply_sample_export(nl_seed.stage_sample_export(v_kind, v_day, v_ops));
    end loop;
  end loop;

  -- The item card's "on purchase order" and "on production order" are a sum
  -- of a part's open supply orders, so they are set from today's files, not
  -- drawn on their own (they were drawn in nl_seed.build_catalog, before
  -- there was any supply to agree with). The generators read on_hand and
  -- demand, never these two columns, so writing them cannot change what they
  -- produce.
  update nl.stock s
     set on_purchase_order = coalesce((select sum(p.quantity)::int
                                       from nl.sample_open_purchase_lines(v_today) p
                                       where p.item_no = s.item_no), 0),
         on_production_order = coalesce((select sum(m.quantity)::int
                                         from nl.sample_open_production_orders(v_today) m
                                         where m.item_no = s.item_no), 0);
end $$;
