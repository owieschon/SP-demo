-- 0010 A daily ERP export that refuses bad files.
--
-- The ERP can only produce file exports. Every morning operations uploads
-- its "open sales lines" export (ordered, not yet shipped). The file is
-- checked in the app first, then STAGED here as a snapshot. Nothing reaches
-- the live table (nl.open_order_lines) until a person applies the snapshot,
-- or releases a held one with a note.
--
--   upload -> staged -----------> apply   -> applied (the one current snapshot)
--          \> held (reasons) ---> release -> applied
--          either one ----------> discard -> discarded (final)
--
-- A snapshot is held when it looks wrong: far fewer lines than the live
-- data, every ship date already past, or rows that failed a check. The
-- reasons are stored with it and shown to the person deciding.
--
-- Then the live lines get on-hand stock allocated to them, oldest ship date
-- first, and fall into exactly one of four buckets (nl.open_line_allocation).

-- A snapshot with fewer lines than this share of the live one is held.
create function nl.partial_export_ratio() returns numeric
language sql immutable
set search_path = ''
as $$ select 0.40::numeric $$;

-- How far ahead "due soon" looks, in days. A line due inside this horizon
-- is at risk when stock does not cover it, and on pace when it does.
create function nl.at_risk_days() returns int
language sql immutable
set search_path = ''
as $$ select 14 $$;

-- Operations people and admins run the imports. Account managers can look.
create function nl.can_run_imports() returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from nl.users
    where id = nl.current_user_id() and role in ('operations', 'admin') and active)
$$;

-- ---------------------------------------------------------------------------
-- Snapshots: one row per uploaded file that passed the file-level checks
-- ---------------------------------------------------------------------------

create table nl.export_snapshots (
  id              bigint generated always as identity (start with 501) primary key,
  kind            text not null default 'open_sales_lines' check (kind in ('open_sales_lines')),
  file_name       text not null,
  -- SHA-256 of the file's normalized rows (sorted, canonical values), not of
  -- its bytes: the ERP stamps the export time into the file and may change
  -- the column order, and neither makes it different data.
  content_hash    text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  status          text not null check (status in ('staged', 'held', 'applied', 'discarded')),
  -- The applied snapshot the live table currently mirrors. Exactly one at most.
  is_current      boolean not null default false,
  row_count       int not null check (row_count > 0),   -- data rows in the file
  line_count      int not null,                         -- rows that passed every check
  error_count     int not null,                         -- rows that did not
  total_quantity  bigint not null,
  total_value     numeric(14, 2) not null,
  ignored_columns text[] not null default '{}',
  -- [{"code": "partial", "message": "..."}], empty when nothing looked wrong.
  hold_reasons    jsonb not null default '[]',
  staged_by       int not null references nl.users (id),
  staged_at       timestamptz not null default now(),
  decided_by      int references nl.users (id),
  decided_at      timestamptz,
  -- Required when a held snapshot is released.
  decision_note   text,
  -- What applying did: {"added": n, "changed": n, "removed": n}
  apply_summary   jsonb,
  updated_at      timestamptz not null default nl.now_ms(),
  -- The same data is only ever loaded once, whatever the file was called.
  unique (kind, content_hash),
  constraint export_snapshots_current_is_applied check (not is_current or status = 'applied'),
  constraint export_snapshots_counts_add_up check (line_count + error_count = row_count),
  constraint export_snapshots_decision_has_a_name
    check (status in ('staged', 'held') or (decided_by is not null and decided_at is not null))
);

create unique index export_snapshots_one_current_idx on nl.export_snapshots (kind) where is_current;
create index export_snapshots_recent_idx on nl.export_snapshots (kind, id desc);
create index export_snapshots_staged_by_idx on nl.export_snapshots (staged_by);
create index export_snapshots_decided_by_idx on nl.export_snapshots (decided_by);

create trigger export_snapshots_touch before update on nl.export_snapshots
  for each row execute function nl.touch_updated_at();

