-- 0008 Keep each commitment's delivered figure current, instead of
-- recomputing every commitment on every page load.
--
-- Before this, nl.commitment_progress summed invoice lines for all
-- commitments each time the board loaded. That cost grows with history: every
-- kept commitment from past years was measured again, although its figure
-- could only change if the ledger changed. On the full world it took 337 ms;
-- at ten times the business it would take seconds.
--
-- Delivered only changes when one of four things changes:
--   1. invoice lines (the ledger),
--   2. a commitment's items,
--   3. a commitment's customer or window,
--   4. which account bills to which (the customer family).
-- Triggers on exactly those four tables re-measure exactly the commitments a
-- change can touch, inside the same transaction, and store the result in
-- nl.commitment_delivery. The page reads the stored figure.
--
-- The status is still derived on every read; only the sum is kept. The live
-- computation (nl.commitment_lines) stays, and nl.delivery_drift() compares
-- the two. The tests require zero drift, and the nightly job repairs any it
-- finds and reports it.

create table nl.commitment_delivery (
  commitment_id    bigint primary key references nl.commitments (id) on delete cascade,
  delivered        numeric(14, 2) not null,
  matched_lines    bigint not null,
  last_delivery_on date,
  measured_at      timestamptz not null default now()
);

comment on table nl.commitment_delivery is
  'Delivered value per commitment, kept current by triggers (migration 0008). Nobody writes it directly.';

alter table nl.commitment_delivery enable row level security;
create policy commitment_delivery_read on nl.commitment_delivery
  for select to nl_app, nl_readonly using (true);
grant select on nl.commitment_delivery to nl_app, nl_readonly;

-- ---------------------------------------------------------------------------
-- Measuring
-- ---------------------------------------------------------------------------

-- The accounts a given account bills to, at any depth, starting with itself.
-- A commitment on any of them counts this account's invoice lines. The
-- mirror image of nl.customer_family().
create function nl.customer_ancestors(p_customer_no text)
returns table (customer_no text)
language sql stable rows 3
set search_path = ''
as $$
  with recursive up (customer_no, path) as (
    select p_customer_no, array[p_customer_no]
    union all
    select parent.bill_to_no, u.path || parent.bill_to_no
    from up u
    join nl.customers parent on parent.customer_no = u.customer_no
    where parent.bill_to_no is not null
      and not parent.bill_to_no = any (u.path)
  )
  select customer_no from up
$$;

-- Measure the given commitments and store the result. The window is part of
-- the index lookup here (the commitment is fixed inside the subquery), so
-- only lines inside the window are read at all.
-- SECURITY DEFINER: triggers fired by a signed-in user's write must be able
-- to update this table, which no user may write directly. Nobody is granted
-- EXECUTE; only the trigger functions below call it.
create function nl.measure_commitments(p_ids bigint[]) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;

  insert into nl.commitment_delivery (commitment_id, delivered, matched_lines, last_delivery_on, measured_at)
  select c.id, m.delivered, m.matched_lines, m.last_delivery_on, now()
  from nl.commitments c
  cross join lateral (
    select coalesce(sum(il.amount), 0) as delivered,
           count(il.amount)           as matched_lines,
           max(il.posted_on)          as last_delivery_on
    from nl.customer_family(c.customer_no) f
    join nl.commitment_items ci on ci.commitment_id = c.id
    join nl.invoice_lines il
      on il.customer_no = f.customer_no
     and il.item_no = ci.item_no
     and il.posted_on between c.starts_on and c.ends_on
  ) m
  where c.id = any (p_ids)
  on conflict (commitment_id) do update
    set delivered        = excluded.delivered,
        matched_lines    = excluded.matched_lines,
        last_delivery_on = excluded.last_delivery_on,
        measured_at      = excluded.measured_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- The four triggers
-- ---------------------------------------------------------------------------

-- 1. The ledger. Statement-level, so an import of thousands of lines
-- re-measures each affected commitment once. A line affects a commitment
-- when the commitment is on the line's account or on any account above it,
-- one of its items is the line's item, and its window covers the line's date.
create function nl.commitments_touched_by_lines(p_customers text[], p_items text[], p_dates date[])
returns bigint[]
language sql stable
set search_path = ''
as $$
  with touched as (
    select customer_no, item_no, min(posted_on) as first_on, max(posted_on) as last_on
    from unnest(p_customers, p_items, p_dates) as l (customer_no, item_no, posted_on)
    group by customer_no, item_no
  ),
  above as (
    select t.customer_no as line_customer, a.customer_no as ancestor
    from (select distinct customer_no from touched) t
    cross join lateral nl.customer_ancestors(t.customer_no) a
  )
  select array_agg(distinct c.id)
  from touched t
  join above ab on ab.line_customer = t.customer_no
  join nl.commitments c
    on c.customer_no = ab.ancestor
   and c.starts_on <= t.last_on
   and c.ends_on >= t.first_on
  join nl.commitment_items ci on ci.commitment_id = c.id and ci.item_no = t.item_no
