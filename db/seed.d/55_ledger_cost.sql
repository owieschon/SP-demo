-- Make the ledger agree with the cost timeline.
--
-- nl_seed.build_year() stamps each invoice line with the part's cost as the
-- item card holds it today, because when a year is built there is no cost
-- history yet (seed.d/50 writes it afterwards). That leaves every old line
-- claiming today's cost, which understates the margin the business actually
-- earned back then: in the oldest year of the full world the gap is 35 to 40
-- per cent.
--
-- This runs after 50 and restamps every line with the cost that applied on
-- the day it was posted. Margin history then reads the truth, and the closed
-- months never move again, because the figure lives on the line.
--
-- It is one statement joined to nl.item_cost_timeline rather than a call to
-- nl.item_cost_on() per row: the function pins its search_path, so it cannot
-- be inlined, and 450,000 calls would cost minutes instead of seconds.
create or replace function nl_seed.extra_55_ledger_cost() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_changed bigint;
begin
  -- Nothing to do if the cost history was not built (seed.d/50 missing).
  if not exists (select 1 from nl.item_costs) then
    return;
  end if;

  update nl.invoice_lines il
     set unit_cost = t.unit_cost
    from nl.item_cost_timeline t
   where t.item_no = il.item_no
     and il.posted_on >= t.effective_from
     and (t.effective_to is null or il.posted_on <= t.effective_to)
     and il.unit_cost is distinct from t.unit_cost;
  get diagnostics v_changed = row_count;

  -- The delivered figures are sums of amount, not cost, so they are
  -- untouched; the statement trigger from 0008 re-measures anyway.
  raise notice 'restamped % invoice lines with the cost of their day', v_changed;
end $$;