-- The rows that passed every check, typed. allocated and short are filled in
-- when the snapshot is applied, so tomorrow can be compared with today even
-- though the stock will have changed by then.
create table nl.export_snapshot_lines (
  snapshot_id   bigint not null references nl.export_snapshots (id) on delete cascade,
  document_no   text not null,
  line_no       int not null check (line_no > 0),
  row_no        int not null,                 -- where it sat in the file (header = row 1)
  customer_no   text not null references nl.customers (customer_no),
  item_no       text not null references nl.items (item_no),
  description   text not null default '',
  ship_date     date not null,
  quantity      int not null check (quantity > 0),
  unit_price    numeric(12, 2) not null check (unit_price >= 0),
  line_amount   numeric(14, 2),               -- as the ERP printed it, when it did
  location_code text not null default '',
  allocated     int,
  short         int,
  primary key (snapshot_id, document_no, line_no)
);

create index export_snapshot_lines_customer_idx on nl.export_snapshot_lines (customer_no);
create index export_snapshot_lines_item_idx on nl.export_snapshot_lines (item_no);

-- The rows that failed, as they were in the file, with every reason.
create table nl.export_snapshot_errors (
  snapshot_id bigint not null references nl.export_snapshots (id) on delete cascade,
  row_no      int not null,
  document_no text not null default '',
  line_no     text not null default '',
  reasons     text[] not null check (cardinality(reasons) > 0),
  raw         jsonb not null default '{}',
  primary key (snapshot_id, row_no)
);

-- ---------------------------------------------------------------------------
-- The live table: what is on order and not yet shipped, as of the current snapshot
-- ---------------------------------------------------------------------------

create table nl.open_order_lines (
  document_no      text not null,
  line_no          int not null,
  customer_no      text not null references nl.customers (customer_no),
  item_no          text not null references nl.items (item_no),
  description      text not null default '',
  ship_date        date not null,
  quantity         int not null check (quantity > 0),
  unit_price       numeric(12, 2) not null,
  line_amount      numeric(14, 2),
  location_code    text not null default '',
  -- The day this line first appeared in an applied export. An update never moves it.
  first_seen_on    date not null,
  last_snapshot_id bigint not null references nl.export_snapshots (id),
  primary key (document_no, line_no)
);

-- Allocation walks each item's lines in ship-date order (the window function
-- in nl.open_line_allocation). This index is that order, and carries the
-- quantity, so the running sum can read it without a sort.
create index open_order_lines_allocation_idx
  on nl.open_order_lines (item_no, ship_date, document_no, line_no) include (quantity);
create index open_order_lines_customer_idx on nl.open_order_lines (customer_no);
create index open_order_lines_snapshot_idx on nl.open_order_lines (last_snapshot_id);

-- ---------------------------------------------------------------------------
-- Allocation and buckets
-- ---------------------------------------------------------------------------

-- Every open line with the stock allocated to it and its bucket.
--
-- Stock goes to the oldest ship date first (then document, then line), per
-- item. claimed_before is how much of the item earlier lines already asked
-- for (a running sum that stops one row short of this one), so
--   allocated = least(quantity, greatest(on_hand - claimed_before, 0))
--   short     = quantity - allocated
--
-- Buckets, exactly one per line:
--   past_due  ship date before today
--   at_risk   due within nl.at_risk_days() and short
--   on_pace   due within nl.at_risk_days() and fully covered
--   later     due after that
create view nl.open_line_allocation with (security_invoker = true) as
with claimed as (
  -- The running sum reads the live table alone, in the order of
  -- open_order_lines_allocation_idx, so at volume it needs no sort.
  select
    l.*,
    coalesce(sum(l.quantity) over (
      partition by l.item_no
      order by l.ship_date, l.document_no, l.line_no
      rows between unbounded preceding and 1 preceding
    ), 0)::int as claimed_before
  from nl.open_order_lines l
),
-- Today and the horizon, asked once per query rather than once per row
-- (see migration 0009). Materialized, or the planner would inline it and
-- call nl.today() for every line again.
params as materialized (
  select nl.today() as today, nl.at_risk_days() as horizon
),
allocated as (
  select
    c.*,
    coalesce(s.on_hand, 0) as on_hand,
    least(c.quantity, greatest(coalesce(s.on_hand, 0) - c.claimed_before, 0)) as allocated,
    p.today,
    p.horizon
  from claimed c
  cross join params p
  left join nl.stock s on s.item_no = c.item_no
)
select
  a.document_no,
  a.line_no,
  a.customer_no,
  a.item_no,
  a.description,
  a.ship_date,
  a.quantity,
  a.unit_price,
  round(a.quantity * a.unit_price, 2) as open_value,
  a.first_seen_on,
  a.last_snapshot_id,
  a.on_hand,
  a.claimed_before,
  a.allocated,
  a.quantity - a.allocated as short,
  case
    when a.ship_date < a.today then 'past_due'
    when a.ship_date <= a.today + a.horizon and a.allocated < a.quantity then 'at_risk'
    when a.ship_date <= a.today + a.horizon then 'on_pace'
    else 'later'
  end as bucket