$$;

create function nl.remeasure_after_ledger_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customers text[];
  v_items     text[];
  v_dates     date[];
begin
  -- While the world is being built there are no commitments yet.
  if not exists (select 1 from nl.commitments) then
    return null;
  end if;

  -- Transition tables only exist for the operations that declare them, so
  -- each branch names only its own.
  if tg_op = 'INSERT' then
    select array_agg(customer_no), array_agg(item_no), array_agg(posted_on)
      into v_customers, v_items, v_dates
    from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(customer_no), array_agg(item_no), array_agg(posted_on)
      into v_customers, v_items, v_dates
    from old_rows;
  else
    select array_agg(customer_no), array_agg(item_no), array_agg(posted_on)
      into v_customers, v_items, v_dates
    from (select customer_no, item_no, posted_on from new_rows
          union all
          select customer_no, item_no, posted_on from old_rows) s;
  end if;

  perform nl.measure_commitments(nl.commitments_touched_by_lines(v_customers, v_items, v_dates));
  return null;
end $$;

create trigger invoice_lines_remeasure_insert
  after insert on nl.invoice_lines
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_ledger_change();
create trigger invoice_lines_remeasure_update
  after update on nl.invoice_lines
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_ledger_change();
create trigger invoice_lines_remeasure_delete
  after delete on nl.invoice_lines
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_ledger_change();

-- 2. A commitment's items.
create function nl.remeasure_after_scope_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct commitment_id) into v_ids from new_rows;
  elsif tg_op = 'DELETE' then
    -- A deleted commitment takes its items with it; only re-measure the
    -- commitments that still exist.
    select array_agg(distinct o.commitment_id) into v_ids
    from old_rows o
    where exists (select 1 from nl.commitments c where c.id = o.commitment_id);
  else
    select array_agg(distinct commitment_id) into v_ids
    from (select commitment_id from new_rows union select commitment_id from old_rows) s;
  end if;
  perform nl.measure_commitments(v_ids);
  return null;
end $$;

create trigger commitment_items_remeasure_insert
  after insert on nl.commitment_items
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_scope_change();
create trigger commitment_items_remeasure_update
  after update on nl.commitment_items
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_scope_change();
create trigger commitment_items_remeasure_delete
  after delete on nl.commitment_items
  referencing old table as old_rows
  for each statement execute function nl.remeasure_after_scope_change();

-- 3. The commitment itself: a new one starts at zero (its items arrive next
-- and trigger 2 measures it); a changed customer or window is re-measured.
create function nl.remeasure_after_commitment_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  if tg_op = 'INSERT' then
    select array_agg(id) into v_ids from new_rows;
  else
    select array_agg(n.id) into v_ids
    from new_rows n
    join old_rows o on o.id = n.id
    where (n.customer_no, n.starts_on, n.ends_on) is distinct from (o.customer_no, o.starts_on, o.ends_on);
  end if;
  perform nl.measure_commitments(v_ids);
  return null;
end $$;

create trigger commitments_remeasure_insert
  after insert on nl.commitments
  referencing new table as new_rows
  for each statement execute function nl.remeasure_after_commitment_change();
create trigger commitments_remeasure_update
  after update on nl.commitments
  referencing old table as old_rows new table as new_rows
  for each statement execute function nl.remeasure_after_commitment_change();

-- 4. The family. When an account starts or stops billing to another, every
-- commitment above it, on the old chain and on the new one, is re-measured.
create function nl.remeasure_after_family_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  select array_agg(distinct c.id) into v_ids
  from (
    select a.customer_no from nl.customer_ancestors(old.bill_to_no) a where old.bill_to_no is not null
    union
    select a.customer_no from nl.customer_ancestors(new.bill_to_no) a where new.bill_to_no is not null
  ) chain
  join nl.commitments c on c.customer_no = chain.customer_no;
  perform nl.measure_commitments(v_ids);
  return null;
end $$;

create trigger customers_remeasure_family
  after update of bill_to_no on nl.customers
  for each row
  when (old.bill_to_no is distinct from new.bill_to_no)
  execute function nl.remeasure_after_family_change();

-- ---------------------------------------------------------------------------
-- Checking and repairing
-- ---------------------------------------------------------------------------

