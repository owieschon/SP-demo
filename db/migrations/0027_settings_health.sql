-- 0027 Health checks that do not make the Settings page wait.
--
-- What 0025 got wrong. Its two health functions were exact: they counted every
-- row of the world before /settings could answer. On the full world that is
-- about 450,000 ledger lines, 164,000 cost revisions and 19,000 stock moves,
-- and the page took around fourteen seconds. Exactness is the right default
-- for a drift check the nightly job runs; it is the wrong default for a line
-- on a page somebody is waiting for.
--
-- So the checks are split in three:
--
--   1. Row counts come from the statistics Postgres already keeps
--      (nl.diagnostic_row_estimates). No table is read. The page says they
--      are estimates, because they are.
--   2. The cost check asks whether there is drift rather than how much, over
--      a sample of the ledger (nl.diagnostic_cost_drift). Bounded work, and
--      it catches the failure that actually happens: a restamp that did not
--      run (db/seed.d/55).
--   3. The two exact checks stay exact and move behind a button
--      (nl.diagnostic_drift_exact). They read everything, which is the point
--      of them, so they run when a person asks and never on page load. The
--      function carries its own statement timeout, so holding the button down
--      cannot tie up the database.
--
-- Depends on 0025, and reads 0008 (nl.delivery_drift), 0018 (nl.item_cost_on)
-- and, when it exists, 0019 (nl.warehouse_drift).

-- The exact counters from 0025. Their replacements are below.
drop function nl.diagnostic_counts();
drop function nl.diagnostic_drift();

-- ---------------------------------------------------------------------------
-- How big the world is, without reading it
-- ---------------------------------------------------------------------------

-- The planner keeps a row estimate per table (pg_class.reltuples) and the
-- statistics collector keeps a live count (pg_stat_all_tables.n_live_tup).
-- Neither is reliable on its own here: reltuples is -1 until a table has been
-- analyzed once and is reset by the TRUNCATE in nl.reset(), and n_live_tup is
-- lost if the statistics are reset. Whichever of the two is larger is the one
-- that has seen the world as it is now, so that is what this returns.
--
-- These are estimates, and the page says so. Nothing on this page needs an
-- exact row count; what it needs is "is the world there, and roughly the size
-- it should be".
create function nl.diagnostic_row_estimates() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.name, t.rows), '{}'::jsonb)
  from (
    select c.relname as name,
           greatest(
             case when c.reltuples < 0 then 0 else c.reltuples end,
             coalesce(s.n_live_tup, 0)
           )::bigint as rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_all_tables s on s.relid = c.oid
    where n.nspname = 'nl'
      and c.relkind = 'r'
      and c.relname in (
        'users', 'customers', 'contacts', 'items',
        'commitments', 'invoices', 'invoice_lines', 'audit_log')
  ) t
$$;

-- ---------------------------------------------------------------------------
-- Is the ledger's cost in step with the cost history?
-- ---------------------------------------------------------------------------

-- Every invoice line carries the cost that applied on the day it was posted,
-- which is what makes margin history stable (DECISIONS 6, db/seed.d/55). If a
-- restamp did not run, the whole ledger claims today's cost, so a sample finds
-- it immediately.
--
-- Five hundred lines, whichever the database hands over first, each compared
-- with nl.item_cost_on() through the cost index. There is no date filter and
-- no sort: nl.invoice_lines has no index on posted_on, so either would turn a
-- five hundred row read into a scan of the whole ledger, which is the cost
-- this migration exists to remove. The exact check behind the button reads
-- every line.
create function nl.diagnostic_cost_drift() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  with sample as (
    select il.item_no, il.posted_on, il.unit_cost
    from nl.invoice_lines il
    limit 500
  )
  select jsonb_build_object(
    'sampled', true,
    'checked', (select count(*) from sample),
    'found', (
      select count(*)
      from sample s
      where s.unit_cost is distinct from nl.item_cost_on(s.item_no, s.posted_on)))
$$;

-- ---------------------------------------------------------------------------
-- The exact checks, for when a person asks
-- ---------------------------------------------------------------------------

-- Everything the fast checks estimate, measured properly: the stored delivered
-- figure against a fresh count for every commitment, stock on hand against the
-- movement ledger, and every ledger line against the cost timeline.
--
-- nl.delivery_drift() and nl.warehouse_drift() are revoked from everyone
-- (migrations 0008 and 0019) because they belong to the nightly job. This
-- function is SECURITY DEFINER so the page can see their result without
-- anybody being granted the checks themselves, and it returns counts only.
--
-- The statement timeout is on the function, so it applies however this is
-- called: a run that cannot finish in half a minute gives up rather than
-- holding a connection while somebody reloads the page.
create function nl.diagnostic_drift_exact() returns jsonb
language plpgsql stable security definer
set search_path = ''
set statement_timeout = '30s'
as $$
declare
  v_started   timestamptz := clock_timestamp();
  v_delivery  int;
  v_warehouse int := null;
  v_cost      int;
begin
  select count(*) into v_delivery from nl.delivery_drift();

  -- The warehouse arrived later than the rest of the app, so a database
  -- without migration 0019 has no answer for this one.
  if to_regprocedure('nl.warehouse_drift()') is not null then
    execute 'select count(*) from nl.warehouse_drift()' into v_warehouse;
  end if;

  select count(*) into v_cost
  from nl.invoice_lines il
  join nl.item_cost_timeline t
    on t.item_no = il.item_no
   and il.posted_on >= t.effective_from
   and (t.effective_to is null or il.posted_on <= t.effective_to)
  where il.unit_cost is distinct from t.unit_cost;

  return jsonb_build_object(
    'delivery', v_delivery,
    'warehouse', v_warehouse,
    'cost', v_cost,
    'ms', round(extract(epoch from (clock_timestamp() - v_started)) * 1000));
end $$;

grant execute on function
  nl.diagnostic_row_estimates(),
  nl.diagnostic_cost_drift(),
  nl.diagnostic_drift_exact()
to nl_app;
-- nl_readonly gets nothing here either.