from allocated a;

-- Day over day: the current applied snapshot against the applied one before
-- it. A line is
--   new          in the current snapshot only
--   shipped      in the previous snapshot only (shipped or cancelled)
--   newly_short  in both, short now, fully covered before
-- Both sides read the allocation stored when each snapshot was applied.
create view nl.open_line_changes with (security_invoker = true) as
with cur as (
  select id from nl.export_snapshots where is_current
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

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Stage a checked file. The app has already parsed it, refused it if it was
-- the wrong report, and split its rows into good lines and rows with
-- problems. This stores both, works out whether a person must look at it
-- first, and never touches the live table.
--
-- p_lines:  [{"row_no", "document_no", "line_no", "customer_no", "item_no",
--             "description", "ship_date", "quantity", "unit_price",
--             "line_amount", "location_code"}]
-- p_errors: [{"row_no", "document_no", "line_no", "reasons": [...], "raw": {...}}]
create function nl.stage_export(
  p_file_name       text,
  p_content_hash    text,
  p_ignored_columns text[],
  p_lines           jsonb,
  p_errors          jsonb,
  p_request_id      text
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
  v_last_ship  date;
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
  where s.kind = 'open_sales_lines' and s.content_hash = p_content_hash;
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

  insert into nl.export_snapshots (file_name, content_hash, status, row_count, line_count, error_count,
                                   total_quantity, total_value, ignored_columns, staged_by)
  values (trim(p_file_name), p_content_hash, 'staged', v_line_count + v_err_count, v_line_count, v_err_count,
          0, 0, coalesce(p_ignored_columns, '{}'), v_actor.id)
  returning id into v_id;

  insert into nl.export_snapshot_lines (snapshot_id, document_no, line_no, row_no, customer_no, item_no,
                                        description, ship_date, quantity, unit_price, line_amount, location_code)
  select v_id, l.document_no, l.line_no, l.row_no, l.customer_no, l.item_no,
         coalesce(l.description, ''), l.ship_date, l.quantity, l.unit_price, l.line_amount,
         coalesce(l.location_code, '')
  from jsonb_to_recordset(p_lines) as l (
    row_no int, document_no text, line_no int, customer_no text, item_no text, description text,
    ship_date date, quantity int, unit_price numeric, line_amount numeric, location_code text);

  insert into nl.export_snapshot_errors (snapshot_id, row_no, document_no, line_no, reasons, raw)
  select v_id, e.row_no, coalesce(e.document_no, ''), coalesce(e.line_no, ''),
         array(select jsonb_array_elements_text(e.reasons)), coalesce(e.raw, '{}')
  from jsonb_to_recordset(p_errors) as e (row_no int, document_no text, line_no text, reasons jsonb, raw jsonb);

  -- Why a person should look before this goes live.
  select row_count into v_live_rows
  from nl.export_snapshots
  where kind = 'open_sales_lines' and is_current;
  if v_live_rows is not null and v_line_count + v_err_count < v_live_rows * nl.partial_export_ratio() then
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'partial',
      'message', format('This file has %s lines; the live data came from a file with %s. '
                        'Under %s%% of the last export usually means the export was cut short.',
                        v_line_count + v_err_count, v_live_rows, round(nl.partial_export_ratio() * 100)));
  end if;

  select max(ship_date) into v_last_ship from nl.export_snapshot_lines where snapshot_id = v_id;
  if v_last_ship is not null and v_last_ship < nl.today() then
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'stale',
      'message', format('Every ship date is before today (the latest is %s). This looks like an old export.',
                        to_char(v_last_ship, 'Mon DD, YYYY')));
  end if;

  if v_err_count > 0 then
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'row_errors',
      'message', format('%s of %s rows failed a check. Releasing loads the other %s and leaves these out.',
                        v_err_count, v_line_count + v_err_count, v_line_count));
  end if;

  v_status := case when jsonb_array_length(v_reasons) > 0 then 'held' else 'staged' end;

  update nl.export_snapshots s
     set status = v_status,
         hold_reasons = v_reasons,
         total_quantity = t.quantity,
         total_value = t.value
    from (select coalesce(sum(quantity), 0) as quantity,
                 coalesce(sum(round(quantity * unit_price, 2)), 0) as value
          from nl.export_snapshot_lines where snapshot_id = v_id) t
   where s.id = v_id
  returning s.updated_at into v_updated_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'import', 'stage_export', 'export_snapshot', v_id::text, p_request_id,
          jsonb_build_object(
            'file_name', trim(p_file_name),
            'content_hash', p_content_hash,
            'status', v_status,
            'lines', v_line_count,
            'errors', v_err_count,
            'hold_reasons', v_reasons));

  v_result := jsonb_build_object(
    'snapshot_id', v_id,
    'status', v_status,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Apply a staged snapshot (one with no hold reasons), or release a held one
-- with a note. Both make it the current snapshot. Operations or admin only.
create function nl.decide_export(
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
    -- Newer data may already be live; an older file must never replace it.
    select id into v_current from nl.export_snapshots where kind = v_snap.kind and is_current;
    if v_current is not null and v_current > v_snap.id then
      raise exception 'Snapshot % is older than the live data (snapshot %), so it cannot be applied.',
        p_snapshot_id, v_current
        using errcode = 'NL422';
    end if;

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

    v_summary := jsonb_build_object('added', v_added, 'changed', v_changed, 'removed', v_removed);

    -- Hand "current" over. Two statements, because the unique index allows
    -- only one current snapshot at any moment.
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
-- Access
-- ---------------------------------------------------------------------------

alter table nl.export_snapshots enable row level security;
alter table nl.export_snapshot_lines enable row level security;
alter table nl.export_snapshot_errors enable row level security;
alter table nl.open_order_lines enable row level security;

-- Everyone on the team can look at every snapshot and the live lines.
create policy export_snapshots_read on nl.export_snapshots for select to nl_app using (true);
create policy export_snapshot_lines_read on nl.export_snapshot_lines for select to nl_app using (true);
create policy export_snapshot_errors_read on nl.export_snapshot_errors for select to nl_app using (true);
create policy open_order_lines_read on nl.open_order_lines for select to nl_app, nl_readonly using (true);

-- Only operations and admins write, and a snapshot is always staged in the
-- stager's own name. The write functions check the same rules first and
-- give a clear message; these policies are the backstop.
create policy export_snapshots_insert on nl.export_snapshots for insert to nl_app
  with check (staged_by = (select nl.current_user_id()) and (select nl.can_run_imports()));
create policy export_snapshots_update on nl.export_snapshots for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));
create policy export_snapshot_lines_insert on nl.export_snapshot_lines for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy export_snapshot_lines_update on nl.export_snapshot_lines for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));
create policy export_snapshot_errors_insert on nl.export_snapshot_errors for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy open_order_lines_insert on nl.open_order_lines for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy open_order_lines_update on nl.open_order_lines for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));
create policy open_order_lines_delete on nl.open_order_lines for delete to nl_app
  using ((select nl.can_run_imports()));

grant select, insert on nl.export_snapshots, nl.export_snapshot_lines, nl.export_snapshot_errors to nl_app;
grant update (status, is_current, total_quantity, total_value, hold_reasons, decided_by, decided_at,
              decision_note, apply_summary, updated_at) on nl.export_snapshots to nl_app;
grant update (allocated, short) on nl.export_snapshot_lines to nl_app;
grant select, insert, delete on nl.open_order_lines to nl_app;
grant update (customer_no, item_no, description, ship_date, quantity, unit_price, line_amount,
              location_code, last_snapshot_id) on nl.open_order_lines to nl_app;
grant select on nl.open_line_allocation, nl.open_line_changes to nl_app;

-- The read-only role sees the order book, not who loaded which file.
grant select on nl.open_order_lines, nl.open_line_allocation to nl_readonly;

grant execute on function nl.partial_export_ratio(), nl.at_risk_days() to nl_app, nl_readonly;
grant execute on function
  nl.can_run_imports(),
  nl.stage_export(text, text, text[], jsonb, jsonb, text),
  nl.decide_export(bigint, text, timestamptz, text, text, text)
to nl_app;