-- Commitments whose stored figure differs from a fresh count through the
-- live view. Should always be empty.
create function nl.delivery_drift()
returns table (commitment_id bigint, stored numeric, measured numeric)
language sql stable
set search_path = ''
as $$
  select c.id, d.delivered, m.delivered
  from nl.commitments c
  left join nl.commitment_delivery d on d.commitment_id = c.id
  cross join lateral (
    select coalesce(sum(l.amount), 0) as delivered
    from nl.commitment_lines l
    where l.commitment_id = c.id
  ) m
  where d.delivered is distinct from m.delivered
$$;

-- For the nightly job: fix any drift and say how much there was.
create function nl.repair_delivery() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  select array_agg(commitment_id order by commitment_id) into v_ids from nl.delivery_drift();
  perform nl.measure_commitments(v_ids);
  return jsonb_build_object('repaired', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;

revoke execute on function
  nl.measure_commitments(bigint[]),
  nl.commitments_touched_by_lines(text[], text[], date[]),
  nl.remeasure_after_ledger_change(),
  nl.remeasure_after_scope_change(),
  nl.remeasure_after_commitment_change(),
  nl.remeasure_after_family_change(),
  nl.delivery_drift(),
  nl.repair_delivery()
from public;
grant execute on function nl.customer_ancestors(text) to nl_app, nl_readonly;

-- Measure everything that already exists.
select nl.measure_commitments(array(select id from nl.commitments));

-- ---------------------------------------------------------------------------
-- Progress reads the stored figure
-- ---------------------------------------------------------------------------

-- Same columns as 0003; only the "delivered" step changed.
create or replace view nl.commitment_progress with (security_invoker = true) as
with latest_outcome as (
  select commitment_id, outcome, source, answered_by, answered_at, note
  from (
    select
      o.*,
      row_number() over (
        partition by o.commitment_id
        order by o.answered_at desc, o.id desc
      ) as answer_rank
    from nl.commitment_outcomes o
  ) ranked
  where answer_rank = 1
),
quoted as (
  select commitment_id, count(*) as quote_count, max(quoted_on) as last_quoted_on
  from nl.quotes
  where commitment_id is not null
  group by commitment_id
),
measured as (
  select
    c.*,
    coalesce(d.delivered, 0)     as delivered,
    coalesce(d.matched_lines, 0) as matched_lines,
    d.last_delivery_on,
    coalesce(q.quote_count, 0)   as quote_count,
    q.last_quoted_on,
    lo.outcome,
    lo.source      as outcome_source,
    lo.answered_by,
    lo.answered_at,
    lo.note        as outcome_note,
    coalesce(d.delivered, 0) >= c.committed_value * nl.kept_ratio() as kept_by_measure,
    nl.today()     as today
  from nl.commitments c
  left join nl.commitment_delivery d on d.commitment_id = c.id
  left join quoted q on q.commitment_id = c.id
  left join latest_outcome lo on lo.commitment_id = c.id
),
classified as (
  select
    m.*,
    case
      when m.outcome is not null then m.outcome   -- someone answered
      when m.kept_by_measure then 'kept'          -- the ledger says so
      when m.delivered > 0 then 'delivering'
      when m.quote_count > 0 then 'quoted'
      else 'promised'
    end as status,
    greatest(m.committed_value - m.delivered, 0) as remaining
  from measured m
)
select
  k.id,
  k.title,
  k.customer_no,
  k.buyer_contact_id,
  k.owner_id,
  k.committed_value,
  k.starts_on,
  k.ends_on,
  k.confidence,
  k.notes,
  k.created_by,
  k.created_at,
  k.updated_at,
  k.delivered,
  k.remaining,
  round(k.delivered / k.committed_value, 4) as delivered_ratio,
  k.matched_lines,
  k.last_delivery_on,
  k.quote_count,
  k.last_quoted_on,
  k.status,
  k.status in ('kept', 'pushed', 'broken') as is_settled,
  k.kept_by_measure,
  k.outcome,
  k.outcome_source,
  k.answered_by,
  k.answered_at,
  k.outcome_note,
  (k.outcome is null and not k.kept_by_measure and k.ends_on < k.today) as needs_outcome,
  case when k.ends_on < k.today then k.today - k.ends_on end as days_since_close,
  least(greatest((k.today - k.starts_on)::numeric / (k.ends_on - k.starts_on + 1), 0), 1)
    as window_elapsed_ratio,
  round(
    k.delivered
    + case when k.status in ('kept', 'pushed', 'broken') then 0
           else k.confidence / 100.0 * k.remaining end,
    2) as expected_value
from classified k;
