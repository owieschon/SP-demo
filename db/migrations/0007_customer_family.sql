-- 0007 Measure each commitment through its own customer family.
--
-- On the full world (2,600 commitments, 450,000 invoice lines) the board took
-- 11 seconds. The recursive view nl.commitment_family expanded every
-- commitment's family in one pass, and the planner guessed that pass would
-- return 1.4 million rows (it returns about 6,500). With that guess it
-- looked invoice lines up by part number alone and threw away 14 million
-- rows on the date and customer checks.
--
-- nl.customer_family() walks one account's family and tells the planner to
-- expect about three rows. A function with a SET clause is never inlined, so
-- the planner keeps that estimate, visits each commitment's family on its
-- own, and reads invoice lines through invoice_lines_delivery_idx (customer,
-- part, date) without touching the table. Same results; about 15 times
-- faster. docs/sql.md shows both plans.

create function nl.customer_family(p_customer_no text)
returns table (customer_no text, depth int)
language sql stable rows 3
set search_path = ''
as $$
  -- The account itself, then every account billed to it, at any depth.
  -- Bad data with a billing loop must not recurse forever.
  with recursive family (customer_no, depth, path) as (
    select p_customer_no, 0, array[p_customer_no]
    union all
    select child.customer_no, f.depth + 1, f.path || child.customer_no
    from family f
    join nl.customers child on child.bill_to_no = f.customer_no
    where not child.customer_no = any (f.path)
  )
  select customer_no, depth from family
$$;

comment on function nl.customer_family(text) is
  'An account and every account billed to it, at any depth. Declared to return about three rows so the planner visits families one at a time.';

-- Same columns as before; the family now comes from the function.
create or replace view nl.commitment_family with (security_invoker = true) as
select c.id as commitment_id, f.customer_no, f.depth
from nl.commitments c
cross join lateral nl.customer_family(c.customer_no) f;

create or replace view nl.commitment_lines with (security_invoker = true) as
select
  c.id as commitment_id,
  il.invoice_no,
  il.line_no,
  il.posted_on,
  il.customer_no,
  f.depth as family_depth,
  il.item_no,
  il.quantity,
  il.unit_price,
  il.amount
from nl.commitments c
cross join lateral nl.customer_family(c.customer_no) f
join nl.commitment_items ci on ci.commitment_id = c.id
join nl.invoice_lines il
  on il.customer_no = f.customer_no
 and il.item_no = ci.item_no
 and il.posted_on between c.starts_on and c.ends_on;

grant execute on function nl.customer_family(text) to nl_app, nl_readonly;
