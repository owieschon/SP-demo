-- Load test: grow the full world to N times its size, then time the pages.
--
-- Not a migration. Run it by hand on a scratch copy of the database, never on
-- a world people are using. nl_bench.multiply(k) adds copy number k of every
-- customer, invoice, invoice line, quote and commitment, with ".k" appended to
-- the business keys and k million added to the numeric ids. The copies keep
-- the shape of the original business (families, windows, outcomes), so
-- copies 2 to 10 make a business ten times the size.
--
--   \i db/bench/scale.sql
--   select nl_bench.multiply(k) from generate_series(2, 10) k;  -- one call per k is kinder
--   select nl_bench.import_a_day();                              -- then time the pages
--   select nl.reset(); select nl.build('full');                  -- back to normal
--   drop schema nl_bench cascade;
--
-- docs/scale.md records the results.

create schema if not exists nl_bench;
revoke all on schema nl_bench from public;

create or replace function nl_bench.multiply(k int) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_suffix text := '.' || k;
  v_offset bigint := k * 1000000;
  v_started timestamptz := clock_timestamp();
  v_steps jsonb := '{}';
  v_t timestamptz;
begin
  if k < 2 then
    raise exception 'Copy 1 is the original world; start at 2.';
  end if;
  if exists (select 1 from nl.commitments where id > v_offset and id < v_offset + 1000000) then
    raise exception 'Copy % already exists.', k;
  end if;

  v_t := clock_timestamp();
  -- Customers, with their billing family copied inside the copy.
  insert into nl.customers (customer_no, name, bill_to_no, city, state, country, email_domain, price_group,
                            ships_own_carrier, blocked, closed, owner_id, agency_id, customer_since)
  select customer_no || v_suffix, name, bill_to_no || v_suffix, city, state, country,
         null, price_group, ships_own_carrier, blocked, closed, owner_id, agency_id, customer_since
  from nl.customers
  where customer_no not like '%.%';
  v_steps := v_steps || jsonb_build_object('customers_ms', round(extract(epoch from clock_timestamp() - v_t) * 1000));

  v_t := clock_timestamp();
  insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, order_no, customer_po,
                           freight, applies_to, subtotal)
  select invoice_no || v_suffix, doc_type, customer_no || v_suffix, bill_to_no || v_suffix, posted_on,
         order_no, customer_po, freight, applies_to || v_suffix, subtotal
  from nl.invoices
  where invoice_no not like '%.%';
  v_steps := v_steps || jsonb_build_object('invoices_ms', round(extract(epoch from clock_timestamp() - v_t) * 1000));

  v_t := clock_timestamp();
  insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
  select invoice_no || v_suffix, line_no, customer_no || v_suffix, posted_on, item_no, quantity, unit_price, amount, unit_cost
  from nl.invoice_lines
  where invoice_no not like '%.%';
  v_steps := v_steps || jsonb_build_object('invoice_lines_ms', round(extract(epoch from clock_timestamp() - v_t) * 1000));

  v_t := clock_timestamp();
  insert into nl.commitments (id, title, customer_no, buyer_contact_id, owner_id, committed_value, starts_on, ends_on,
                              confidence, notes, created_by, created_at)
  overriding system value
  select id + v_offset, title, customer_no || v_suffix, null, owner_id, committed_value, starts_on, ends_on,
         confidence, notes, created_by, created_at
  from nl.commitments
  where id < 1000000;

  -- This insert fires the scope trigger, which measures every new commitment.
  insert into nl.commitment_items (commitment_id, item_no, quantity)
  select commitment_id + v_offset, item_no, quantity
  from nl.commitment_items
  where commitment_id < 1000000;
  v_steps := v_steps || jsonb_build_object('commitments_ms', round(extract(epoch from clock_timestamp() - v_t) * 1000));

  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note, evidence)
  select commitment_id + v_offset, outcome, source, answered_by, answered_at, note, evidence
  from nl.commitment_outcomes
  where commitment_id < 1000000;

  insert into nl.quotes (id, customer_no, commitment_id, quoted_on, valid_until, source, created_by, created_at)
  overriding system value
  select id + v_offset, customer_no || v_suffix, commitment_id + v_offset, quoted_on, valid_until, source,
         created_by, created_at
  from nl.quotes
  where id < 1000000;
  insert into nl.quote_lines (quote_id, line_no, item_no, quantity, unit_price)
  select quote_id + v_offset, line_no, item_no, quantity, unit_price
  from nl.quote_lines
  where quote_id < 1000000;

  return v_steps || jsonb_build_object(
    'copy', k,
    'total_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000));
end $$;

-- A day of new invoice lines arriving, as the daily ledger import would
-- deliver them: copies of the most recent day's lines, posted today, on
-- customers that have open commitments. Returns how long the insert took,
-- including the triggers that re-measure the commitments it touches.
create or replace function nl_bench.import_a_day() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_day date := (select max(posted_on) from nl.invoice_lines where posted_on < nl.today());
  v_t timestamptz;
  v_lines int;
  v_before timestamptz := now();
  v_measured int;
begin
  insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
  select invoice_no || '.today', doc_type, customer_no, bill_to_no, nl.today(), subtotal
  from nl.invoices
  where posted_on = v_day;

  v_t := clock_timestamp();
  insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
  select invoice_no || '.today', line_no, customer_no, nl.today(), item_no, quantity, unit_price, amount, unit_cost
  from nl.invoice_lines
  where posted_on = v_day;
  get diagnostics v_lines = row_count;

  select count(*) into v_measured from nl.commitment_delivery where measured_at >= v_before;

  return jsonb_build_object(
    'lines', v_lines,
    'insert_with_triggers_ms', round(extract(epoch from clock_timestamp() - v_t) * 1000, 1),
    'commitments_remeasured', v_measured);
end $$;

revoke execute on all functions in schema nl_bench from public;
